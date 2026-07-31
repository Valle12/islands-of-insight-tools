import { describe, expect, test } from "bun:test";
import { BLOCKED, symbolCell, EMPTY } from "../../src/pages/match-three-solver/cell";
import {
  applyGravity,
  applyMove,
  boardKey,
  boardProblem,
  cellAt,
  blockCount,
  symbolCounts,
  findMatches,
  hasStrandedSymbol,
  legalMoves,
  resolve,
  toBoard,
  toGrid,
} from "../../src/pages/match-three-solver/rules";
import type { MatchThreeTest } from "../../src/util/types";
import { board, CASCADE, draw, marked } from "./boards";

describe("findMatches", () => {
  test("marks a horizontal run of three", () => {
    const value = board(["aaa"]);
    expect(marked(value, findMatches(value))).toEqual(["0,0", "1,0", "2,0"]);
  });

  test("marks a vertical run of three", () => {
    const value = board(["ab", "ab", "ac"]);
    expect(marked(value, findMatches(value))).toEqual(["0,0", "0,1", "0,2"]);
  });

  test("takes the whole run, not just three of it", () => {
    const value = board(["aaaaa"]);
    expect(marked(value, findMatches(value))).toHaveLength(5);
  });

  test("clears both arms of a T", () => {
    const value = board(["aaa", "bab", "bab"]);
    expect(marked(value, findMatches(value))).toEqual([
      "0,0",
      "1,0",
      "1,1",
      "1,2",
      "2,0",
    ]);
  });

  test("clears both arms of a plus", () => {
    const value = board(["bab", "aaa", "bab"]);
    expect(marked(value, findMatches(value))).toEqual([
      "0,1",
      "1,0",
      "1,1",
      "1,2",
      "2,1",
    ]);
  });

  test("clears both arms of an L", () => {
    const value = board(["abb", "abb", "aaa"]);
    expect(marked(value, findMatches(value))).toEqual([
      "0,0",
      "0,1",
      "0,2",
      "1,2",
      "2,2",
    ]);
  });

  test("two in a row is not a match", () => {
    const value = board(["aab", "bba"]);
    expect(findMatches(value)).toBeNull();
  });

  test("a run of blocked cells is not a match", () => {
    expect(findMatches(board(["###"]))).toBeNull();
  });

  test("a run of empty cells is not a match", () => {
    expect(findMatches(board(["..."]))).toBeNull();
  });

  test("a run may not cross a blocked cell", () => {
    expect(findMatches(board(["aa#aa"]))).toBeNull();
  });
});

describe("applyGravity", () => {
  test("drops a floating block to the bottom", () => {
    const value = board(["a", ".", "."]);
    applyGravity(value);
    expect(draw(value)).toEqual([".", ".", "a"]);
  });

  test("stacks blocks in order", () => {
    const value = board(["a", ".", "b", "."]);
    applyGravity(value);
    expect(draw(value)).toEqual([".", ".", "a", "b"]);
  });

  test("rests a block on a blocked cell instead of passing through", () => {
    const value = board(["a", ".", "#"]);
    applyGravity(value);
    expect(draw(value)).toEqual([".", "a", "#"]);
  });

  test("settles each segment of a column independently", () => {
    const value = board(["a", ".", "#", "b", "."]);
    applyGravity(value);
    expect(draw(value)).toEqual([".", "a", "#", ".", "b"]);
  });

  test("leaves a settled board alone", () => {
    const value = board(["...", "ab.", "abc"]);
    applyGravity(value);
    expect(draw(value)).toEqual(["...", "ab.", "abc"]);
  });
});

describe("resolve", () => {
  test("clears a match and drops what was above it", () => {
    const value = board(["b..", "b..", "aaa"]);
    expect(resolve(value)).toEqual({ cleared: 3, cascades: 1 });
    expect(draw(value)).toEqual(["...", "b..", "b.."]);
  });

  test("keeps going while the fall keeps making matches", () => {
    // CASCADE with its swap already applied: column 0 clears, which drops its
    // `b` onto the bottom row beside two more.
    const value = board(["...", "b..", "a..", "a..", "ac.", "abb"]);
    const outcome = resolve(value);
    expect(outcome).toEqual({ cleared: 7, cascades: 2 });
    expect(findMatches(value)).toBeNull();
  });

  test("a stable board is left untouched", () => {
    const value = board(CASCADE);
    expect(resolve(value)).toEqual({ cleared: 0, cascades: 0 });
    expect(draw(value)).toEqual(CASCADE);
  });
});

