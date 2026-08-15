// Match-three solver worker: loads the requested wasm build variant and runs
// one arm. Message in: { puzzle, config, variant }; messages out are progress
// and best (posted by the wasm module itself, which runs in this scope), then
// done { moves, unsolvable, stats } or error.
//
// There is deliberately no per-arm "phase" message: wasmBridge.ts has no use
// for one — the page's phase readout comes from the TypeScript arm — and a
// message nobody reads is a contract nobody maintains. The native CLI still
// narrates arm starts through the same `Callbacks::onArmStart` hook.
//
// Everything that is not about match three — the variant table, the fallback
// to the portable build, the error protocol — lives in ./astar.workerCore.js,
// copied in beside this file from src/util. This file is hand-written source
// in an otherwise generated directory; the astar*.mjs and .wasm beside it are
// em++ output and gitignored.

import {
  plainArray,
  plainSearchStats,
  runSolverWorker,
} from "./astar.workerCore.js";

runSolverWorker(result => ({
  moves: plainArray(result.moves, move => ({
    a: { x: move.a.x, y: move.a.y },
    b: { x: move.b.x, y: move.b.y },
  })),
  unsolvable: result.unsolvable === true,
  stats: plainSearchStats(result.stats),
}));
