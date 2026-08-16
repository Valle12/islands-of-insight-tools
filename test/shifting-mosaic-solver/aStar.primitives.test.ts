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
  return new AStar({
    gridWidth,
    gridHeight,
    shapes,
    initialAnchors,
    goalIndex,
    goalAnchor,
  });
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
  describe("Constructor / precomputed shape data", () => {
    test("computes bounding box width and height per shape", () => {
      const shapes: Position[][] = [
        [{ x: 0, y: 0 }],
        [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
          { x: 2, y: 0 },
        ],
        [
          { x: 0, y: 0 },
          { x: 0, y: 1 },
          { x: 1, y: 0 },
          { x: 1, y: 1 },
        ],
      ];
      const aStar = makeAStar(
        5,
        5,
        shapes,
        [
          { x: 0, y: 0 },
          { x: 0, y: 2 },
          { x: 2, y: 2 },
        ],
        0,
        { x: 4, y: 4 },
      );
      const internal = aStar as any;
      expect(internal.shapeBoxWidth).toEqual([1, 3, 2]);
      expect(internal.shapeBoxHeight).toEqual([1, 1, 2]);
    });

    test("builds a cell set per shape", () => {
      const shapes: Position[][] = [
        [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
          { x: 0, y: 1 },
        ],
      ];
      const aStar = makeAStar(
        3,
        3,
        shapes,
        [{ x: 0, y: 0 }],
        0,
        { x: 0, y: 0 },
      );
      const internal = aStar as any;
      const set: Set<number> = internal.shapeCellSets[0];
      expect(set.has(0 * 1024 + 0)).toBe(true);
      expect(set.has(1 * 1024 + 0)).toBe(true);
      expect(set.has(0 * 1024 + 1)).toBe(true);
      expect(set.has(1 * 1024 + 1)).toBe(false);
    });
  });

  describe("InBounds", () => {
    const shapes: Position[][] = [
      [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 0, y: 1 },
      ],
    ];
    const aStar = makeAStar(
      5,
      5,
      shapes,
      [{ x: 0, y: 0 }],
      0,
      { x: 0, y: 0 },
    );
    const internal = aStar as any;

    test("anchor at (0,0) fits within bounds", () => {
      expect(internal.inBounds(0, { x: 0, y: 0 })).toBe(true);
    });

    test("anchor that would push the bbox out to the right is rejected", () => {
      // bbox is 2x2, gridWidth is 5 → max anchor.x is 3
      expect(internal.inBounds(0, { x: 4, y: 0 })).toBe(false);
      expect(internal.inBounds(0, { x: 3, y: 0 })).toBe(true);
    });

    test("anchor that would push the bbox out at the bottom is rejected", () => {
      expect(internal.inBounds(0, { x: 0, y: 4 })).toBe(false);
      expect(internal.inBounds(0, { x: 0, y: 3 })).toBe(true);
    });

    test("negative anchor coordinates are rejected", () => {
      expect(internal.inBounds(0, { x: -1, y: 0 })).toBe(false);
      expect(internal.inBounds(0, { x: 0, y: -1 })).toBe(false);
    });
  });

  describe("BoundingBoxesOverlap", () => {
    const shapes: Position[][] = [
      [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
      ],
      [
        { x: 0, y: 0 },
        { x: 0, y: 1 },
      ],
    ];
    const aStar = makeAStar(
      5,
      5,
      shapes,
      [
        { x: 0, y: 0 },
        { x: 3, y: 0 },
      ],
      0,
      { x: 4, y: 4 },
    );
    const internal = aStar as any;

    test("overlapping bboxes return true", () => {
      expect(
        internal.boundingBoxesOverlap(0, { x: 0, y: 0 }, 1, { x: 1, y: 0 }),
      ).toBe(true);
    });

    test("non-overlapping bboxes return false (horizontal gap)", () => {
      expect(
        internal.boundingBoxesOverlap(0, { x: 0, y: 0 }, 1, { x: 3, y: 0 }),
      ).toBe(false);
    });

    test("touching bboxes (adjacent, not overlapping) return false", () => {
      // block 0 spans x=0..1 (width 2), block 1 starts at x=2
      expect(
        internal.boundingBoxesOverlap(0, { x: 0, y: 0 }, 1, { x: 2, y: 0 }),
      ).toBe(false);
    });

    test("non-overlapping bboxes return false (vertical gap)", () => {
      expect(
        internal.boundingBoxesOverlap(0, { x: 0, y: 0 }, 1, { x: 0, y: 3 }),
      ).toBe(false);
    });
  });

});
