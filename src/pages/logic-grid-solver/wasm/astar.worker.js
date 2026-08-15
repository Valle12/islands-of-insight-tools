// Logic-grid solver worker: loads the requested wasm build variant and runs
// one arm. Message in: { puzzle, config, variant }; messages out are progress
// (posted by the wasm module itself, which runs in this scope), then
// done { status, reason, cells, proven, decided, playable, witnesses, stats }
// or error.
//
// Everything that is not about the logic grid — the variant table, the
// fallback to the portable build, the error protocol — lives in
// ./astar.workerCore.js, copied in beside this file from src/util. This file
// is hand-written source in an otherwise generated directory; the astar*.mjs
// and .wasm beside it are em++ output and gitignored.
//
// This solver reports its own stats shape rather than the A* one, so it spells
// the block out instead of reaching for `plainSearchStats`.

import { plainArray, runSolverWorker } from "./astar.workerCore.js";

runSolverWorker(result => ({
  status: result.status,
  reason: result.reason,
  cells: plainArray(result.cells),
  proven: result.proven === true,
  decided: result.decided,
  playable: result.playable,
  witnesses: plainArray(result.witnesses, cells => plainArray(cells)),
  stats: result.stats
    ? {
        nodes: result.stats.nodes,
        refutations: result.stats.refutations,
        oracleRejections: result.stats.oracleRejections,
        stoppedOnMemory: result.stats.stoppedOnMemory,
        wallMs: result.stats.wallMs,
        arm: result.stats.arm,
      }
    : undefined,
}));
