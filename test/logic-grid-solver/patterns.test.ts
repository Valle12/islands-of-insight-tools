import { describe, expect, test } from "bun:test";
import { DARK, LIGHT, UNKNOWN } from "../../src/pages/logic-grid-solver/cell";
import {
  canonicalPatterns,
  comparePatterns,
  describePattern,
  dihedralImages,
  isTightBox,
  namesASquare,
  normalizePattern,
  patternFromPicture,
  patternKey,
} from "../../src/pages/logic-grid-solver/patterns";
import { RULES } from "../../src/pages/logic-grid-solver/rules";
import { toFlat, verifyLogicGrid } from "../../src/pages/logic-grid-solver/verify";
import { CONFIG_VERSION } from "../../src/pages/logic-grid-solver/config";
import type { LogicGridTest } from "../../src/util/types";

/** A pattern from a picture, which every case below is written as. */
const draw = patternFromPicture;

describe("normalizePattern", () => {
  test("trims a box down to the squares it names", () => {
    const trimmed = normalizePattern(draw(["...", ".D.", "..."]));
    expect(trimmed).toEqual({ width: 1, height: 1, cells: [DARK] });
  });

  test("keeps an interior blank row, which a knight's move has", () => {
    const trimmed = normalizePattern(draw(["....", ".D..", "....", "..D."]));
    expect(trimmed).toEqual({
      width: 2,
      height: 3,
      cells: [DARK, UNKNOWN, UNKNOWN, UNKNOWN, UNKNOWN, DARK],
    });
  });

  test("an untouched box comes back unchanged", () => {
    const pattern = draw(["DD", "DD"]);
    expect(normalizePattern(pattern)).toEqual(pattern);
  });

  test("a box that names nothing is not a pattern", () => {
    expect(normalizePattern(draw(["..", ".."]))).toBeNull();
  });
});

describe("isTightBox", () => {
  test("accepts a trimmed box", () => {
    expect(isTightBox(draw(["D.", ".D"]))).toBeTrue();
  });

  test("accepts an interior blank row", () => {
    expect(isTightBox(draw(["D.", "..", ".D"]))).toBeTrue();
  });

  test.each([
    ["a blank top row", ["..", "DD"]],
    ["a blank bottom row", ["DD", ".."]],
    ["a blank left column", [".D", ".D"]],
    ["a blank right column", ["D.", "D."]],
  ])("refuses %s", (_name, picture) => {
    expect(isTightBox(draw(picture))).toBeFalse();
  });

  test("a blank box names nothing and is not tight", () => {
    const blank = draw(["..", ".."]);
    expect(namesASquare(blank)).toBeFalse();
    expect(isTightBox(blank)).toBeFalse();
  });
});

describe("dihedralImages", () => {
  test("a chiral shape has all eight", () => {
    // The L-tetromino, which is exactly why the built-in rule emitted eight.
    expect(dihedralImages(draw(["D.", "D.", "DD"]))).toHaveLength(8);
  });

  test("a T has four, since its mirror is one of its rotations", () => {
    expect(dihedralImages(draw(["DDD", ".D."]))).toHaveLength(4);
  });

  test("a 2x2 block has one", () => {
    expect(dihedralImages(draw(["DD", "DD"]))).toHaveLength(1);
  });

  test("a checkerboard's images are BOTH colorings", () => {
    // Turning it ninety degrees swaps which diagonal is dark, which is what
    // made the two checkerboard patterns one rule all along.
    const images = dihedralImages(draw(["DL", "LD"]));
    expect(images).toHaveLength(2);
    expect(images.map(image => image.cells[0])).toEqual([DARK, LIGHT]);
  });

  test("every image keeps the squares it started with", () => {
    const named = (cells: number[]) =>
      cells.filter(square => square !== UNKNOWN).length;
    for (const image of dihedralImages(draw(["DLD", ".D."])))
      expect(named(image.cells)).toBe(4);
  });
});

