import { describe, expect, test } from "bun:test";
import { Direction } from "../../src/pages/rolling-blocks-solver/directions";
import type { Turn } from "../../src/pages/rolling-blocks-solver/turn";
import type { BFSTest, Tile } from "../../src/util/types";

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

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

async function loadWasmModule() {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const wasmDir = join(__dirname, "../../src/pages/rolling-blocks-solver/wasm");
  const wasmPath = join(wasmDir, "astar.mjs");
  const wasmBinPath = join(wasmDir, "astar.wasm");
  const createModule = (await import(wasmPath)).default;
  const wasmBinary = readFileSync(wasmBinPath);
  return createModule({
    locateFile(file: string) {
      if (file.endsWith(".wasm")) {
        return wasmBinPath;
      }
      return file;
    },
    wasmBinary,
  });
}

describe.if(Bun.env.ROLLING_BLOCKS_TEST === "true")("BFS", () => {
  const solvableCases = [
    ["bfsTest.json"],
    ["bfsTest1.json"],
    ["bfsTest2.json"],
    ["bfsTest3.json"],
    ["bfsTest4.json"],
    ["bfsTest5.json"],
    ["bfsTest6.json"],
    ["bfsTest7.json"],
    ["bfsTest8.json"],
    ["bfsTest9.json"],
    ["bfsTest10.json"],
    ["bfsTest11.json"],
    ["bfsTest12.json"],
    ["bfsTest13.json"],
    ["bfsTest14.json"],
    ["bfsTest15.json"],
    ["bfsTest16.json"],
    ["bfsTest17.json"],
    ["bfsTest18.json"],
    ["bfsTest19.json"],
    ["bfsTest20.json"],
    ["bfsTest21.json"],
    ["bfsTest22.json"],
    ["bfsTest23.json"],
    ["bfsTest24.json"],
    ["bfsTest25.json"],
    ["bfsTest26.json"],
    ["bfsTest27.json"],
    ["bfsTest28.json"],
    ["bfsTest29.json"],
    ["bfsTest30.json"],
  ];

  describe("Search", () => {
    test.each(solvableCases)("should solve %s", async filename => {
      const data: BFSTest = await Bun.file(
        `${import.meta.dir}/../resources/${filename}`,
      ).json();

      const flatCells: number[] = new Array(data.gridWidth * data.gridHeight);
      for (let x = 0; x < data.gridWidth; x++) {
        for (let y = 0; y < data.gridHeight; y++) {
          flatCells[x + y * data.gridWidth] = TILE_MAP[data.cells[x]![y]!];
        }
      }

      const blocks = data.blocks.map(b => ({
        id: b.id,
        x: b.x,
        y: b.y,
        width: b.width,
        depth: b.depth,
        height: b.height,
      }));

      const module = await loadWasmModule();
      const result = module.search(
        data.gridWidth,
        data.gridHeight,
        flatCells,
        blocks,
        2,
      );

      const turns: Turn[] = [];
      for (let i = 0; i < result.length; i++) {
        turns.push({
          blockId: result[i].blockId,
          direction: DIRECTION_MAP[result[i].direction]!,
        });
      }

      // Validate that the solution is non-empty and consists of valid moves
      expect(Array.isArray(turns)).toBe(true);
      expect(turns.length).toBeGreaterThan(0);
      for (const move of turns) {
        expect(typeof move.blockId).toBe("number");
        expect(Object.values(Direction)).toContain(move.direction);
      }

      // Optionally, check that applying the moves solves the puzzle (not implemented here)
    });
  });
});
