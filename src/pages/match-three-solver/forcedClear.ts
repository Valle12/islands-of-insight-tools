// The forced-single-clear bound: this puzzle's one admissible lower bound that
// is actually worth computing. The C++ twin is a-star/ForcedClear.h.
//
// The stranded prune catches a symbol down to one or two blocks — it can never
// line up again. Four and five say something stronger. Every clear takes at
// least three blocks of the symbol it clears, so a symbol's clears partition its
// blocks into parts of three or more; for four the only partition is {4} and for
// five it is {5}. A symbol at exactly four or five blocks must therefore lose
// ALL of them in a SINGLE clear — taking three would leave one or two behind,
// and the stranded prune then calls that dead.
//
// So every one of those blocks has to reach one clearing shape together. And
// reaching it costs MOVES, because:
//
//   * a block changes column only via a horizontal swap, exactly one column at a
//     time — gravity and cascades are vertical;
//   * a horizontal swap moves two blocks of two DIFFERENT symbols (swapping
//     equal symbols is not a legal move), so per move at most ONE block of any
//     given symbol changes column, by one.
//
// Hence the least total horizontal displacement from where those blocks are to
// any single clearing shape is a lower bound on the moves still needed. Unlike
// the rejected "remaining * 3 cells" bound it is immune to cascades, because a
// cascade moves nothing horizontally.
//
// Two deliberate under-estimates keep it admissible. Vertical positions are
// treated as free, though gravity is not in fact controllable; and blockades are
// ignored, though they restrict which swaps exist. Both only ever make the bound
// smaller, which is the safe direction for a prover.
//
// Measured before it was built (a-star/bench/HARD-BOARDS.md): it takes
// matchThreeTest47's proof floor from 11 to 12 at a 60 s budget, and does it
// with FEWER nodes. Its weaker predecessor — the plain "get three of them
// aligned" bound over every symbol — pruned zero of ~15 000 states and was
// rejected.

import { FIRST_SYMBOL, isSymbol } from "./cell";
import { MIN_RUN, type MatchThreeBoard } from "./rules";
import { SYMBOL_COUNT } from "./symbols";

/** No symbol is at a forced-single-clear count, so the bound says nothing. */
export const NO_BOUND = -1;

/**
 * The block counts this bound has anything to say about. Below MIN_FORCED the
 * stranded prune already applies; above MAX_FORCED a symbol can split its blocks
 * across two clears and nothing is forced.
 */
const MIN_FORCED = 4;
const MAX_FORCED = 5;

/** Whether any symbol sits at a count that forces a single clear. */
export function anyForcedCount(counts: Int32Array): boolean {
  for (let i = 0; i < SYMBOL_COUNT; i++) {
    const n = counts[i]!;
    if (n === MIN_FORCED || n === MAX_FORCED) return true;
  }
  return false;
}

/** Least displacement to bring every block into one column — a vertical run. */
function intoOneColumn(cols: number[], width: number): number {
  let best = Infinity;
  for (let c = 0; c < width; c++) {
    let total = 0;
    for (const x of cols) total += Math.abs(x - c);
    if (total < best) best = total;
  }
  return best;
}

/** Total displacement pairing each sorted block with its sorted target. */
function totalDistance(sorted: number[], targets: number[]): number {
  let total = 0;
  for (let i = 0; i < targets.length; i++) {
    total += Math.abs(sorted[i]! - targets[i]!);
  }
  return total;
}

/**
 * Least displacement to one block per column across a window as wide as the
 * group — a horizontal run. Sorted-to-sorted is optimal on a line.
 */
function intoOneRow(sorted: number[], width: number): number {
  const n = sorted.length;
  let best = Infinity;
  for (let c = 0; c + n - 1 < width; c++) {
    let total = 0;
    for (let i = 0; i < n; i++) total += Math.abs(sorted[i]! - (c + i));
    if (total < best) best = total;
  }
  return best;
}

/**
 * The column multiset of a T whose stem sits in column `stem`, within the
 * three-wide window starting at `from`: three blocks in the stem column and one
 * in each of its two neighbours.
 */
function teeTargets(from: number, stem: number): number[] {
  const targets: number[] = [];
  for (let c = from; c < from + MIN_RUN; c++) {
    for (let k = 0; k < (c === stem ? MIN_RUN : 1); k++) targets.push(c);
  }
  return targets;
}

/**
 * Least displacement to a T, L or plus: a vertical three and a horizontal three
 * sharing one cell, so three consecutive columns with three blocks in one of
 * them and one in each of the others.
 *
 * This shape is why a count of five cannot reuse the straight-run cost. Five
 * cells clear together either as a run of five or as a perpendicular 3+3
 * overlapping in one cell, and pricing only the run would OVER-estimate — which
 * in a prover is not conservative, it is wrong.
 */
function intoTee(sorted: number[], width: number): number {
  let best = Infinity;
  for (let from = 0; from + MIN_RUN - 1 < width; from++) {
    for (let stem = from; stem < from + MIN_RUN; stem++) {
      const total = totalDistance(sorted, teeTargets(from, stem));
      if (total < best) best = total;
    }
  }
  return best;
}

/** Moves this symbol alone still needs, for a symbol at four or five blocks. */
function costForSymbol(sorted: number[], width: number): number {
  const straight = Math.min(intoOneColumn(sorted, width), intoOneRow(sorted, width));
  return sorted.length === MAX_FORCED
    ? Math.min(straight, intoTee(sorted, width))
    : straight;
}

/**
 * Columns of every live block, per symbol. A symbol stops being recorded past
 * five, because only four and five say anything — one with thirty blocks costs
 * nothing beyond its counter.
 */
function collectColumns(board: MatchThreeBoard): {
  columns: number[][];
  counts: Int32Array;
} {
  const { width, height } = board;
  const columns: number[][] = Array.from({ length: SYMBOL_COUNT }, () => []);
  const counts = new Int32Array(SYMBOL_COUNT);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const cell = board.cells[y * width + x]!;
      if (!isSymbol(cell)) continue;
      const s = cell - FIRST_SYMBOL;
      if (counts[s]! < MAX_FORCED) columns[s]!.push(x);
      counts[s] = counts[s]! + 1;
    }
  }
  return { columns, counts };
}

/**
 * The bound, or `NO_BOUND` when no symbol is at a forced-single-clear count.
 *
 * Two admissible combinations, take the larger: each symbol's own cost is a
 * bound by itself (one unit per move per symbol), and half the total rounded up
 * is one too, because a horizontal swap moves blocks of exactly two different
 * symbols and so can serve two of them at once but never more.
 *
 * Guard the call with `anyForcedCount` on the counts the search already keeps —
 * this walks the board, and there is no reason to walk it where it cannot speak.
 */
export function forcedBound(board: MatchThreeBoard): number {
  const { columns, counts } = collectColumns(board);
  let max = NO_BOUND;
  let sum = 0;
  for (let s = 0; s < SYMBOL_COUNT; s++) {
    const count = counts[s]!;
    if (count !== MIN_FORCED && count !== MAX_FORCED) continue;
    const sorted = [...columns[s]!].sort((a, b) => a - b);
    const cost = costForSymbol(sorted, board.width);
    if (cost > max) max = cost;
    sum += cost;
  }
  if (max === NO_BOUND) return NO_BOUND;
  return Math.max(max, Math.ceil(sum / 2));
}
