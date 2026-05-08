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

export interface WasmSearchCallbacks {
  onProgress?: (nodesExpanded: number) => void;
  onDone?: (path: Turn[]) => void;
  onError?: (error: string) => void;
}

export function searchWasm(
  gridWidth: number,
  gridHeight: number,
  cells: Tile[][],
  blocks: Block[],
  callbacks: WasmSearchCallbacks,
  weight = 2,
): Worker {
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

  const worker = new Worker("/astar.worker.js", { type: "module" });

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
      callbacks.onDone?.(path);
      worker.terminate();
    } else if (type === "error") {
      callbacks.onError?.(event.data.error);
      worker.terminate();
    }
  };

  worker.postMessage({
    gridWidth,
    gridHeight,
    cells: flatCells,
    blocks: blocksData,
    weight,
  });

  return worker;
}
