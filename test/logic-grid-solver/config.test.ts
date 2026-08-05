import { describe, expect, test } from "bun:test";
import { readdirSync } from "fs";
import {
  CONFIG_VERSION,
  MAX_GRID_SIDE,
  migrationNotice,
  validateConfig,
} from "../../src/pages/logic-grid-solver/config";
import { RULE_COUNT } from "../../src/pages/logic-grid-solver/rules";
import { SYMBOL_KIND_COUNT } from "../../src/pages/logic-grid-solver/symbols";
import type { LogicGridTest } from "../../src/util/types";

const RESOURCE_DIR = `${import.meta.dir}/../resources/logic-grid-solver`;

describe("validateConfig (logic grid)", () => {
  /** 3x2, one clue of each kind, one gap. */
  const validConfig: LogicGridTest = {
    version: CONFIG_VERSION,
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
   * player's downloads folder is full of them. Absent means the first version,
   * which is the current one — so such a file is not "old", and nothing is
   * reported as migrated.
   */
  test("accepts a file with no version and calls it current", () => {
    const { version, ...withoutVersion } = clone();
    expect(version).toBe(CONFIG_VERSION);
    const result = validateConfig(withoutVersion);
    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    expect(result.config.version).toBe(CONFIG_VERSION);
    expect(result.migratedFrom).toBeUndefined();
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
   * The banner an out-of-date file gets. Pinned here rather than through the
   * editor because no file can BE out of date until `MIGRATIONS` has an entry
   * — so the page's one `if` is all this cannot reach, and whoever writes the
   * first migration should cover it there.
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
      // A diagonal axis through an edge midpoint would map square centres
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

  /** A seat of 0 means the square's own centre, which is what absent means —
   * so it normalises back to absent, exactly as an empty `shapes` does. */
  test("normalises a seat of zero back to absent", () => {
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
