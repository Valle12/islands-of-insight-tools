// The fast, non-proving arms of the anytime pipeline: a greedy rollout
// restarter and a widening beam. Neither can prove anything — they exist to
// find SOME clearing sequence quickly, so the page has a best-so-far to show
// and the prover an upper bound to cap its deepening at. Both are
// deterministic: the rollout noise is seeded, the beam has none, so a given
// board reproduces the same candidates run to run (only where the budget
// cuts them off varies with the machine).

import {
  applyMove,
  boardKey,
  hasStrandedSymbol,
  legalMoves,
  type MatchThreeBoard,
  type Move,
  type MoveOutcome,
} from "./rules";

/**
 * Rollouts without an improvement before greedy gives up early. This is what
 * keeps easy boards instant: the arm's time slice is a cap, never a floor.
 */
const GREEDY_PATIENCE = 60;

/** Beam widths, tried in order while the slice lasts. */
const BEAM_WIDTHS = [128, 512, 2048];

/** Deterministic tie-break noise — the engine must reproduce run to run. */
function mulberry32(seed: number): () => number {
  // The generator lives on 32-bit wraparound arithmetic; Math.imul(x, 1) is
  // the ToInt32 wrap that a Math.trunc would get wrong past 2^31.
  let a = Math.trunc(seed);
  return () => {
    a = Math.imul(a + 0x6d2b79f5, 1);
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface RolloutPick {
  move: Move;
  outcome: MoveOutcome;
  won: boolean;
}

/**
 * The greedy policy at one state: the biggest clear that does not strand a
 * symbol (a stranded board is dead, so such a move is taken only when every
 * move strands), with seeded noise breaking cleared-count ties.
 */
function pickMove(
  board: MatchThreeBoard,
  blocks: number,
  rng: () => number,
  counter: { work: number },
): RolloutPick | null {
  let best: RolloutPick | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const move of legalMoves(board)) {
    const outcome = applyMove(board, move);
    if (!outcome) continue;
    counter.work++;
    if (blocks - outcome.cleared === 0) {
      return { move, outcome, won: true };
    }
    const alive = hasStrandedSymbol(outcome.board) ? 0 : 1;
    const score = alive * 1_000_000 + outcome.cleared * 256 + rng() * 255;
    if (score > bestScore) {
      bestScore = score;
      best = { move, outcome, won: false };
    }
  }
  return best;
}

/** One greedy line from the start; null when it dead-ends or cannot beat `bound`. */
function rolloutOnce(
  start: MatchThreeBoard,
  blocks: number,
  bound: number,
  rng: () => number,
  counter: { work: number },
): Move[] | null {
  let board = start;
  let left = blocks;
  const path: Move[] = [];
  while (path.length < bound) {
    const pick = pickMove(board, left, rng, counter);
    if (!pick) return null;
    path.push(pick.move);
    if (pick.won) return path;
    board = pick.outcome.board;
    left -= pick.outcome.cleared;
  }
  return null;
}

/**
 * Restarted greedy rollouts until the deadline or until `GREEDY_PATIENCE`
 * restarts in a row stop improving. Every improvement (a full clear shorter
 * than anything seen) goes out through `onImproved` as it is found.
 */
export function greedySearch(
  start: MatchThreeBoard,
  blocks: number,
  deadline: number,
  boundLength: number,
  onImproved: (moves: Move[]) => void,
  tick: (workDelta: number) => void,
): void {
  const rng = mulberry32(0x51ab);
  let bound = boundLength;
  let sinceImprovement = 0;
  while (performance.now() < deadline && sinceImprovement < GREEDY_PATIENCE) {
    const counter = { work: 0 };
    const moves = rolloutOnce(start, blocks, bound, rng, counter);
    tick(counter.work);
    sinceImprovement++;
    if (moves && moves.length < bound) {
      bound = moves.length;
      sinceImprovement = 0;
      onImproved(moves);
    }
  }
}

interface BeamNode {
  readonly board: MatchThreeBoard;
  readonly path: Move[];
  readonly blocks: number;
}

/**
 * Expands one frontier state into `next`: stranded children pruned,
 * duplicates within the level collapsed through `seen`. Returns the full
 * path the moment a child clears the board.
 */
function expandBeamNode(
  node: BeamNode,
  next: BeamNode[],
  seen: Set<string>,
  counter: { work: number },
): Move[] | null {
  for (const move of legalMoves(node.board)) {
    const outcome = applyMove(node.board, move);
    if (!outcome) continue;
    counter.work++;
    const left = node.blocks - outcome.cleared;
    if (left === 0) return [...node.path, move];
    if (hasStrandedSymbol(outcome.board)) continue;
    const key = boardKey(outcome.board);
    if (seen.has(key)) continue;
    seen.add(key);
    next.push({
      board: outcome.board,
      path: [...node.path, move],
      blocks: left,
    });
  }
  return null;
}

/**
 * One level-synchronous beam of the given width: the `width` states with the
 * fewest blocks left carry each level forward. Because levels advance one
 * move at a time, the first full clear found is the shortest this beam can
 * produce.
 */
function beamRun(
  start: MatchThreeBoard,
  blocks: number,
  width: number,
  deadline: number,
  bound: number,
  tick: (workDelta: number) => void,
): Move[] | null {
  let frontier: BeamNode[] = [{ board: start, path: [], blocks }];
  for (let level = 1; level < bound && frontier.length > 0; level++) {
    const next: BeamNode[] = [];
    const seen = new Set<string>();
    const counter = { work: 0 };
    for (const node of frontier) {
      if (performance.now() >= deadline) {
        tick(counter.work);
        return null;
      }
      const solution = expandBeamNode(node, next, seen, counter);
      if (solution) {
        tick(counter.work);
        return solution;
      }
    }
    tick(counter.work);
    next.sort((a, b) => a.blocks - b.blocks);
    frontier = next.slice(0, width);
  }
  return null;
}

/**
 * The beam ladder: each width once, narrowest first, while the slice lasts.
 * A wider beam re-searches with more room for the states a narrow one
 * discarded — that is the diversifier that shortens greedy's overshoot.
 */
export function beamSearch(
  start: MatchThreeBoard,
  blocks: number,
  deadline: number,
  boundLength: number,
  onImproved: (moves: Move[]) => void,
  tick: (workDelta: number) => void,
): void {
  let bound = boundLength;
  for (const width of BEAM_WIDTHS) {
    if (performance.now() >= deadline) return;
    const found = beamRun(start, blocks, width, deadline, bound, tick);
    if (found && found.length < bound) {
      bound = found.length;
      onImproved(found);
    }
  }
}
