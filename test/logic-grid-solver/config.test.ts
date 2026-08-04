import { describe, expect, test } from "bun:test";
import { readdirSync } from "fs";
import {
  MAX_GRID_SIDE,
  validateConfig,
} from "../../src/pages/logic-grid-solver/config";
import { RULE_COUNT } from "../../src/pages/logic-grid-solver/rules";
import { SYMBOL_KIND_COUNT } from "../../src/pages/logic-grid-solver/symbols";
import type { LogicGridTest } from "../../src/util/types";

const RESOURCE_DIR = `${import.meta.dir}/../resources/logic-grid-solver`;

describe("validateConfig (logic grid)", () => {
  /** 3x2, one clue of each kind, one gap. */
  const validConfig: LogicGridTest = {
    gridWidth: 3,
    gridHeight: 2,
    rules: [0, 2],
    cells: [
      [1, 0],
      [2, 0],
      [0, 3],
    ],
    symbols: [
      { x: 0, y: 0, type: 0, value: 2 },
      { x: 1, y: 1, type: 1, value: "B" },
    ],
  };

  const clone = () => structuredClone(validConfig);

  test("accepts a well-formed config", () => {
    const result = validateConfig(clone());
    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    expect(result.config).toEqual(validConfig);
  });

  test("a board with no rules and no clues is still a board", () => {
    const result = validateConfig({
      gridWidth: 1,
      gridHeight: 1,
      rules: [],
      cells: [[0]],
      symbols: [],
    });
    expect(result.ok).toBeTrue();
  });

  /** The file format is what it validates; unknown keys are not part of it. */
  test("drops keys it does not know about", () => {
    const result = validateConfig({ ...clone(), notes: "hello" });
    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    expect(Object.keys(result.config).sort()).toEqual([
      "cells",
      "gridHeight",
      "gridWidth",
      "rules",
      "symbols",
    ]);
  });

  /** A canonical file, whatever order the rules were written in. */
  test("returns the rules sorted", () => {
    const result = validateConfig({ ...clone(), rules: [5, 1, 3] });
    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    expect(result.config.rules).toEqual([1, 3, 5]);
  });

  const rejections: [string, unknown, string][] = [
    ["a non-object", 42, "Config must be a JSON object."],
    ["null", null, "Config must be a JSON object."],
    [
      "a fractional width",
      { ...validConfig, gridWidth: 2.5 },
      `gridWidth must be an integer between 1 and ${MAX_GRID_SIDE}.`,
    ],
    [
      "an oversized height",
      { ...validConfig, gridHeight: MAX_GRID_SIDE + 1 },
      `gridHeight must be an integer between 1 and ${MAX_GRID_SIDE}.`,
    ],
    [
      "the wrong number of columns",
      { ...validConfig, cells: [[1, 0], [2, 0]] },
      "cells must be an array of 3 columns.",
    ],
    [
      "a short column",
      { ...validConfig, cells: [[1, 0], [2], [0, 3]] },
      "Every cells column must have 2 entries.",
    ],
    [
      "a colour past unplayable",
      { ...validConfig, cells: [[1, 0], [2, 0], [0, 4]] },
      "Cells must be integers between 0 and 3 (0 unknown, 1 dark, 2 light, 3 unplayable).",
    ],
    ["rules that are not a list", { ...validConfig, rules: 3 },
      "rules must be an array of rule indices."],
    [
      "a rule index this build does not know",
      { ...validConfig, rules: [RULE_COUNT] },
      `Rules must be integers between 0 and ${RULE_COUNT - 1}.`,
    ],
    [
      "the same rule twice",
      { ...validConfig, rules: [1, 1] },
      "Rule 1 is listed more than once.",
    ],
    ["symbols that are not a list", { ...validConfig, symbols: {} },
      "symbols must be an array."],
    [
      "a symbol that is not an object",
      { ...validConfig, symbols: ["area"] },
      "Every symbol must be a JSON object.",
    ],
    [
      "a symbol off the board",
      { ...validConfig, symbols: [{ x: 3, y: 0, type: 0, value: 1 }] },
      "Symbol coordinates must lie on the 3x2 board.",
    ],
    [
      "a symbol kind this build does not know",
      {
        ...validConfig,
        symbols: [{ x: 0, y: 0, type: SYMBOL_KIND_COUNT, value: 1 }],
      },
      `Symbol types must be integers between 0 and ${SYMBOL_KIND_COUNT - 1}.`,
    ],
    [
      "an area larger than the board",
      { ...validConfig, symbols: [{ x: 0, y: 0, type: 0, value: 7 }] },
      "Area number values must be integers between 1 and 6.",
    ],
    [
      "a letter that is not one letter",
      { ...validConfig, symbols: [{ x: 0, y: 0, type: 1, value: "AB" }] },
      "Letter values must be a single letter from A to Z.",
    ],
    [
      "two symbols on one cell",
      {
        ...validConfig,
        symbols: [
          { x: 0, y: 0, type: 0, value: 1 },
          { x: 0, y: 0, type: 1, value: "C" },
        ],
      },
      "Column 1, row 1 carries more than one symbol.",
    ],
    [
      "a symbol on a gap",
      { ...validConfig, symbols: [{ x: 2, y: 1, type: 0, value: 1 }] },
      "Column 3, row 2 is unplayable and cannot carry a symbol.",
    ],
    ["a non-array shapes", { ...validConfig, shapes: 3 }, "shapes must be an array."],
    [
      "a merged cell of one square",
      { ...validConfig, shapes: [[0]] },
      "Every merged cell must be an array of at least two squares.",
    ],
    [
      "a merged cell square off the board",
      { ...validConfig, shapes: [[0, 6]] },
      "Merged cell squares must be integers between 0 and 5.",
    ],
    [
      "a merged cell on a gap",
      { ...validConfig, shapes: [[4, 5]] },
      "Column 3, row 2 is unplayable and cannot be part of a merged cell.",
    ],
    [
      "a square in two merged cells",
      { ...validConfig, shapes: [[3, 4], [4, 3]] },
      "Column 2, row 2 belongs to more than one merged cell.",
    ],
    [
      "a square listed twice in one merged cell",
      { ...validConfig, shapes: [[0, 0]] },
      "Column 1, row 1 belongs to more than one merged cell.",
    ],
    [
      "a disconnected merged cell",
      { ...validConfig, shapes: [[0, 4]] },
      "Every merged cell must be one connected shape.",
    ],
    [
      "a merged cell painted in two colours",
      { ...validConfig, shapes: [[0, 3]] },
      "Column 1, row 2 is a different colour from the rest of its merged cell.",
    ],
    [
      "two symbols on one merged cell",
      {
        ...validConfig,
        symbols: [
          { x: 0, y: 1, type: 0, value: 2 },
          { x: 1, y: 1, type: 1, value: "B" },
        ],
        shapes: [[3, 4]],
      },
      "A merged cell carries more than one symbol.",
    ],
    [
      "a dart with no direction",
      { ...validConfig, symbols: [{ x: 0, y: 0, type: 2, value: 1 }] },
      "Dart directions must be integers between 0 and 3.",
    ],
    [
      "a dart aimed nowhere it could point",
      {
        ...validConfig,
        symbols: [{ x: 0, y: 0, type: 2, value: 1, direction: 4 }],
      },
      "Dart directions must be integers between 0 and 3.",
    ],
    [
      "a dart longer than the board's longest line",
      {
        ...validConfig,
        symbols: [{ x: 0, y: 0, type: 2, value: 3, direction: 1 }],
      },
      "Dart values must be integers between 0 and 2.",
    ],
    [
      "a direction on a clue that points nowhere",
      {
        ...validConfig,
        symbols: [{ x: 0, y: 0, type: 0, value: 1, direction: 1 }],
      },
      "Only a directed symbol carries a direction, and Area number is not one.",
    ],
    [
      // Where an undirected clue sits inside a merged cell is decoration and
      // the editor re-homes it on load; a dart's square is where its line
      // starts, so moving it would load a different puzzle.
      "a dart off its merged cell's anchor",
      {
        ...validConfig,
        symbols: [{ x: 1, y: 1, type: 2, value: 1, direction: 1 }],
        shapes: [[3, 4]],
      },
      "A directed symbol on a merged cell must sit on column 1, row 2.",
    ],
  ];

  test.each(rejections)("rejects %s", (_name, input, error) => {
    const result = validateConfig(input);
    expect(result.ok).toBeFalse();
    if (result.ok) return;
    expect(result.error).toBe(error);
  });

  test("accepts merged cells and keeps them", () => {
    // Squares 3 and 4 are the two uncoloured ones in row 2: a merged cell has
    // to agree about its colour, which is what the rejection below pins.
    const result = validateConfig({ ...clone(), shapes: [[3, 4]] });
    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    expect(result.config.shapes).toEqual([[3, 4]]);
  });

  test("accepts a dart and keeps the way it points", () => {
    const result = validateConfig({
      ...clone(),
      symbols: [{ x: 0, y: 0, type: 2, value: 2, direction: 3 }],
    });
    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    expect(result.config.symbols).toEqual([
      { x: 0, y: 0, type: 2, value: 2, direction: 3 },
    ]);
  });

  /**
   * The same rule the shapes key follows, and for the same reason: an
   * undirected clue that came back carrying `direction: 0` would break the
   * byte-identical round trip every captured board is held to below.
   */
  test("omits the direction key on a clue that points nowhere", () => {
    const result = validateConfig(clone());
    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    expect(result.config.symbols.every(one => !("direction" in one))).toBeTrue();
  });

  /**
   * Absent, not `[]`. Every captured fixture predates the key, and the sweep
   * below asserts they all still round-trip byte-identically — so an empty list
   * has to normalise back to nothing rather than appear in the download.
   */
  test("omits the shapes key when a board has none", () => {
    const result = validateConfig(clone());
    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    expect("shapes" in result.config).toBeFalse();

    const empty = validateConfig({ ...clone(), shapes: [] });
    expect(empty.ok).toBeTrue();
    if (!empty.ok) return;
    expect("shapes" in empty.config).toBeFalse();
  });
});

describe("Captured boards", () => {
  // Discovered by listing, not enumerated: the fixtures are boards captured
  // from the game, so dropping another one in has to need no code change.
  //
  // The directory holds ONLY real captures — anything a test invents lives in
  // `boards.ts` instead, so a made-up board cannot quietly pad this sweep.
  const FIXTURES = readdirSync(RESOURCE_DIR).filter(name =>
    name.endsWith(".json"),
  );

  test("there are captured boards to check", () => {
    expect(FIXTURES.length).toBeGreaterThan(0);
  });

  test.each(FIXTURES)("accepts captured board %s", async name => {
    const fixture = await Bun.file(`${RESOURCE_DIR}/${name}`).json();
    const result = validateConfig(fixture);
    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    // A fixture that round-trips is one the editor could have produced.
    expect(result.config).toEqual(fixture);
  });
});
