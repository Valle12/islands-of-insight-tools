import { EMPTY, FIRST_SYMBOL, isSymbol, symbolIndexOf } from "./cell";
import { SOLVE_BUDGET_MS } from "./config";
import { beamSearch, greedySearch } from "./fastSolvers";
import { anyForcedCount, forcedBound, NO_BOUND } from "./forcedClear";
import { runNrpa } from "./nrpa";
import {
  applyGravity,
  applyMove,
  blockCount,
  cellAt,
  findMatchesInto,
  hasRunThrough,
  markRunsThrough,
  MIN_RUN,
  type MatchThreeBoard,
  type Move,
} from "./rules";
import { SYMBOL_COUNT } from "./symbols";
import { TransTable } from "./transTable";

/**
 * What the engine is doing right now. `greedy`, `beam` and `nrpa` are the arms
 * looking for any clearing sequence; `prove` is the deepening that rules
 * shorter lengths out; `grouping` runs once the length is settled and only
 * tidies which same-length solution gets shown.
 */
export type SolvePhase = "greedy" | "beam" | "nrpa" | "prove" | "grouping";

export interface SolveProgress {
  readonly phase: SolvePhase;
  /** The deepest solution length fully ruled out so far. */
  readonly ruledOut: number;
  /** Length of the best solution found so far, or null before any. */
  readonly bestLength: number | null;
  readonly nodes: number;
}

export interface SolveOptions {
  readonly budgetMs?: number;
  /**
   * Failed-state table ceiling override — a knob for tests and the bench,
   * not a page setting. Tiny values force eviction on every store, which is
   * how the tests prove eviction cannot change an answer.
   */
  readonly tableBytes?: number;
  readonly onProgress?: (progress: SolveProgress) => void;
  /**
   * Streams every improvement to the best-known solution, as it is found.
   * The client that holds the latest of these can stop the search at any
   * point and still have a playable answer.
   */
  readonly onBest?: (moves: Move[]) => void;
  /** Called once, as the search returns, with what it spent getting there. */
  readonly onStats?: (stats: SolveStats) => void;
}

/** What a finished search spent, however it ended. */
export interface SolveStats {
  /** Work units — fast-arm moves applied plus prover edges considered. */
  readonly nodes: number;
  /** Transposition-table entries held at return. */
  readonly tableEntries: number;
  /** The deepest prover iteration entered, completed or not. */
  readonly depthReached: number;
}

export type SolveResult =
  | {
      status: "solved";
      moves: Move[];
      /**
       * Whether the move count is proven minimal: every shorter length was
       * searched out. False means the search ran out of budget with this as
       * its best find — the count is honest, just not a proof.
       */
      proven: boolean;
      /**
       * Whether the search also finished proving this is the *best-grouped*
       * solution of its length. Only meaningful when `proven` is true; a
       * tidier ordering may exist either way.
       */
      groupingProven: boolean;
    }
  | { status: "unsolvable" }
  | {
      status: "budget";
      /** No solution of this many moves or fewer exists — that much IS proven. */
      readonly ruledOut: number;
    };

/** Nodes between clock reads. Reading the clock per node costs more than the search. */
const CHECK_INTERVAL = 2_000;

/** Progress posts at most this often; the page reads it at human speed. */
const PROGRESS_INTERVAL_MS = 100;

/**
 * Failed-state table ceiling. Past it the table evicts instead of growing —
 * the search slows down rather than dying, which is the point: the unbounded
 * predecessor took tens of GB into an OS kill on exactly the boards this
 * solver exists for.
 */
const TABLE_BYTES = 256 * 1024 * 1024;

/**
 * Whether two packed symbol pairs share a symbol. A pair is the two pre-swap
 * symbols of a move, packed `(a << 4) | b`.
 */
