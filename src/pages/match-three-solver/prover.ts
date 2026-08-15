// The exhaustive prover: one bounded DFS pass over move count, with a bounded
// transposition table of states searched out in vain.
//
// The finder of last resort AND the only thing in this engine that can call a
// board unclearable, which is why it gets its own file: everything here is in
// service of one recursion staying allocation-free, and none of it is of any
// use to the cheap arms. Mirrors `a-star/SearchProver.cpp`, which is split from
// its own cheap arms the same way.

import { EMPTY, FIRST_SYMBOL, isSymbol } from "./cell";
import { SOLVE_BUDGET_MS } from "./config";
import { anyForcedCount, forcedBound, NO_BOUND } from "./forcedClear";
import {
  applyGravity,
  blockCount,
  findMatchesInto,
  hasRunThrough,
  markRunsThrough,
  MIN_RUN,
  type MatchThreeBoard,
  type Move,
} from "./rules";
import { SYMBOL_COUNT } from "./symbols";
import { TransTable } from "./transTable";
import {
  CHECK_INTERVAL,
  PROGRESS_INTERVAL_MS,
  TABLE_BYTES,
  type SolveOptions,
  type SolveProgress,
  type SolveResult,
  type SolveStats,
} from "./engineTypes";

/**
 * Per-recursion-level scratch, allocated once and reused by every node that
 * ever runs at that depth: the boards its children land in, their sort keys,
 * and the shared masks. This is what makes a node expansion allocation-free —
 * the previous shape built ~450 objects and ~13 KB of typed arrays per node,
 * and the collector was a measurable slice of the search.
 */
interface Level {
  /** Child boards, created on first use and overwritten ever after. */
  boards: (MatchThreeBoard | undefined)[];
  /** Moves packed as `(cellIndex << 1) | downBit`. */
  moves: Int32Array;
  cleared: Int32Array;
  scores: Int32Array;
  order: Int32Array;
  /** Per-child, per-symbol cleared counts, `SYMBOL_COUNT` slots per child. */
  deltas: Int32Array;
  /** Scratch clone the swap-legality probe swaps and unswaps in place. */
  probe: MatchThreeBoard;
  /** Match-mask scratch shared by every child's cascade. */
  mask: Uint8Array;
  /** Where a last move is played out; only "did it clear everything" matters. */
  leaf: MatchThreeBoard;
  capacity: number;
}

function newBoard(width: number, height: number): MatchThreeBoard {
  return { width, height, cells: new Uint8Array(width * height) };
}

function newLevel(width: number, height: number): Level {
  return {
    boards: [],
    moves: new Int32Array(16),
    cleared: new Int32Array(16),
    scores: new Int32Array(16),
    order: new Int32Array(16),
    deltas: new Int32Array(16 * SYMBOL_COUNT),
    probe: newBoard(width, height),
    mask: new Uint8Array(width * height),
    leaf: newBoard(width, height),
    capacity: 16,
  };
}

function growArray(old: Int32Array, capacity: number): Int32Array {
  const next = new Int32Array(capacity);
  next.set(old);
  return next;
}

function ensureCapacity(level: Level, needed: number): void {
  if (needed <= level.capacity) return;
  const capacity = level.capacity * 2;
  level.capacity = capacity;
  level.moves = growArray(level.moves, capacity);
  level.cleared = growArray(level.cleared, capacity);
  level.scores = growArray(level.scores, capacity);
  level.order = growArray(level.order, capacity);
  level.deltas = growArray(level.deltas, capacity * SYMBOL_COUNT);
}

/**
 * DFS to a fixed depth, returning the first solution it reaches — the length
 * of which it claims nothing about.
 *
 * It used to deepen one length at a time, which did make a reported move count
 * minimal; the single pass at `floor(blocks / MIN_RUN)` searches the same space
 * for a fraction of the work, because every move clears at least `MIN_RUN`
 * cells and no plan can be longer than that. Searching THAT depth out having
 * found nothing is what makes "unsolvable" a real proof rather than a timeout
 * in disguise — see `run`.
 */
export class Search {
  private readonly deadline: number;
  private readonly onProgress: ((progress: SolveProgress) => void) | undefined;
  private readonly onBest: ((moves: Move[]) => void) | undefined;
  private readonly tableBytes: number;
  /** Work the fast arms already did, folded into the reported counters. */
  private readonly nodesOffset: number;
  /** Boards searched out in vain, and at what remaining depth. */
  private table!: TransTable;
  private readonly levels: Level[] = [];
  /** Live blocks per symbol, patched as moves are pushed and popped. */
  private readonly symbolCounts = new Int32Array(SYMBOL_COUNT);
  private pathMoves = new Int32Array(0);
  private pathLength = 0;
  private width = 0;
  private height = 0;

