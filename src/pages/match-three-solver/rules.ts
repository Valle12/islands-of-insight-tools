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

/**
 * Marks every run of `MIN_RUN` or more along one line: `length` cells at
 * `start`, `start + step`, and so on. Reading one past the end as EMPTY is
 * what closes a run that reaches the edge. Rows and columns share this
 * through the stride alone — no index callback: this runs once per cascade
 * round of every child the search builds, and two closures per call were
 * measurable.
 */
function markLineRuns(
  cells: Uint8Array,
  mask: Uint8Array,
  start: number,
  step: number,
  length: number,
): boolean {
  let found = false;
  let runValue: number = EMPTY;
  let runStart = 0;
  for (let position = 0; position <= length; position++) {
    const value = position < length ? cells[start + position * step]! : EMPTY;
    if (value === runValue && isSymbol(value)) continue;

    if (isSymbol(runValue) && position - runStart >= MIN_RUN) {
      for (let k = runStart; k < position; k++) mask[start + k * step] = 1;
      found = true;
    }
    runValue = value;
    runStart = position;
  }
  return found;
}

/**
 * `findMatches` into a caller-owned mask, zeroed here. The search keeps one
 * scratch mask per recursion level alive across millions of cascade rounds,
 * which is what makes a round allocation-free. A `+` or a `T` needs no
 * special case — it is just a cell the row and the column pass both mark.
 */
export function findMatchesInto(
  board: MatchThreeBoard,
  mask: Uint8Array,
): boolean {
  const { width, height, cells } = board;
  mask.fill(0);
  let found = false;
  for (let y = 0; y < height; y++) {
    if (markLineRuns(cells, mask, y * width, 1, width)) found = true;
  }
  for (let x = 0; x < width; x++) {
    if (markLineRuns(cells, mask, x, width, height)) found = true;
  }
  return found;
}

/** Every cell in some run of three, or null when the board is stable. */
export function findMatches(board: MatchThreeBoard): Uint8Array | null {
  const mask = new Uint8Array(board.cells.length);
  return findMatchesInto(board, mask) ? mask : null;
}

/**
 * Marks the horizontal and vertical runs through (x, y), if any. On a board
 * that was settled before a swap, every new match passes through one of the
 * two swapped cells — the same argument `hasRunThrough` rests on — so two of
 * these calls find the entire first wave without rescanning the board.
 *
 * Unlike its neighbour `findMatchesInto`, this does NOT zero `mask` — the two
 * calls that make up one first wave accumulate into the same one. The mask is
 * the caller's to clear, and the two exported entry points take opposite sides
 * of that contract on purpose.
 */
export function markRunsThrough(
  board: MatchThreeBoard,
  x: number,
  y: number,
  mask: Uint8Array,
): boolean {
  const { width, height, cells } = board;
  const value = cells[y * width + x]!;
  if (!isSymbol(value)) return false;
  let found = false;

  let left = x;
  while (left > 0 && cells[y * width + left - 1] === value) left--;
  let right = x;
  while (right + 1 < width && cells[y * width + right + 1] === value) right++;
  if (right - left + 1 >= MIN_RUN) {
    for (let k = left; k <= right; k++) mask[y * width + k] = 1;
    found = true;
  }

  let top = y;
  while (top > 0 && cells[(top - 1) * width + x] === value) top--;
  let bottom = y;
  while (bottom + 1 < height && cells[(bottom + 1) * width + x] === value) {
    bottom++;
  }
  if (bottom - top + 1 >= MIN_RUN) {
    for (let k = top; k <= bottom; k++) mask[k * width + x] = 1;
    found = true;
  }

  return found;
}

/**
 * Whether the cell at (x, y) sits in a run of three. A swap can only create a
 * match through one of the two cells it moved, so this is all the legality
 * check needs to look at.
 */
export function hasRunThrough(
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

/**
 * Whether the two cells a move names are a swap the game would offer at all:
 * both on the board, orthogonally adjacent with `b` to `a`'s right or below,
 * both holding a symbol, and holding different ones.
 *
 * Mirrors the opening of `a-star/Rules.cpp`'s `applyMove`, which is where these
 * checks have always been. Without them `swapCells` would read an out-of-range
 * index as `undefined` and write it back into the `Uint8Array` as EMPTY —
 * DELETING a block rather than swapping — so a witness with bad coordinates
 * could reach `blockCount(current) === 0` and be accepted as a solution, and a
 * non-adjacent swap would render in the viewer as a move the game refuses.
 */
function isWellFormed(board: MatchThreeBoard, move: Move): boolean {
  const { width, height } = board;
  const { a, b } = move;
  if (a.x < 0 || a.x >= width || b.x < 0 || b.x >= width) return false;
  if (a.y < 0 || a.y >= height || b.y < 0 || b.y >= height) return false;
  const adjacent =
    (b.y === a.y && b.x === a.x + 1) || (b.x === a.x && b.y === a.y + 1);
  if (!adjacent) return false;
  const first = cellAt(board, a.x, a.y);
  const second = cellAt(board, b.x, b.y);
  return isSymbol(first) && isSymbol(second) && first !== second;
}

/** Applies a swap and its whole cascade, or null when the swap clears nothing. */
export function applyMove(
  board: MatchThreeBoard,
  move: Move,
): MoveOutcome | null {
  if (!isWellFormed(board, move)) return null;
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
