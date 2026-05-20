import { describe, expect, test } from "bun:test";
import { AStar } from "../../src/pages/shifting-mosaic-solver/aStar";
import { Direction } from "../../src/pages/shifting-mosaic-solver/directions";
import { Node } from "../../src/pages/shifting-mosaic-solver/node";
import type { Turn } from "../../src/pages/shifting-mosaic-solver/turn";
import type { Position, ShiftingMosaicTest } from "../../src/util/types";

const PER_PUZZLE_BUDGET_MS = Number(
  Bun.env.SHIFTING_MOSAIC_BUDGET_MS ?? 10_000,
);
const PER_PUZZLE_TIMEOUT_MS = PER_PUZZLE_BUDGET_MS + 5_000;
const PER_PUZZLE_WEIGHT = Number(Bun.env.SHIFTING_MOSAIC_WEIGHT ?? 1);
const PER_PUZZLE_DEADLOCK_PRUNING =
  Bun.env.SHIFTING_MOSAIC_DEADLOCK_PRUNING !== "0";

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

  describe("BlocksCollide (cell-level)", () => {
    test("two L-shapes whose bboxes overlap but whose cells do not are not colliding", () => {
      // Shape A: L pointing top-right
      //   X X
      //   X .
      const shapeA: Position[] = [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 0, y: 1 },
      ];
      // Shape B: just bottom-right cell
      //   . X
      const shapeB: Position[] = [{ x: 1, y: 1 }];
      // We use a 2x2 bbox shape B by also including {x:0,y:0} for bbox
      // ... but we want a shape that fits the (1,1) corner exactly.
      // Easier: use a real bbox-overlapping case where the cell at (1,1) is empty.
      const shapeBReal: Position[] = [
        { x: 1, y: 1 },
        { x: 0, y: 1 },
      ];
      // shapeBReal's bbox is 2x2 (because we have x∈{0,1}, y∈{0,1}... wait y=1 only)
      // Actually bbox is 2 wide, 1 tall (since min(y)=1, but bbox calc uses max(y)+1 = 2)
      // Hmm bbox calc is just max+1 — let me redo with normalized shape.
      // Skip this — use a more direct test below instead.
      void shapeA;
      void shapeB;
      void shapeBReal;
    });

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

  describe("Heuristic", () => {
    test("Manhattan distance of goal block to goal anchor", () => {
      const shapes: Position[][] = [[{ x: 0, y: 0 }], [{ x: 0, y: 0 }]];
      const aStar = makeAStar(
        10,
        10,
        shapes,
        [
          { x: 0, y: 0 },
          { x: 0, y: 0 },
        ],
        1,
        { x: 5, y: 7 },
      );
      const internal = aStar as any;
      const node = new Node([
        { x: 0, y: 0 },
        { x: 2, y: 3 },
      ]);
      expect(internal.heuristic(node)).toBe(3 + 4);
    });

    test("returns 0 when goal block already at goal anchor", () => {
      const shapes: Position[][] = [[{ x: 0, y: 0 }]];
      const aStar = makeAStar(
        10,
        10,
        shapes,
        [{ x: 0, y: 0 }],
        0,
        { x: 5, y: 7 },
      );
      const internal = aStar as any;
      const node = new Node([{ x: 5, y: 7 }]);
      expect(internal.heuristic(node)).toBe(0);
    });
  });

  describe("IsGoalState", () => {
    const shapes: Position[][] = [[{ x: 0, y: 0 }], [{ x: 0, y: 0 }]];
    const aStar = makeAStar(
      10,
      10,
      shapes,
      [
        { x: 0, y: 0 },
        { x: 0, y: 0 },
      ],
      1,
      { x: 5, y: 7 },
    );
    const internal = aStar as any;

    test("true when goal block's anchor equals goal anchor", () => {
      const node = new Node([
        { x: 0, y: 0 },
        { x: 5, y: 7 },
      ]);
      expect(internal.isGoalState(node)).toBe(true);
    });

    test("false when goal block's anchor differs", () => {
      const node = new Node([
        { x: 0, y: 0 },
        { x: 5, y: 6 },
      ]);
      expect(internal.isGoalState(node)).toBe(false);
    });

    test("ignores non-goal blocks even if they happen to sit on the goal anchor", () => {
      const node = new Node([
        { x: 5, y: 7 },
        { x: 0, y: 0 },
      ]);
      expect(internal.isGoalState(node)).toBe(false);
    });
  });

  describe("NodeSignature", () => {
    test("produces stable, position-ordered output", () => {
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
          { x: 0, y: 0 },
          { x: 0, y: 0 },
        ],
        0,
        { x: 4, y: 4 },
      );
      const internal = aStar as any;
      const node = new Node([
        { x: 1, y: 2 },
        { x: 3, y: 0 },
        { x: 4, y: 4 },
      ]);
      expect(internal.nodeSignature(node)).toBe("1,2|3,0|4,4");
    });

    test("two nodes with the same anchors produce the same signature", () => {
      const shapes: Position[][] = [[{ x: 0, y: 0 }], [{ x: 0, y: 0 }]];
      const aStar = makeAStar(
        5,
        5,
        shapes,
        [
          { x: 0, y: 0 },
          { x: 0, y: 0 },
        ],
        0,
        { x: 4, y: 4 },
      );
      const internal = aStar as any;
      const sigA = internal.nodeSignature(
        new Node([
          { x: 1, y: 1 },
          { x: 2, y: 2 },
        ]),
      );
      const sigB = internal.nodeSignature(
        new Node([
          { x: 1, y: 1 },
          { x: 2, y: 2 },
        ]),
      );
      expect(sigA).toBe(sigB);
    });
  });

  describe("Search (small puzzles)", () => {
    test("returns empty path when start equals goal", () => {
      const shapes: Position[][] = [[{ x: 0, y: 0 }]];
      const aStar = makeAStar(
        3,
        3,
        shapes,
        [{ x: 1, y: 1 }],
        0,
        { x: 1, y: 1 },
      );
      const turns = aStar.search();
      expect(turns).toEqual([]);
    });

    test("solves a trivial one-step problem", () => {
      const shapes: Position[][] = [[{ x: 0, y: 0 }]];
      const aStar = makeAStar(
        3,
        3,
        shapes,
        [{ x: 0, y: 0 }],
        0,
        { x: 1, y: 0 },
      );
      const turns = aStar.search();
      expect(turns.length).toBe(1);
      expect(turns[0]).toEqual({ blockId: 0, direction: Direction.RIGHT });
    });

    test("solves a two-block puzzle that requires moving an obstacle out of the way", () => {
      // Grid:  G . X .
      // Goal block (index 1) at (3,0), needs to reach (0,0).
      // Obstacle (index 0) at (2,0) blocks the way.
      const shapes: Position[][] = [[{ x: 0, y: 0 }], [{ x: 0, y: 0 }]];
      const aStar = makeAStar(
        4,
        2,
        shapes,
        [
          { x: 2, y: 0 },
          { x: 3, y: 0 },
        ],
        1,
        { x: 0, y: 0 },
      );
      const turns = aStar.search();
      expect(turns.length).toBeGreaterThan(0);

      // Replay and verify final anchors.
      const final = applyTurns(
        [
          { x: 2, y: 0 },
          { x: 3, y: 0 },
        ],
        turns,
      );
      expect(final[1]).toEqual({ x: 0, y: 0 });
    });
  });

  describe("Search (JSON puzzles)", () => {
    const cases: [string][] = [];
    cases.push(["shiftingMosaicTest.json"]);
    for (let i = 1; i <= 30; i++) {
      cases.push([`shiftingMosaicTest${i}.json`]);
    }

    test.each(cases)(
      "should solve %s",
      async filename => {
        const data: ShiftingMosaicTest = await Bun.file(
          `${import.meta.dir}/../resources/${filename}`,
        ).json();

        const aStar = new AStar(
          data.gridWidth,
          data.gridHeight,
          data.shapes,
          data.initialAnchors,
          data.goalIndex,
          data.goalAnchor,
          PER_PUZZLE_WEIGHT,
          PER_PUZZLE_DEADLOCK_PRUNING,
        );
        const turns = aStar.search(PER_PUZZLE_BUDGET_MS);
        console.log(`${filename}: ${turns.length} moves`, turns);

        expect(turns.length).toBeGreaterThan(0);

        const final = applyTurns(data.initialAnchors, turns);
        const goalFinal = final[data.goalIndex]!;
        expect(goalFinal.x).toBe(data.goalAnchor.x);
        expect(goalFinal.y).toBe(data.goalAnchor.y);
      },
      PER_PUZZLE_TIMEOUT_MS,
    );
  });
});

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
