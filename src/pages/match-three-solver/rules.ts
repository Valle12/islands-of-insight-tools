import type { MatchThreeCell, MatchThreeTest, Position } from "../../util/types";
import { BLOCKED, symbolIndexOf, EMPTY, isSymbol } from "./cell";

/** Cells that must line up before anything clears. */
export const MIN_RUN = 3;

/**
 * A board in the shape the search wants: one flat `Uint8Array` indexed
 * `y * width + x`, so a state is one cheap allocation to clone and one string
 * to key a transposition table with. The editor's `MatchThreeCell[][]` is
 * column-major (`cells[x][y]`); `toBoard` / `toGrid` convert between the two.
 */
export interface MatchThreeBoard {
  readonly width: number;
  readonly height: number;
  readonly cells: Uint8Array;
}

/** One player move: swapping two orthogonally adjacent blocks. */
export interface Move {
  readonly a: Position;
  readonly b: Position;
}

export interface MoveOutcome {
  readonly board: MatchThreeBoard;
  /**
   * The cells the swap clears before anything falls. This is what the step
   * viewer highlights — the cascade that follows is a consequence, not a thing
   * the player aims at.
   */
  readonly firstWave: Uint8Array;
  readonly cleared: number;
  readonly cascades: number;
}

export function toBoard(config: MatchThreeTest): MatchThreeBoard {
  const { gridWidth: width, gridHeight: height } = config;
  const cells = new Uint8Array(width * height);
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      cells[y * width + x] = config.cells[x]![y]!;
    }
  }
  return { width, height, cells };
}

export function toGrid(board: MatchThreeBoard): MatchThreeCell[][] {
  return Array.from({ length: board.width }, (_, x) =>
    Array.from(
      { length: board.height },
      (_unused, y) => board.cells[y * board.width + x]!,
    ),
  );
}

export function cellAt(board: MatchThreeBoard, x: number, y: number): number {
  return board.cells[y * board.width + x]!;
}

export function cloneBoard(board: MatchThreeBoard): MatchThreeBoard {
  return {
    width: board.width,
    height: board.height,
    cells: new Uint8Array(board.cells),
  };
}

/**
 * A transposition-table key. One character per cell beats joining digits: the
 * alphabet is tiny and the result is a single interned string.
 */
export function boardKey(board: MatchThreeBoard): string {
  return String.fromCodePoint(...board.cells);
}

export function blockCount(board: MatchThreeBoard): number {
  let count = 0;
  for (const cell of board.cells) {
    if (isSymbol(cell)) count++;
  }
  return count;
}

/** Remaining blocks per symbol, indexed by symbol. */
export function symbolCounts(board: MatchThreeBoard): number[] {
  const counts: number[] = [];
  for (const cell of board.cells) {
    if (!isSymbol(cell)) continue;
    const slot = symbolIndexOf(cell);
    counts[slot] = (counts[slot] ?? 0) + 1;
  }
  return counts;
}

/**
 * True once some symbol is down to one or two blocks. Nothing can ever clear
 * those — no run of three is left to build — so the board is dead. This is the
 * search's load-bearing prune: it fires on most moves that break up a symbol.
 */
export function hasStrandedSymbol(board: MatchThreeBoard): boolean {
  return symbolCounts(board).some(count => count > 0 && count < MIN_RUN);
}

/** Maps a (line, position) pair on one axis to a flat cell index. */
type LineIndex = (line: number, position: number) => number;

/**
 * Marks every run of `MIN_RUN` or more along a single line. Reading one past
 * the end as EMPTY is what closes a run that reaches the edge.
 */
function markLine(
  cells: Uint8Array,
  mask: Uint8Array,
  line: number,
  length: number,
  indexOf: LineIndex,
): boolean {
  let found = false;
  let runValue: number = EMPTY;
  let runStart = 0;

  for (let position = 0; position <= length; position++) {
    const value = position < length ? cells[indexOf(line, position)]! : EMPTY;
    if (value === runValue && isSymbol(value)) continue;

    if (isSymbol(runValue) && position - runStart >= MIN_RUN) {
      for (let k = runStart; k < position; k++) mask[indexOf(line, k)] = 1;
      found = true;
    }
    runValue = value;
    runStart = position;
  }
  return found;
}

/**
 * Marks every run along one axis. The axis is entirely `indexOf`'s doing,
 * which is why rows and columns share this — and why a `+` or a `T` needs no
 * special case: it is just a cell both passes happen to mark.
 */
function markRuns(
  cells: Uint8Array,
  mask: Uint8Array,
  lines: number,
  length: number,
  indexOf: LineIndex,
): boolean {
  let found = false;
  for (let line = 0; line < lines; line++) {
    if (markLine(cells, mask, line, length, indexOf)) found = true;
  }
  return found;
}

/** Every cell in some run of three, or null when the board is stable. */
export function findMatches(board: MatchThreeBoard): Uint8Array | null {
  const { width, height, cells } = board;
  const mask = new Uint8Array(cells.length);
  const rows = markRuns(
    cells,
    mask,
    height,
    width,
    (y, x) => y * width + x,
  );
  const columns = markRuns(
    cells,
    mask,
    width,
    height,
    (x, y) => y * width + x,
  );
  return rows || columns ? mask : null;
}

/**
 * Whether the cell at (x, y) sits in a run of three. A swap can only create a
 * match through one of the two cells it moved, so this is all the legality
 * check needs to look at.
 */