function sharesSymbol(left: number, right: number): boolean {
  const leftA = left >> 4;
  const leftB = left & 15;
  const rightA = right >> 4;
  const rightB = right & 15;
  return (
    leftA === rightA ||
    leftA === rightB ||
    leftB === rightA ||
    leftB === rightB
  );
}

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
  /** Pre-swap symbols packed as `(symbolA << 4) | symbolB`. */
  symbols: Int32Array;
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
    symbols: new Int32Array(16),
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
  level.symbols = growArray(level.symbols, capacity);
  level.cleared = growArray(level.cleared, capacity);
  level.scores = growArray(level.scores, capacity);
  level.order = growArray(level.order, capacity);
  level.deltas = growArray(level.deltas, capacity * SYMBOL_COUNT);
}

/**
 * Iterative-deepening DFS. Depth `d` is only reported once every shorter
 * length has been searched out, so a reported move count is always minimal —
 * and because every move clears at least `MIN_RUN` cells, the deepening
 * terminates on its own, which is what makes "unsolvable" a real proof rather
 * than a timeout in disguise.
 */
/** A solution handed to the prover to prove minimal — or beat. */
interface Incumbent {
  readonly moves: Move[];
  readonly switches: number;
}

class Search {
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
  private pathSymbols = new Int32Array(0);
  private pathLength = 0;
  private width = 0;
  private height = 0;

  private nodes = 0;
  private sinceCheck = 0;
  private expired = false;
  private depth = 0;
  private ruledOut = 0;
  private solutions = 0;
  private stopAtFirst = true;
  /** Whether the current first-pass iteration found any solution. */
  private passFound = false;
  private best: Move[] | null = null;
  private bestSwitches = Number.POSITIVE_INFINITY;
  private lastProgressMs = 0;

  constructor(options: SolveOptions, nodesOffset = 0) {
    this.deadline =
      performance.now() + (options.budgetMs ?? SOLVE_BUDGET_MS);
    this.onProgress = options.onProgress;
    this.onBest = options.onBest;
    this.tableBytes = options.tableBytes ?? TABLE_BYTES;
    this.nodesOffset = nodesOffset;
  }

  /** Sets up the per-board state both search modes need. Returns maxDepth. */
  private prepare(board: MatchThreeBoard, incumbent?: Incumbent): number {
    this.width = board.width;
    this.height = board.height;
    this.table = new TransTable(board.cells.length, this.tableBytes);
    this.seedSymbolCounts(board);
    if (incumbent) {
      this.best = incumbent.moves;
      this.bestSwitches = incumbent.switches;
    }
    const natural = Math.floor(blockCount(board) / MIN_RUN);
    this.pathMoves = new Int32Array(natural + 1);
    this.pathSymbols = new Int32Array(natural + 1);
    return natural;
  }

  /**
   * One bounded pass per bound, going straight to the deepest length worth
   * trying instead of climbing to it. A depth-B search covers every path of
   * length ≤ B, so a solution found this way is a real answer — just not a
   * proven-minimal one — and a pass that searches out proves the incumbent
   * minimal in one go.
   *
   * This is the only arm that finds anything at all on the hardest captured
   * boards: measured on matchThreeTest47 it turns up the 20-move solution
   * (which a 46-minute deepening run in July confirmed is optimal) where
   * every other arm returns nothing.
   */
  runDive(board: MatchThreeBoard, incumbent?: Incumbent): SolveResult {
    const natural = this.prepare(board, incumbent);
    const blocks = blockCount(board);
    if (blocks === 0) {
      return { status: "solved", moves: [], proven: true, groupingProven: true };
    }

    for (;;) {
      const bound = this.best
        ? Math.min(natural, this.best.length - 1)
        : natural;
      if (bound <= 0) break;

      this.depth = bound;
      this.passFound = false;
      this.stopAtFirst = true;
      this.explore(board, bound, blocks);
      if (this.passFound) continue;
      if (this.expired) break;

      // Searched out: nothing shorter than the incumbent exists.
      this.ruledOut = bound;
      if (!this.best) return { status: "unsolvable" };
      return {
        status: "solved",
        moves: this.best,
        proven: true,
        groupingProven: false,
      };
    }

    return this.best
      ? {
          status: "solved",
          moves: this.best,
          proven: this.ruledOut >= this.best.length - 1,
          groupingProven: false,
        }
      : { status: "budget", ruledOut: this.ruledOut };
  }

