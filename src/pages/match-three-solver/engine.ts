// The match-three search: the cheap arms first, then one exhaustive pass that
// both finds and, if it comes back empty, proves the board unclearable.
//
// This file is the assembly and nothing else. The vocabulary is in
// `engineTypes.ts`, the cheap arms and their budget slices in `cheapArms.ts`,
// and the prover in `prover.ts` — the same three-way split the C++ twin has
// between `Search.h`, `SearchGreedy/Beam/Nrpa.cpp` and `SearchProver.cpp`.

import { blockCount, type MatchThreeBoard } from "./rules";
import { SOLVE_BUDGET_MS } from "./config";
import { runFastArms } from "./cheapArms";
import { Search } from "./prover";
import type { SolveOptions, SolveResult } from "./engineTypes";

// The page and the worker import all of this from here, which is what lets the
// split above be an implementation detail rather than a rename at every call
// site.
export type {
  SolveOptions,
  SolvePhase,
  SolveProgress,
  SolveResult,
  SolveStats,
} from "./engineTypes";

/**
 * Solves a board within a time budget, stopping at the FIRST solution it can
 * play rather than the shortest one.
 *
 * The cheap arms run first and answer almost everything: measured over the 52
 * captured boards, greedy alone answers 38 of them and every one of those 38
 * answers is what an exhaustive search would have called optimal anyway. What
 * is given up by not proving is small and measured — across the corpus the
 * first solution found is the minimal one on 48 of 49 boards.
 *
 * When nothing cheap works, one exhaustive pass to `maxDepth` both finds and,
 * if it comes back empty, proves the board unclearable.
 */
export function solveMatchThree(
  board: MatchThreeBoard,
  options: SolveOptions = {},
): SolveResult {
  const budgetMs = options.budgetMs ?? SOLVE_BUDGET_MS;
  const deadline = performance.now() + budgetMs;

  const blocks = blockCount(board);
  if (blocks === 0) {
    options.onStats?.({ nodes: 0, tableEntries: 0, depthReached: 0 });
    return { status: "solved", moves: [] };
  }

  const arms = runFastArms(board, blocks, budgetMs, deadline, options);
  if (arms.best) {
    options.onStats?.({
      nodes: arms.work,
      tableEntries: 0,
      depthReached: arms.best.length,
    });
    return { status: "solved", moves: arms.best };
  }

  // Nothing cheap worked. The exhaustive search is both the finder of last
  // resort and the only thing that can call the board unclearable, so it gets
  // everything that is left rather than a share of it.
  const search = new Search(
    { ...options, budgetMs: Math.max(0, deadline - performance.now()) },
    arms.work,
  );
  const result = search.run(board);
  options.onStats?.(search.stats());
  return result;
}
