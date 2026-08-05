import {
  intInRange,
  readGridSize,
  type ConfigResult,
} from "../../util/configValidation";
import {
  configVersion,
  migrateConfig,
  type ConfigMigration,
} from "../../util/configVersion";
import type { LogicGridSymbol, LogicGridTest } from "../../util/types";
import { CELL_LIMIT, UNPLAYABLE } from "./cell";
import { RULE_COUNT } from "./rules";
import {
  axisIndex,
  SYMBOL_KIND_COUNT,
  symbolDirectionError,
  symbolKindAt,
  symbolSeatError,
  symbolValueError,
} from "./symbols";

/**
 * Hard ceiling on either grid side. Real logic grids in the game are small;
 * this is stress headroom, kept low enough that a full repaint of the grid
 * stays imperceptible.
 */
export const MAX_GRID_SIDE = 32;

/**
 * How long the solver may run before it gives up.
 *
 * A properly clued board is usually finished by deduction alone, in
 * milliseconds — 108 of the 111 captured boards total well under a second
 * between them. The budget exists for the two cases that are not like that: the
 * underclued mode, where every cell the deduction could not settle costs a search
 * of its own to prove, and the profile sweep on a wide connectivity board.
 *
 * Two minutes rather than one because of the second. `logicGridTest67` is
 * 15 cells across and measures **45 s in the browser** (38 s natively), so a
 * one-minute budget left almost no headroom and a machine any slower than this
 * one would have watched it time out with the answer nearly in hand. Nothing
 * else in the corpus comes within two orders of magnitude of the limit, so this
 * is invisible in practice — and the panel has a live step counter and a Cancel
 * button for the board where it is not.
 */
export const SOLVE_BUDGET_MS = 120_000;

/**
 * How to read each older shape of this page's download format, newest step
 * last — see `configVersion.ts` for the whole contract.
 *
 * Empty because the format has never had a breaking change: `shapes`,
 * `direction` and `seat` all arrived as OPTIONAL keys, which every earlier file
 * satisfies by not having them. The first change that cannot be expressed that
 * way appends its step here, which is what takes `CONFIG_VERSION` to 2.
 */
const MIGRATIONS: readonly ConfigMigration[] = [];

/**
 * The format version this build writes, derived from the list above so the two
 * cannot disagree. Every download carries it as its first key, and a file
 * without one is version 1 — see `configVersion.ts`.
 */
export const CONFIG_VERSION = configVersion(MIGRATIONS);

export type ConfigParseResult = ConfigResult<LogicGridTest>;

/** Returns the first problem with the colour grid, or null when it is valid. */
function cellsError(
  cells: unknown,
  gridWidth: number,
  gridHeight: number,
): string | null {
  if (!Array.isArray(cells) || cells.length !== gridWidth) {
    return `cells must be an array of ${gridWidth} columns.`;
  }
  const maxCell = CELL_LIMIT - 1;
  for (const column of cells) {
    if (!Array.isArray(column) || column.length !== gridHeight) {
      return `Every cells column must have ${gridHeight} entries.`;
    }
    if (!column.every(cell => intInRange(cell, 0, maxCell))) {
      return `Cells must be integers between 0 and ${maxCell} (0 unknown, 1 dark, 2 light, 3 unplayable).`;
    }
  }
  return null;
}

/**
 * Returns the first problem with the active rule list, or null.
 *
 * An index this build does not know is REJECTED rather than ignored: a config
 * written by a later build carries a rule this one cannot show, and silently
 * dropping it would load a different puzzle under the same name.
 */
function rulesError(rules: unknown): string | null {
  if (!Array.isArray(rules)) {
    return "rules must be an array of rule indices.";
  }
  const seen = new Set<number>();
  for (const rule of rules) {
    if (!intInRange(rule, 0, RULE_COUNT - 1)) {
      return `Rules must be integers between 0 and ${RULE_COUNT - 1}.`;
    }
    if (seen.has(rule)) return `Rule ${rule} is listed more than once.`;
    seen.add(rule);
  }
  return null;
}

