import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, resolve } from "node:path";

const projectRoot = resolve(import.meta.dir, "../..");

const boostInclude =
  process.env.BOOST_INCLUDE ??
  (process.platform === "win32"
    ? String.raw`E:\packages\vcpkg\installed\x64-windows\include`
    : null);

// Resolved, not hardcoded: emscripten 6.0 replaced the Windows `.bat` wrappers
// with `.exe`, so the old `em++.bat` literal stopped existing on an emsdk
// upgrade. Bun.which applies PATHEXT, so the bare name finds either one.
//
// LAZY, and it returns null rather than throwing: with the stamps below, a tree
// whose wasm is already current needs no compiler at all. `bun run build` (and
// therefore the CI `dist` job, and deploy on a cache hit) has to work on a
// runner that never installed emsdk. Only an actual rebuild demands it.
// Boxed, because `null` is a RESULT here and not an empty cache: em++ really
// is absent on the CI paths that only bundle. Caching the bare `string | null`
// and filling it with `??=` would rescan PATH once per variant every time the
// answer was "not found" — which is exactly the eight-variant no-compiler case.
let emccResolved: { readonly path: string | null } | undefined;
function resolveEmcc(): string | null {
  emccResolved ??= { path: Bun.which("em++") };
  return emccResolved.path;
}

function requireEmcc(): string {
  const found = resolveEmcc();
  if (!found) {
    throw new Error(
      "em++ not found on PATH — activate emsdk first (emsdk activate latest).",
    );
  }
  return found;
}

let emccVersionCache: string | undefined;
/** `em++ --version`, or "" when there is no compiler to ask. */
function emccVersion(): string {
  if (emccVersionCache !== undefined) return emccVersionCache;
  const found = resolveEmcc();
  if (found) {
    const proc = Bun.spawnSync([found, "--version"]);
    emccVersionCache = proc.stdout.toString().trim();
  } else {
    emccVersionCache = "";
  }
  return emccVersionCache;
}

/**
 * Rebuild whatever the stamps say is current. The escape hatch for a stamp that
 * has gone wrong, and for measuring a cold build.
 */
const forceRebuild = process.env.FORCE_WASM === "1";

interface Stamp {
  /** Hash of the sources, the a-star headers and the full argv. */
  sourcesHash: string;
  /** `em++ --version` at the time the output was produced. */
  emccVersion: string;
}

/**
 * Hashes CONTENT, never mtimes: a fresh `git checkout` and an actions/cache
 * restore both rewrite mtimes wholesale, so an mtime check would either rebuild
 * everything on CI or — far worse — trust a restored-but-stale output.
 *
 * The headers matter as much as the sources: AStar.h, PuzzleProfile.h,
 * ParallelCascade.h and friends are not in any `sources` list but absolutely
 * change the generated code. Only the a-star directory ROOT is hashed —
 * `bench/` and `test/` are native-only and must not invalidate the wasm.
 *
 * `args` must be the FLAGS only, never the absolute paths. Hashing the full
 * argv broke CI: `-I $BOOST_INCLUDE` is present in the job that compiles and
 * absent in the one that only bundles, so the same commit produced two
 * different hashes and the second job tried to rebuild without a compiler.
 * Absolute paths also make a stamp non-portable between machines.
 */
function sourcesHashFor(aStarDir: string, sources: string[], args: string[]) {
  const headers = readdirSync(aStarDir)
    .filter(name => name.endsWith(".h"))
    .sort()
    .map(name => resolve(aStarDir, name));
  const inputs = [...sources.map(s => resolve(aStarDir, s)), ...headers];

  const hash = createHash("sha256");
  // The argv covers the output name, -I paths, SM_SIMD, -m64, -pthread and the
  // memory ceilings, so flipping any build knob invalidates the stamp.
  hash.update(args.join("\0"));
  for (const file of inputs) {
    hash.update("\0");
    hash.update(basename(file));
    hash.update("\0");
    hash.update(readFileSync(file));
  }
  return hash.digest("hex");
}

function readStamp(path: string): Stamp | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Stamp;
  } catch {
    // A truncated stamp from an interrupted build means "rebuild", not "crash".
    return null;
  }
}

