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

await build({
  aStarDir: resolve(projectRoot, "src/pages/shifting-mosaic-solver/a-star"),
  outDir: resolve(projectRoot, "src/pages/shifting-mosaic-solver/wasm"),
  sources: ["wasm_bindings.cpp", "AStar.cpp", "DragSolver.cpp"],
  outputJs: "astar.mjs",
  exportName: "createShiftingMosaicAStarModule",
  needsBoost: false,
});

// pthreads variant: used when the page is cross-origin isolated (the
// coi-serviceworker shim provides COOP/COEP on GitHub Pages). Its cascade
// races the solver arms on real threads inside one module.
await build({
  aStarDir: resolve(projectRoot, "src/pages/shifting-mosaic-solver/a-star"),
  outDir: resolve(projectRoot, "src/pages/shifting-mosaic-solver/wasm"),
  sources: ["wasm_bindings.cpp", "AStar.cpp", "DragSolver.cpp"],
  outputJs: "astar.threads.mjs",
  exportName: "createShiftingMosaicAStarModule",
  needsBoost: false,
  extraArgs: ["-pthread", "-sPTHREAD_POOL_SIZE=10"],
});

// MEMORY64 variant: single-threaded, but with an 8GB heap ceiling instead of
// the 4GB wasm32 wall. The flat drag / hier / unit arms keep every expanded
// node's state resident (~2.4KB/node), so on the hardest boards they hit the
// 4GB wall and ABORT at ~25% of their time budget (measured, IIT-21). This
// build lets those arms run their whole budget. The bridge prefers it in the
// multi-worker portfolio (non-isolated fallback) when the runtime supports
// (non-shared) Memory64 — browsers behind a flag today, node natively; bun
// cannot load it yet — and falls back to the wasm32 build otherwise.
await build({
  aStarDir: resolve(projectRoot, "src/pages/shifting-mosaic-solver/a-star"),
  outDir: resolve(projectRoot, "src/pages/shifting-mosaic-solver/wasm"),
  sources: ["wasm_bindings.cpp", "AStar.cpp", "DragSolver.cpp"],
  outputJs: "astar.mem64.mjs",
  exportName: "createShiftingMosaicAStarModule",
  needsBoost: false,
  memory64: true,
  maxMemory: "8GB",
});

// pthreads + MEMORY64 variant: the primary (cross-origin isolated) path with
// an 8GB SHARED heap instead of the 4GB one. This is where a bigger heap
// matters most — all 8 cascade arms race inside ONE shared heap, so on the
// isolated path 4GB is split across them and the deep arms hit the wall
// soonest. Uses a shared 64-bit memory (a different capability from the
// single-threaded mem64 build's non-shared one), so the bridge gates it on a
// SHARED-memory64 validate probe and falls back to the wasm32 threads build.
await build({
  aStarDir: resolve(projectRoot, "src/pages/shifting-mosaic-solver/a-star"),
  outDir: resolve(projectRoot, "src/pages/shifting-mosaic-solver/wasm"),
  sources: ["wasm_bindings.cpp", "AStar.cpp", "DragSolver.cpp"],
  outputJs: "astar.threads.mem64.mjs",
  exportName: "createShiftingMosaicAStarModule",
  needsBoost: false,
  memory64: true,
  maxMemory: "8GB",
  extraArgs: ["-pthread", "-sPTHREAD_POOL_SIZE=10"],
});