describe("patternKey", () => {
  test("two rotations of one shape share it", () => {
    expect(patternKey(draw(["D.", "D.", "DD"]))).toBe(
      patternKey(draw(["DDD", "D.."])),
    );
  });

  test("a shape and its mirror share it", () => {
    expect(patternKey(draw(["D.", "D.", "DD"]))).toBe(
      patternKey(draw([".D", ".D", "DD"])),
    );
  });

  test("different shapes do not", () => {
    expect(patternKey(draw(["DD", "DD"]))).not.toBe(
      patternKey(draw(["LL", "LL"])),
    );
  });

  test("orders by height, then width, then squares", () => {
    const short = draw(["DD"]);
    const tall = draw(["D.", ".D"]);
    expect(comparePatterns(short, tall)).toBeLessThan(0);
    expect(comparePatterns(tall, short)).toBeGreaterThan(0);
    expect(comparePatterns(short, draw(["DD"]))).toBe(0);
  });
});

describe("canonicalPatterns", () => {
  test("sorts and drops a repeat wearing another rotation", () => {
    const sorted = canonicalPatterns([
      draw(["D.", "..", ".D"]),
      draw(["DD", "DD"]),
      // The same knight's move, turned.
      draw([".D", "..", "D."]),
    ]);
    expect(sorted).toHaveLength(2);
    expect(sorted.map(pattern => pattern.height)).toEqual([2, 3]);
  });

  test("hands back copies rather than the originals", () => {
    const original = draw(["DD", "DD"]);
    const [copy] = canonicalPatterns([original]);
    copy!.cells[0] = LIGHT;
    expect(original.cells[0]).toBe(DARK);
  });
});

describe("describePattern", () => {
  test("names the position and every square it holds", () => {
    expect(describePattern(draw(["D.", ".L"]), 3)).toBe(
      "Forbidden pattern 3, 2 by 2, dark at row 1 column 1, " +
        "light at row 2 column 2",
    );
  });

  test("borrows no name from a rule the shape happens to match", () => {
    // A drawn 2x2 shows only what was drawn — deliberately not "No dark 2x2",
    // which is a chip the row still carries and a different thing to store.
    expect(describePattern(draw(["DD", "DD"]), 1)).not.toContain("2x2");
  });
});

/**
 * The claim the format bump rests on, from this side: every retired rule's
 * stored shape forbids exactly what the rule forbade.
 *
 * Checked by exhaustive agreement rather than by inspection — every coloring
 * of a board big enough to hold the shape, judged twice: once with the rule
 * switched on as a flag, once with the shape carried as a drawing. The C++
 * suite asserts the same thing about the compiled table; between them, a
 * rewritten fixture cannot mean something new.
 */
describe("the retired arrangements", () => {
  const RETIRED = RULES.map((rule, index) => ({ rule, index })).filter(
    ({ rule }) => rule.drawn,
  );

  test("there are ten of them", () => {
    expect(RETIRED).toHaveLength(10);
  });

  test.each(RETIRED.map(({ rule, index }) => [rule.id, index] as const))(
    "%s forbids exactly what its shape does",
    (_id, index) => {
      const drawn = RULES[index]!.drawn!;
      const pattern = patternFromPicture(drawn.squares);
      // Four wide by four tall holds every one of the ten with room to spare,
      // and 2^16 colorings is a complete sweep.
      const gridWidth = 4;
      const gridHeight = 4;
      const board = (extra: Partial<LogicGridTest>): LogicGridTest => ({
        version: CONFIG_VERSION,
        gridWidth,
        gridHeight,
        rules: [],
        cells: [],
        symbols: [],
        ...extra,
      });
      // The rule is retired, so the config validator would refuse the index —
      // but `verifyLogicGrid` reads `config.rules` directly, which is what
      // makes asking it the old question still possible.
      const byRule = board({ rules: [index] });
      const byShape = board({ patterns: [pattern] });
      const cells = gridWidth * gridHeight;
      for (let mask = 0; mask < 1 << cells; mask++) {
        const column: number[][] = [];
        for (let x = 0; x < gridWidth; x++) {
          const rows: number[] = [];
          for (let y = 0; y < gridHeight; y++)
            rows.push((mask >> (y * gridWidth + x)) & 1 ? DARK : LIGHT);
          column.push(rows);
        }
        byRule.cells = column;
        byShape.cells = column;
        const flat = toFlat(byRule);
        const ruled = verifyLogicGrid(byRule, flat) !== "none";
        const drawnSays = verifyLogicGrid(byShape, flat) !== "none";
        if (ruled !== drawnSays) {
          throw new Error(
            `mask ${mask}: rule says ${String(ruled)}, shape says ${String(drawnSays)}`,
          );
        }
      }
    },
  );
});
