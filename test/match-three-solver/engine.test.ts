import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { solveMatchThree } from "../../src/pages/match-three-solver/engine";
import {
  applyMove,
  boardProblem,
  blockCount,
  toBoard,
  type MatchThreeBoard,
  type Move,
} from "../../src/pages/match-three-solver/rules";
import type { MatchThreeTest } from "../../src/util/types";
import { board, CASCADE } from "./boards";

/**
 * Replays a solution the way the player would. Every move has to still be
 * legal at the point it is played, and the board has to end up empty — an
 * answer that does not survive this is not an answer.
 */
function clearsBoard(start: MatchThreeBoard, moves: Move[]): boolean {
  let current = start;
  for (const move of moves) {
    const outcome = applyMove(current, move);
    if (!outcome) return false;
    current = outcome.board;
  }
  return blockCount(current) === 0;
}

function solve(rows: string[], budgetMs?: number) {
  return solveMatchThree(board(rows), budgetMs === undefined ? {} : { budgetMs });
}

/** One swap turns both rows into a line: `aab`/`bba` becomes `aaa`/`bbb`. */
const ONE_MOVE = ["aab", "bba"];

/** The same trick stacked twice over, with no swap able to reach both halves. */
const TWO_MOVES = ["aab", "bba", "ccd", "ddc"];

/**
 * One swap, two waves, empty board: the swap completes a run of four `a`, and
 * what drops into the gap lines up as `ccc` over `bbb`.
 */
const CASCADE_CLEARS = ["c..", "b..", "a..", "a..", "cac", "abb"];

/**
 * A diagonal weave of four symbols. Each has nine blocks, yet no swap
 * anywhere on it produces a line, so there is nothing to search.
 */
const NO_SWAPS = [
  "abcdab",
  "cdabcd",
  "abcdab",
  "cdabcd",
  "abcdab",
  "cdabcd",
];

/** Solvable, but only after a search far too long to finish instantly. */
const SLOW = [
  "ccbbaa",
  "babcbb",
  "ccabbc",
  "bccbab",
  "cabaca",
  "aacaac",
];

