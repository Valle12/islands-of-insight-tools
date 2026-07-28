// A/B throughput benchmark for the shifting-mosaic wasm build (used to
// evaluate SM_SIMD=1 / -msimd128). Runs fixed-node-cap searches — they never
// solve, so wall time measures pure engine throughput, immune to
// solution-path luck. Compare runs against artifacts built with and without
// the flag:
//
//   bun run build:wasm             && bun run src/util/benchWasmSimd.ts
//   SM_SIMD=1 bun run build:wasm   && bun run src/util/benchWasmSimd.ts

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { instantiateFromDisk } from "./wasmModule";

const here = dirname(fileURLToPath(import.meta.url));
const wasmDir = join(here, "../pages/shifting-mosaic-solver/wasm");

async function loadModule() {
  const wasmPath = join(wasmDir, "astar.mjs");
  const wasmBinPath = join(wasmDir, "astar.wasm");
  const createModule = (await import(wasmPath)).default;
  return createModule(instantiateFromDisk(wasmBinPath));
}

const CASES: { name: string; fixture: string; config: Record<string, unknown> }[] = [
  {
    // Drag-engine throughput: flood fills + incremental scoring + PEA*.
    name: "drag@200k(test41)",
    fixture: "shiftingMosaicTest41.json",
    config: { engine: "drag", dragWeight: 4, settledOnly: true, pea: 64, maxMs: 0, maxNodes: 200_000, postProcess: false },
  },
  {
    // Unit-engine throughput: scalar cell-set collisions + heuristic stack.
    name: "unit@1M(test37)",
    fixture: "shiftingMosaicTest37.json",
    config: { engine: "unit", weight: 3, maxMs: 0, maxNodes: 1_000_000, postProcess: false },
  },
];
const REPS = 3;

for (const c of CASES) {
  const data = JSON.parse(
    readFileSync(join(here, "../../test/resources", c.fixture), "utf8"),
  );
  const puzzle = {
    gridWidth: data.gridWidth,
    gridHeight: data.gridHeight,
    shapes: data.shapes,
    initialAnchors: data.initialAnchors,
    goalIndex: data.goalIndex,
    goalAnchor: data.goalAnchor,
  };
  const times: number[] = [];
  for (let r = 0; r < REPS; r++) {
    // Fresh module per rep: identical heap layout, no cross-rep warmup bias.
    const module = await loadModule();
    const t0 = performance.now();
    module.solve(puzzle, c.config);
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  console.log(
    `${c.name}: median ${Math.round(times[Math.floor(REPS / 2)]!)}ms  (runs: ${times.map(t => Math.round(t)).join(", ")})`,
  );
}
