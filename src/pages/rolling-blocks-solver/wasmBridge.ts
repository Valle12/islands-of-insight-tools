import type { Tile } from "../../util/types";
import type { Block } from "./block";
import { Direction } from "./directions";
import type { Turn } from "./turn";

const TILE_MAP: Record<Tile, number> = {
  regular: 0,
  mustTouch: 1,
  goal: 2,
  unplayable: 3,
};

const DIRECTION_MAP: Record<number, Direction> = {
  0: Direction.UP,
  1: Direction.RIGHT,
  2: Direction.DOWN,
  3: Direction.LEFT,
};

// One solve = one worker for now; the handle hides that so the page keeps
// working unchanged when the portfolio (several racing workers) lands.
export interface SolverHandle {
  terminate(): void;
}

export interface SolveStats {
  nodesExpanded: number;
  statesStored: number;
  stoppedOnMemory: boolean;
  wallMs: number;
}

export interface SolveConfig {
  weight?: number;
  maxMs?: number;
  maxNodes?: number;
  maxStatesStored?: number;
  maxHeapBytes?: number;
  postProcess?: boolean;
}

export interface WasmSearchCallbacks {
  onProgress?: (nodesExpanded: number) => void;
  onDone?: (path: Turn[], stats?: SolveStats) => void;
  onError?: (error: string) => void;
}

export function searchRollingBlocksWasm(
  gridWidth: number,
  gridHeight: number,
  cells: Tile[][],
  blocks: Block[],
  callbacks: WasmSearchCallbacks,
  config: SolveConfig = {},
): SolverHandle {
  const flatCells: number[] = new Array(gridWidth * gridHeight);
  for (let x = 0; x < gridWidth; x++) {
    for (let y = 0; y < gridHeight; y++) {
      flatCells[x + y * gridWidth] = TILE_MAP[cells[x]![y]!];
    }
  }

  const blocksData = blocks.map(b => ({
    id: b.id,
    x: b.x,
    y: b.y,
    width: b.width,
    depth: b.depth,
    height: b.height,
  }));

  const worker = new Worker("../astar.worker.js", { type: "module" });

  worker.onmessage = (event: MessageEvent) => {
    const { type } = event.data;
    if (type === "progress") {
      callbacks.onProgress?.(event.data.progress);
    } else if (type === "done") {
      const path: Turn[] = event.data.path.map(
        (t: { blockId: number; direction: number }) => ({
          blockId: t.blockId,
          direction: DIRECTION_MAP[t.direction],
        }),
      );
      callbacks.onDone?.(path, event.data.stats);
      worker.terminate();
    } else if (type === "error") {
      callbacks.onError?.(event.data.error);
      worker.terminate();
    }
  };

  worker.postMessage({
    puzzle: {
      gridWidth,
      gridHeight,
      cells: flatCells,
      blocks: blocksData,
    },
    config,
  });

  return { terminate: () => worker.terminate() };
}
