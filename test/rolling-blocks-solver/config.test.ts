import { describe, expect, test } from "bun:test";
import {
  MAX_BLOCKS,
  MAX_GRID_SIDE,
  validateConfig,
} from "../../src/pages/rolling-blocks-solver/config";
import type { Tile } from "../../src/util/types";

// A small, structurally valid config in the download/fixture format.
const VALID = {
  gridWidth: 4,
  gridHeight: 3,
  cells: [
    ["regular", "regular", "regular"],
    ["mustTouch", "regular", "goal"],
    ["regular", "unplayable", "goal"],
    ["regular", "regular", "regular"],
  ] as Tile[][],
  blocks: [
    { id: 1, x: 0, y: 0, width: 1, depth: 1, height: 2 },
    { id: 2, x: 3, y: 1, width: 1, depth: 2, height: 1 },
  ],
};

function clone(): typeof VALID {
  return JSON.parse(JSON.stringify(VALID));
}

describe("validateConfig (rolling blocks)", () => {
  test("accepts a well-formed config", () => {
    const result = validateConfig(clone());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.gridWidth).toBe(4);
      expect(result.config.cells[2]![1]).toBe("unplayable");
      expect(result.config.blocks).toHaveLength(2);
      expect(result.config.blocks[1]!.height).toBe(1);
    }
  });

  test("accepts a real downloaded fixture", async () => {
    const fixture = await Bun.file(
      `${import.meta.dir}/../resources/rolling-blocks-solver/rollingBlocksTest9.json`,
    ).json();
    const result = validateConfig(fixture);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.blocks).toHaveLength(2);
  });

  test("renumbers block ids to 1..n", () => {
    const a = clone();
    a.blocks[0]!.id = 7;
    a.blocks[1]!.id = 9;
    const result = validateConfig(a);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.blocks.map(b => b.id)).toEqual([1, 2]);
    }
  });

  test("rejects non-object input", () => {
    for (const bad of [null, 42, "text", [], undefined]) {
      expect(validateConfig(bad).ok).toBe(false);
    }
  });

  test("rejects grid sizes outside 1..64", () => {
    for (const size of [0, -1, MAX_GRID_SIDE + 1, 3.5]) {
      const a = clone();
      a.gridWidth = size;
      expect(validateConfig(a).ok).toBe(false);
      const b = clone();
      b.gridHeight = size;
      expect(validateConfig(b).ok).toBe(false);
    }
  });

  test("rejects a cells grid that does not match the dimensions", () => {
    const a = clone();
    a.cells = a.cells.slice(0, 3);
    expect(validateConfig(a).ok).toBe(false);

    const b = clone();
    b.cells[1] = b.cells[1]!.slice(0, 2);
    expect(validateConfig(b).ok).toBe(false);
  });

  test("rejects unknown tile values", () => {
    const a = clone();
    (a.cells[0] as string[])[0] = "lava";
    expect(validateConfig(a).ok).toBe(false);
  });

  test("rejects more than MAX_BLOCKS blocks", () => {
    const a = {
      gridWidth: 32,
      gridHeight: 32,
      cells: Array.from({ length: 32 }, () =>
        Array.from({ length: 32 }, () => "regular" as Tile),
      ),
      blocks: Array.from({ length: MAX_BLOCKS + 1 }, (_, i) => ({
        id: i + 1,
        x: i % 32,
        y: Math.floor(i / 32),
        width: 1,
        depth: 1,
        height: 1,
      })),
    };
    expect(validateConfig(a).ok).toBe(false);
  });

  test("rejects block dimensions outside 1..64", () => {
    for (const dim of ["width", "depth", "height"] as const) {
      for (const value of [0, 65, 2.5]) {
        const a = clone();
        a.blocks[0]![dim] = value;
        expect(validateConfig(a).ok).toBe(false);
      }
    }
  });

  test("rejects a block extending outside the grid", () => {
    const a = clone();
    a.blocks[0]!.x = 3;
    a.blocks[0]!.width = 2;
    expect(validateConfig(a).ok).toBe(false);
  });

  test("rejects a block on an unplayable cell", () => {
    const a = clone();
    a.blocks[0]!.x = 2;
    a.blocks[0]!.y = 1;
    expect(validateConfig(a).ok).toBe(false);
  });

  test("rejects overlapping blocks", () => {
    const a = clone();
    a.blocks[1]!.x = 0;
    a.blocks[1]!.y = 0;
    a.blocks[1]!.depth = 1;
    expect(validateConfig(a).ok).toBe(false);
  });

  test("accepts an empty blocks array (work-in-progress board)", () => {
    const a = clone();
    a.blocks = [];
    expect(validateConfig(a).ok).toBe(true);
  });

  test("ignores a turns key from captured fixtures", () => {
    const a = clone() as Record<string, unknown>;
    a.turns = [{ blockId: 1, direction: "UP" }];
    const result = validateConfig(a);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.turns).toBeUndefined();
  });
});