  run(board: MatchThreeBoard, incumbent?: Incumbent): SolveResult {
    const natural = this.prepare(board, incumbent);
    const blocks = blockCount(board);
    // With an incumbent in hand, exhausting every shorter length is a proof
    // of its minimality — the deepening never has to visit its own depth.
    const cap = this.best ? Math.min(natural, this.best.length - 1) : natural;

    for (let depth = 0; depth <= cap; depth++) {
      this.depth = depth;

      this.passFound = false;
      this.stopAtFirst = true;
      this.explore(board, depth, blocks);

      if (this.passFound) {
        // The length is settled — shorter than anything known. Spend what is
        // left of the budget looking for it arranged more conveniently.
        this.stopAtFirst = false;
        this.explore(board, depth, blocks);
        return {
          status: "solved",
          moves: this.best!,
          proven: true,
          groupingProven: !this.expired,
        };
      }
      // The iteration the clock interrupted proved nothing — only the depths
      // before it were actually searched out.
      if (this.expired) {
        return this.best
          ? {
              status: "solved",
              moves: this.best,
              proven: false,
              groupingProven: false,
            }
          : { status: "budget", ruledOut: this.ruledOut };
      }
      this.ruledOut = depth;
    }

    if (this.best) {
      // Every shorter length is searched out: the incumbent is minimal. What
      // remains of the budget goes to tidying its grouping at exactly its
      // length — shorter solutions were just proven not to exist.
      this.depth = this.best.length;
      this.stopAtFirst = false;
      this.explore(board, this.best.length, blocks);
      return {
        status: "solved",
        moves: this.best,
        proven: true,
        groupingProven: !this.expired,
      };
    }
    return { status: "unsolvable" };
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
        phase: this.stopAtFirst ? "prove" : "grouping",
        ruledOut: this.ruledOut,
        bestLength: this.best ? this.best.length : null,
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
      if (this.outOfTime() || (this.stopAtFirst && this.passFound)) {
        return false;
      }
      const child = level.order[i]!;
      this.pushStep(level, child);
      this.explore(
        level.boards[child]!,
        remaining - 1,
        blocks - level.cleared[child]!,
      );
      this.popStep(level, child);
    }
    return true;
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
    const cells = board.cells;

