// The three cheap arms and how the budget is divided between them.
//
// Greedy rollouts, then the beam ladder, then NRPA — each within a slice, and
// each run ONLY when the ones before it came back empty-handed. The algorithms
// themselves are in `fastSolvers.ts` and `nrpa.ts`; what lives here is the
// order, the slices and the reason each one is skipped once there is a witness.
//
// Separated from the prover because the two answer different questions: these
// arms can only ever FIND a solution, and none of them proves anything.

import { beamSearch, greedySearch } from "./fastSolvers";
import { runNrpa } from "./nrpa";
import { MIN_RUN, type MatchThreeBoard, type Move } from "./rules";
import {
  PROGRESS_INTERVAL_MS,
  type SolveOptions,
  type SolvePhase,
} from "./engineTypes";

/** The fast arms' slices — caps, never floors: both arms exit early when
 * they stop finding anything, which is what keeps easy boards instant. */
const GREEDY_SLICE_MS = 2_000;
const GREEDY_SLICE_FRACTION = 0.05;
const BEAM_SLICE_MS = 45_000;
const BEAM_SLICE_FRACTION = 0.2;

/**
 * NRPA's slice when the cheap arms found nothing. Bounded like theirs rather
 * than taking half of everything: it solved matchThreeTest51 in 13 s, so a
 * minute is generous, and every millisecond past that is one the dive and the
 * prover do not get — measured, an unbounded share cost the hard boards a
 * whole level of `ruledOut`.
 */
const NRPA_SLICE_MS = 60_000;
const NRPA_SLICE_FRACTION = 0.25;

export interface ArmsOutcome {
  readonly best: Move[] | null;
  readonly work: number;
}

/**
 * Greedy rollouts, then the beam ladder, each within its slice of the
 * budget. Improvements stream out through `onBest` the moment they exist.
 */
export function runFastArms(
  board: MatchThreeBoard,
  blocks: number,
  budgetMs: number,
  deadline: number,
  options: SolveOptions,
): ArmsOutcome {
  let best: Move[] | null = null;
  let work = 0;
  let lastPost = 0;

  const post = (phase: SolvePhase) => {
    const now = performance.now();
    if (now - lastPost < PROGRESS_INTERVAL_MS) return;
    lastPost = now;
    options.onProgress?.({ phase, nodes: work });
  };
  const improve = (moves: Move[]) => {
    if (best && moves.length >= best.length) return;
    best = moves;
    options.onBest?.(moves);
  };
  const bound = () =>
    best ? (best as Move[]).length : Math.floor(blocks / MIN_RUN) + 1;

  const greedyDeadline = Math.min(
    deadline,
    performance.now() +
      Math.min(GREEDY_SLICE_MS, budgetMs * GREEDY_SLICE_FRACTION),
  );
  greedySearch(board, blocks, greedyDeadline, bound(), improve, delta => {
    work += delta;
    post("greedy");
  });

  // Only when greedy came back empty-handed. The beam can only FIND a
  // solution, and measured on this corpus it has never shortened one greedy
  // already had — so with a witness in hand its budget belongs to the provers.
  if (!best) {
    const beamDeadline = Math.min(
      deadline,
      performance.now() +
        Math.min(BEAM_SLICE_MS, budgetMs * BEAM_SLICE_FRACTION),
    );
    beamSearch(board, blocks, beamDeadline, bound(), improve, delta => {
      work += delta;
      post("beam");
    });
  }

  // Only when the cheap arms came back empty-handed. NRPA is the arm for
  // boards they cannot touch — measured, it is the only thing that has ever
  // produced a witness for matchThreeTest51 — and on a board greedy already
  // solved there is nothing for it to add.
  if (!best) {
    const left = Math.max(0, deadline - performance.now());
    const nrpaDeadline =
      performance.now() + Math.min(NRPA_SLICE_MS, left * NRPA_SLICE_FRACTION);
    post("nrpa");
    const outcome = runNrpa(board, {}, nrpaDeadline, improve);
    work += outcome.playouts;
    post("nrpa");
  }

  return { best, work };
}
