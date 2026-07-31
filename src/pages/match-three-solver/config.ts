import type { MatchThreeCell, MatchThreeTest } from "../../util/types";
import { cellLimit } from "./cell";
import { SYMBOL_COUNT } from "./symbols";

/**
 * Hard ceiling on either grid side. Real match-three boards in the game are
 * small; this is stress headroom, kept low enough that a full repaint of the
 * grid stays imperceptible.
 */
export const MAX_GRID_SIDE = 32;

/**
 * How long the search may run before it gives up. The solver only ever reports
 * a move count it has *proven* minimal, which means exhausting every shorter
 * length first — so a board that is too big has to be refused rather than
 * answered approximately.
 */
export const SOLVE_BUDGET_MS = 30_000;

export type ConfigParseResult =
  | { ok: true; config: MatchThreeTest }
  | { ok: false; error: string };

function intInRange(value: unknown, min: number, max: number): value is number {
  return (
    Number.isInteger(value) &&
    (value as number) >= min &&
    (value as number) <= max
  );
}

/** Returns the first problem with the cells grid, or null when it is valid. */
function cellsError(
  cells: unknown,
  gridWidth: number,
  gridHeight: number,
): string | null {
  if (!Array.isArray(cells) || cells.length !== gridWidth) {
    return `cells must be an array of ${gridWidth} columns.`;
  }
  // Bounded by every symbol the app knows, not by the board: a cell names a
  // symbol outright, so there is no per-board palette left to overrun.
  const maxCell = cellLimit(SYMBOL_COUNT) - 1;
  for (const column of cells) {
    if (!Array.isArray(column) || column.length !== gridHeight) {
      return `Every cells column must have ${gridHeight} entries.`;
    }
    if (!column.every(cell => intInRange(cell, 0, maxCell))) {
      return `Cells must be integers between 0 and ${maxCell} (0 empty, 1 blocked, 2+ symbols).`;
    }
  }
  return null;
}

/**
 * Validates an unknown parsed JSON value against the match-three config
 * (download/fixture) format. Returns the typed config on success, or a
 * human-readable error explaining the first problem found.
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
  if (cellsProblem !== null) {
    return { ok: false, error: cellsProblem };
  }
  const cells = raw.cells as MatchThreeCell[][];

  return { ok: true, config: { gridWidth, gridHeight, cells } };
}
