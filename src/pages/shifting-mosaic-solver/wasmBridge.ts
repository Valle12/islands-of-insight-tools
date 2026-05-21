import type { Position } from "../../util/types";
import type { Turn } from "./turn";
import { Direction } from "./directions";

// Direction integers as encoded by the C++ `enum class Direction`.
const DIRECTION_MAP: Record<number, Direction> = {
  0: Direction.UP,
  1: Direction.RIGHT,
  2: Direction.DOWN,
  3: Direction.LEFT,
};

export interface WasmSearchCallbacks {
  onProgress?: (nodesExpanded: number) => void;
  onDone?: (path: Turn[]) => void;
  onError?: (error: string) => void;
}

export interface ShiftingMosaicPuzzle {
  gridWidth: number;
  gridHeight: number;
  shapes: Position[][];
  initialAnchors: Position[];
  goalIndex: number;
  goalAnchor: Position;
}

// Production solver config — matches the C++/native default that solves all
// 31 fixtures: weighted A* (w=3) + the full additive heuristic stack, stride
// auto-detection on.
const SOLVER_CONFIG = {
  weight: 3,
  deadlockPruning: true,
  maxMs: 60_000,
  maxNodes: 20_000_000,
  useIda: false,
  pathBlockerWeight: 1,
  boundaryWeight: 1,
  allWallsBfsBase: false,
  macroMoves: false,
  axisAwareWeight: 1,
  lpDisplacementWeight: 1,
  strideOverride: 0,
  // Shorten the found solution before handing it to the UI.
  postProcess: true,
};

/**
 * Spawns the WASM solver worker for a shifting-mosaic puzzle. Returns the
 * Worker so the caller can terminate() it if the user cancels.
 */
export function searchShiftingMosaicWasm(
  puzzle: ShiftingMosaicPuzzle,
  callbacks: WasmSearchCallbacks,
): Worker {
  const worker = new Worker("/sm-wasm/astar.worker.js", { type: "module" });

  worker.onmessage = (event: MessageEvent) => {
    const { type } = event.data;
    if (type === "progress") {
      callbacks.onProgress?.(event.data.progress);
    } else if (type === "done") {
      const path: Turn[] = event.data.path.map(
        (t: { blockId: number; direction: number }) => ({
          blockId: t.blockId,
          direction: DIRECTION_MAP[t.direction]!,
        }),
      );
      callbacks.onDone?.(path);
      worker.terminate();
    } else if (type === "error") {
      callbacks.onError?.(event.data.error);
      worker.terminate();
    }
  };

  worker.onerror = event => {
    callbacks.onError?.(event.message || "Worker failed to start");
    worker.terminate();
  };

  worker.postMessage({ ...puzzle, ...SOLVER_CONFIG });
  return worker;
}
