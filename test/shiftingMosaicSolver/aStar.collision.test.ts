import { describe, expect, test } from "bun:test";
import { AStar } from "../../src/pages/shifting-mosaic-solver/aStar";
import { Direction } from "../../src/pages/shifting-mosaic-solver/directions";
import { Node } from "../../src/pages/shifting-mosaic-solver/node";
import type { Turn } from "../../src/pages/shifting-mosaic-solver/turn";
import type { Position } from "../../src/util/types";

// NOTE: these tests cover the TypeScript reference AStar (used for unit-level
// checks of the individual primitives). The full 31-fixture solving suite
// runs against the production WASM solver in wasm.test.ts.

function makeAStar(
  gridWidth: number,
  gridHeight: number,
  shapes: Position[][],
  initialAnchors: Position[],
  goalIndex: number,
  goalAnchor: Position,
): AStar {
  return new AStar(
    gridWidth,
    gridHeight,
    shapes,
    initialAnchors,
    goalIndex,
    goalAnchor,
  );
}


function applyTurns(initialAnchors: Position[], turns: Turn[]): Position[] {
  const anchors = initialAnchors.map(a => ({ x: a.x, y: a.y }));
  for (const turn of turns) {
    const anchor = anchors[turn.blockId]!;
    switch (turn.direction) {
      case Direction.UP:
        anchor.y -= 1;
        break;
      case Direction.RIGHT:
        anchor.x += 1;
        break;
      case Direction.DOWN:
        anchor.y += 1;
        break;
      case Direction.LEFT:
        anchor.x -= 1;
        break;
    }
  }
  return anchors;
}

describe("AStar (shifting-mosaic)", () => {
  describe("BlocksCollide (cell-level)", () => {
    // "bboxes overlap, cells do not" is exactly what the next case asserts —
    // an earlier scratch attempt at it that never reached an assertion has
    // been dropped rather than left as an always-passing test.
    test("L-shape and single cell — bbox overlaps, cells overlap", () => {
      const shapes: Position[][] = [
        [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
          { x: 0, y: 1 },
        ],
        [{ x: 0, y: 0 }],
      ];
      const aStar = makeAStar(
        5,
        5,
        shapes,
        [
          { x: 0, y: 0 },
          { x: 0, y: 0 },
        ],
        0,
        { x: 0, y: 0 },
      );
      const internal = aStar as any;
      // Single cell sits at (1, 1) - matches no cell of L-shape (which has no (1,1))
      expect(
        internal.blocksCollide(0, { x: 0, y: 0 }, 1, { x: 1, y: 1 }),
      ).toBe(false);
      // bbox overlaps but cell (1,1) is not in L-shape
      expect(
        internal.boundingBoxesOverlap(0, { x: 0, y: 0 }, 1, { x: 1, y: 1 }),
      ).toBe(true);
    });

    test("two single-cell blocks at the same anchor collide", () => {
      const shapes: Position[][] = [[{ x: 0, y: 0 }], [{ x: 0, y: 0 }]];
      const aStar = makeAStar(
        5,
        5,
        shapes,
        [
          { x: 0, y: 0 },
          { x: 1, y: 1 },
        ],
        0,
        { x: 4, y: 4 },
      );
      const internal = aStar as any;
      expect(
        internal.blocksCollide(0, { x: 2, y: 2 }, 1, { x: 2, y: 2 }),
      ).toBe(true);
    });

    test("two adjacent single-cell blocks (not overlapping) do not collide", () => {
      const shapes: Position[][] = [[{ x: 0, y: 0 }], [{ x: 0, y: 0 }]];
      const aStar = makeAStar(
        5,
        5,
        shapes,
        [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
        ],
        0,
        { x: 4, y: 4 },
      );
      const internal = aStar as any;
      expect(
        internal.blocksCollide(0, { x: 0, y: 0 }, 1, { x: 1, y: 0 }),
      ).toBe(false);
    });

    test("L-shape on top of L-shape at same anchor collides", () => {
      const lShape: Position[] = [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 0, y: 1 },
      ];
      const shapes: Position[][] = [lShape, lShape];
      const aStar = makeAStar(
        5,
        5,
        shapes,
        [
          { x: 0, y: 0 },
          { x: 2, y: 0 },
        ],
        0,
        { x: 4, y: 4 },
      );
      const internal = aStar as any;
      expect(
        internal.blocksCollide(0, { x: 0, y: 0 }, 1, { x: 0, y: 0 }),
      ).toBe(true);
    });
  });

  describe("CollidesWithOthers", () => {
    const shapes: Position[][] = [
      [{ x: 0, y: 0 }],
      [{ x: 0, y: 0 }],
      [{ x: 0, y: 0 }],
    ];
    const aStar = makeAStar(
      5,
      5,
      shapes,
      [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 2, y: 0 },
      ],
      0,
      { x: 4, y: 4 },
    );
    const internal = aStar as any;

    test("returns true when newAnchor overlaps any other block", () => {
      expect(
        internal.collidesWithOthers(
          0,
          { x: 1, y: 0 },
          [
            { x: 0, y: 0 },
            { x: 1, y: 0 },
            { x: 2, y: 0 },
          ],
        ),
      ).toBe(true);
    });

    test("returns false when newAnchor is on the block's own current anchor (self skipped)", () => {
      expect(
        internal.collidesWithOthers(
          0,
          { x: 0, y: 0 },
          [
            { x: 0, y: 0 },
            { x: 1, y: 0 },
            { x: 2, y: 0 },
          ],
        ),
      ).toBe(false);
    });

    test("returns false when newAnchor is in an empty cell", () => {
      expect(
        internal.collidesWithOthers(
          0,
          { x: 3, y: 0 },
          [
            { x: 0, y: 0 },
            { x: 1, y: 0 },
            { x: 2, y: 0 },
          ],
        ),
      ).toBe(false);
    });
  });

});