  private nodes = 0;
  private sinceCheck = 0;
  private expired = false;
  private depth = 0;
  private solutions = 0;
  private best: Move[] | null = null;
  private lastProgressMs = 0;

  constructor(options: SolveOptions, nodesOffset = 0) {
    this.deadline =
      performance.now() + (options.budgetMs ?? SOLVE_BUDGET_MS);
    this.onProgress = options.onProgress;
    this.onBest = options.onBest;
    this.tableBytes = options.tableBytes ?? TABLE_BYTES;
    this.nodesOffset = nodesOffset;
  }

  /** Sets up the per-board state. Returns maxDepth. */
  private prepare(board: MatchThreeBoard): number {
    this.width = board.width;
    this.height = board.height;
    this.table = new TransTable(board.cells.length, this.tableBytes);
    this.seedSymbolCounts(board);
    const natural = Math.floor(blockCount(board) / MIN_RUN);
    this.pathMoves = new Int32Array(natural + 1);
    return natural;
  }

  /**
   * One exhaustive pass at the deepest length worth trying, returning the
   * moment it finds anything.
   *
   * `maxDepth = floor(blocks / MIN_RUN)` is a real ceiling, because every move
   * clears at least `MIN_RUN` cells — so a pass that searches out having found
   * nothing has PROVEN the board cannot be cleared. That is the only proof this
   * engine still makes, and it is about existence rather than length.
   *
   * It is also the arm that finds anything at all on the hardest captured
   * boards: measured on matchThreeTest47 it turns up a 20-move solution where
   * every cheap arm returns nothing.
   */
  run(board: MatchThreeBoard): SolveResult {
    const maxDepth = this.prepare(board);
    const blocks = blockCount(board);
    if (blocks === 0) return { status: "solved", moves: [] };
    if (maxDepth <= 0) return { status: "unsolvable" };

    this.depth = maxDepth;
    this.explore(board, maxDepth, blocks);

    if (this.best) return { status: "solved", moves: this.best };
    // Searched out with nothing found, and the clock never interrupted it.
    return this.expired ? { status: "budget" } : { status: "unsolvable" };
  }

  /** The counters `SolveOptions.onStats` reports. */
  stats(): SolveStats {
    return {
      nodes: this.nodesOffset + this.nodes,
      tableEntries: this.table ? this.table.size : 0,
      depthReached: this.depth,
    };
  }

  private seedSymbolCounts(board: MatchThreeBoard): void {
    this.symbolCounts.fill(0);
    for (const cell of board.cells) {
      if (!isSymbol(cell)) continue;
      const slot = cell - FIRST_SYMBOL;
      this.symbolCounts[slot] = this.symbolCounts[slot]! + 1;
    }
  }

  /**
   * True once some symbol is down to one or two blocks — nothing can ever
   * clear those, so the board is dead. The search's load-bearing prune, now
   * eight array reads instead of a full board rescan per node.
   */
  private hasStrandedSymbol(): boolean {
    for (let slot = 0; slot < SYMBOL_COUNT; slot++) {
      const count = this.symbolCounts[slot]!;
      if (count > 0 && count < MIN_RUN) return true;
    }
    return false;
  }

  /** True once the budget is gone; also the progress heartbeat. */
  private outOfTime(): boolean {
    this.nodes++;
    if (++this.sinceCheck < CHECK_INTERVAL) return this.expired;
    this.sinceCheck = 0;
    const now = performance.now();
    if (now - this.lastProgressMs >= PROGRESS_INTERVAL_MS) {
      this.lastProgressMs = now;
      this.onProgress?.({
        phase: "exhaustive",
        nodes: this.nodesOffset + this.nodes,
      });
    }
    if (now >= this.deadline) this.expired = true;
    return this.expired;
  }

  /**
   * Note what is deliberately NOT among the prunes here: "`remaining` moves
   * clear at most `remaining * MIN_RUN` cells". A move clears *at least*
   * three cells, never at most — one swap that sets off a cascade can empty
   * the whole board — so that bound cuts away the very solutions worth
   * finding.
   */
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
    if (this.hasStrandedSymbol()) return;
    // The forced-single-clear bound. Admissible, so a proof stays a proof: it
    // only ever says "this needs MORE moves than are left". Gated on the counts
    // the search already maintains, so the board walk behind it runs only where
    // it can possibly say something. See forcedClear.ts.
    if (anyForcedCount(this.symbolCounts)) {
      const need = forcedBound(board);
      if (need !== NO_BOUND && need > remaining) return;
    }
    if (this.table.probe(board.cells, remaining)) return;

