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

/**
 * How sharply a sampling rollout still prefers the bigger clear. Measured over
 * four policies on matchThreeTest51: this one produced the most distinct
 * outcomes and got the furthest (7 blocks left, against 19 for the old
 * tie-break-only noise).
 */
const SAMPLING_TEMPERATURE = 3;

interface RolloutPick {
  move: Move;
  outcome: MoveOutcome;
  won: boolean;
}

/** Every move worth considering at one state, with what it costs the board. */
interface Candidate {
  readonly pick: RolloutPick;
  readonly cleared: number;
  /** False when the move strands a symbol, i.e. kills the board outright. */
  readonly alive: boolean;
}

function candidates(
  board: MatchThreeBoard,
  blocks: number,
  counter: { work: number },
): { list: Candidate[]; winner: RolloutPick | null } {
  const list: Candidate[] = [];
  for (const move of legalMoves(board)) {
    const outcome = applyMove(board, move);
    if (!outcome) continue;
    counter.work++;
    if (blocks - outcome.cleared === 0) {
      return { list, winner: { move, outcome, won: true } };
    }
    list.push({
      pick: { move, outcome, won: false },
      cleared: outcome.cleared,
      alive: !hasStrandedSymbol(outcome.board),
    });
  }
  return { list, winner: null };
}

/** The biggest clear that does not strand a symbol, or the biggest if all do. */
function bestCandidate(list: Candidate[]): RolloutPick | null {
  let best: Candidate | null = null;
  for (const candidate of list) {
    if (!best) {
      best = candidate;
      continue;
    }
    if (candidate.alive !== best.alive) {
      if (candidate.alive) best = candidate;
      continue;
    }
    if (candidate.cleared > best.cleared) best = candidate;
  }
  return best ? best.pick : null;
}

/**
 * Samples a move with probability rising in the clear size, so a restart really
 * takes a different line.
 *
 * The obvious cheaper thing — adding noise to the greedy score — does NOT
 * diversify, and that is not a subtlety: with `cleared * 256 + rng() * 255` the
 * noise is strictly smaller than one unit of `cleared`, so it can only break
 * exact ties. Measured on matchThreeTest51, 4000 restarts of that policy
 * produced **two** distinct outcomes. A noise term smaller than one unit of the
 * score it perturbs is not randomisation.
 */
function sampleCandidate(
  list: Candidate[],
  rng: () => number,
): RolloutPick | null {
  if (list.length === 0) return null;
  const live = list.some(candidate => candidate.alive);
  let total = 0;
  const weights = list.map(candidate => {
    // A move that strands a symbol is only ever taken when every move does.
    const weight =
      live && !candidate.alive
        ? 0
        : Math.exp(candidate.cleared / SAMPLING_TEMPERATURE);
    total += weight;
    return weight;
  });
  if (total === 0) return bestCandidate(list);

  let target = rng() * total;
  for (let i = 0; i < list.length; i++) {
    target -= weights[i]!;
    if (target <= 0) return list[i]!.pick;
  }
  return list.at(-1)!.pick;
}

/**
 * One line from the start; null when it dead-ends or cannot beat `bound`.
 *
 * `sample` false plays the pure greedy line, which is what the first rollout
 * does, and it is why the sampling below was added *after* it rather than in
 * place of it: measured over the 52 captured boards, that one greedy line
 * answers 38 of them and every one of those answers is already the proven
 * optimum, worst case 4 ms. Nothing here may cost the page that.
 */
function rolloutOnce(
  start: MatchThreeBoard,
  blocks: number,
  bound: number,
  sample: boolean,
  rng: () => number,
  counter: { work: number },
): Move[] | null {
  let board = start;
  let left = blocks;
  const path: Move[] = [];
  while (path.length < bound) {
    const { list, winner } = candidates(board, left, counter);
    const pick =
      winner ?? (sample ? sampleCandidate(list, rng) : bestCandidate(list));
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
  let rollouts = 0;
  while (performance.now() < deadline && sinceImprovement < GREEDY_PATIENCE) {
    const counter = { work: 0 };
    // Rollout one is the greedy line; every restart after it samples.
    const moves = rolloutOnce(start, blocks, bound, rollouts > 0, rng, counter);
    rollouts++;
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
