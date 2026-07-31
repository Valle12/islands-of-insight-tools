import { symbolIndexOf } from "./cell";
import { SOLVE_BUDGET_MS } from "./config";
import {
  applyMove,
  boardKey,
  cellAt,
  blockCount,
  hasStrandedSymbol,
  legalMoves,
  MIN_RUN,
  type MatchThreeBoard,
  type Move,
  type MoveOutcome,
} from "./rules";

export interface SolveProgress {
  /** The solution length currently being ruled out. */
  readonly depth: number;
  readonly nodes: number;
}

export interface SolveOptions {
  readonly budgetMs?: number;
  readonly onProgress?: (progress: SolveProgress) => void;
  /** Called once, as the search returns, with what it spent getting there. */
  readonly onStats?: (stats: SolveStats) => void;
}

/** What a finished search spent, however it ended. */
export interface SolveStats {
  /** Edges considered — the same counter the progress heartbeat reports. */
  readonly nodes: number;
  /** Transposition-table entries held at return. */
  readonly tableEntries: number;
  /** The deepest iteration entered, completed or not. */
  readonly depthReached: number;
}

export type SolveResult =
  | {
      status: "solved";
      moves: Move[];
      /**
       * Whether the search also finished proving this is the *best-grouped*
       * shortest solution. False means the move count is still minimal — that
       * part is never reported unproven — but a tidier ordering may exist.
       */
      groupingProven: boolean;
    }
  | { status: "unsolvable" }
  | { status: "budget"; depth: number };

/** Nodes between clock reads. Reading the clock per node costs more than the search. */
const CHECK_INTERVAL = 2_000;

/** The two symbols a swap exchanges. */
type MoveSymbols = readonly [number, number];

interface Child {
  readonly move: Move;
  readonly symbols: MoveSymbols;
  readonly outcome: MoveOutcome;
}

interface PathStep {
  readonly move: Move;
  readonly symbols: MoveSymbols;
}

function sharesSymbol(left: MoveSymbols, right: MoveSymbols): boolean {
  return (
    left[0] === right[0] ||
    left[0] === right[1] ||
    left[1] === right[0] ||
    left[1] === right[1]
  );
}

/**
 * How often the player has to switch which symbol they are working on. The
 * primary objective is the move count; this only picks between solutions that
 * already tie on it, because clearing one symbol at a time is far easier to
 * follow than hopping around the board.
 */
function countSwitches(path: readonly PathStep[]): number {
  let switches = 0;
  for (let i = 1; i < path.length; i++) {
    if (!sharesSymbol(path[i - 1]!.symbols, path[i]!.symbols)) switches++;
  }
  return switches;
}

/**
 * Iterative-deepening DFS. Depth `d` is only reported once every shorter
 * length has been searched out, so a reported move count is always minimal —
 * and because every move clears at least `MIN_RUN` cells, the deepening
 * terminates on its own, which is what makes "unsolvable" a real proof rather
 * than a timeout in disguise.
 */
class Search {
  private readonly deadline: number;
  private readonly onProgress: ((progress: SolveProgress) => void) | undefined;
  /** Board key -> the largest remaining depth it was searched out at, in vain. */
  private readonly failed = new Map<string, number>();
  private readonly path: PathStep[] = [];

  private nodes = 0;
  private sinceCheck = 0;
  private expired = false;
  private depth = 0;
  private solutions = 0;
  private stopAtFirst = true;
  private best: Move[] | null = null;
  private bestSwitches = Number.POSITIVE_INFINITY;

  constructor(options: SolveOptions) {
    this.deadline =
      performance.now() + (options.budgetMs ?? SOLVE_BUDGET_MS);
    this.onProgress = options.onProgress;
  }

