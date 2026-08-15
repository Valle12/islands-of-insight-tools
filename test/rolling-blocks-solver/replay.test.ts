import { describe, expect, test } from "bun:test";
import { Block } from "../../src/pages/rolling-blocks-solver/block";
import { Direction } from "../../src/pages/rolling-blocks-solver/directions";
import {
  isSolved,
  isSolvedAtStart,
  replayTurns,
  type Puzzle,
} from "../../src/pages/rolling-blocks-solver/replay";
import type { Turn } from "../../src/pages/rolling-blocks-solver/turn";
import type { Tile } from "../../src/util/types";
import { extractBit, positionToIndex } from "../../src/util/utilMethods";

/** Column-major grid of `regular`, with `paint` applied on top. */
function grid(
  width: number,
  height: number,
  paint: Record<string, Tile> = {},
): Tile[][] {
  const cells: Tile[][] = Array.from({ length: width }, () =>
    Array.from({ length: height }, () => "regular" as Tile),
  );
  for (const [key, tile] of Object.entries(paint)) {
    const [x, y] = key.split(",").map(Number);
    cells[x!]![y!] = tile;
  }
  return cells;
}

const cube = (id: number, x: number, y: number) => new Block(id, x, y, 1, 1, 1);

const satisfiedAt = (mask: bigint, x: number, y: number, width: number) =>
  extractBit(mask, positionToIndex(x, y, width)) === 1n;

describe("replayTurns", () => {
  test("captures the board before every turn, plus the final one", () => {
    const puzzle: Puzzle = {
      gridWidth: 4,
      gridHeight: 1,
      cells: grid(4, 1),
      blocks: [cube(1, 0, 0)],
    };
    const turns: Turn[] = [
      { blockId: 1, direction: Direction.RIGHT },
      { blockId: 1, direction: Direction.RIGHT },
    ];

    const { steps, legalUpTo } = replayTurns(puzzle, turns);

    expect(legalUpTo).toBe(2);
    expect(steps).toHaveLength(3);
    expect(steps.map(s => s.blocks[0]!.x)).toEqual([0, 1, 2]);
  });

  test("leaves the caller's blocks untouched", () => {
    const start = cube(1, 0, 0);
    const puzzle: Puzzle = {
      gridWidth: 4,
      gridHeight: 1,
      cells: grid(4, 1),
      blocks: [start],
    };

    replayTurns(puzzle, [{ blockId: 1, direction: Direction.RIGHT }]);

    expect(start.x).toBe(0);
  });

  test("rolls a tall block onto its side", () => {
    // A 1x1 footprint standing 2 high tips onto a 1x2 footprint.
    const puzzle: Puzzle = {
      gridWidth: 4,
      gridHeight: 1,
      cells: grid(4, 1),
      blocks: [new Block(1, 0, 0, 1, 1, 2)],
    };

    const { steps } = replayTurns(puzzle, [
      { blockId: 1, direction: Direction.RIGHT },
    ]);

    const rolled = steps[1]!.blocks[0]!;
    expect([rolled.x, rolled.width, rolled.height]).toEqual([1, 2, 1]);
  });

  test("stops at a turn that rolls a block off the board", () => {
    const puzzle: Puzzle = {
      gridWidth: 2,
      gridHeight: 1,
      cells: grid(2, 1),
      blocks: [cube(1, 0, 0)],
    };
    const turns: Turn[] = [
      { blockId: 1, direction: Direction.RIGHT },
      { blockId: 1, direction: Direction.RIGHT },
    ];

    const { steps, legalUpTo } = replayTurns(puzzle, turns);

    expect(legalUpTo).toBe(1);
    expect(steps).toHaveLength(2);
  });

  test("stops at a turn naming a block that does not exist", () => {
    const puzzle: Puzzle = {
      gridWidth: 3,
      gridHeight: 1,
      cells: grid(3, 1),
      blocks: [cube(1, 0, 0)],
    };

    const { legalUpTo } = replayTurns(puzzle, [
      { blockId: 7, direction: Direction.RIGHT },
    ]);

    expect(legalUpTo).toBe(0);
  });

  test("stops at a turn that runs a block into another one", () => {
    const puzzle: Puzzle = {
      gridWidth: 3,
      gridHeight: 1,
      cells: grid(3, 1),
      blocks: [cube(1, 0, 0), cube(2, 1, 0)],
    };

    const { legalUpTo } = replayTurns(puzzle, [
      { blockId: 1, direction: Direction.RIGHT },
    ]);

    expect(legalUpTo).toBe(0);
  });

  test("stops at a turn that lands on an unplayable cell", () => {
    const puzzle: Puzzle = {
      gridWidth: 3,
      gridHeight: 1,
      cells: grid(3, 1, { "1,0": "unplayable" }),
      blocks: [cube(1, 0, 0)],
    };

    const { legalUpTo } = replayTurns(puzzle, [
      { blockId: 1, direction: Direction.RIGHT },
    ]);

    expect(legalUpTo).toBe(0);
  });

  test("seeds the satisfied mask from where the blocks already stand", () => {
    const puzzle: Puzzle = {
      gridWidth: 3,
      gridHeight: 1,
      cells: grid(3, 1, { "0,0": "mustTouch" }),
      blocks: [cube(1, 0, 0)],
    };

    const { steps } = replayTurns(puzzle, []);

    expect(satisfiedAt(steps[0]!.satisfied, 0, 0, 3)).toBeTrue();
  });

  test("satisfaction only ever grows", () => {
    const puzzle: Puzzle = {
      gridWidth: 4,
      gridHeight: 1,
      cells: grid(4, 1, { "1,0": "mustTouch", "2,0": "mustTouch" }),
      blocks: [cube(1, 0, 0)],
    };

    const { steps, legalUpTo } = replayTurns(puzzle, [
      { blockId: 1, direction: Direction.RIGHT },
      { blockId: 1, direction: Direction.RIGHT },
    ]);

    expect(legalUpTo).toBe(2);
    expect(satisfiedAt(steps[1]!.satisfied, 1, 0, 4)).toBeTrue();
    // Rolling on refuses to forget the star it already collected.
    expect(satisfiedAt(steps[2]!.satisfied, 1, 0, 4)).toBeTrue();
    expect(satisfiedAt(steps[2]!.satisfied, 2, 0, 4)).toBeTrue();
  });

  test("a star already stepped on becomes a wall", () => {
    const puzzle: Puzzle = {
      gridWidth: 3,
      gridHeight: 1,
      cells: grid(3, 1, { "1,0": "mustTouch" }),
      blocks: [cube(1, 0, 0)],
    };

    // Right onto the star, right off it, then back left onto it again.
    const { legalUpTo } = replayTurns(puzzle, [
      { blockId: 1, direction: Direction.RIGHT },
      { blockId: 1, direction: Direction.RIGHT },
      { blockId: 1, direction: Direction.LEFT },
    ]);

    expect(legalUpTo).toBe(2);
  });
});

