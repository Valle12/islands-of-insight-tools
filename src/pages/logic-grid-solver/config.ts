import type {
  LogicGridCell,
  LogicGridSymbol,
  LogicGridTest,
} from "../../util/types";
import { CELL_LIMIT, UNPLAYABLE } from "./cell";
import { RULE_COUNT } from "./rules";
import { SYMBOL_KIND_COUNT, symbolKindAt, symbolValueError } from "./symbols";

/**
 * Hard ceiling on either grid side. Real logic grids in the game are small;
 * this is stress headroom, kept low enough that a full repaint of the grid
 * stays imperceptible.
 */
export const MAX_GRID_SIDE = 32;

export type ConfigParseResult =
  | { ok: true; config: LogicGridTest }
  | { ok: false; error: string };

function intInRange(value: unknown, min: number, max: number): value is number {
  return (
    Number.isInteger(value) &&
    (value as number) >= min &&
    (value as number) <= max
  );
}

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
  cells: LogicGridCell[][],
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

  return symbolValueError(kind, raw.value, gridWidth * gridHeight);
}

/** Returns the first problem with the clue layer, or null when it is valid. */
function symbolsError(
  symbols: unknown,
  gridWidth: number,
  gridHeight: number,
  cells: LogicGridCell[][],
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
 * Validates an unknown parsed JSON value against the logic grid config
 * (download/fixture) format. Returns the typed config on success, or a
 * human-readable error explaining the first problem found.
 *
 * The result is rebuilt from the validated fields, so unknown keys are dropped
 * and the rule list comes back sorted whatever order the file listed it in.
 */
export function validateConfig(data: unknown): ConfigParseResult {
  if (typeof data !== "object" || data === null) {
    return { ok: false, error: "Config must be a JSON object." };
  }
  const raw = data as Record<string, unknown>;

  if (!intInRange(raw.gridWidth, 1, MAX_GRID_SIDE)) {
    return {
      ok: false,
      error: `gridWidth must be an integer between 1 and ${MAX_GRID_SIDE}.`,
    };
  }
  if (!intInRange(raw.gridHeight, 1, MAX_GRID_SIDE)) {
    return {
      ok: false,
      error: `gridHeight must be an integer between 1 and ${MAX_GRID_SIDE}.`,
    };
  }
  const gridWidth = raw.gridWidth as number;
  const gridHeight = raw.gridHeight as number;

  const cellsProblem = cellsError(raw.cells, gridWidth, gridHeight);
  if (cellsProblem !== null) return { ok: false, error: cellsProblem };
  const cells = raw.cells as LogicGridCell[][];

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
  const symbols = (raw.symbols as LogicGridSymbol[]).map(symbol => ({
    x: symbol.x,
    y: symbol.y,
    type: symbol.type,
    value: symbol.value,
  }));

  return { ok: true, config: { gridWidth, gridHeight, rules, cells, symbols } };
}
