import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import {
  BLOCKED,
  symbolCell,
  EMPTY,
} from "../../src/pages/match-three-solver/cell";
import {
  MAX_GRID_SIDE,
  validateConfig,
} from "../../src/pages/match-three-solver/config";
import { SYMBOL_COUNT } from "../../src/pages/match-three-solver/symbols";
import type { MatchThreeCell } from "../../src/util/types";

const VALID = {
  gridWidth: 3,
  gridHeight: 2,
  cells: [
    [symbolCell(0), BLOCKED],
    [EMPTY, symbolCell(1)],
    [symbolCell(1), symbolCell(0)],
  ] as MatchThreeCell[][],
};

/** The highest legal cell value: every symbol the app knows. */
const MAX_CELL = symbolCell(SYMBOL_COUNT - 1);

function clone(): typeof VALID {
  return JSON.parse(JSON.stringify(VALID));
}

describe("Match three validateConfig", () => {
  test("accepts a hand-written valid config", () => {
    const result = validateConfig(clone());
    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    expect(result.config.cells[1]![1]).toBe(symbolCell(1));
  });

  test("accepts every symbol the app knows", () => {
    const result = validateConfig({
      gridWidth: 1,
      gridHeight: SYMBOL_COUNT,
      cells: [
        Array.from({ length: SYMBOL_COUNT }, (_, i) => symbolCell(i)),
      ],
    });
    expect(result.ok).toBeTrue();
  });

  // Discovered by listing, not enumerated: the fixtures are boards captured
  // from the game, so dropping another one in has to need no code change. The
  // validator checks the *file format* only — that a board is a state the game
  // could be in is the solver's business, and engine.test.ts checks it there.
  const FIXTURES = readdirSync(
    `${import.meta.dir}/../resources/match-three-solver`,
  ).filter(name => name.endsWith(".json"));

  test("there are captured boards to check", () => {
    expect(FIXTURES.length).toBeGreaterThan(0);
  });

  test.each(FIXTURES)("accepts captured board %s", async name => {
    const fixture = await Bun.file(
      `${import.meta.dir}/../resources/match-three-solver/${name}`,
    ).json();
    expect(validateConfig(fixture).ok).toBeTrue();
  });

  const rejections: [string, unknown, string][] = [
    ["a non-object", 42, "Config must be a JSON object."],
    ["null", null, "Config must be a JSON object."],
    [
      "a missing width",
      { ...clone(), gridWidth: undefined },
      `gridWidth must be an integer between 1 and ${MAX_GRID_SIDE}.`,
    ],
    [
      "a fractional width",
      { ...clone(), gridWidth: 2.5 },
      `gridWidth must be an integer between 1 and ${MAX_GRID_SIDE}.`,
    ],
    [
      "an oversized width",
      { ...clone(), gridWidth: MAX_GRID_SIDE + 1 },
      `gridWidth must be an integer between 1 and ${MAX_GRID_SIDE}.`,
    ],
    [
      "a zero height",
      { ...clone(), gridHeight: 0 },
      `gridHeight must be an integer between 1 and ${MAX_GRID_SIDE}.`,
    ],
    [
      "cells that are not an array",
      { ...clone(), cells: "nope" },
      "cells must be an array of 3 columns.",
    ],
    [
      "the wrong number of columns",
      { ...clone(), cells: [[0, 1]] },
      "cells must be an array of 3 columns.",
    ],
    [
      "a short column",
      { ...clone(), cells: [[0, 1], [0], [0, 1]] },
      "Every cells column must have 2 entries.",
    ],
    [
      "a cell that is not a number",
      { ...clone(), cells: [[0, "blocked"], [0, 1], [0, 1]] },
      `Cells must be integers between 0 and ${MAX_CELL} (0 empty, 1 blocked, 2+ symbols).`,
    ],
    [
      "a fractional cell",
      { ...clone(), cells: [[0, 1.5], [0, 1], [0, 1]] },
      `Cells must be integers between 0 and ${MAX_CELL} (0 empty, 1 blocked, 2+ symbols).`,
    ],
    [
      "a symbol index past the list",
      { ...clone(), cells: [[0, MAX_CELL + 1], [0, 1], [0, 1]] },
      `Cells must be integers between 0 and ${MAX_CELL} (0 empty, 1 blocked, 2+ symbols).`,
    ],
    [
      "a negative cell",
      { ...clone(), cells: [[0, -1], [0, 1], [0, 1]] },
      `Cells must be integers between 0 and ${MAX_CELL} (0 empty, 1 blocked, 2+ symbols).`,
    ],
  ];

  test.each(rejections)("rejects %s", (_name, input, error) => {
    const result = validateConfig(input);
    expect(result.ok).toBeFalse();
    if (result.ok) return;
    expect(result.error).toBe(error);
  });
});
