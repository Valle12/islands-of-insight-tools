import { describe, expect, test } from "bun:test";
import { Block } from "../../src/pages/rolling-blocks-solver/block";
import { Direction } from "../../src/pages/rolling-blocks-solver/directions";
import type { Turn } from "../../src/pages/rolling-blocks-solver/turn";
import type { BFSTest, Tile } from "../../src/util/types";
import { extractBit, positionToIndex } from "../../src/util/utilMethods";

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

      const wasmBlocks = data.blocks.map(b => ({
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
        wasmBlocks,
        2,
      );

      const turns: Turn[] = [];
      for (let i = 0; i < result.length; i++) {
        turns.push({
          blockId: result[i].blockId,
          direction: DIRECTION_MAP[result[i].direction]!,
        });
      }

      expect(turns.length).toBeGreaterThan(0);

      const blocks = data.blocks.map(
        b => new Block(b.id, b.x, b.y, b.width, b.depth, b.height),
      );

      let mustTouchCellsSatisfied = 0n;
      for (const block of blocks) {
        mustTouchCellsSatisfied = block.updateMustTouchCells(
          data.gridWidth,
          data.cells,
          mustTouchCellsSatisfied,
        );
      }

      for (const turn of turns) {
        const block = blocks.find(b => b.id === turn.blockId)!;
        block.roll(turn.direction);
        expect(
          block.checkValidity(
            data.gridWidth,
            data.gridHeight,
            data.cells,
            blocks,
            mustTouchCellsSatisfied,
          ),
        ).toBe(true);
        mustTouchCellsSatisfied = block.updateMustTouchCells(
          data.gridWidth,
          data.cells,
          mustTouchCellsSatisfied,
        );
      }

      for (let x = 0; x < data.gridWidth; x++) {
        for (let y = 0; y < data.gridHeight; y++) {
          if (data.cells[x]![y] !== "mustTouch") continue;
          const index = positionToIndex(x, y, data.gridWidth);
          expect(extractBit(mustTouchCellsSatisfied, index)).toBe(1n);
        }
      }

      const goalIndices: Set<bigint> = new Set();
      for (let x = 0; x < data.gridWidth; x++) {
        for (let y = 0; y < data.gridHeight; y++) {
          if (data.cells[x]![y] === "goal") {
            goalIndices.add(positionToIndex(x, y, data.gridWidth));
          }
        }
      }

      if (goalIndices.size > 0) {
        const coveredGoals: Set<bigint> = new Set();
        for (const block of blocks) {
          let fullyOnGoals = true;
          for (let x = block.x; x < block.x + block.width && fullyOnGoals; x++) {
            for (let y = block.y; y < block.y + block.depth; y++) {
              if (data.cells[x]![y] !== "goal") {
                fullyOnGoals = false;
                break;
              }
            }
          }
          if (!fullyOnGoals) continue;
          for (let x = block.x; x < block.x + block.width; x++) {
            for (let y = block.y; y < block.y + block.depth; y++) {
              const idx = positionToIndex(x, y, data.gridWidth);
              if (goalIndices.has(idx)) coveredGoals.add(idx);
            }
          }
        }
        expect(coveredGoals.size).toBe(goalIndices.size);
      }
    });
  });
});