describe("legalMoves", () => {
  test("finds the swap that completes a line", () => {
    expect(legalMoves(board(CASCADE))).toContainEqual({
      a: { x: 0, y: 4 },
      b: { x: 1, y: 4 },
    });
  });

  test("a swap that clears nothing is not a move", () => {
    expect(legalMoves(board(CASCADE))).not.toContainEqual({
      a: { x: 0, y: 5 },
      b: { x: 1, y: 5 },
    });
  });

  test("finds a vertical swap", () => {
    expect(legalMoves(board(["bca", "abb"]))).toContainEqual({
      a: { x: 0, y: 0 },
      b: { x: 0, y: 1 },
    });
  });

  test("two blocks of the same symbol are never a move", () => {
    expect(legalMoves(board(["aa", "aa"]))).toEqual([]);
  });

  test("empty and blocked cells never take part in a swap", () => {
    expect(legalMoves(board(["a.", "a#", "a."]))).toEqual([]);
  });

  test("a board with nothing to swap has no moves", () => {
    expect(legalMoves(board(["..", ".."]))).toEqual([]);
  });
});

describe("applyMove", () => {
  test("clears the first wave, then everything the fall sets off", () => {
    const outcome = applyMove(board(CASCADE), {
      a: { x: 0, y: 4 },
      b: { x: 1, y: 4 },
    })!;

    expect(marked(outcome.board, outcome.firstWave)).toEqual([
      "0,2",
      "0,3",
      "0,4",
      "0,5",
    ]);
    expect(outcome.cascades).toBe(2);
    expect(outcome.cleared).toBe(7);
    expect(draw(outcome.board)).toEqual([
      "...",
      "...",
      "...",
      "...",
      "...",
      ".c.",
    ]);
  });

  test("clears two lines at once when the swap makes both", () => {
    const outcome = applyMove(board(["...", "..b", "aab", "bba"]), {
      a: { x: 2, y: 2 },
      b: { x: 2, y: 3 },
    })!;
    expect(outcome.firstWave.reduce((sum, on) => sum + on, 0)).toBe(6);
  });

  test("returns null for a swap that clears nothing", () => {
    expect(
      applyMove(board(CASCADE), { a: { x: 0, y: 5 }, b: { x: 1, y: 5 } }),
    ).toBeNull();
  });

  test("leaves the board it was given alone", () => {
    const value = board(CASCADE);
    applyMove(value, { a: { x: 0, y: 4 }, b: { x: 1, y: 4 } });
    expect(draw(value)).toEqual(CASCADE);
  });
});

describe("Counting", () => {
  test("blockCount ignores empty and blocked cells", () => {
    expect(blockCount(board(["a#.", ".ba"]))).toBe(3);
  });

  test("symbolCounts reports per symbol", () => {
    expect(symbolCounts(board(["aab", "#.a"]))).toEqual([3, 1]);
  });

  test("a symbol with fewer than three blocks left is stranded", () => {
    expect(hasStrandedSymbol(board(["aab", "a.a"]))).toBeTrue();
  });

  test("a board where every symbol could still line up is not stranded", () => {
    expect(hasStrandedSymbol(board(["aab", "abb"]))).toBeFalse();
  });

  test("a board with no blocks at all is not stranded", () => {
    expect(hasStrandedSymbol(board(["#.", ".#"]))).toBeFalse();
  });
});

describe("boardProblem", () => {
  test("names a floating block", () => {
    expect(boardProblem(board([".a.", "..."]))).toBe(
      "Column 2, Row 1 floats above an empty cell. " +
        "A board must have settled before it can be solved.",
    );
  });

  test("names a line that is already standing", () => {
    expect(boardProblem(board(["aaa"]))).toBe(
      "Column 1, Row 1 is already part of a line of three. " +
        "A board must have no matches left.",
    );
  });

  test("a block resting on a blocked cell is not floating", () => {
    expect(boardProblem(board(["a", "#"]))).toBeNull();
  });

  test("a settled board with no matches has no problem", () => {
    expect(boardProblem(board(CASCADE))).toBeNull();
  });

  test("an empty board has no problem", () => {
    expect(boardProblem(board(["..", ".."]))).toBeNull();
  });
});

describe("Conversion", () => {
  const config: MatchThreeTest = {
    gridWidth: 3,
    gridHeight: 2,
    cells: [
      [EMPTY, symbolCell(0)],
      [BLOCKED, symbolCell(1)],
      [EMPTY, symbolCell(0)],
    ],
  };

  test("a config round-trips through the flat board", () => {
    expect(toGrid(toBoard(config))).toEqual(config.cells);
  });

  test("the flat board keeps the config's column-major layout", () => {
    const value = toBoard(config);
    expect(cellAt(value, 1, 0)).toBe(BLOCKED);
    expect(cellAt(value, 2, 1)).toBe(symbolCell(0));
  });

  test("boardKey tells two different boards apart", () => {
    expect(boardKey(board(["ab"]))).not.toBe(boardKey(board(["ba"])));
  });

  test("boardKey matches for equal boards", () => {
    expect(boardKey(board(["ab"]))).toBe(boardKey(board(["ab"])));
  });
});
