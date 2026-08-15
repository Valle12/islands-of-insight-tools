// Shifting-mosaic solver worker: loads the requested wasm build variant and
// runs ONE solver arm off the main thread. Message in: { puzzle, config,
// variant } — see wasm_bindings.cpp::solve for the config schema (engine:
// unit | drag | hier | cascade | corridor | assembly | jam | beam; every field
// optional). The wasm itself posts {type:"progress"} and {type:"phase"} from
// this scope; this file posts the terminal {type:"done"|"error"}. The bridge
// identifies arms by Worker instance, so no message ids are needed.
//
// Everything that is not about shifting mosaic — the variant table, the
// fallback to the portable build, the error protocol — lives in
// ./astar.workerCore.js, copied in beside this file from src/util. This file
// is hand-written source in an otherwise generated directory; the astar*.mjs
// and .wasm beside it are em++ output and gitignored.
//
// The result is a bare sequence of turns rather than a struct: this solver's
// bindings return the plan directly, with no stats block.

import { plainArray, runSolverWorker } from "./astar.workerCore.js";

runSolverWorker(result => ({
  path: plainArray(result, turn => ({
    blockId: turn.blockId,
    direction: turn.direction,
  })),
}));