async function build({
  aStarDir,
  outDir,
  sources,
  outputJs,
  exportName,
  needsBoost,
  extraArgs = [],
  maxMemory = "4GB",
  memory64 = false,
}: {
  aStarDir: string;
  outDir: string;
  sources: string[];
  outputJs: string;
  exportName: string;
  needsBoost: boolean;
  extraArgs?: string[];
  // wasm heap ceiling. wasm32 tops out at 4GB; a MEMORY64 build can go higher
  // (the flat/hier searches on the hardest boards exhaust 4GB and abort).
  maxMemory?: string;
  // wasm64 (`-m64`): 64-bit pointers, so the heap can exceed the 4GB wasm32 wall.
  // Only runtimes with the Memory64 proposal can load it (node yes; bun not
  // yet — the bridge feature-detects and falls back to the wasm32 build).
  memory64?: boolean;
}) {
  mkdirSync(outDir, { recursive: true });

  // Split into paths and flags. Only the flags are hashed into the stamp —
  // see sourcesHashFor. `needsBoost` stands in for the -I below, so that
  // switching a solver's boost dependency on or off still invalidates while
  // the machine-specific path does not.
  const flagArgs = [
    // Optional wasm SIMD (needs no cross-origin isolation): SM_SIMD=1.
    ...(process.env.SM_SIMD === "1" ? ["-msimd128"] : []),
    // `-m64`, not `-sMEMORY64=1`: emscripten 6.0.0 made the standard compiler
    // flag an alias for the setting, and 6.0.4 warns that the setting is
    // deprecated. Needs emsdk >= 6.0.0 — on older toolchains `-m64` is ignored
    // and you silently get a wasm32 build under a mem64 name.
    ...(memory64 ? ["-m64"] : []),
    ...extraArgs,
    "-std=c++23",
    "-O3",
    "-s",
    "WASM=1",
    "-s",
    "MODULARIZE=1",
    "-s",
    `EXPORT_NAME=${exportName}`,
    "-s",
    "ENVIRONMENT=web,worker",
    "-s",
    "ALLOW_MEMORY_GROWTH=1",
    "-s",
    "INITIAL_MEMORY=16777216",
    // Deep drag-space searches on the largest puzzles can grow past wasm's
    // default 2GB ceiling; allow more (full wasm32 range, or beyond on wasm64).
    "-s",
    `MAXIMUM_MEMORY=${maxMemory}`,
    "--bind",
    "-flto",
    "-fno-exceptions",
  ];

  const args = [
    ...sources.map(s => resolve(aStarDir, s)),
    "-o",
    resolve(outDir, outputJs),
    ...(needsBoost && boostInclude ? ["-I", boostInclude] : []),
    ...flagArgs,
  ];

  // An LTO build of these TUs costs minutes, and `bun run build`, `bun run
  // test` and both CI workflows all pay for all eight variants. Skip the ones
  // whose inputs have not moved.
  // `astar.mjs.stamp`, deliberately not `.astar.mjs.stamp`: actions/upload-artifact
  // v4+ drops hidden files unless told otherwise, and a stamp that silently
  // fails to travel with its binary would make the CI dist job try to compile.
  const stampPath = resolve(outDir, `${outputJs}.stamp`);
  const wasmPath = resolve(outDir, outputJs.replace(/\.mjs$/, ".wasm"));
  const hash = sourcesHashFor(aStarDir, sources, [
    outputJs,
    String(needsBoost),
    ...flagArgs,
  ]);

  if (!forceRebuild && existsSync(resolve(outDir, outputJs)) && existsSync(wasmPath)) {
    const stamp = readStamp(stampPath);
    if (stamp?.sourcesHash === hash) {
      const version = emccVersion();
      if (version === stamp.emccVersion) {
        console.log(`em++ skip: ${outputJs} (up to date)`);
        return;
      }
      if (version === "") {
        // No compiler to compare against. The sources match, so the output is
        // almost certainly the right one — but say so, because "no emsdk" must
        // never look identical to "verified current".
        console.warn(
          `em++ skip: ${outputJs} (up to date; em++ not on PATH, ` +
            `compiler version NOT verified)`,
        );
        return;
      }
    }
  }

  const proc = Bun.spawn([requireEmcc(), ...args], {
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`em++ exited with code ${exitCode}`);
  }

  const stamp: Stamp = { sourcesHash: hash, emccVersion: emccVersion() };
  writeFileSync(stampPath, JSON.stringify(stamp));
}

// The rolling-blocks variants mirror the shifting-mosaic set below: same
// TUs, differing only in output name / memory model / -pthread. threads =
// in-module arm race on cross-origin isolated pages; mem64 = 8GB heap
// ceiling where the runtime can load Memory64.
const ROLLING_BLOCKS_VARIANTS = [
  { outputJs: "astar.mjs" },
  { outputJs: "astar.threads.mjs", threads: true },
  { outputJs: "astar.mem64.mjs", memory64: true },
  { outputJs: "astar.threads.mem64.mjs", threads: true, memory64: true },
] as const;

await Promise.all(
  ROLLING_BLOCKS_VARIANTS.map(variant =>
    build({
      aStarDir: resolve(projectRoot, "src/pages/rolling-blocks-solver/a-star"),
      outDir: resolve(projectRoot, "src/pages/rolling-blocks-solver/wasm"),
      sources: [
        "wasm_bindings.cpp",
        "AStar.cpp",
        "AStarGoals.cpp",
        "AStarOptimizer.cpp",
        "SearchCracker.cpp",
        "SearchBeam.cpp",
        "SolverArms.cpp",
        "Block.cpp",
        "SolverClock.cpp",
        "Replay.cpp",
      ],
      outputJs: variant.outputJs,
      exportName: "createAStarModule",
      needsBoost: true,
      memory64: "memory64" in variant,
      maxMemory: "memory64" in variant ? "8GB" : "4GB",
      extraArgs:
        "threads" in variant ? ["-pthread", "-sPTHREAD_POOL_SIZE=10"] : [],
    }),
  ),
);

