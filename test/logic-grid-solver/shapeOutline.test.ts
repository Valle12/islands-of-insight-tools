import { describe, expect, test } from "bun:test";
import {
  outlinePath,
  type OutlineGeometry,
} from "../../src/pages/logic-grid-solver/shapeOutline";

/**
 * The outline of a merged cell. Square sizes here are chosen so every corner
 * lands on a whole number and the path can be compared exactly: a 10px square
 * with a 4px gap gives a pitch of 14 and a half-gap of 2.
 */
// `stroke: 0` so the traced corners are the footprint's own, with no inset to
// account for; the inset is exercised on its own at the bottom.
const GEOMETRY: OutlineGeometry = { cell: 10, gap: 4, radius: 0, stroke: 0 };

/** Every corner the path visits, in order, as "x,y". */
function points(path: string): string[] {
  return [...path.matchAll(/[ML]([-\d.]+) ([-\d.]+)/g)].map(
    m => `${m[1]},${m[2]}`,
  );
}

describe("outlinePath", () => {
  test("a single square is its own rectangle", () => {
    // Not a merged cell in practice, but it pins the coordinate system: the
    // square at (0,0) spans 0..10 with nothing grown, because it has no mates.
    expect(points(outlinePath([0], 4, GEOMETRY)).sort()).toEqual(
      ["0,0", "10,0", "10,10", "0,10"].sort(),
    );
  });

  /**
   * The join is the whole point: two squares 4px apart come out as ONE
   * rectangle 24 wide, with no edge at the seam. Each grew half the gap towards
   * the other, so they meet exactly at x = 12.
   */
  test("two squares side by side are one rectangle", () => {
    const path = outlinePath([0, 1], 4, GEOMETRY);
    expect(points(path).sort()).toEqual(
      ["0,0", "24,0", "24,10", "0,10"].sort(),
    );
  });

  test("a column joins the same way", () => {
    const path = outlinePath([0, 4], 4, GEOMETRY);
    expect(points(path).sort()).toEqual(
      ["0,0", "10,0", "10,24", "0,24"].sort(),
    );
  });

  /**
   * An L keeps a clean right angle where it turns, rather than a notch: the
   * little square between the three is reached by the corner square's growth on
   * both sides and by nothing else, which is exactly the polyomino's own inner
   * corner.
   */
  test("an L turns a square inner corner", () => {
    const path = outlinePath([0, 1, 4], 4, GEOMETRY);
    expect(points(path).sort()).toEqual(
      ["0,0", "24,0", "24,10", "10,10", "10,24", "0,24"].sort(),
    );
  });

  /** A 2x2 fills the little square between its four members. */
  test("a 2x2 block is one square with no hole", () => {
    const path = outlinePath([0, 1, 4, 5], 4, GEOMETRY);
    expect(points(path).sort()).toEqual(
      ["0,0", "24,0", "24,24", "0,24"].sort(),
    );
  });

  /**
   * A ring has two loops — the outside and the hole — and both have to be in
   * the path, or the middle would be filled in.
   */
  test("a ring keeps its hole", () => {
    const ring = [0, 1, 2, 5, 7, 10, 11, 12];
    const path = outlinePath(ring, 5, GEOMETRY);
    expect(path.match(/Z/g)).toHaveLength(2);
    // The hole is the middle square plus the gaps around it, (10,10)..(28,28).
    expect(points(path)).toContain("10,10");
    expect(points(path)).toContain("28,28");
  });

  test("convex corners round and concave ones stay square", () => {
    const rounded = outlinePath([0, 1, 4], 4, { ...GEOMETRY, radius: 3 });
    // Six corners on an L, five of them convex; the inner one is not rounded,
    // so exactly five arcs.
    expect(rounded.match(/A/g)).toHaveLength(5);
    expect(outlinePath([0, 1, 4], 4, GEOMETRY).match(/A/g)).toBeNull();
  });

  test("a radius never eats more than half of the side it sits on", () => {
    // Radius 40 on a 10px square: every arc is clamped to 5.
    const path = outlinePath([0], 4, { ...GEOMETRY, radius: 40 });
    for (const [, r] of path.matchAll(/A([-\d.]+) /g)) {
      expect(Number(r)).toBeLessThanOrEqual(5);
    }
  });

  test("the last column does not wrap into the next row", () => {
    // (3,0) and (0,1) are adjacent as flat indices but not on the board.
    const path = outlinePath([3, 4], 4, GEOMETRY);
    expect(path.match(/Z/g)).toHaveLength(2);
  });

  /**
   * An SVG stroke straddles its path, so the path is pulled half a stroke
   * inside the footprint — which puts the rim exactly where a CSS border sits
   * on a plain square, rather than half a pixel further out.
   */
  test("the path sits half a stroke inside the footprint", () => {
    const path = outlinePath([0], 4, { ...GEOMETRY, stroke: 1 });
    expect(points(path).sort()).toEqual(
      ["0.5,0.5", "9.5,0.5", "9.5,9.5", "0.5,9.5"].sort(),
    );
  });
});
