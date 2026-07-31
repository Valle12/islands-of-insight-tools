// Nested Rollout Policy Adaptation.
//
// The arm that cracked matchThreeTest51 — 16 moves in 13 seconds, on a board
// where greedy, the beam, the dive and the deepening prover had between them
// never produced a single witness at any budget. NRPA holds the records on
// SameGame and Morpion Solitaire, and SameGame is close enough to this puzzle
// (clear groups of like-coloured blocks under gravity) that the transfer is not
// a coincidence.
//
// How it works: a POLICY assigns a weight to every move, playouts sample moves
// in proportion to exp(weight), and each nesting level repeatedly (a) runs the
// level below, (b) keeps the best sequence it saw, and (c) nudges the policy
// toward that sequence. Level 0 is a single playout. The nudge is what makes it
// more than random restarts: a move that appears in good lines gets easier to
// draw, so the search concentrates on a promising REGION of the space rather
// than a promising single line.
//
// It proves nothing. Like the other fast arms it exists to find a witness, and
// the provers decide what is minimal.

import {
  applyMove,
  blockCount,
  hasStrandedSymbol,
  legalMoves,
  type MatchThreeBoard,
  type Move,
} from "./rules";

/**
 * How far the policy moves toward a good sequence per adaptation. 1.0 is the
 * value the original NRPA paper uses and what the measurement that solved
 * matchThreeTest51 ran with.
 */
const ALPHA = 1;

/** Nesting depth and iterations per level. Level 3 x 30 solved test51. */
export interface NrpaOptions {
  readonly level?: number;
  readonly iterations?: number;
  readonly seed?: number;
}

export interface NrpaResult {
  /**
   * The solution, or empty when nothing cleared the board.
   *
   * Only ever a COMPLETE line. The search itself tracks its best partial line,
   * because fewest-blocks-left is the score it optimises — but a partial line is
   * not an answer, and handing one out as if it were sent a move list that does
   * not clear the board through the C++ twin's CLI.
   */
  readonly moves: Move[];
  /** Blocks the best line left behind; 0 means solved. */
  readonly left: number;
  /** Playouts run, for the work counter. */
  readonly playouts: number;
}

