import { describe, expect, test } from "bun:test";
import { Block } from "../../src/pages/rolling-blocks-solver/block";
import { Direction } from "../../src/pages/rolling-blocks-solver/directions";
import type { Turn } from "../../src/pages/rolling-blocks-solver/turn";
import type { RollingBlocksTest, Tile } from "../../src/util/types";
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

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { instantiateFromDisk } from "../../src/util/wasmModule";

async function loadWasmModule() {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const wasmDir = join(__dirname, "../../src/pages/rolling-blocks-solver/wasm");
  const wasmPath = join(wasmDir, "astar.mjs");
  const wasmBinPath = join(wasmDir, "astar.wasm");
  const createModule = (await import(wasmPath)).default;
  return createModule(instantiateFromDisk(wasmBinPath));
}

// The wasm `solve` puzzle shape: flat numeric cells + plain block records.
function toPuzzle(data: RollingBlocksTest) {
  const flatCells: number[] = new Array(data.gridWidth * data.gridHeight);
  for (let x = 0; x < data.gridWidth; x++) {
    for (let y = 0; y < data.gridHeight; y++) {
      flatCells[x + y * data.gridWidth] = TILE_MAP[data.cells[x]![y]!];
    }
  }
  return {
    gridWidth: data.gridWidth,
    gridHeight: data.gridHeight,
    cells: flatCells,
    blocks: data.blocks.map(b => ({
      id: b.id,
      x: b.x,
      y: b.y,
      width: b.width,
      depth: b.depth,
      height: b.height,
    })),
  };
}

describe.if(Bun.env.ROLLING_BLOCKS_TEST === "true")("Rolling Blocks A*", () => {
  const solvableCases = [
    ["rollingBlocksTest.json"],
    ["rollingBlocksTest1.json"],
    ["rollingBlocksTest2.json"],
    ["rollingBlocksTest3.json"],
    ["rollingBlocksTest4.json"],
    ["rollingBlocksTest5.json"],
    ["rollingBlocksTest6.json"],
    ["rollingBlocksTest7.json"],
    ["rollingBlocksTest8.json"],
    ["rollingBlocksTest9.json"],
    ["rollingBlocksTest10.json"],
    ["rollingBlocksTest11.json"],
    ["rollingBlocksTest12.json"],
    ["rollingBlocksTest13.json"],
    ["rollingBlocksTest14.json"],
    ["rollingBlocksTest15.json"],
    ["rollingBlocksTest16.json"],
    ["rollingBlocksTest17.json"],
    ["rollingBlocksTest18.json"],
    ["rollingBlocksTest19.json"],
    ["rollingBlocksTest20.json"],
    ["rollingBlocksTest21.json"],
    ["rollingBlocksTest22.json"],
    ["rollingBlocksTest23.json"],
    ["rollingBlocksTest24.json"],
    ["rollingBlocksTest25.json"],
    ["rollingBlocksTest26.json"],
    ["rollingBlocksTest27.json"],
    ["rollingBlocksTest28.json"],
    ["rollingBlocksTest29.json"],
    ["rollingBlocksTest30.json"],
    ["rollingBlocksTest31.json"],
    ["rollingBlocksTest32.json"],
    ["rollingBlocksTest33.json"],
    ["rollingBlocksTest34.json"],
    ["rollingBlocksTest35.json"],
    ["rollingBlocksTest36.json"],
    ["rollingBlocksTest37.json"],
    ["rollingBlocksTest38.json"],
    ["rollingBlocksTest39.json"],
  ];

  describe("Search", () => {
    // Explicit per-test timeout: the heavier boards (18/34/36) need far more
    // than bun's 5 s default under wasm.
    const SOLVE_TEST_TIMEOUT_MS = 120_000;
    test.each(solvableCases)(
      "should solve %s",
      async filename => {
      const data: RollingBlocksTest = await Bun.file(
        `${import.meta.dir}/../resources/rolling-blocks-solver/${filename}`,
      ).json();

      const module = await loadWasmModule();
      const result = module.solve(toPuzzle(data), {
        engine: "cascade",
        maxMs: 90_000,
      });
      expect(result.error).toBeUndefined();

      const turns: Turn[] = [];
      for (let i = 0; i < result.turns.length; i++) {
        turns.push({
          blockId: result.turns[i].blockId,
          direction: DIRECTION_MAP[result.turns[i].direction]!,
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
      },
      SOLVE_TEST_TIMEOUT_MS,
    );
  });

  describe("Budgets and caps", () => {
    test("maxNodes stops the search with stats and no turns", async () => {
      // Budget checks run on a 1024-expansion cadence; fixture 36 needs
      // orders of magnitude more than that, so maxNodes=1 stops at exactly
      // 1024 without finding anything.
      const data: RollingBlocksTest = await Bun.file(
        `${import.meta.dir}/../resources/rolling-blocks-solver/rollingBlocksTest36.json`,
      ).json();
      const module = await loadWasmModule();
      const result = module.solve(toPuzzle(data), {
        engine: "wastar",
        weight: 2,
        maxNodes: 1,
      });

      expect(result.error).toBeUndefined();
      expect(result.turns).toHaveLength(0);
      expect(result.stats.nodesExpanded).toBe(1024);
      expect(result.stats.statesStored).toBeGreaterThan(0);
      expect(result.stats.stoppedOnMemory).toBe(false);
    });

    test("a board beyond the engine caps returns a readable error", async () => {
      const module = await loadWasmModule();
      const result = module.solve(
        {
          gridWidth: 65,
          gridHeight: 5,
          cells: new Array(65 * 5).fill(0),
          blocks: [{ id: 1, x: 0, y: 0, width: 1, depth: 1, height: 1 }],
        },
        {},
      );
      expect(String(result.error)).toContain("64x64");
      expect(result.turns).toHaveLength(0);
    });
  });
});
