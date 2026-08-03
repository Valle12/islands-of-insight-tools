import { describe, expect, test } from "bun:test";
import {
  RULE_COUNT,
  RULE_DISPLAY_ORDER,
  RULES,
  ruleAt,
} from "../../src/pages/logic-grid-solver/rules";
import {
  DIRECTION_COUNT,
  DIRECTIONS,
  MIN_AREA_VALUE,
  parseSymbolValue,
  symbolDirectionError,
  SYMBOL_KIND_COUNT,
  SYMBOL_KINDS,
  symbolKindAt,
  symbolValueError,
  symbolValueMax,
} from "../../src/pages/logic-grid-solver/symbols";

/** A 5x5 board: 25 cells, and a longest line of 4 squares. */
const SIZE = { gridWidth: 5, gridHeight: 5 };

/**
 * Both catalogues are stored by INDEX, so their order is part of the file
 * format. The two tables below are what makes a reorder fail loudly instead of
 * silently rewriting every puzzle ever saved; appending a row is the only edit
 * either of them should ever need.
 */
const RULE_ORDER: [number, string][] = [
  [0, "no-dark-2x2"],
  [1, "no-light-2x2"],
  [2, "no-dark-1x2"],
  [3, "no-light-1x2"],
  [4, "no-dark-1x3"],
  [5, "no-light-1x3"],
  [6, "no-dark-1x4"],
  [7, "no-light-1x4"],
  [8, "no-dark-1x5"],
  [9, "no-light-1x5"],
  [10, "no-checkerboard"],
  [11, "connect-dark"],
  [12, "connect-light"],
  [13, "one-symbol-dark"],
  [14, "one-symbol-light"],
  [15, "underclued"],
  [16, "area-two-dark"],
  [17, "area-two-light"],
  [18, "area-four-dark"],
  [19, "area-four-light"],
];

/**
 * And what the ROW looks like, which is a different question with a different
 * answer — `area-two-dark` is stored at 16 and drawn at 13. This table may be
 * rewritten whenever the row should read differently; the one above may not.
 */
const ROW_ORDER: string[] = [
  "no-dark-2x2",
  "no-light-2x2",
  "no-dark-1x2",
  "no-light-1x2",
  "no-dark-1x3",
  "no-light-1x3",
  "no-dark-1x4",
  "no-light-1x4",
  "no-dark-1x5",
  "no-light-1x5",
  "no-checkerboard",
  "connect-dark",
  "connect-light",
  "area-two-dark",
  "area-two-light",
  "area-four-dark",
  "area-four-light",
  "one-symbol-dark",
  "one-symbol-light",
  "underclued",
];

const SYMBOL_ORDER: [number, string][] = [
  [0, "area"],
  [1, "letter"],
  [2, "dart"],
];

/** The four directions are stored by index too, so their order is frozen. */
const DIRECTION_ORDER: [number, string][] = [
  [0, "up"],
  [1, "right"],
  [2, "down"],
  [3, "left"],
];

describe("RULES", () => {
  test.each(RULE_ORDER)("index %i is still %s", (index, id) => {
    expect(ruleAt(index)?.id).toBe(id);
  });

  test("the pinned order covers every rule", () => {
    expect(RULE_COUNT).toBe(RULE_ORDER.length);
  });

  test("ids are unique and labels are non-empty", () => {
    expect(new Set(RULES.map(rule => rule.id)).size).toBe(RULE_COUNT);
    expect(RULES.every(rule => rule.label.trim() !== "")).toBeTrue();
  });

  test("an index past the end is undefined rather than a stand-in", () => {
    expect(ruleAt(RULE_COUNT)).toBeUndefined();
  });
});

describe("RULE_DISPLAY_ORDER", () => {
  test("draws the row in family order, not storage order", () => {
    expect(RULE_DISPLAY_ORDER.map(index => ruleAt(index)?.id)).toEqual(
      ROW_ORDER,
    );
  });

  test("shows every rule exactly once", () => {
    // The invariant that makes the indirection safe. Grouping is what builds
    // the list, so a rule can never be left out of it — but a group nobody
    // draws would drop its chips silently, and this is what says so.
    expect([...RULE_DISPLAY_ORDER].sort((a, b) => a - b)).toEqual([
      ...Array(RULE_COUNT).keys(),
    ]);
  });

  test("says nothing about where a rule is stored", () => {
    // Both halves of the point in one assertion: the row is not the file
    // format, and the file format is still append-only.
    expect(RULE_DISPLAY_ORDER).not.toEqual([...Array(RULE_COUNT).keys()]);
    expect(RULE_DISPLAY_ORDER.indexOf(16)).toBeLessThan(
      RULE_DISPLAY_ORDER.indexOf(15),
    );
  });
});

describe("SYMBOL_KINDS", () => {
  test.each(SYMBOL_ORDER)("index %i is still %s", (index, id) => {
    expect(symbolKindAt(index)?.id).toBe(id);
  });

  test("the pinned order covers every kind", () => {
    expect(SYMBOL_KIND_COUNT).toBe(SYMBOL_ORDER.length);
  });

  test("ids are unique, and every kind shows a sample glyph", () => {
    expect(new Set(SYMBOL_KINDS.map(kind => kind.id)).size).toBe(
      SYMBOL_KIND_COUNT,
    );
    expect(SYMBOL_KINDS.every(kind => kind.sample.length > 0)).toBeTrue();
  });
});

