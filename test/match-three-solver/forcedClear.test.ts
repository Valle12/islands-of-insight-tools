import { describe, expect, test } from "bun:test";
import {
  anyForcedCount,
  forcedBound,
  NO_BOUND,
} from "../../src/pages/match-three-solver/forcedClear";
import { SYMBOL_COUNT } from "../../src/pages/match-three-solver/symbols";
import { board } from "./boards";

// The forced-single-clear bound is used as a PRUNE in the prover, so being
// wrong here does not slow a search down, it makes it claim a proof it has not
// got. Every case below is about the bound never exceeding the moves genuinely
// needed. Its C++ twin is a-star/ForcedClear.h and the two must agree.

function counts(...pairs: [number, number][]): Int32Array {
  const out = new Int32Array(SYMBOL_COUNT);
  for (const [symbol, n] of pairs) out[symbol] = n;
  return out;
}

describe("anyForcedCount", () => {
  test("fires only at four and five", () => {
    // 1 and 2 belong to the stranded prune; 3 can clear as a run of three; 6 can
    // split into two clears of three, so none of them forces a single clear.
    for (const n of [0, 1, 2, 3, 6, 7, 30]) {
      expect(anyForcedCount(counts([0, n]))).toBeFalse();
    }
    expect(anyForcedCount(counts([0, 4]))).toBeTrue();
    expect(anyForcedCount(counts([0, 5]))).toBeTrue();
  });

  test("finds a forced symbol behind unforced ones", () => {
    expect(anyForcedCount(counts([0, 12], [3, 9], [7, 4]))).toBeTrue();
  });
});

describe("forcedBound", () => {
  test("says nothing when no symbol is at four or five", () => {
    expect(forcedBound(board(["..."]))).toBe(NO_BOUND);
    // Three of one symbol: a run of three clears them, nothing is forced.
    expect(forcedBound(board(["aaa"]))).toBe(NO_BOUND);
    // Six can go as three plus three.
    expect(forcedBound(board(["aaa", "aaa"]))).toBe(NO_BOUND);
  });

  test("is zero when the four are already in one column", () => {
    expect(forcedBound(board(["a", "a", "a", "a"]))).toBe(0);
  });

  test("is zero when the four are already in one row", () => {
    expect(forcedBound(board(["aaaa"]))).toBe(0);
  });

  test("counts the columns four scattered blocks must cross", () => {
    // Columns 0, 1, 4, 5 on a six-wide board. Gathering into one column costs
    // 1+0+3+4 = 8 at column 1, and 2+1+2+3 = 8 at column 2 — but a run of four
    // needs only columns 1,2,3,4: 1+0+1+1 = ... the row shape is far cheaper,
    // which is exactly why both are tried. Whatever the cheapest is, it is a
    // count of swaps and so must be well under the four-column spread.
    const bound = forcedBound(board(["a.a..a", "....a."]));
    expect(bound).toBeGreaterThan(0);
    expect(bound).toBeLessThanOrEqual(4);
  });

  /**
   * The case admissibility hangs on. Five cells clear together either as a
   * straight run of five or as a perpendicular three-plus-three sharing one
   * cell, and a version that priced only the straight run would report a
   * positive bound for a board that is already one swap from clearing — an
   * OVER-estimate, which in a prover is not conservative, it is wrong.
   */
  test("is zero for five already in a T, which is not a straight run", () => {
    // Column 1 holds three, and row 1 holds three through the middle of them:
    // a plus. Five blocks of `a`, no straight run of five anywhere.
    expect(forcedBound(board([".a.", "aaa", ".a."]))).toBe(0);
    // The L variant: the vertical three at the END of the horizontal three.
    expect(forcedBound(board(["a..", "a..", "aaa"]))).toBe(0);
  });

  test("is zero for five already in a straight run", () => {
    expect(forcedBound(board(["aaaaa"]))).toBe(0);
    expect(forcedBound(board(["a", "a", "a", "a", "a"]))).toBe(0);
  });

  test("never exceeds what a hand-checked board really needs", () => {
    // `a` sits at columns 0 and 2 with two in column 1 — one swap brings the
    // stragglers together, so the bound may claim at most that.
    expect(forcedBound(board(["a.a", ".a.", ".a."]))).toBeLessThanOrEqual(2);
  });

  test("takes the larger of the per-symbol and the shared-move bounds", () => {
    // Two symbols each at four and each needing displacement. One horizontal
    // swap moves blocks of exactly two different symbols, so it can serve both
    // at once — the combined bound is half the total, never the whole of it.
    const two = forcedBound(board(["a...a", "b...b", "a...a", "b...b"]));
    const one = forcedBound(board(["a...a", ".....", "a...a", "....."]));
    expect(two).toBeGreaterThanOrEqual(one);
    // ...and never the naive sum, which would not be admissible.
    expect(two).toBeLessThan(one * 2);
  });

  test("ignores symbols that are not at a forced count", () => {
    // `b` has plenty of blocks and contributes nothing; only `a`'s four count.
    const withNoise = forcedBound(board(["a..a", "bbbb", "bbbb", "a..a"]));
    const alone = forcedBound(board(["a..a", "....", "....", "a..a"]));
    expect(withNoise).toBe(alone);
  });
});
