import { describe, expect, test } from "bun:test";
import {
  intInRange,
  readGridSize,
} from "../src/util/configValidation";

describe("intInRange", () => {
  test.each([
    [1, 1, 10],
    [10, 1, 10],
    [5, 1, 10],
    [0, 0, 0],
    [-3, -5, 0],
  ])("accepts %p within [%p, %p]", (value, min, max) => {
    expect(intInRange(value, min, max)).toBeTrue();
  });

  test.each([
    ["below the range", 0],
    ["above the range", 11],
    ["a fraction", 2.5],
    ["a numeric string", "3"],
    ["null", null],
    ["undefined", undefined],
    ["NaN", NaN],
    ["Infinity", Infinity],
  ])("rejects %s", (_name, value) => {
    expect(intInRange(value, 1, 10)).toBeFalse();
  });
});

describe("readGridSize", () => {
  test("reads both dimensions off a well-formed config", () => {
    const result = readGridSize(
      { gridWidth: 4, gridHeight: 7, cells: [] },
      32,
    );
    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    // Only the two dimensions — the rest of the config is the page's business.
    expect(result.config).toEqual({ gridWidth: 4, gridHeight: 7 });
  });

  test.each([
    ["a non-object", 42],
    ["null", null],
  ])("rejects %s before looking for dimensions", (_name, data) => {
    const result = readGridSize(data, 32);
    expect(result.ok).toBeFalse();
    if (result.ok) return;
    expect(result.error).toBe("Config must be a JSON object.");
  });

  /**
   * The messages are part of the download format's contract — the pages' own
   * tests assert them verbatim — so they are pinned here at the source.
   */
  test.each([
    ["gridWidth", { gridWidth: 0, gridHeight: 4 }],
    ["gridWidth", { gridWidth: 2.5, gridHeight: 4 }],
    ["gridWidth", { gridWidth: 33, gridHeight: 4 }],
    ["gridWidth", { gridHeight: 4 }],
    ["gridHeight", { gridWidth: 4, gridHeight: 0 }],
    ["gridHeight", { gridWidth: 4, gridHeight: 33 }],
    ["gridHeight", { gridWidth: 4 }],
  ])("names %s when it is unusable", (key, data) => {
    const result = readGridSize(data, 32);
    expect(result.ok).toBeFalse();
    if (result.ok) return;
    expect(result.error).toBe(
      `${key} must be an integer between 1 and 32.`,
    );
  });

  /** The width is reported first, so one message names one problem. */
  test("reports the width when both are wrong", () => {
    const result = readGridSize({ gridWidth: 0, gridHeight: 0 }, 32);
    expect(result.ok).toBeFalse();
    if (result.ok) return;
    expect(result.error).toContain("gridWidth");
  });

  test("the cap is the caller's, not a constant here", () => {
    expect(readGridSize({ gridWidth: 40, gridHeight: 4 }, 64).ok).toBeTrue();
    expect(readGridSize({ gridWidth: 40, gridHeight: 4 }, 32).ok).toBeFalse();
  });
});