describe("DIRECTIONS", () => {
  test.each(DIRECTION_ORDER)("index %i is still %s", (index, id) => {
    expect(DIRECTIONS[index]?.id).toBe(id);
  });

  test("the pinned order covers every direction", () => {
    expect(DIRECTION_COUNT).toBe(DIRECTION_ORDER.length);
  });

  /**
   * The order is clockwise from up because that is what `nearestVertex` returns
   * for four sides, which is what lets a dragged arrow land on the right entry
   * with no translation table. Each step is also the offset it names.
   */
  test("reads clockwise from up, and each step is its own offset", () => {
    expect(DIRECTIONS.map(one => [one.dx, one.dy])).toEqual([
      [0, -1],
      [1, 0],
      [0, 1],
      [-1, 0],
    ]);
  });
});

describe("symbolValueMax", () => {
  test("an area is bounded by the board and a dart by its line", () => {
    expect(symbolValueMax(symbolKindAt(0)!, SIZE)).toBe(25);
    // The longest ray on a 5x5 leaves the dart's own square behind.
    expect(symbolValueMax(symbolKindAt(2)!, SIZE)).toBe(4);
    expect(
      symbolValueMax(symbolKindAt(2)!, { gridWidth: 3, gridHeight: 9 }),
    ).toBe(8);
  });
});

describe("symbolValueError", () => {
  const area = symbolKindAt(0)!;
  const letter = symbolKindAt(1)!;
  const dart = symbolKindAt(2)!;

  test("accepts an area inside the board", () => {
    expect(symbolValueError(area, MIN_AREA_VALUE, SIZE)).toBeNull();
    expect(symbolValueError(area, 25, SIZE)).toBeNull();
  });

  test("an area of zero is not a region", () => {
    expect(symbolValueError(area, 0, SIZE)).toBe(
      "Area number values must be integers between 1 and 25.",
    );
  });

  test("an area cannot name more cells than the board has", () => {
    expect(symbolValueError(area, 26, SIZE)).not.toBeNull();
  });

  test("an area must be a whole number, not a string", () => {
    expect(symbolValueError(area, 2.5, SIZE)).not.toBeNull();
    expect(symbolValueError(area, "3", SIZE)).not.toBeNull();
  });

  /** Zero is one of the two darts that fill in immediately, not a mistake. */
  test("a dart of zero is a real dart", () => {
    expect(symbolValueError(dart, 0, SIZE)).toBeNull();
  });

  test("a dart cannot name more squares than its line holds", () => {
    expect(symbolValueError(dart, 4, SIZE)).toBeNull();
    expect(symbolValueError(dart, 5, SIZE)).toBe(
      "Dart values must be integers between 0 and 4.",
    );
  });

  test("accepts a single upper-case letter", () => {
    expect(symbolValueError(letter, "A", SIZE)).toBeNull();
    expect(symbolValueError(letter, "Z", SIZE)).toBeNull();
  });

  test("rejects lower case, multiple letters and non-letters", () => {
    for (const value of ["a", "AB", "", "1", 1]) {
      expect(symbolValueError(letter, value, SIZE)).toBe(
        "Letter values must be a single letter from A to Z.",
      );
    }
  });
});

describe("symbolDirectionError", () => {
  const area = symbolKindAt(0)!;
  const dart = symbolKindAt(2)!;

  test("a directed kind takes one of the four", () => {
    for (let index = 0; index < DIRECTION_COUNT; index++) {
      expect(symbolDirectionError(dart, index)).toBeNull();
    }
  });

  test("a directed kind refuses a missing or unknown direction", () => {
    for (const value of [undefined, -1, DIRECTION_COUNT, 1.5, "up"]) {
      expect(symbolDirectionError(dart, value)).toBe(
        `Dart directions must be integers between 0 and ${DIRECTION_COUNT - 1}.`,
      );
    }
  });

  /**
   * Not merely ignored: a direction stored on a clue that never reads one
   * would look like part of the puzzle and change nothing about it.
   */
  test("an undirected kind refuses to carry one at all", () => {
    expect(symbolDirectionError(area, undefined)).toBeNull();
    expect(symbolDirectionError(area, 0)).toBe(
      "Only a directed symbol carries a direction, and Area number is not one.",
    );
  });
});

describe("parseSymbolValue", () => {
  const area = symbolKindAt(0)!;
  const letter = symbolKindAt(1)!;
  const dart = symbolKindAt(2)!;

  test("reads a number for an area and upper-cases a letter", () => {
    expect(parseSymbolValue(area, " 12 ", SIZE)).toBe(12);
    expect(parseSymbolValue(letter, "b", SIZE)).toBe("B");
  });

  test("reads a dart of zero, which an area could not be", () => {
    expect(parseSymbolValue(dart, "0", SIZE)).toBe(0);
    expect(parseSymbolValue(area, "0", SIZE)).toBeNull();
  });

  /** A half-typed field must stamp nothing rather than stamping a guess. */
  test("returns null for anything the kind cannot use", () => {
    expect(parseSymbolValue(area, "", SIZE)).toBeNull();
    expect(parseSymbolValue(area, "-", SIZE)).toBeNull();
    expect(parseSymbolValue(area, "99", SIZE)).toBeNull();
    expect(parseSymbolValue(letter, "", SIZE)).toBeNull();
    expect(parseSymbolValue(letter, "AB", SIZE)).toBeNull();
  });
});
