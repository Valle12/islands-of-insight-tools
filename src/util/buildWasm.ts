import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dir, "../..");

const boostInclude =
  process.env.BOOST_INCLUDE ??
  (process.platform === "win32"
    ? String.raw`E:\packages\vcpkg\installed\x64-windows\include`
    : null);

const emcc = process.platform === "win32" ? "em++.bat" : "em++";

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
  // MEMORY64: 64-bit pointers, so the heap can exceed the 4GB wasm32 wall.
  // Only runtimes with the Memory64 proposal can load it (node yes; bun not
  // yet — the bridge feature-detects and falls back to the wasm32 build).
  memory64?: boolean;
}) {
  mkdirSync(outDir, { recursive: true });

  const args = [
    ...sources.map(s => resolve(aStarDir, s)),
    "-o",
    resolve(outDir, outputJs),
    ...(needsBoost && boostInclude ? ["-I", boostInclude] : []),
    // Optional wasm SIMD (needs no cross-origin isolation): SM_SIMD=1.
    ...(process.env.SM_SIMD === "1" ? ["-msimd128"] : []),
    ...(memory64 ? ["-s", "MEMORY64=1"] : []),
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

  const proc = Bun.spawn([emcc, ...args], {
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`em++ exited with code ${exitCode}`);
  }
}

await build({
  aStarDir: resolve(projectRoot, "src/pages/rolling-blocks-solver/a-star"),
  outDir: resolve(projectRoot, "src/pages/rolling-blocks-solver/wasm"),
  sources: ["wasm_bindings.cpp", "AStar.cpp", "Block.cpp"],
  outputJs: "astar.mjs",
  exportName: "createAStarModule",
  needsBoost: true,
});

// The four shifting-mosaic variants compile the SAME three translation units
// and differ only in output name / memory model / -pthread, so they are listed
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
      sources: ["wasm_bindings.cpp", "AStar.cpp", "DragSolver.cpp"],
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
