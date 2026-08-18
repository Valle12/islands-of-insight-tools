// Nested Rollout Policy Adaptation.
//
// The arm that cracked matchThreeTest51 — 16 moves in 13 seconds, on a board
// where greedy, the beam, the dive and the deepening prover had between them
// never produced a single witness at any budget. NRPA holds the records on
// SameGame and Morpion Solitaire, and SameGame is close enough to this puzzle
// (clear groups of like-colored blocks under gravity) that the transfer is not
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

/** One rung of the restart ladder: nesting depth, and iterations per level. */
interface Rung {
  readonly level: number;
  readonly iterations: number;
}

/**
 * What a restart cycles through, and the second reason restarts work at all.
 * A fresh policy alone only changes WHERE the search looks; the nesting level
 * changes HOW — level 2 runs many shallow adaptations, level 4 few deep ones —
 * and on matchThreeTest50 that difference decides the board.
 *
 * **The rungs cost the same on purpose, and getting that wrong cost a
 * two-thirds drop in solve rate.** A rung is `iterations ** level` playouts, so
 * the natural-looking counts are wildly unequal: level 2 x 100 is 10 000
 * playouts, level 3 x 30 is 27 000, level 4 x 20 is 160 000 — about 94 s of
 * search, more than a whole 45 s slice. A ladder carrying that rung gets one
 * cheap restart, one medium one, then nothing, because the expensive rung
 * swallows every second that was left. Measured natively on test50, eight seeds
 * at 45 s: level 2 x 100 pinned solves 6 of 8, the unequal ladder solves 2.
 * Equal cost is what makes the level a diversity axis rather than a lottery on
 * how much budget the cycle happens to reach. All three rungs are ~10 000
 * playouts, and at a fixed 45 s seeds 0 and 1 answer only to level 2 while seed
 * 4 answers only to level 4 — which is why all three stay.
 */
const LADDER: Rung[] = [
  { level: 2, iterations: 100 },
  { level: 3, iterations: 22 },
  { level: 4, iterations: 10 },
];

/**
 * Restarts with no improvement to the best line before the arm gives up.
 *
 * Restarts alone are unbounded on a board nothing can clear: `best.left` never
 * reaches 0, so the loop spins until the deadline — which on an unsolvable board
 * meant burning the whole 60 s slice before the prover got to say so, and four
 * unit tests duly timed out. So the arm needs greedy's patience idea.
 *
 * It counts BARREN RESTARTS and not, as would be tempting, restarts since the
 * last improvement *within* a run: on matchThreeTest50 the winning restart goes
 * from 9 blocks left straight to 0 while every other restart also reaches 9, so
 * "stop when nothing is improving" would cut off precisely the draw that wins.
 * The count is generous for the same reason — the corpus's winners land within
 * ~5 restarts and a 300 s slice only fits ~50, so this never binds on a board
 * worth searching, while on a dead one every restart is near-instant.
 */
const BARREN_RESTARTS = 64;

/**
 * `level` / `iterations` pin one rung and switch the ladder off — for the bench
 * sweeps and for a portfolio arm that wants a fixed character. Left unset, one
 * arm covers every rung.
 */
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
   * because fewest-blocks-left is the score it optimizes — but a partial line is
   * not an answer, and handing one out as if it were sent a move list that does
   * not clear the board through the C++ twin's CLI.
   */
  readonly moves: Move[];
  /**
   * The best line itself, complete or not — diagnostics, NEVER an answer.
   * `moves` is the answer; this is what the campaign harness replays to reach
   * the state NRPA plateaued at so an exact search can try to finish it.
   */
  readonly partial: Move[];
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
  const pinned: Rung | null = options.level
    ? {
        level: options.level,
        iterations: options.iterations ?? LADDER[0]!.iterations,
      }
    : null;
  const rungFor = (restart: number): Rung =>
    pinned ?? LADDER[restart % LADDER.length]!;
  const rng = mulberry32(options.seed ?? 0x5eed);
  const total = blockCount(start);
  const width = start.width;

  /** A move's policy slot: the cell it starts from, plus its direction. */
  const codeOf = (move: Move): number =>
    ((move.a.y * width + move.a.x) << 1) | (move.b.y > move.a.y ? 1 : 0);

  let playouts = 0;
  let best: Line = { moves: [], left: total };

  // Nothing to look for: a symbol already down to one or two blocks can never
  // line up again, so no playout can clear this board. Exact and free, and it
  // is the difference between the prover being told immediately and the slice
  // being spent first.
  if (total > 0 && hasStrandedSymbol(start)) {
    return { moves: [], partial: [], left: total, playouts: 0 };
  }

  // The same argument for a board with no legal swap at all. `hasStrandedSymbol`
  // does not cover it — a diagonal weave can hold nine blocks of every symbol
  // and still offer no move — so without this every playout breaks on its first
  // `expand`, `best.left` never falls, and the ladder runs the full
  // BARREN_RESTARTS x ~10 000 playouts before the prover is told. Measured:
  // ~3.2 s of the slice on a 6x6 weave, which is what pushed three unit tests
  // past bun's default 5 s timeout.
  if (total > 0 && legalMoves(start).length === 0) {
    return { moves: [], partial: [], left: total, playouts: 0 };
  }

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

  let iterations = LADDER[0]!.iterations;

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

  // Restarts, and they are the whole difference between finding
  // matchThreeTest50 and not. A level-N search exhausts its iterations and
  // returns; the losing runs come back with two thirds of the slice unspent,
  // and their plateau state is usually PROVABLY dead (exact endgame search: 3
  // of 4 harvested test50 plateaus unsolvable). A run that plateaus has not run
  // out of search, it has run out of THIS policy. The RNG keeps its stream
  // across restarts rather than being re-seeded, so a restart cannot repeat a
  // policy already tried and the caller's seed still reproduces everything.
  let restarts = 0;
  let barren = 0;
  while (
    best.left !== 0 &&
    barren < BARREN_RESTARTS &&
    performance.now() < deadline
  ) {
    const before = best.left;
    const rung = rungFor(restarts);
    iterations = rung.iterations;
    search(rung.level, new Policy(start.cells.length));
    restarts++;
    barren = best.left < before ? 0 : barren + 1;
  }
  return {
    moves: best.left === 0 ? best.moves : [],
    partial: best.moves,
    left: best.left,
    playouts,
  };
}
