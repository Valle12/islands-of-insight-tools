// Rolling-blocks solver worker: loads the requested A* wasm build variant and
// runs one arm. Message in: { puzzle, config, variant }; messages out are
// progress and phase (posted by the wasm module itself, which runs in this
// scope), then done { path, stats } or error.
//
// Everything that is not about rolling blocks — the variant table, the
// fallback to the portable build, the error protocol — lives in
// ./astar.workerCore.js, copied in beside this file from src/util. This file
// is hand-written source in an otherwise generated directory; the astar*.mjs
// and .wasm beside it are em++ output and gitignored.

import {
  plainArray,
  plainSearchStats,
  runSolverWorker,
} from "./astar.workerCore.js";

runSolverWorker(result => ({
  path: plainArray(result.turns, turn => ({
    blockId: turn.blockId,
    direction: turn.direction,
  })),
  stats: plainSearchStats(result.stats),
}));