function hasRunThrough(
  board: MatchThreeBoard,
  x: number,
  y: number,
): boolean {
  const { width, height, cells } = board;
  const value = cells[y * width + x]!;
  if (!isSymbol(value)) return false;

  let across = 1;
  for (let i = x - 1; i >= 0 && cells[y * width + i] === value; i--) across++;
  for (let i = x + 1; i < width && cells[y * width + i] === value; i++) {
    across++;
  }
  if (across >= MIN_RUN) return true;

  let down = 1;
  for (let j = y - 1; j >= 0 && cells[j * width + x] === value; j--) down++;
  for (let j = y + 1; j < height && cells[j * width + x] === value; j++) {
    down++;
  }
  return down >= MIN_RUN;
}

/** Blocks fall to the bottom of their column segment; BLOCKED never moves. */
export function applyGravity(board: MatchThreeBoard): void {
  const { width, height, cells } = board;
  for (let x = 0; x < width; x++) {
    let write = height - 1;
    for (let y = height - 1; y >= 0; y--) {
      const value = cells[y * width + x]!;
      if (value === BLOCKED) {
        write = y - 1;
        continue;
      }
      if (value === EMPTY) continue;
      cells[y * width + x] = EMPTY;
      cells[write * width + x] = value;
      write--;
    }
  }
}

function clearMask(board: MatchThreeBoard, mask: Uint8Array): number {
  let cleared = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    board.cells[i] = EMPTY;
    cleared++;
  }
  return cleared;
}

/**
 * Clears and drops until nothing matches. Every clear can drop blocks into a
 * new line, so this repeats rather than running once.
 */
export function resolve(board: MatchThreeBoard): {
  cleared: number;
  cascades: number;
} {
  let cleared = 0;
  let cascades = 0;
  for (;;) {
    const mask = findMatches(board);
    if (!mask) return { cleared, cascades };
    cleared += clearMask(board, mask);
    applyGravity(board);
    cascades++;
  }
}

function swapCells(board: MatchThreeBoard, move: Move): void {
  const first = move.a.y * board.width + move.a.x;
  const second = move.b.y * board.width + move.b.x;
  const held = board.cells[first]!;
  board.cells[first] = board.cells[second]!;
  board.cells[second] = held;
}

/**
 * Adds the legal swaps that pair `a` with the cell to its right and the one
 * below it. Only those two directions: taking all four would offer every swap
 * twice. `probe` is a scratch copy of `board`, restored before returning.
 */
function collectSwaps(
  board: MatchThreeBoard,
  probe: MatchThreeBoard,
  a: Position,
  moves: Move[],
): void {
  const { width, height, cells } = board;
  const value = cells[a.y * width + a.x]!;

  for (const b of [
    { x: a.x + 1, y: a.y },
    { x: a.x, y: a.y + 1 },
  ]) {
    if (b.x >= width || b.y >= height) continue;
    const other = cells[b.y * width + b.x]!;
    if (!isSymbol(other) || other === value) continue;

    const move: Move = { a, b };
    swapCells(probe, move);
    const clears =
      hasRunThrough(probe, a.x, a.y) || hasRunThrough(probe, b.x, b.y);
    swapCells(probe, move);
    if (clears) moves.push(move);
  }
}

/**
 * Every swap the player is allowed to make. A swap needs two adjacent cells of
 * two different symbols, and it only goes through if it clears something — the
 * game refuses moves that merely reposition a block.
 */
export function legalMoves(board: MatchThreeBoard): Move[] {
  const { width, height, cells } = board;
  const moves: Move[] = [];
  const probe = cloneBoard(board);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!isSymbol(cells[y * width + x]!)) continue;
      collectSwaps(board, probe, { x, y }, moves);
    }
  }
  return moves;
}

/** Applies a swap and its whole cascade, or null when the swap clears nothing. */
export function applyMove(
  board: MatchThreeBoard,
  move: Move,
): MoveOutcome | null {
  const next = cloneBoard(board);
  swapCells(next, move);

  const firstWave = findMatches(next);
  if (!firstWave) return null;

  const cleared = clearMask(next, firstWave);
  applyGravity(next);
  const rest = resolve(next);

  return {
    board: next,
    firstWave,
    cleared: cleared + rest.cleared,
    cascades: 1 + rest.cascades,
  };
}

function describePosition(x: number, y: number): string {
  return `Column ${x + 1}, Row ${y + 1}`;
}

/**
 * Why this board is not a state the game could be in, or null when it is one.
 * Captured boards have already settled, so a floating block or a line that is
 * still standing means the capture is wrong — repairing it silently would
 * solve a puzzle the player never had.
 */
export function boardProblem(board: MatchThreeBoard): string | null {
  const { width, height } = board;

  for (let y = 0; y < height - 1; y++) {
    for (let x = 0; x < width; x++) {
      if (!isSymbol(cellAt(board, x, y))) continue;
      if (cellAt(board, x, y + 1) !== EMPTY) continue;
      return (
        `${describePosition(x, y)} floats above an empty cell. ` +
        `A board must have settled before it can be solved.`
      );
    }
  }

  const mask = findMatches(board);
  if (mask) {
    const index = mask.indexOf(1);
    return (
      `${describePosition(index % width, Math.floor(index / width))} is ` +
      `already part of a line of three. A board must have no matches left.`
    );
  }

  return null;
}
