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
      expect(turns).toHaveLength(1);
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

});