    const found = this.solutions;
    const searchedOut =
      remaining === 1
        ? this.exploreLeaf(board, blocks)
        : this.exploreInner(board, remaining, blocks);

    // Only a subtree that was searched to the end, and came back with nothing,
    // may be written off — an entry from an abandoned subtree would prune a
    // branch that still holds the answer.
    if (searchedOut && this.solutions === found) {
      this.table.store(board.cells, remaining);
    }
  }

  private exploreInner(
    board: MatchThreeBoard,
    remaining: number,
    blocks: number,
  ): boolean {
    const level = this.level(this.pathLength);
    const moveCount = this.collectMoves(board, level);
    this.buildChildren(board, level, moveCount);
    this.sortChildren(level, moveCount);

    for (let i = 0; i < moveCount; i++) {
      if (this.outOfTime() || this.best !== null) return false;
      const child = level.order[i]!;
      this.pushStep(level, child);
      this.explore(
        level.boards[child]!,
        remaining - 1,
        blocks - level.cleared[child]!,
      );
      this.popStep(level, child);
    }
    // Not a bare `true`: the clock can run out INSIDE the last child, and the
    // loop then ends normally with no top-of-iteration check left to catch it.
    // Reported as searched out, that node — and every node above it that was
    // also on its parent's last branch — would be written off in the table as
    // proven barren. `this.expired` is read, never `outOfTime()`, which counts
    // a node as a side effect.
    return !this.expired;
  }

  /**
   * The last ply, where a move only matters if it clears the whole board:
   * each candidate is played into one scratch and thrown away, with no sort,
   * no keying and no child bookkeeping. The leaf ply is the majority of all
   * expansions in the tree, which is why it gets its own lean path.
   */
  private exploreLeaf(board: MatchThreeBoard, blocks: number): boolean {
    const level = this.level(this.pathLength);
    const moveCount = this.collectMoves(board, level);

    for (let i = 0; i < moveCount; i++) {
      if (this.outOfTime() || this.best !== null) return false;
      const packed = level.moves[i]!;
      if (this.applyInto(board, level.leaf, packed, level, 0) !== blocks) {
        continue;
      }
      this.pathMoves[this.pathLength] = packed;
      this.pathLength++;
      this.keepSolution();
      this.pathLength--;
    }
    return true;
  }

  private level(depth: number): Level {
    let level = this.levels[depth];
    if (!level) {
      level = newLevel(this.width, this.height);
      this.levels[depth] = level;
    }
    return level;
  }

  /**
   * Every legal swap, packed into `level.moves`. Right then down from each
   * cell, so a swap is offered exactly once — and in the same order the old
   * `legalMoves` enumerated, which keeps tie-broken solutions stable.
   */
  private collectMoves(board: MatchThreeBoard, level: Level): number {
    const { width, height, cells } = board;
    level.probe.cells.set(cells);
    let count = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (!isSymbol(cells[y * width + x]!)) continue;
        const index = y * width + x;
        count = this.tryMove(level, index, 0, count);
        count = this.tryMove(level, index, 1, count);
      }
    }
    return count;
  }

  /** Records a swap when it is in bounds, between two symbols, and clears. */
  private tryMove(
    level: Level,
    aIndex: number,
    down: number,
    count: number,
  ): number {
    const probe = level.probe;
    const { width, height, cells } = probe;
    const x = aIndex % width;
    const y = (aIndex - x) / width;
    const bx = down === 1 ? x : x + 1;
    const by = down === 1 ? y + 1 : y;
    if (bx >= width || by >= height) return count;

    const bIndex = by * width + bx;
    const a = cells[aIndex]!;
    const b = cells[bIndex]!;
    if (!isSymbol(b) || a === b) return count;

    cells[aIndex] = b;
    cells[bIndex] = a;
    const clears =
      hasRunThrough(probe, x, y) || hasRunThrough(probe, bx, by);
    cells[aIndex] = a;
    cells[bIndex] = b;
    if (!clears) return count;

    ensureCapacity(level, count + 1);
    level.moves[count] = (aIndex << 1) | down;
    return count + 1;
  }

  private otherIndex(packed: number): number {
    const aIndex = packed >> 1;
    return (packed & 1) === 1 ? aIndex + this.width : aIndex + 1;
  }

  private buildChildren(
    board: MatchThreeBoard,
    level: Level,
    count: number,
  ): void {
    for (let i = 0; i < count; i++) {
      const packed = level.moves[i]!;
      level.cleared[i] = this.applyInto(
        board,
        this.childBoard(level, i),
        packed,
        level,
        i,
      );
    }
  }

  private childBoard(level: Level, slot: number): MatchThreeBoard {
    let board = level.boards[slot];
    if (!board) {
      board = newBoard(this.width, this.height);
      level.boards[slot] = board;
    }
    return board;
  }

  /**
   * Plays `packed` out on a copy of `board` living in `child`: swap, clear
   * the first wave (marked through the two swapped cells only — the swap is
   * pre-proven legal, and on a settled board every new match passes through
   * a moved cell), then cascade until stable. Returns the cells cleared and
   * leaves the per-symbol breakdown in `level.deltas` at `slot`.
   */
  private applyInto(
    board: MatchThreeBoard,
    child: MatchThreeBoard,
    packed: number,
    level: Level,
    slot: number,
  ): number {
    const cells = child.cells;
    cells.set(board.cells);
    const aIndex = packed >> 1;
    const bIndex = this.otherIndex(packed);
    const held = cells[aIndex]!;
    cells[aIndex] = cells[bIndex]!;
    cells[bIndex] = held;

    const mask = level.mask;
    mask.fill(0);
    const ax = aIndex % this.width;
    const bx = bIndex % this.width;
    markRunsThrough(child, ax, (aIndex - ax) / this.width, mask);
    markRunsThrough(child, bx, (bIndex - bx) / this.width, mask);

    const base = slot * SYMBOL_COUNT;
    level.deltas.fill(0, base, base + SYMBOL_COUNT);
    let cleared = this.clearCounting(cells, mask, level.deltas, base);
    applyGravity(child);
    while (findMatchesInto(child, mask)) {
      cleared += this.clearCounting(cells, mask, level.deltas, base);
      applyGravity(child);
    }
    return cleared;
  }

  private clearCounting(
    cells: Uint8Array,
    mask: Uint8Array,
    deltas: Int32Array,
    base: number,
  ): number {
    let cleared = 0;
    for (let i = 0; i < mask.length; i++) {
      if (mask[i] === 0) continue;
      const slot = base + (cells[i]! - FIRST_SYMBOL);
      deltas[slot] = deltas[slot]! + 1;
      cells[i] = EMPTY;
      cleared++;
    }
    return cleared;
  }

  /**
   * Biggest clear first — the order that reaches an empty board soonest, which
   * is now the only thing the ordering is for. Insertion sort, stable and
   * allocation-free: descending score, ties in enumeration order.
   */
  private sortChildren(level: Level, count: number): void {
    for (let i = 0; i < count; i++) {
      level.scores[i] = level.cleared[i]!;
      level.order[i] = i;
    }
    for (let i = 1; i < count; i++) {
      const entry = level.order[i]!;
      const score = level.scores[entry]!;
      let j = i - 1;
      while (j >= 0 && level.scores[level.order[j]!]! < score) {
        level.order[j + 1] = level.order[j]!;
        j--;
      }
      level.order[j + 1] = entry;
    }
  }

  private pushStep(level: Level, child: number): void {
    this.pathMoves[this.pathLength] = level.moves[child]!;
    this.pathLength++;
    const base = child * SYMBOL_COUNT;
    for (let slot = 0; slot < SYMBOL_COUNT; slot++) {
      this.symbolCounts[slot] =
        this.symbolCounts[slot]! - level.deltas[base + slot]!;
    }
  }

  private popStep(level: Level, child: number): void {
    this.pathLength--;
    const base = child * SYMBOL_COUNT;
    for (let slot = 0; slot < SYMBOL_COUNT; slot++) {
      this.symbolCounts[slot] =
        this.symbolCounts[slot]! + level.deltas[base + slot]!;
    }
  }

  /** The first solution reached is the answer; the search stops right after. */
  private keepSolution(): void {
    this.solutions++;
    if (this.best) return;
    this.best = this.decodePath();
    this.onBest?.(this.best);
  }

  /** The packed path as the `Move[]` the page and the viewer speak. */
  private decodePath(): Move[] {
    const moves: Move[] = [];
    for (let i = 0; i < this.pathLength; i++) {
      const packed = this.pathMoves[i]!;
      const aIndex = packed >> 1;
      const x = aIndex % this.width;
      const y = (aIndex - x) / this.width;
      const b = (packed & 1) === 1 ? { x, y: y + 1 } : { x: x + 1, y };
      moves.push({ a: { x, y }, b });
    }
    return moves;
  }
}