/** Returns the first problem with one clue, or null when it is valid. */
function symbolError(
  symbol: unknown,
  gridWidth: number,
  gridHeight: number,
  cells: number[][],
): string | null {
  if (typeof symbol !== "object" || symbol === null) {
    return "Every symbol must be a JSON object.";
  }
  const raw = symbol as Record<string, unknown>;

  if (
    !intInRange(raw.x, 0, gridWidth - 1) ||
    !intInRange(raw.y, 0, gridHeight - 1)
  ) {
    return `Symbol coordinates must lie on the ${gridWidth}x${gridHeight} board.`;
  }
  const x = raw.x as number;
  const y = raw.y as number;

  if (!intInRange(raw.type, 0, SYMBOL_KIND_COUNT - 1)) {
    return `Symbol types must be integers between 0 and ${SYMBOL_KIND_COUNT - 1}.`;
  }
  const kind = symbolKindAt(raw.type as number)!;

  // A gap in the board is not a cell the puzzle clues, and the editor cannot
  // produce one, so a file claiming otherwise is describing a different board.
  if (cells[x]![y] === UNPLAYABLE) {
    return `Column ${x + 1}, row ${y + 1} is unplayable and cannot carry a symbol.`;
  }

  const valueProblem = symbolValueError(kind, raw.value, {
    gridWidth,
    gridHeight,
  });
  if (valueProblem !== null) return valueProblem;
  const directionProblem = symbolDirectionError(kind, raw.direction);
  if (directionProblem !== null) return directionProblem;
  const seatProblem = symbolSeatError(kind, raw.seat);
  if (seatProblem !== null) return seatProblem;

  // A diagonal axis on an edge-midpoint seat has no reflection on the square
  // grid — mirrors would land on square corners — so the combination is
  // refused here exactly as the solver names it. Whether the seat's squares
  // really belong to the clue's merged cell is `seatShapeError`'s question.
  if (kind.aims === "axis") {
    const diagonal =
      raw.direction === axisIndex("diagonal-down") ||
      raw.direction === axisIndex("diagonal-up");
    if (diagonal && (raw.seat === 1 || raw.seat === 2)) {
      return `A diagonal ${kind.label.toLowerCase()} symbol cannot sit on a grid-line seat.`;
    }
  }
  return null;
}

/** Returns the first problem with the clue layer, or null when it is valid. */
function symbolsError(
  symbols: unknown,
  gridWidth: number,
  gridHeight: number,
  cells: number[][],
): string | null {
  if (!Array.isArray(symbols)) {
    return "symbols must be an array.";
  }
  const seen = new Set<number>();
  for (const symbol of symbols) {
    const problem = symbolError(symbol, gridWidth, gridHeight, cells);
    if (problem !== null) return problem;

    const entry = symbol as LogicGridSymbol;
    const slot = entry.y * gridWidth + entry.x;
    if (seen.has(slot)) {
      return `Column ${entry.x + 1}, row ${entry.y + 1} carries more than one symbol.`;
    }
    seen.add(slot);
  }
  return null;
}

/**
 * Returns the first problem with one merged cell, or null.
 *
 * `claimed` accumulates across the whole list, so it also catches the same
 * square appearing twice inside a single shape.
 */
function shapeError(
  shape: unknown,
  size: { gridWidth: number; gridHeight: number },
  cells: number[][],
  claimed: Set<number>,
): string | null {
  const { gridWidth, gridHeight } = size;
  const limit = gridWidth * gridHeight;
  if (!Array.isArray(shape) || shape.length < 2) {
    // A cell of one square IS a plain cell, so the other spelling is refused
    // rather than accepted and normalised away.
    return "Every merged cell must be an array of at least two squares.";
  }
  for (const square of shape) {
    if (!intInRange(square, 0, limit - 1)) {
      return `Merged cell squares must be integers between 0 and ${limit - 1}.`;
    }
    const x = (square as number) % gridWidth;
    const y = Math.floor((square as number) / gridWidth);
    if (cells[x]![y] === UNPLAYABLE) {
      return `Column ${x + 1}, row ${y + 1} is unplayable and cannot be part of a merged cell.`;
    }
    if (claimed.has(square as number)) {
      return `Column ${x + 1}, row ${y + 1} belongs to more than one merged cell.`;
    }
    claimed.add(square as number);
  }

  // Connectivity first, then agreement — the same order the solver's own
  // `structureProblem` uses, so the two name the same fault on the same file.
  const squares = shape as number[];
  const broken = connectedError(squares, gridWidth);
  if (broken !== null) return broken;

  // Every square of a merged cell holds ONE colour, so a file that paints them
  // differently describes a cell that cannot exist. The editor cannot produce
  // one — restructuring clears — but an imported file can, and the solver
  // refuses it, so accepting it here would only turn a clear message into a
  // failure inside wasm.
  const given = colorAt(cells, squares[0]!, gridWidth);
  const split = squares.find(
    square => colorAt(cells, square, gridWidth) !== given,
  );
  if (split === undefined) return null;
  const x = split % gridWidth;
  const y = Math.floor(split / gridWidth);
  return `Column ${x + 1}, row ${y + 1} is a different colour from the rest of its merged cell.`;
}