    for (let i = 0; i < moveCount; i++) {
      if (this.outOfTime() || (this.stopAtFirst && this.passFound)) {
        return false;
      }
      const packed = level.moves[i]!;
      if (this.applyInto(board, level.leaf, packed, level, 0) !== blocks) {
        continue;
      }
      const aIndex = packed >> 1;
      const bIndex = this.otherIndex(packed);
      this.pathMoves[this.pathLength] = packed;
      this.pathSymbols[this.pathLength] =
        ((cells[aIndex]! - FIRST_SYMBOL) << 4) | (cells[bIndex]! - FIRST_SYMBOL);
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
    const cells = board.cells;
    for (let i = 0; i < count; i++) {
      const packed = level.moves[i]!;
      const aIndex = packed >> 1;
      const bIndex = this.otherIndex(packed);
      level.symbols[i] =
        ((cells[aIndex]! - FIRST_SYMBOL) << 4) |
        (cells[bIndex]! - FIRST_SYMBOL);
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
   * Biggest clear first while the length is still in question — that is the
   * order that reaches an empty board soonest. Only once the length is
   * settled is it worth spending the ordering on staying with one symbol,
   * which is a property of the answer rather than a way of finding it.
   * Insertion sort, stable and allocation-free: descending score, ties in
   * enumeration order — the order the old `Array.sort` produced.
   */
  private sortChildren(level: Level, count: number): void {
    const previous =
      this.stopAtFirst || this.pathLength === 0
        ? -1
        : this.pathSymbols[this.pathLength - 1]!;
    for (let i = 0; i < count; i++) {
      const stay =
        previous >= 0 && sharesSymbol(level.symbols[i]!, previous) ? 1 : 0;
      level.scores[i] = stay * 65536 + level.cleared[i]!;
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
    this.pathSymbols[this.pathLength] = level.symbols[child]!;
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

  /**
   * How often the player has to switch which symbol they are working on. The
   * primary objective is the move count; this only picks between solutions
   * that already tie on it, because clearing one symbol at a time is far
   * easier to follow than hopping around the board.
   */
  private countSwitches(): number {
    let switches = 0;
    for (let i = 1; i < this.pathLength; i++) {
      if (!sharesSymbol(this.pathSymbols[i - 1]!, this.pathSymbols[i]!)) {
        switches++;
      }
    }
    return switches;
  }

  private keepSolution(): void {
    this.solutions++;
    this.passFound = true;
    const length = this.pathLength;
    const switches = this.countSwitches();
    if (this.best) {
      // A shorter solution always wins; at equal length the grouping decides.
      if (length > this.best.length) return;
      if (length === this.best.length && switches >= this.bestSwitches) return;
    }
    this.bestSwitches = switches;
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

/**
 * Share of what is left that the dive may spend. It only runs when the fast
 * arms came back empty-handed, so on an easy board this costs nothing at all —
 * and on a hard one it is the arm most likely to produce the only answer the
 * player will get.
 */
const DIVE_FRACTION = 0.5;

interface ArmsOutcome {
  readonly best: Move[] | null;
  readonly work: number;
}

/**
 * Greedy rollouts, then the beam ladder, each within its slice of the
 * budget. Improvements stream out through `onBest` the moment they exist.
 */
function runFastArms(
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
    options.onProgress?.({
      phase,
      ruledOut: 0,
      bestLength: best ? best.length : null,
      nodes: work,
    });
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

/**
 * The grouping metric of an arm's solution, replayed to read each swap's
 * pre-swap symbols — the prover needs it so an equal-grouping rearrangement
 * does not oust the incumbent for nothing.
 */
function movesSwitches(board: MatchThreeBoard, moves: Move[]): number {
  let current = board;
  let previous = -1;
  let switches = 0;
  for (const move of moves) {
    const first = symbolIndexOf(cellAt(current, move.a.x, move.a.y));
    const second = symbolIndexOf(cellAt(current, move.b.x, move.b.y));
    const symbols = (first << 4) | second;
    if (previous >= 0 && !sharesSymbol(previous, symbols)) switches++;
    previous = symbols;
    const outcome = applyMove(current, move);
    if (!outcome) break;
    current = outcome.board;
  }
  return switches;
}

/**
 * The anytime pipeline: greedy rollouts and a beam find SOME clearing
 * sequence early (streamed via `onBest`), then the deepening prover works
 * minimality from below with the incumbent's length as its cap. Easy boards
 * end exactly as they always did — proven, in milliseconds — because the
 * arms give up early when there is nothing to find; hard boards end with a
 * labeled best instead of nothing.
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
    return { status: "solved", moves: [], proven: true, groupingProven: true };
  }

  const arms = runFastArms(board, blocks, budgetMs, deadline, options);
  let best = arms.best;
  let work = arms.work;

  // Nothing found yet: one bounded dive is the difference between a labeled
  // answer and "gave up" on the boards that need it most.
  if (!best) {
    const left = Math.max(0, deadline - performance.now());
    const dive = new Search(
      { ...options, budgetMs: left * DIVE_FRACTION },
      work,
    );
    const dived = dive.runDive(board);
    work = dive.stats().nodes;
    if (dived.status === "solved" && dived.moves.length > 0) {
      if (dived.proven) {
        options.onStats?.(dive.stats());
        return dived;
      }
      best = dived.moves;
    } else if (dived.status === "unsolvable") {
      options.onStats?.(dive.stats());
      return dived;
    }
  }

  const search = new Search(
    { ...options, budgetMs: Math.max(0, deadline - performance.now()) },
    work,
  );
  const incumbent = best
    ? { moves: best, switches: movesSwitches(board, best) }
    : undefined;
  const result = search.run(board, incumbent);
  options.onStats?.(search.stats());
  return result;
}