  run(board: MatchThreeBoard): SolveResult {
    const blocks = blockCount(board);
    const maxDepth = Math.floor(blocks / MIN_RUN);

    for (let depth = 0; depth <= maxDepth; depth++) {
      this.depth = depth;

      this.stopAtFirst = true;
      this.explore(board, depth, blocks);

      if (this.best) {
        // The length is settled. Spend what is left of the budget looking for
        // the same length arranged more conveniently.
        this.stopAtFirst = false;
        this.explore(board, depth, blocks);
        return {
          status: "solved",
          moves: this.best,
          groupingProven: !this.expired,
        };
      }
      if (this.expired) return { status: "budget", depth };
    }

    return { status: "unsolvable" };
  }

  /** The counters `SolveOptions.onStats` reports. */
  stats(): SolveStats {
    return {
      nodes: this.nodes,
      tableEntries: this.failed.size,
      depthReached: this.depth,
    };
  }

  /** True once the budget is gone; also the progress heartbeat. */
  private outOfTime(): boolean {
    this.nodes++;
    if (++this.sinceCheck < CHECK_INTERVAL) return this.expired;
    this.sinceCheck = 0;
    this.onProgress?.({ depth: this.depth, nodes: this.nodes });
    if (performance.now() >= this.deadline) this.expired = true;
    return this.expired;
  }

  /**
   * Whether this state cannot possibly pay off within `remaining` moves.
   *
   * Note what is deliberately NOT here: "`remaining` moves clear at most
   * `remaining * MIN_RUN` cells". A move clears *at least* three cells, never
   * at most — one swap that sets off a cascade can empty the whole board — so
   * that bound cuts away the very solutions worth finding.
   */
  private hopeless(
    board: MatchThreeBoard,
    remaining: number,
    key: string,
  ): boolean {
    if (hasStrandedSymbol(board)) return true;
    const failedAt = this.failed.get(key);
    return failedAt !== undefined && failedAt >= remaining;
  }

  private expand(board: MatchThreeBoard): Child[] {
    const children = legalMoves(board).map(move => ({
      move,
      symbols: [
        symbolIndexOf(cellAt(board, move.a.x, move.a.y)),
        symbolIndexOf(cellAt(board, move.b.x, move.b.y)),
      ] as MoveSymbols,
      outcome: applyMove(board, move)!,
    }));

    // Biggest clear first while the length is still in question — that is the
    // order that reaches an empty board soonest. Only once the length is
    // settled is it worth spending the ordering on staying with one symbol,
    // which is a property of the answer rather than a way of finding it.
    const previous = this.stopAtFirst ? undefined : this.path.at(-1)?.symbols;

    children.sort((left, right) => {
      if (previous) {
        const stay =
          Number(sharesSymbol(right.symbols, previous)) -
          Number(sharesSymbol(left.symbols, previous));
        if (stay !== 0) return stay;
      }
      return right.outcome.cleared - left.outcome.cleared;
    });
    return children;
  }

  private keepSolution(): void {
    this.solutions++;
    const switches = countSwitches(this.path);
    if (switches >= this.bestSwitches) return;
    this.bestSwitches = switches;
    this.best = this.path.map(step => step.move);
  }

  private explore(
    board: MatchThreeBoard,
    remaining: number,
    blocks: number,
  ): void {
    if (blocks === 0) {
      this.keepSolution();
      return;
    }
    if (remaining === 0) return;

    const key = boardKey(board);
    if (this.hopeless(board, remaining, key)) return;

    const found = this.solutions;
    let searchedOut = true;

    for (const child of this.expand(board)) {
      if (this.outOfTime() || (this.stopAtFirst && this.best)) {
        searchedOut = false;
        break;
      }
      this.path.push({ move: child.move, symbols: child.symbols });
      this.explore(
        child.outcome.board,
        remaining - 1,
        blocks - child.outcome.cleared,
      );
      this.path.pop();
    }

    // Only a subtree that was searched to the end, and came back with nothing,
    // may be written off — an entry from an abandoned subtree would prune a
    // branch that still holds the answer.
    if (searchedOut && this.solutions === found) {
      this.failed.set(key, remaining);
    }
  }
}

export function solveMatchThree(
  board: MatchThreeBoard,
  options: SolveOptions = {},
): SolveResult {
  const search = new Search(options);
  const result = search.run(board);
  options.onStats?.(search.stats());
  return result;
}