describe("isSolved", () => {
  test("a board with nothing to satisfy is solved from the start", () => {
    const puzzle: Puzzle = {
      gridWidth: 2,
      gridHeight: 1,
      cells: grid(2, 1),
      blocks: [cube(1, 0, 0)],
    };

    expect(isSolved(puzzle, puzzle.blocks, 0n)).toBeTrue();
  });

  test("an unvisited must-touch cell keeps the board unsolved", () => {
    const puzzle: Puzzle = {
      gridWidth: 3,
      gridHeight: 1,
      cells: grid(3, 1, { "2,0": "mustTouch" }),
      blocks: [cube(1, 0, 0)],
    };

    const { steps } = replayTurns(puzzle, []);
    expect(isSolved(puzzle, steps[0]!.blocks, steps[0]!.satisfied)).toBeFalse();

    const rolled = replayTurns(puzzle, [
      { blockId: 1, direction: Direction.RIGHT },
      { blockId: 1, direction: Direction.RIGHT },
    ]);
    const final = rolled.steps[rolled.steps.length - 1]!;
    expect(isSolved(puzzle, final.blocks, final.satisfied)).toBeTrue();
  });

  test("a block only covers a goal when its whole footprint is on goal", () => {
    // A 2-wide block lying across one goal cell and one regular cell counts
    // for nothing, which is what makes the second goal cell load-bearing.
    const puzzle: Puzzle = {
      gridWidth: 3,
      gridHeight: 1,
      cells: grid(3, 1, { "1,0": "goal" }),
      blocks: [new Block(1, 1, 0, 2, 1, 1)],
    };

    expect(isSolved(puzzle, puzzle.blocks, 0n)).toBeFalse();

    const exact: Puzzle = {
      ...puzzle,
      cells: grid(3, 1, { "1,0": "goal", "2,0": "goal" }),
    };
    expect(isSolved(exact, exact.blocks, 0n)).toBeTrue();
  });

  test("every goal cell has to be covered, not just one", () => {
    const puzzle: Puzzle = {
      gridWidth: 3,
      gridHeight: 1,
      cells: grid(3, 1, { "0,0": "goal", "2,0": "goal" }),
      blocks: [cube(1, 0, 0)],
    };

    expect(isSolved(puzzle, puzzle.blocks, 0n)).toBeFalse();
  });
});

// What tells "no moves needed" apart from "no solution": both come back from
// the solver as the empty plan, and only the start state says which.
describe("isSolvedAtStart", () => {
  test("a board with nothing left to do is solved before a turn", () => {
    const puzzle: Puzzle = {
      gridWidth: 3,
      gridHeight: 1,
      cells: grid(3, 1, { "0,0": "goal" }),
      blocks: [cube(1, 0, 0)],
    };

    expect(isSolvedAtStart(puzzle)).toBeTrue();
  });

  test("a must-touch cell under a block counts as stepped on", () => {
    // The satisfied mask is SEEDED from where the blocks already stand, so a
    // board is solved by standing on its last star, not only by rolling onto
    // it. Reading the blocks directly would miss this.
    const puzzle: Puzzle = {
      gridWidth: 3,
      gridHeight: 1,
      cells: grid(3, 1, { "0,0": "mustTouch" }),
      blocks: [cube(1, 0, 0)],
    };

    expect(isSolvedAtStart(puzzle)).toBeTrue();
  });

  test("a board with work left is not", () => {
    const puzzle: Puzzle = {
      gridWidth: 3,
      gridHeight: 1,
      cells: grid(3, 1, { "2,0": "goal" }),
      blocks: [cube(1, 0, 0)],
    };

    expect(isSolvedAtStart(puzzle)).toBeFalse();
  });
});
