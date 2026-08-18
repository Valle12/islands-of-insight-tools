import { describe, expect, test } from "bun:test";
import { readdirSync } from "fs";
import {
  CONFIG_VERSION,
  MAX_GRID_SIDE,
  migrationNotice,
  validateConfig,
} from "../../src/pages/logic-grid-solver/config";
import { RULE_COUNT, RULES } from "../../src/pages/logic-grid-solver/rules";
import { SYMBOL_KIND_COUNT } from "../../src/pages/logic-grid-solver/symbols";
import type { LogicGridTest } from "../../src/util/types";

const RESOURCE_DIR = `${import.meta.dir}/../resources/logic-grid-solver`;

describe("validateConfig (logic grid)", () => {
  /** 3x2, one clue of each kind, one gap, one rule of each shape. */
  const validConfig: LogicGridTest = {
    version: CONFIG_VERSION,
    gridWidth: 3,
    gridHeight: 2,
    rules: [0],
    runs: [{ color: "dark", length: 2 }],
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

  /**
   * Under "Numbers are off by one" every numeric clue displays its true count
   * ± 1, so a displayed ZERO is legal exactly when the file carries rule 32 —
   * and the same file without it is refused with the un-widened bounds.
   */
  test("a displayed zero needs the off-by-one rule", () => {
    const offByOne = RULES.findIndex(rule => rule.id === "off-by-one");
    const zeroed = {
      ...clone(),
      rules: [offByOne],
      symbols: [{ x: 0, y: 0, type: 0, value: 0 }],
    };
    const withRule = validateConfig(zeroed);
    expect(withRule.ok).toBeTrue();
    if (withRule.ok) {
      expect(withRule.config.symbols).toEqual([
        { x: 0, y: 0, type: 0, value: 0 },
      ]);
    }
    expect(validateConfig({ ...zeroed, rules: [] })).toEqual({
      ok: false,
      error: "Area number values must be integers between 1 and 6.",
    });
  });

  /** A galaxy is position and kind alone, and a value on one is refused by
   * the same generic net that covers the lotus. */
  test("a galaxy round-trips bare and refuses a value", () => {
    const galaxy = 5;
    const bare = {
      ...clone(),
      symbols: [{ x: 0, y: 0, type: galaxy }],
    };
    const result = validateConfig(bare);
    expect(result.ok).toBeTrue();
    if (result.ok) {
      expect(result.config.symbols).toEqual([{ x: 0, y: 0, type: galaxy }]);
    }
    expect(
      validateConfig({
        ...clone(),
        symbols: [{ x: 0, y: 0, type: galaxy, value: 0 }],
      }),
    ).toEqual({ ok: false, error: "Galaxy symbols carry no value." });
  });

  /**
   * A galaxy's center may sit on a grid line or a corner, so it carries a
   * seat — and unlike a lotus's it needs no merged cell under it. A seat of 0
   * is still omitted, the round-trip discipline every optional key follows.
   */
  test("a galaxy takes a seat with no merged cell, and omits seat 0", () => {
    const galaxy = 5;
    const seated = validateConfig({
      ...clone(),
      symbols: [{ x: 0, y: 0, type: galaxy, seat: 3 }],
    });
    expect(seated.ok).toBeTrue();
    if (seated.ok) {
      expect(seated.config.symbols).toEqual([
        { x: 0, y: 0, type: galaxy, seat: 3 },
      ]);
    }
    const centered = validateConfig({
      ...clone(),
      symbols: [{ x: 0, y: 0, type: galaxy, seat: 0 }],
    });
    expect(centered.ok).toBeTrue();
    if (centered.ok) {
      expect(centered.config.symbols).toEqual([{ x: 0, y: 0, type: galaxy }]);
    }
  });

  /** The seat has to be a real point OF the board: the squares it sits
   * between must exist. Whether they are PLAYABLE is deliberately not asked —
   * the solver names that board unsolvable instead. */
  test("a galaxy seat that runs off the board is refused", () => {
    const galaxy = 5;
    const config = clone();
    // The last playable square of the top row: a seat to its RIGHT has no
    // square to sit against. (The board's bottom-right corner is a gap, and a
    // clue on one is refused earlier for a different reason.)
    const edge = { x: config.gridWidth - 1, y: 0 };
    expect(
      validateConfig({
        ...config,
        symbols: [{ ...edge, type: galaxy, seat: 1 }],
      }),
    ).toEqual({
      ok: false,
      error: "Column 3, row 1 carries a seat the board does not surround.",
    });
    // ...while a seat DOWNWARD from the same square is a real point, so it is
    // accepted: the check is per direction, not per square.
    expect(
      validateConfig({
        ...config,
        symbols: [{ ...edge, type: galaxy, seat: 2 }],
      }).ok,
    ).toBeTrue();
    expect(
      validateConfig({
        ...config,
        symbols: [{ x: 0, y: 0, type: galaxy, seat: 4 }],
      }),
    ).toEqual({
      ok: false,
      error: "Galaxy seats must be integers between 0 and 3.",
    });
  });

  /** A LOTUS seat still needs one, which is the half that did not change. */
  test("a lotus seat still needs a merged cell", () => {
    const lotus = 3;
    expect(
      validateConfig({
        ...clone(),
        symbols: [{ x: 0, y: 0, type: lotus, direction: 0, seat: 1 }],
      }),
    ).toEqual({
      ok: false,
      error: "Column 1, row 1 carries a seat but no merged cell to sit in.",
    });
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
      "runs",
      "symbols",
      "version",
    ]);
  });

  /** The tag leads the file, so a reader can tell which shape it is in before
   * it has parsed anything that shape could have changed. */
  test("writes the version as the first key", () => {
    const result = validateConfig(clone());
    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    expect(Object.keys(result.config)[0]).toBe("version");
  });

  /**
   * Every board captured before the tag existed has no `version` key, and a
   * player's downloads folder is full of them. Absent means the FIRST version
   * — so such a file is old now, and comes back migrated and stamped with the
   * current tag.
   */
  test("reads a file with no version as version 1 and migrates it", () => {
    const result = validateConfig({
      gridWidth: 3,
      gridHeight: 2,
      rules: [0, 2],
      cells: [
        [1, 0],
        [2, 0],
        [0, 3],
      ],
      symbols: [],
    });
    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    expect(result.config.version).toBe(CONFIG_VERSION);
    expect(result.migratedFrom).toBe(1);
    expect(result.config.rules).toEqual([0]);
    expect(result.config.runs).toEqual([{ color: "dark", length: 2 }]);
  });

  test("reports nothing migrated for a file already current", () => {
    const result = validateConfig(clone());
    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    expect(result.migratedFrom).toBeUndefined();
  });

  /**
   * The version is read before a single structural check, so a file this build
   * cannot read says so instead of failing somewhere inside a shape that has
   * since changed meaning.
   */
  test("refuses a board from a newer build by name", () => {
    const result = validateConfig({ ...clone(), version: CONFIG_VERSION + 1 });
    expect(result.ok).toBeFalse();
    if (result.ok) return;
    expect(result.error).toBe(
      `This board is saved in format version ${CONFIG_VERSION + 1}, and this ` +
        `build reads up to version ${CONFIG_VERSION}. Update the page and ` +
        `load it again.`,
    );
  });

  test("refuses a version that is not a positive integer", () => {
    const result = validateConfig({ ...clone(), version: "1" });
    expect(result.ok).toBeFalse();
    if (result.ok) return;
    expect(result.error).toBe("version must be a positive integer.");
  });

  /**
   * The banner an out-of-date file gets — the editor's own test shows it on a
   * real upload; this pins the wording.
   */
  test("names both versions in the notice an out-of-date file gets", () => {
    expect(migrationNotice(1)).toBe(
      "This board was saved in format version 1 and has been updated to " +
        `version ${CONFIG_VERSION}. Download it again to save the file in ` +
        "the current format.",
    );
  });

  /** A canonical file, whatever order the rules were written in. */
  test("returns the rules sorted", () => {
    const result = validateConfig({ ...clone(), rules: [12, 1, 10] });
    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    expect(result.config.rules).toEqual([1, 10, 12]);
  });

  /** The sized lists come back canonical too: dark first, then value rising —
   * whatever order they were written in. */
  test("returns the sized lists in canonical order", () => {
    const result = validateConfig({
      ...clone(),
      // One area per color is all the family allows, so the value-within-
      // color half of "canonical" is `runs`' to prove.
      areas: [
        { color: "light", size: 3 },
        { color: "dark", size: 2 },
      ],
      runs: [
        { color: "light", length: 4 },
        { color: "dark", length: 5 },
        { color: "dark", length: 2 },
      ],
    });
    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    expect(result.config.areas).toEqual([
      { color: "dark", size: 2 },
      { color: "light", size: 3 },
    ]);
    expect(result.config.runs).toEqual([
      { color: "dark", length: 2 },
      { color: "dark", length: 5 },
      { color: "light", length: 4 },
    ]);
  });

  /** Two AREA sizes on one color hold together only where that color is
   * absent from the board — all zero of its regions being both sizes at once
   * — which is not a puzzle anyone means, so the family takes one per color
   * and the file is refused by name. */
  test("refuses two area sizes on one color", () => {
    const result = validateConfig({
      ...clone(),
      areas: [
        { color: "dark", size: 2 },
        { color: "dark", size: 3 },
      ],
    });
    expect(result.ok).toBeFalse();
    if (result.ok) return;
    expect(result.error).toBe(
      "Only one area rule per color is allowed, so the dark area cannot be both 2 and 3.",
    );
  });

  /** The RUN family is the other way round: two lengths on one color are two
   * separate bans, both enforceable and at worst redundant. */
  test("accepts several run lengths on one color", () => {
    const result = validateConfig({
      ...clone(),
      runs: [
        { color: "dark", length: 2 },
        { color: "dark", length: 4 },
      ],
    });
    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    expect(result.config.runs).toEqual([
      { color: "dark", length: 2 },
      { color: "dark", length: 4 },
    ]);
  });

  /** An area bigger than the board still loads: it is enforceable — the
   * color simply cannot appear — so refusing it here would make the
   * validator claim what only Solve can honestly say. */
  test("accepts an area larger than the board", () => {
    const result = validateConfig({
      ...clone(),
      areas: [{ color: "light", size: 9999 }],
    });
    expect(result.ok).toBeTrue();
  });

  /** The entry shape is exactly `{color, size}` / `{color, length}`: anything
   * else a hand-edited file carries is dropped, like unknown top-level keys. */
  test("strips unknown keys from sized entries", () => {
    const result = validateConfig({
      ...clone(),
      areas: [{ color: "dark", size: 2, notes: "hello" }],
    });
    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    expect(result.config.areas).toEqual([{ color: "dark", size: 2 }]);
  });

  /** Absent, not `[]` — the `shapes` discipline, and the corpus round-trip
   * below is what holds it. */
  test("omits an empty sized list", () => {
    const result = validateConfig({ ...clone(), areas: [], runs: [] });
    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    expect("areas" in result.config).toBeFalse();
    expect("runs" in result.config).toBeFalse();
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
      "a color past unplayable",
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
    [
      // Reachable only from a hand-edited file: the migration rewrote every
      // version 1 download, so the refusal points at the list it belongs in.
      "a sized rule index left in the flag list",
      { ...validConfig, rules: [16] },
      "Rule 16 is stored in the areas list in this format version.",
    ],
    [
      "a run rule spelled as its version 1 index",
      { ...validConfig, rules: [2] },
      "Rule 2 is stored in the runs list in this format version.",
    ],
    ["areas that are not a list", { ...validConfig, areas: 3 },
      "areas must be an array of area rules."],
    [
      "an area entry that is not an object",
      { ...validConfig, areas: ["dark"] },
      "Every areas entry must be a JSON object.",
    ],
    [
      "an area color outside the two",
      { ...validConfig, areas: [{ color: "red", size: 2 }] },
      'Area rule colors must be "dark" or "light".',
    ],
    [
      "an area of zero",
      { ...validConfig, areas: [{ color: "dark", size: 0 }] },
      "Area rule sizes must be integers between 1 and 9999.",
    ],
    [
      "a fractional area",
      { ...validConfig, areas: [{ color: "dark", size: 2.5 }] },
      "Area rule sizes must be integers between 1 and 9999.",
    ],
    [
      "an area past the format cap",
      { ...validConfig, areas: [{ color: "dark", size: 10000 }] },
      "Area rule sizes must be integers between 1 and 9999.",
    ],
    [
      "the same area rule twice",
      {
        ...validConfig,
        areas: [
          { color: "dark", size: 2 },
          { color: "dark", size: 2 },
        ],
      },
      "The dark area 2 rule is listed more than once.",
    ],
    ["runs that are not a list", { ...validConfig, runs: 3 },
      "runs must be an array of run rules."],
    [
      "a run of one",
      { ...validConfig, runs: [{ color: "dark", length: 1 }] },
      "Run rule lengths must be integers between 2 and 8.",
    ],
    [
      // Nine is the first length the engine cannot compile into a pattern,
      // and a rule it cannot enforce is refused rather than carried inertly.
      "a run past the engine's pattern cap",
      { ...validConfig, runs: [{ color: "light", length: 9 }] },
      "Run rule lengths must be integers between 2 and 8.",
    ],
    [
      "the same run rule twice",
      {
        ...validConfig,
        runs: [
          { color: "light", length: 3 },
          { color: "light", length: 3 },
        ],
      },
      "The light 1x3 rule is listed more than once.",
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
      // A galaxy's seat puts it BETWEEN squares, so two of them can share one
      // without sharing the square they are stored on. The game never shows
      // it and the editor refuses to place it, so a file carrying one is
      // refused by name rather than drawn as two pills through each other.
      "a seated galaxy running through another galaxy",
      {
        ...validConfig,
        symbols: [
          { x: 1, y: 0, type: 5 },
          { x: 0, y: 0, type: 5, seat: 1 },
        ],
      },
      "Column 1, row 1 carries a galaxy sharing a cell with another galaxy.",
    ],
    [
      "two seated galaxies sharing one square",
      {
        ...validConfig,
        symbols: [
          { x: 0, y: 0, type: 5, seat: 1 },
          { x: 1, y: 0, type: 5, seat: 1 },
        ],
      },
      "Column 2, row 1 carries a galaxy sharing a cell with another galaxy.",
    ],
    [
      // Two on different SQUARES of one merged cell are two centers of
      // rotational symmetry for one region, which no coloring can satisfy.
      "two galaxies in one merged cell",
      {
        ...validConfig,
        // Both squares of the cell one color, so the merged-cell color rule
        // does not answer first and hide the one under test.
        cells: [
          [1, 0],
          [1, 0],
          [0, 3],
        ],
        symbols: [
          { x: 0, y: 0, type: 5 },
          { x: 1, y: 0, type: 5 },
        ],
        shapes: [[0, 1]],
      },
      "Column 2, row 1 carries a galaxy sharing a cell with another galaxy.",
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
      "a merged cell painted in two colors",
      { ...validConfig, shapes: [[0, 3]] },
      "Column 1, row 2 is a different color from the rest of its merged cell.",
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
      // The first valueless kind: a number on it would look like part of the
      // puzzle and mean nothing.
      "a symmetry symbol carrying a value",
      {
        ...validConfig,
        symbols: [{ x: 0, y: 0, type: 3, value: 1, direction: 0 }],
      },
      "Symmetry symbols carry no value.",
    ],
    [
      "a symmetry symbol with no axis",
      { ...validConfig, symbols: [{ x: 0, y: 0, type: 3 }] },
      "Symmetry directions must be integers between 0 and 3.",
    ],
    [
      "a symmetry seat outside the four",
      {
        ...validConfig,
        symbols: [{ x: 0, y: 0, type: 3, direction: 0, seat: 4 }],
      },
      "Symmetry seats must be integers between 0 and 3.",
    ],
    [
      "a seat on a clue that has none",
      { ...validConfig, symbols: [{ x: 0, y: 0, type: 0, value: 1, seat: 1 }] },
      "Only a symmetry symbol carries a seat, and Area number is not one.",
    ],
    [
      // A diagonal axis through an edge midpoint would map square centers
      // onto square corners: there is no reflection on the grid to check.
      "a diagonal symmetry on a grid-line seat",
      {
        ...validConfig,
        symbols: [{ x: 0, y: 0, type: 3, direction: 1, seat: 1 }],
      },
      "A diagonal symmetry symbol cannot sit on a grid-line seat.",
    ],
    [
      "a seat with no merged cell to sit in",
      {
        ...validConfig,
        symbols: [{ x: 0, y: 0, type: 3, direction: 0, seat: 2 }],
      },
      "Column 1, row 1 carries a seat but no merged cell to sit in.",
    ],
    [
      // Seat 2 is the midpoint of the edge BELOW, and this cell lies along
      // the bottom row: there is no square beyond the seam to share it.
      "a seat its merged cell does not surround",
      {
        ...validConfig,
        symbols: [{ x: 0, y: 1, type: 3, direction: 0, seat: 2 }],
        shapes: [[3, 4]],
      },
      "Column 1, row 2 carries a seat its merged cell does not surround.",
    ],
    [
      // Its own square always counts, so there is no viewpoint of zero.
      "a viewpoint of zero",
      { ...validConfig, symbols: [{ x: 0, y: 0, type: 4, value: 0 }] },
      "Viewpoint values must be integers between 1 and 4.",
    ],
    [
      // Bounded by the CROSS — the row and the column, the own square counted
      // once — which on this 3x2 board is four.
      "a viewpoint seeing past its whole cross",
      { ...validConfig, symbols: [{ x: 0, y: 0, type: 4, value: 5 }] },
      "Viewpoint values must be integers between 1 and 4.",
    ],
    [
      "a direction on a viewpoint",
      {
        ...validConfig,
        symbols: [{ x: 0, y: 0, type: 4, value: 2, direction: 1 }],
      },
      "Only a directed symbol carries a direction, and Viewpoint is not one.",
    ],
    [
      "a seat on a viewpoint",
      { ...validConfig, symbols: [{ x: 0, y: 0, type: 4, value: 2, seat: 1 }] },
      "Only a symmetry symbol carries a seat, and Viewpoint is not one.",
    ],
  ];

  test.each(rejections)("rejects %s", (_name, input, error) => {
    const result = validateConfig(input);
    expect(result.ok).toBeFalse();
    if (result.ok) return;
    expect(result.error).toBe(error);
  });

  test("accepts merged cells and keeps them", () => {
    // Squares 3 and 4 are the two uncolored ones in row 2: a merged cell has
    // to agree about its color, which is what the rejection below pins.
    const result = validateConfig({ ...clone(), shapes: [[3, 4]] });
    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    expect(result.config.shapes).toEqual([[3, 4]]);
  });

  /**
   * Which square of a merged cell a clue sits on is the player's own choice
   * and is kept exactly as written — for a dart it is where the line STARTS,
   * so a validator that moved one to a canonical square would load a different
   * puzzle from the file it was handed.
   */
  test("accepts a clue on any square of its merged cell", () => {
    const result = validateConfig({
      ...clone(),
      symbols: [{ x: 1, y: 1, type: 2, value: 1, direction: 1 }],
      shapes: [[3, 4]],
    });
    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    expect(result.config.symbols).toEqual([
      { x: 1, y: 1, type: 2, value: 1, direction: 1 },
    ]);
  });

  test("accepts several clues on one merged cell, one per square", () => {
    // The game's harder boards do exactly this — two darts on one domino. An
    // impossible combination (two different letters, say) still loads; the
    // SOLVER is what refuses it, with an honest unsolvable.
    const result = validateConfig({
      ...clone(),
      symbols: [
        { x: 0, y: 1, type: 2, value: 1, direction: 1 },
        { x: 1, y: 1, type: 2, value: 0, direction: 0 },
      ],
      shapes: [[3, 4]],
    });
    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    expect(result.config.symbols).toHaveLength(2);
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

  /** A number and nothing else: no direction, no seat — the four rays ARE the
   * clue, so the config carries only where it sits and what it must see. */
  test("accepts a viewpoint and keeps its number alone", () => {
    const result = validateConfig({
      ...clone(),
      symbols: [{ x: 0, y: 0, type: 4, value: 3 }],
    });
    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    expect(result.config.symbols).toEqual([{ x: 0, y: 0, type: 4, value: 3 }]);
  });

  /** No `value` key at all, and both new keys kept exactly as written: the
   * axis in `direction`, and the seat on the seam its cell really has. */
  test("accepts a symmetry symbol and keeps its axis and seat", () => {
    const result = validateConfig({
      ...clone(),
      symbols: [{ x: 0, y: 1, type: 3, direction: 2, seat: 1 }],
      shapes: [[3, 4]],
    });
    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    expect(result.config.symbols).toEqual([
      { x: 0, y: 1, type: 3, direction: 2, seat: 1 },
    ]);
  });

  /** A seat of 0 means the square's own center, which is what absent means —
   * so it normalizes back to absent, exactly as an empty `shapes` does. */
  test("normalizes a seat of zero back to absent", () => {
    const result = validateConfig({
      ...clone(),
      symbols: [{ x: 0, y: 0, type: 3, direction: 0, seat: 0 }],
    });
    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    expect(result.config.symbols).toEqual([
      { x: 0, y: 0, type: 3, direction: 0 },
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
   * has to normalize back to nothing rather than appear in the download.
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

describe("The v1 migration", () => {
  /** A version 1 file, as `currentConfig` wrote one back then. */
  const v1 = (rules: unknown) => ({
    version: 1,
    gridWidth: 3,
    gridHeight: 2,
    rules,
    cells: [
      [1, 0],
      [2, 0],
      [0, 3],
    ],
    symbols: [],
  });

  test("moves every sized index into its family, canonically", () => {
    // 16 dark area 2, 31 light area 3; 4 dark 1x3, 3 light 1x2 — written
    // shuffled, read back dark-first and rising.
    const result = validateConfig(v1([0, 16, 4, 31, 11, 3]));
    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    expect(result.migratedFrom).toBe(1);
    expect(result.config.version).toBe(CONFIG_VERSION);
    expect(result.config.rules).toEqual([0, 11]);
    expect(result.config.areas).toEqual([
      { color: "dark", size: 2 },
      { color: "light", size: 3 },
    ]);
    expect(result.config.runs).toEqual([
      { color: "dark", length: 3 },
      { color: "light", length: 2 },
    ]);
  });

  /** The migration is mechanical and does not guess: a v1 mask naming two dark
   * areas rewrites into two dark entries, and the validator — which runs after
   * it — names the contradiction. Naming both numbers is what makes the
   * message actionable, since only the author knows which was meant. */
  test("lets the validator name two area sizes a v1 mask carried", () => {
    // 16 dark area 2 and 47 dark area 24, both set in one v1 mask.
    const result = validateConfig(v1([16, 47]));
    expect(result.ok).toBeFalse();
    if (result.ok) return;
    expect(result.error).toBe(
      "Only one area rule per color is allowed, so the dark area cannot be both 2 and 24.",
    );
  });

  test("converts all 22 sized indices to the full family lists", () => {
    const sizedIndices = RULES.flatMap((rule, index) =>
      rule.sized ? [index] : [],
    );
    expect(sizedIndices).toHaveLength(22);

    // The eight RUN indices convert together, because that family keeps its
    // several-per-color lists.
    const runIndices = RULES.flatMap((rule, index) =>
      rule.sized?.family === "runs" ? [index] : [],
    );
    const runs = validateConfig(v1(runIndices));
    expect(runs.ok).toBeTrue();
    if (!runs.ok) return;
    expect(runs.config.rules).toEqual([]);
    const lengths = [2, 3, 4, 5];
    expect(runs.config.runs).toEqual([
      ...lengths.map(length => ({ color: "dark" as const, length })),
      ...lengths.map(length => ({ color: "light" as const, length })),
    ]);

    // The fourteen AREA indices convert one at a time, since two of them on
    // one color is exactly what the family no longer allows.
    for (const index of sizedIndices.filter(one => !runIndices.includes(one))) {
      const { family, color, value } = RULES[index]!.sized!;
      expect(family).toBe("areas");
      const result = validateConfig(v1([index]));
      expect(result.ok).toBeTrue();
      if (!result.ok) return;
      expect(result.config.rules).toEqual([]);
      expect(result.config.areas).toEqual([{ color, size: value }]);
    }
  });

  /** A migration runs before any structural check and must not guess: the
   * broken parts stay put, and the validator names them as it always did. */
  test("leaves a garbage rules value for the validator to name", () => {
    expect(validateConfig(v1("nope"))).toEqual({
      ok: false,
      error: "rules must be an array of rule indices.",
    });
  });

  test("leaves an unknown index beside the moved ones", () => {
    expect(validateConfig(v1([16, 99]))).toEqual({
      ok: false,
      error: `Rules must be integers between 0 and ${RULE_COUNT - 1}.`,
    });
  });

  /** Impossible from any writer, so the refusal only has to be honest — it
   * now names the family entry the index became, not the index. */
  test("a doubled sized index becomes a doubled family entry", () => {
    expect(validateConfig(v1([16, 16]))).toEqual({
      ok: false,
      error: "The dark area 2 rule is listed more than once.",
    });
  });

  /** v1 dropped keys it did not know, so a v1 file carrying `areas` was legal
   * and its value meant nothing — the migration discards it the same way
   * rather than merging junk into real data. */
  test("discards a version 1 file's own sized keys", () => {
    const result = validateConfig({
      ...v1([0]),
      areas: "junk",
      runs: [{ color: "dark", length: 9 }],
    });
    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    expect("areas" in result.config).toBeFalse();
    expect("runs" in result.config).toBeFalse();
  });
});

describe("The v2 migration", () => {
  /** A version 2 file, as `currentConfig` wrote one before the retirement. */
  const v2 = (rules: unknown) => ({
    version: 2,
    gridWidth: 3,
    gridHeight: 2,
    rules,
    cells: [
      [1, 0],
      [2, 0],
      [0, 3],
    ],
    symbols: [],
  });

  test("moves a retired arrangement into the patterns list", () => {
    // 28 no-dark-diagonal, beside two rules that stay.
    const result = validateConfig(v2([0, 28, 11]));
    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    expect(result.migratedFrom).toBe(2);
    expect(result.config.version).toBe(CONFIG_VERSION);
    expect(result.config.rules).toEqual([0, 11]);
    expect(result.config.patterns).toEqual([
      { width: 2, height: 2, cells: [1, 0, 0, 1] },
    ]);
  });

  test("converts all ten retired indices, one at a time", () => {
    const drawnIndices = RULES.flatMap((rule, index) =>
      rule.drawn ? [index] : [],
    );
    expect(drawnIndices).toHaveLength(10);
    for (const index of drawnIndices) {
      const result = validateConfig(v2([index]));
      expect(result.ok).toBeTrue();
      if (!result.ok) return;
      expect(result.config.rules).toEqual([]);
      expect(result.config.patterns).toHaveLength(1);
    }
  });

  test("writes several retired indices in canonical order", () => {
    // 49 the knight's move (2x3), 28 the diagonal (2x2) — the shorter first
    // however the file listed them.
    const result = validateConfig(v2([49, 28]));
    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    expect(result.config.patterns?.map(pattern => pattern.height)).toEqual([
      2, 3,
    ]);
  });

  /** The mirrored pair are DIFFERENT shapes — one names dark squares, the
   * other light — so a file with both keeps both. */
  test("keeps a retired pair's two colors apart", () => {
    const result = validateConfig(v2([28, 29]));
    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    expect(result.config.patterns).toHaveLength(2);
  });

  test("leaves an unknown index for the validator to name", () => {
    expect(validateConfig(v2([28, 99]))).toEqual({
      ok: false,
      error: `Rules must be integers between 0 and ${RULE_COUNT - 1}.`,
    });
  });

  /** v2 dropped keys it did not know, so a v2 file carrying `patterns` was
   * legal and its value meant nothing — discarded rather than merged, the
   * `areas`/`runs` precedent from the version before. */
  test("discards a version 2 file's own patterns key", () => {
    const result = validateConfig({ ...v2([0]), patterns: "junk" });
    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    expect("patterns" in result.config).toBeFalse();
  });

  /** Both steps run in order, so a version 1 file arrives at version 3 with
   * its sized indices in `areas`/`runs` AND its retired ones in `patterns`. */
  test("a version 1 file migrates through both steps", () => {
    const result = validateConfig({ ...v2([0, 16, 28]), version: 1 });
    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    expect(result.migratedFrom).toBe(1);
    expect(result.config.rules).toEqual([0]);
    expect(result.config.areas).toEqual([{ color: "dark", size: 2 }]);
    expect(result.config.patterns).toHaveLength(1);
  });
});

describe("Patterns", () => {
  /** A plain 2x2 board, which every case below hangs a `patterns` list on. */
  const base = () => ({
    version: CONFIG_VERSION,
    gridWidth: 2,
    gridHeight: 2,
    rules: [],
    cells: [
      [0, 0],
      [0, 0],
    ],
    symbols: [],
  });

  /** A board with whatever `patterns` value is under test. */
  const withPatterns = (patterns: unknown) => ({ ...base(), patterns });

  const square = { width: 2, height: 2, cells: [1, 1, 1, 1] };
  const knight = { width: 2, height: 3, cells: [1, 0, 0, 0, 0, 1] };

  test("accepts a drawn shape", () => {
    const result = validateConfig(withPatterns([square]));
    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    expect(result.config.patterns).toEqual([square]);
  });

  test("omits the key entirely when a board draws none", () => {
    const result = validateConfig(base());
    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    expect("patterns" in result.config).toBeFalse();
  });

  test("omits the key when the list is present but empty", () => {
    const result = validateConfig(withPatterns([]));
    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    expect("patterns" in result.config).toBeFalse();
  });

  /** Accepted in any order and canonicalized on output, the sized families'
   * asymmetry with the two C++ intakes — which refuse a disordered list. */
  test("sorts the list into canonical order", () => {
    const result = validateConfig(withPatterns([knight, square]));
    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    expect(result.config.patterns).toEqual([square, knight]);
  });

  /** By the shape's canonical key, so one rule cannot be carried twice
   * wearing two rotations — they forbid the same thing. */
  test("refuses a rotation of a shape already listed", () => {
    const turned = { width: 2, height: 3, cells: [0, 1, 0, 0, 1, 0] };
    expect(validateConfig(withPatterns([knight, turned]))).toEqual({
      ok: false,
      error: "A pattern is listed more than once.",
    });
  });

  test.each([
    ["patterns must be an array of forbidden patterns.", "nope"],
    ["Every patterns entry must be a JSON object.", [7]],
    [
      `Pattern sizes must be integers between 1 and ${MAX_GRID_SIDE}.`,
      [{ width: 0, height: 2, cells: [] }],
    ],
    [
      `Pattern sizes must be integers between 1 and ${MAX_GRID_SIDE}.`,
      [{ width: 33, height: 1, cells: [] }],
    ],
    [
      "A pattern's cells must hold one entry per square of its box.",
      [{ width: 2, height: 2, cells: [1, 1, 1] }],
    ],
    // Never a gap: a pattern names squares that must hold a COLOR.
    [
      "Pattern squares must be 0, 1 or 2.",
      [{ width: 2, height: 1, cells: [1, 3] }],
    ],
    [
      "A pattern must name at least one square.",
      [{ width: 2, height: 1, cells: [0, 0] }],
    ],
    [
      "A pattern's box must be trimmed to the squares it names.",
      [{ width: 2, height: 2, cells: [0, 0, 1, 1] }],
    ],
  ])("refuses with %s", (error, patterns) => {
    expect(validateConfig(withPatterns(patterns))).toEqual({
      ok: false,
      error,
    });
  });

  /** An INTERIOR blank row is ordinary — a knight's move has one — so only an
   * empty EDGE makes a box untrimmed. */
  test("accepts a blank row in the middle of a box", () => {
    expect(validateConfig(withPatterns([knight])).ok).toBeTrue();
  });

  test.each(
    RULES.flatMap((rule, index) => (rule.drawn ? [[rule.id, index]] : [])),
  )("refuses the retired index %s by name", (_id, index) => {
    expect(validateConfig({ ...base(), rules: [index] })).toEqual({
      ok: false,
      error: `Rule ${index} is stored in the patterns list in this format version.`,
    });
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