/** The colour on a square, by its flat index. */
function colorAt(cells: number[][], square: number, gridWidth: number): number {
  return cells[square % gridWidth]![Math.floor(square / gridWidth)]!;
}

/**
 * A merged cell has to be one connected polyomino, which the editor guarantees
 * by splitting whatever a stroke leaves behind into its components. A file
 * saying otherwise describes a cell that cannot be drawn.
 */
function connectedError(shape: number[], gridWidth: number): string | null {
  const members = new Set(shape);
  const seen = new Set<number>([shape[0]!]);
  const queue = [shape[0]!];
  while (queue.length > 0) {
    const square = queue.pop()!;
    const x = square % gridWidth;
    const y = Math.floor(square / gridWidth);
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nx = x + dx;
      if (nx < 0 || nx >= gridWidth) continue;
      const next = (y + dy) * gridWidth + nx;
      if (!members.has(next) || seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen.size === members.size
    ? null
    : "Every merged cell must be one connected shape.";
}

/** Returns the first problem with the merged-cell layer, or null. */
function shapesError(
  shapes: unknown,
  size: { gridWidth: number; gridHeight: number },
  cells: number[][],
  symbols: LogicGridSymbol[],
): string | null {
  if (!Array.isArray(shapes)) {
    return "shapes must be an array.";
  }
  const claimed = new Set<number>();
  for (const shape of shapes) {
    const problem = shapeError(shape, size, cells, claimed);
    if (problem !== null) return problem;

    // A merged cell is ONE cell, so it carries at most one clue however many
    // squares it spans — and WHICH of its squares that clue sits on is the
    // player's own choice, so there is nothing else to ask. A dart's square is
    // where its ray starts and a symmetry symbol's is half of its seat, so
    // every kind keeps the square the file names.
    const squares = shape as number[];
    const clued = symbols.filter(symbol =>
      squares.includes(symbol.y * size.gridWidth + symbol.x),
    );
    if (clued.length > 1) {
      return "A merged cell carries more than one symbol.";
    }
  }
  return null;
}

/**
 * The half of a seat only the merged-cell layer can judge: its squares must
 * really surround a point of the clue's own cell. A seam seat needs the
 * square beyond it as a shape-mate; a corner seat needs at least THREE of its
 * four surrounding squares in the cell — a 2x2 block's centre has four, and
 * an L-tromino's natural middle is the corner it wraps, which has three.
 */
function seatShapeError(
  symbols: LogicGridSymbol[],
  shapes: number[][],
  gridWidth: number,
  gridHeight: number,
): string | null {
  for (const symbol of symbols) {
    const seat = symbol.seat ?? 0;
    if (symbolKindAt(symbol.type)?.aims !== "axis" || seat === 0) continue;
    const cell = shapes.find(shape =>
      shape.includes(symbol.y * gridWidth + symbol.x),
    );
    if (!cell) {
      return `Column ${symbol.x + 1}, row ${symbol.y + 1} carries a seat but no merged cell to sit in.`;
    }
    // Bounds first: past the right edge the flat index would wrap to the next
    // row and could falsely match a member there.
    const owns = (x: number, y: number) =>
      x < gridWidth && y < gridHeight && cell.includes(y * gridWidth + x);
    const right = owns(symbol.x + 1, symbol.y);
    const down = owns(symbol.x, symbol.y + 1);
    const corner = owns(symbol.x + 1, symbol.y + 1);
    const fits =
      (seat === 1 && right) ||
      (seat === 2 && down) ||
      (seat === 3 && 1 + Number(right) + Number(down) + Number(corner) >= 3);
    if (!fits) {
      return `Column ${symbol.x + 1}, row ${symbol.y + 1} carries a seat its merged cell does not surround.`;
    }
  }
  return null;
}

/**
 * Validates an unknown parsed JSON value against the logic grid config
 * (download/fixture) format. Returns the typed config on success, or a
 * human-readable error explaining the first problem found.
 *
 * The result is rebuilt from the validated fields, so unknown keys are dropped
 * and the rule list comes back sorted whatever order the file listed it in.
 *
 * `shapes` is the one OPTIONAL key, and an empty one normalises back to absent:
 * every captured fixture predates it, and `config.test.ts` asserts they all
 * round-trip byte-identically.
 */
export function validateConfig(data: unknown): ConfigParseResult {
  // First of all, and before a single structural check: a migration is exactly
  // what makes an older file's shape make sense to the rules below.
  const migrated = migrateConfig(data, MIGRATIONS);
  if (!migrated.ok) return { ok: false, error: migrated.error };

  const size = readGridSize(migrated.data, MAX_GRID_SIDE);
  if (!size.ok) return size;
  const { gridWidth, gridHeight } = size.config;
  const raw = migrated.data as Record<string, unknown>;

  const cellsProblem = cellsError(raw.cells, gridWidth, gridHeight);
  if (cellsProblem !== null) return { ok: false, error: cellsProblem };
  const cells = raw.cells as number[][];

  const rulesProblem = rulesError(raw.rules);
  if (rulesProblem !== null) return { ok: false, error: rulesProblem };

  const symbolsProblem = symbolsError(
    raw.symbols,
    gridWidth,
    gridHeight,
    cells,
  );
  if (symbolsProblem !== null) return { ok: false, error: symbolsProblem };

  const rules = [...(raw.rules as number[])].sort((a, b) => a - b);
  // `value`, `direction` and `seat` are each spread only when the clue has
  // one, for the same reason `shapes` is omitted below: every captured
  // fixture predates the optional keys and has to keep round-tripping
  // byte-identically. A seat of 0 normalises back to absent, like an empty
  // `shapes` — it means the square's own centre, which is what absent means.
  const symbols = (raw.symbols as LogicGridSymbol[]).map(symbol => ({
    x: symbol.x,
    y: symbol.y,
    type: symbol.type,
    ...(symbol.value === undefined ? {} : { value: symbol.value }),
    ...(symbol.direction === undefined ? {} : { direction: symbol.direction }),
    ...(symbol.seat ? { seat: symbol.seat } : {}),
  }));

  // `version` FIRST, and always the current one — whatever the file said, what
  // comes out of here is the shape this build stores.
  const config: LogicGridTest = {
    version: CONFIG_VERSION,
    gridWidth,
    gridHeight,
    rules,
    cells,
    symbols,
  };

  if (raw.shapes !== undefined) {
    const shapesProblem = shapesError(
      raw.shapes,
      { gridWidth, gridHeight },
      cells,
      symbols,
    );
    if (shapesProblem !== null) return { ok: false, error: shapesProblem };
    const shapes = (raw.shapes as number[][]).map(shape => [...shape]);
    if (shapes.length > 0) config.shapes = shapes;
  }

  // After the shapes: a seat is judged against the merged cell it sits in,
  // and a board with no shapes at all has nowhere for one.
  const seatProblem = seatShapeError(
    symbols,
    config.shapes ?? [],
    gridWidth,
    gridHeight,
  );
  if (seatProblem !== null) return { ok: false, error: seatProblem };

  // The number is reported only when the file really was older, so the page
  // can say the copy on disk is out of date without claiming it of every load.
  return migrated.from < CONFIG_VERSION
    ? { ok: true, config, migratedFrom: migrated.from }
    : { ok: true, config };
}