// The four shifting-mosaic variants compile the SAME translation units and
// differ only in output name / memory model / -pthread, so they are listed
// once and built concurrently — serially they cost 4x the wall clock of the
// slowest one, and `bun run build` and `bun test` both pay for all of them.
//   - threads:       cross-origin isolated pages (the coi-serviceworker shim
//                    supplies COOP/COEP on GitHub Pages). Its cascade races the
//                    solver arms on real threads inside one module.
//   - mem64:         single-threaded with an 8GB heap ceiling instead of the
//                    4GB wasm32 wall. The flat drag / hier / unit arms keep
//                    every expanded node's state resident (~2.4KB/node), so on
//                    the hardest boards they hit the 4GB wall and ABORT at ~25%
//                    of their time budget (measured, IIT-21); this build lets
//                    them run the whole budget. The bridge prefers it in the
//                    multi-worker portfolio when the runtime supports
//                    (non-shared) Memory64 — browsers behind a flag today, node
//                    natively; bun cannot load it yet.
//   - threads+mem64: the primary isolated path with an 8GB SHARED heap. This is
//                    where a bigger heap matters most — all 8 cascade arms race
//                    inside ONE shared heap. Shared 64-bit memory is a distinct
//                    capability from the single-threaded build's non-shared
//                    one, so the bridge gates it on its own validate probe and
//                    falls back to the wasm32 threads build.
const SHIFTING_MOSAIC_VARIANTS = [
  { outputJs: "astar.mjs" },
  { outputJs: "astar.threads.mjs", threads: true },
  { outputJs: "astar.mem64.mjs", memory64: true },
  { outputJs: "astar.threads.mem64.mjs", threads: true, memory64: true },
] as const;

await Promise.all(
  SHIFTING_MOSAIC_VARIANTS.map(variant =>
    build({
      aStarDir: resolve(projectRoot, "src/pages/shifting-mosaic-solver/a-star"),
      outDir: resolve(projectRoot, "src/pages/shifting-mosaic-solver/wasm"),
      // AStar and DragSolver are each split across several .cpp files purely
      // for file size; every one of them is part of the same class.
      sources: [
        "wasm_bindings.cpp",
        "SolverClock.cpp",
        "AStar.cpp",
        "AStarHeuristics.cpp",
        "AStarSearch.cpp",
        "AStarOptimizer.cpp",
        "DragSolver.cpp",
        "DragSolverHeuristics.cpp",
        "DragSolverSearch.cpp",
        "DragSolverExpand.cpp",
        "DragSolverAssembly.cpp",
        "DragSolverArms.cpp",
        "DragSolverBeam.cpp",
      ],
      outputJs: variant.outputJs,
      exportName: "createShiftingMosaicAStarModule",
      needsBoost: false,
      memory64: "memory64" in variant,
      maxMemory: "memory64" in variant ? "8GB" : "4GB",
      extraArgs:
        "threads" in variant ? ["-pthread", "-sPTHREAD_POOL_SIZE=10"] : [],
    }),
  ),
);

// Match-three's four variants. Same shape as the other two solvers; what each
// one buys here is specific:
//   - threads:       six arms race inside one module on a cross-origin isolated
//                    page. All of them share one Bounds, so a find by the
//                    greedy arm immediately caps what the provers have to do.
//   - mem64:         the bounded failed-state table means this build no longer
//                    rescues a search from aborting — it lets the table hold
//                    more before it starts evicting, which is the difference
//                    between re-searching a subtree and remembering it.
//   - threads+mem64: both, and the one that matters most: six tables share the
//                    heap, so the 4GB wall arrives six times sooner.
// FixtureIo.cpp and GenerateCommands.cpp are deliberately absent — they need
// nlohmann and exceptions, and this build has neither.
const MATCH_THREE_VARIANTS = [
  { outputJs: "astar.mjs" },
  { outputJs: "astar.threads.mjs", threads: true },
  { outputJs: "astar.mem64.mjs", memory64: true },
  { outputJs: "astar.threads.mem64.mjs", threads: true, memory64: true },
] as const;

await Promise.all(
  MATCH_THREE_VARIANTS.map(variant =>
    build({
      aStarDir: resolve(projectRoot, "src/pages/match-three-solver/a-star"),
      outDir: resolve(projectRoot, "src/pages/match-three-solver/wasm"),
      // Keep in sync with match_three_core in that directory's CMakeLists.txt,
      // which lists the same TUs plus the native-only fixture I/O.
      sources: [
        "wasm_bindings.cpp",
        "Rules.cpp",
        "Replay.cpp",
        "SearchProver.cpp",
        "SearchGreedy.cpp",
        "SearchBeam.cpp",
        "SolverArms.cpp",
        "SolverClock.cpp",
      ],
      outputJs: variant.outputJs,
      exportName: "createMatchThreeModule",
      needsBoost: false,
      memory64: "memory64" in variant,
      maxMemory: "memory64" in variant ? "8GB" : "4GB",
      extraArgs:
        "threads" in variant ? ["-pthread", "-sPTHREAD_POOL_SIZE=10"] : [],
    }),
  ),
);