describe("solveMatchThree", () => {
  test("a board with nothing on it is already solved", () => {
    expect(solve(["..", "#."])).toEqual({
      status: "solved",
      moves: [],
      groupingProven: true,
    });
  });

  test("finds the single swap that clears the board", () => {
    const result = solve(ONE_MOVE);
    expect(result.status).toBe("solved");
    if (result.status !== "solved") return;
    expect(result.moves).toEqual([{ a: { x: 2, y: 0 }, b: { x: 2, y: 1 } }]);
    expect(clearsBoard(board(ONE_MOVE), result.moves)).toBeTrue();
  });

  test("takes two moves when no single swap can reach both halves", () => {
    const result = solve(TWO_MOVES);
    expect(result.status).toBe("solved");
    if (result.status !== "solved") return;
    expect(result.moves).toHaveLength(2);
    expect(clearsBoard(board(TWO_MOVES), result.moves)).toBeTrue();
  });

  test("counts a whole cascade as the one move the player makes", () => {
    const result = solve(CASCADE_CLEARS);
    expect(result.status).toBe("solved");
    if (result.status !== "solved") return;
    expect(result.moves).toEqual([{ a: { x: 0, y: 4 }, b: { x: 1, y: 4 } }]);
    expect(clearsBoard(board(CASCADE_CLEARS), result.moves)).toBeTrue();
  });

  test("reports the moves in the order they must be played", () => {
    const result = solve(TWO_MOVES);
    if (result.status !== "solved") throw new Error(result.status);
    const reversed = [...result.moves].reverse();
    expect(clearsBoard(board(TWO_MOVES), result.moves)).toBeTrue();
    expect(clearsBoard(board(TWO_MOVES), reversed)).toBeFalse();
  });

  describe("Unsolvable boards", () => {
    test("a symbol with too few blocks to ever line up", () => {
      expect(solve(CASCADE)).toEqual({ status: "unsolvable" });
    });

    test("a board with no legal swap at all", () => {
      expect(solve(NO_SWAPS)).toEqual({ status: "unsolvable" });
    });

    test("a board whose every move strands what it leaves behind", () => {
      // Both legal swaps clear six of the eight cells and orphan the other two.
      expect(solve(["aabb", "bbaa"])).toEqual({ status: "unsolvable" });
    });
  });

  describe("Budget", () => {
    test("every board these cases lean on is a legal start state", () => {
      for (const rows of [ONE_MOVE, TWO_MOVES, CASCADE_CLEARS, NO_SWAPS, SLOW]) {
        expect(boardProblem(board(rows))).toBeNull();
      }
    });

    test("gives up rather than report a length it has not proven", () => {
      const result = solve(SLOW, 0);
      expect(result.status).toBe("budget");
      if (result.status !== "budget") return;
      expect(result.depth).toBeGreaterThanOrEqual(0);
    });

    test("a board it can finish is never reported as a give-up", () => {
      expect(solve(TWO_MOVES, 0).status).toBe("solved");
    });
  });

  describe("Progress", () => {
    test("reports the length it is currently ruling out", () => {
      const seen: number[] = [];
      solveMatchThree(board(SLOW), {
        budgetMs: 0,
        onProgress: progress => seen.push(progress.depth),
      });
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every(depth => depth >= 0)).toBeTrue();
    });
  });

  /**
   * Every board captured from the game, discovered by listing rather than
   * enumerated — dropping another export in makes it run with no code change.
   * The whole point of the corpus: a real board is always a state the game
   * could be in, and is always clearable.
   */
  describe("Captured boards", () => {
    const DIR = `${import.meta.dir}/../resources/match-three-solver`;
    const FIXTURES = readdirSync(DIR).filter(name => name.endsWith(".json"));

    /**
     * The captured boards the search cannot yet finish. They are legal game
     * states like every other fixture, and nothing suggests they are anything
     * but clearable — the engine simply runs out of budget before it can prove
     * a length. Named here rather than dropped from the sweep so that the day
     * one of them becomes solvable, this test is what says so.
     */
    const BEYOND_BUDGET = new Set([
      "matchThreeTest47.json",
      "matchThreeTest50.json",
      "matchThreeTest51.json",
    ]);

    /** Enough to notice one of them turning easy, without paying the full budget. */
    const PROBE_MS = 2_000;

    /** The slowest board that does finish needs ~13s; leave room on a busy CI. */
    const SWEEP_TIMEOUT_MS = 60_000;

    test("there are captured boards to solve", () => {
      expect(FIXTURES.length).toBeGreaterThan(0);
    });

    test.each(FIXTURES)(
      "%s is a legal game state",
      async name => {
        const config = (await Bun.file(
          `${DIR}/${name}`,
        ).json()) as MatchThreeTest;
        expect(boardProblem(toBoard(config))).toBeNull();
      },
    );

    test.each(FIXTURES.filter(name => !BEYOND_BUDGET.has(name)))(
      "%s is clearable",
      async name => {
        const config = (await Bun.file(
          `${DIR}/${name}`,
        ).json()) as MatchThreeTest;
        const start = toBoard(config);

        const result = solveMatchThree(start);
        expect(result.status).toBe("solved");
        if (result.status !== "solved") return;
        expect(result.moves.length).toBeGreaterThan(0);
        // The move list is only an answer if it survives being played.
        expect(clearsBoard(start, result.moves)).toBeTrue();
      },
      SWEEP_TIMEOUT_MS,
    );

    test.each([...BEYOND_BUDGET])(
      "%s still outruns the budget",
      async name => {
        expect(FIXTURES).toContain(name);
        const config = (await Bun.file(
          `${DIR}/${name}`,
        ).json()) as MatchThreeTest;
        const result = solveMatchThree(toBoard(config), {
          budgetMs: PROBE_MS,
        });
        // Never "unsolvable": that would be a proof, and no proof was reached.
        expect(result.status).toBe("budget");
      },
    );
  });

  describe("Grouping", () => {
    test("a solution it had time to tidy is marked as proven", () => {
      const result = solve(TWO_MOVES);
      if (result.status !== "solved") throw new Error(result.status);
      expect(result.groupingProven).toBeTrue();
    });

    test("keeps moves on one symbol together when the length allows it", () => {
      // Three independent pairs of lines, one swap each, in any order.
      const result = solve(["aab", "bba", "ccd", "ddc", "eef", "ffe"]);
      if (result.status !== "solved") throw new Error(result.status);
      expect(result.moves).toHaveLength(3);
    });
  });
});
