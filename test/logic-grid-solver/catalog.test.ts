import { describe, expect, test } from "bun:test";
import { RULE_COUNT, RULES, ruleAt } from "../../src/pages/logic-grid-solver/rules";
import {
  MIN_AREA_VALUE,
  parseSymbolValue,
  SYMBOL_KIND_COUNT,
  SYMBOL_KINDS,
  symbolKindAt,
  symbolValueError,
} from "../../src/pages/logic-grid-solver/symbols";

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
];

const SYMBOL_ORDER: [number, string][] = [
  [0, "area"],
  [1, "letter"],
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

describe("symbolValueError", () => {
  const area = symbolKindAt(0)!;
  const letter = symbolKindAt(1)!;

  test("accepts an area inside the board", () => {
    expect(symbolValueError(area, MIN_AREA_VALUE, 25)).toBeNull();
    expect(symbolValueError(area, 25, 25)).toBeNull();
  });

  test("an area of zero is not a region", () => {
    expect(symbolValueError(area, 0, 25)).toBe(
      "Area number values must be integers between 1 and 25.",
    );
  });

  test("an area cannot name more cells than the board has", () => {
    expect(symbolValueError(area, 26, 25)).not.toBeNull();
  });

  test("an area must be a whole number, not a string", () => {
    expect(symbolValueError(area, 2.5, 25)).not.toBeNull();
    expect(symbolValueError(area, "3", 25)).not.toBeNull();
  });

  test("accepts a single upper-case letter", () => {
    expect(symbolValueError(letter, "A", 25)).toBeNull();
    expect(symbolValueError(letter, "Z", 25)).toBeNull();
  });

  test("rejects lower case, multiple letters and non-letters", () => {
    for (const value of ["a", "AB", "", "1", 1]) {
      expect(symbolValueError(letter, value, 25)).toBe(
        "Letter values must be a single letter from A to Z.",
      );
    }
  });
});

describe("parseSymbolValue", () => {
  const area = symbolKindAt(0)!;
  const letter = symbolKindAt(1)!;

  test("reads a number for an area and upper-cases a letter", () => {
    expect(parseSymbolValue(area, " 12 ", 25)).toBe(12);
    expect(parseSymbolValue(letter, "b", 25)).toBe("B");
  });

  /** A half-typed field must stamp nothing rather than stamping a guess. */
  test("returns null for anything the kind cannot use", () => {
    expect(parseSymbolValue(area, "", 25)).toBeNull();
    expect(parseSymbolValue(area, "-", 25)).toBeNull();
    expect(parseSymbolValue(area, "99", 25)).toBeNull();
    expect(parseSymbolValue(letter, "", 25)).toBeNull();
    expect(parseSymbolValue(letter, "AB", 25)).toBeNull();
  });
});
