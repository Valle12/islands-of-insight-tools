import { describe, expect, test } from "bun:test";
import { validateConfig } from "../../src/pages/shifting-mosaic-solver/config";
import type { ShiftingMosaicTest } from "../../src/util/types";

const VALID: ShiftingMosaicTest = {
  gridWidth: 4,
  gridHeight: 3,
  shapes: [
    [{ x: 0, y: 0 }],
    [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
    ],
  ],
  initialAnchors: [
    { x: 0, y: 0 },
    { x: 1, y: 1 },
  ],
  goalIndex: 0,
  goalAnchor: { x: 3, y: 0 },
};

function clone(): ShiftingMosaicTest {
  return JSON.parse(JSON.stringify(VALID));
}

describe("validateConfig", () => {
  test("accepts a well-formed config", () => {
    const result = validateConfig(clone());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config).toEqual(VALID);
  });

  test("accepts a JSON-parsed copy", () => {
    const result = validateConfig(JSON.parse(JSON.stringify(VALID)));
    expect(result.ok).toBe(true);
  });

  test("rejects non-object input", () => {
    for (const bad of [null, 42, "text", [], undefined]) {
      const result = validateConfig(bad);
      expect(result.ok).toBe(false);
    }
  });

  test("rejects a non-positive grid size", () => {
    const a = clone();
    a.gridWidth = 0;
    expect(validateConfig(a).ok).toBe(false);

    const b = clone();
    b.gridHeight = -2;
    expect(validateConfig(b).ok).toBe(false);
  });

  test("rejects a non-integer grid size", () => {
    const a = clone();
    (a as { gridWidth: number }).gridWidth = 4.5;
    expect(validateConfig(a).ok).toBe(false);
  });

  test("rejects missing or empty shapes", () => {
    const a = clone();
    (a as { shapes: unknown }).shapes = [];
    expect(validateConfig(a).ok).toBe(false);

    const b = clone();
    b.shapes[1] = [];
    expect(validateConfig(b).ok).toBe(false);
  });

  test("rejects a shape with a non-integer cell", () => {
    const a = clone();
    (a.shapes[0] as unknown[]) = [{ x: 0.5, y: 0 }];
    expect(validateConfig(a).ok).toBe(false);
  });

  test("rejects an initialAnchors length mismatch", () => {
    const a = clone();
    a.initialAnchors = [{ x: 0, y: 0 }];
    expect(validateConfig(a).ok).toBe(false);
  });

  test("rejects an out-of-range goalIndex", () => {
    const a = clone();
    a.goalIndex = 5;
    expect(validateConfig(a).ok).toBe(false);

    const b = clone();
    b.goalIndex = -1;
    expect(validateConfig(b).ok).toBe(false);
  });

  test("rejects a malformed goalAnchor", () => {
    const a = clone();
    (a as { goalAnchor: unknown }).goalAnchor = { x: 1 };
    expect(validateConfig(a).ok).toBe(false);
  });

  test("rejects a block that extends outside the grid", () => {
    const a = clone();
    a.initialAnchors[1] = { x: 3, y: 1 }; // 2-wide block would reach x=4
    const result = validateConfig(a);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("outside the grid");
  });

  test("rejects overlapping blocks", () => {
    const a = clone();
    a.initialAnchors[1] = { x: 0, y: 0 }; // collides with block 1 at (0,0)
    const result = validateConfig(a);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("overlaps");
  });

  test("rejects a goal zone that extends outside the grid", () => {
    const a = clone();
    a.goalAnchor = { x: 4, y: 0 };
    const result = validateConfig(a);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("goal zone");
  });
});