/** Deterministic sampling — a seed has to reproduce a run exactly. */
function mulberry32(seed: number): () => number {
  let a = Math.trunc(seed);
  return () => {
    a = Math.imul(a + 0x6d2b79f5, 1);
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Step {
  readonly move: Move;
  readonly board: MatchThreeBoard;
  readonly cleared: number;
}

/**
 * The policy: one weight per move code. A move is coded by the cell it starts
 * from and whether its partner is below — the same packing the engines use for
 * moves, so the code is position-based and stays meaningful across playouts,
 * which is what NRPA needs of it.
 */
class Policy {
  private readonly weights: Float64Array;

  constructor(cells: number) {
    this.weights = new Float64Array(cells * 2);
  }

  get(code: number): number {
    return this.weights[code]!;
  }

  add(code: number, delta: number): void {
    this.weights[code] = this.weights[code]! + delta;
  }

  clone(): Policy {
    const copy = new Policy(this.weights.length / 2);
    copy.weights.set(this.weights);
    return copy;
  }
}

function expand(board: MatchThreeBoard, left: number): Step[] {
  const steps: Step[] = [];
  for (const move of legalMoves(board)) {
    const outcome = applyMove(board, move);
    if (!outcome) continue;
    steps.push({ move, board: outcome.board, cleared: outcome.cleared });
    if (left - outcome.cleared === 0) {
      // A finishing move is never worth sampling against — take it.
      return [steps.at(-1)!];
    }
  }
  return steps;
}

/** One line, and what it left behind. */
interface Line {
  readonly moves: Move[];
  readonly left: number;
}

/** A move's weight under a policy, as the sampler sees it. */
type WeightOf = (move: Move) => number;

/**
 * `exp(weight)` per step and their sum — the sampling distribution itself.
 * Shared by the sampler and the adaptation, which have to agree on it exactly:
 * `adapt` subtracts each move's probability under the policy the playout drew
 * from, so a second, subtly different spelling here would silently teach the
 * policy the wrong lesson.
 */
function weigh(
  steps: Step[],
  weightOf: WeightOf,
): { weights: number[]; total: number } {
  let total = 0;
  const weights = steps.map(step => {
    const weight = Math.exp(weightOf(step.move));
    total += weight;
    return weight;
  });
  return { weights, total };
}

/** Draws one step in proportion to its weight. */
function sample(steps: Step[], weightOf: WeightOf, rng: () => number): Step {
  if (steps.length === 1) return steps[0]!;
  const { weights, total } = weigh(steps, weightOf);
  let target = rng() * total;
  for (let i = 0; i < steps.length; i++) {
    target -= weights[i]!;
    if (target <= 0) return steps[i]!;
  }
  return steps.at(-1)!;
}

export function runNrpa(
  start: MatchThreeBoard,
  options: NrpaOptions,
  deadline: number,
  onImproved: (moves: Move[]) => void,
): NrpaResult {
  const level = options.level ?? 3;
  const iterations = options.iterations ?? 30;
  const rng = mulberry32(options.seed ?? 0x5eed);
  const total = blockCount(start);
  const width = start.width;

  /** A move's policy slot: the cell it starts from, plus its direction. */
  const codeOf = (move: Move): number =>
    ((move.a.y * width + move.a.x) << 1) | (move.b.y > move.a.y ? 1 : 0);

  let playouts = 0;
  let best: Line = { moves: [], left: total };

  const playout = (policy: Policy): Line => {
    const weightOf: WeightOf = move => policy.get(codeOf(move));
    let board = start;
    let left = total;
    const moves: Move[] = [];
    while (left > 0) {
      const steps = expand(board, left);
      if (steps.length === 0) break;
      const chosen = sample(steps, weightOf, rng);
      moves.push(chosen.move);
      board = chosen.board;
      left -= chosen.cleared;
      if (left > 0 && hasStrandedSymbol(board)) break;
    }
    playouts++;
    if (left < best.left) {
      best = { moves, left };
      if (left === 0) onImproved(moves);
    }
    return { moves, left };
  };

  /**
   * Nudges the policy toward `moves`: the taken move gains, and every move that
   * was available loses in proportion to how likely the policy already was to
   * take it. Replaying the line is what makes "was available" meaningful.
   */
  const adapt = (policy: Policy, moves: Move[]): Policy => {
    const weightOf: WeightOf = move => policy.get(codeOf(move));
    const next = policy.clone();
    let board = start;
    let left = total;
    for (const move of moves) {
      const steps = expand(board, left);
      if (steps.length === 0) break;
      const { weights, total: totalWeight } = weigh(steps, weightOf);
      const chosenCode = codeOf(move);
      next.add(chosenCode, ALPHA);
      for (let i = 0; i < steps.length; i++) {
        next.add(codeOf(steps[i]!.move), (-ALPHA * weights[i]!) / totalWeight);
      }
      const taken = steps.find(step => codeOf(step.move) === chosenCode);
      if (!taken) break;
      board = taken.board;
      left -= taken.cleared;
    }
    return next;
  };

  const search = (depth: number, policy: Policy): Line => {
    if (depth === 0) return playout(policy);
    let levelBest: Line = { moves: [], left: total };
    let current = policy;
    for (let i = 0; i < iterations; i++) {
      if (performance.now() >= deadline) break;
      const result = search(depth - 1, current);
      // `<=` rather than `<`: re-adapting toward an equally good sequence is
      // what lets the policy keep sharpening instead of stalling.
      if (result.left <= levelBest.left) levelBest = result;
      if (levelBest.left === 0) return levelBest;
      current = adapt(current, levelBest.moves);
    }
    return levelBest;
  };

  search(level, new Policy(start.cells.length));
  return {
    moves: best.left === 0 ? best.moves : [],
    left: best.left,
    playouts,
  };
}
