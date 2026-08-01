import {
  intInRange,
  readGridSize,
  type ConfigResult,
} from "../../util/configValidation";
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
 * How long the search may look for a solution before giving up.
 *
 * It bounds only the boards where NOTHING is found, because the search stops
 * the moment it has an answer to show. Measured on the real page over the 52
 * captured boards: 49 settle in a median 361 ms and the slowest of the other
 * three answers in 10.2 s, so a minute is roughly six times the worst case
 * anything real has needed — enough headroom for a hand-drawn board harder
 * than the corpus, without making an impossible one feel hung.
 */
export const SOLVE_BUDGET_MS = 60_000;

export type ConfigParseResult = ConfigResult<MatchThreeTest>;

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
  const size = readGridSize(data, MAX_GRID_SIDE);
  if (!size.ok) return size;
  const { gridWidth, gridHeight } = size.config;
  const raw = data as Record<string, unknown>;

  const cellsProblem = cellsError(raw.cells, gridWidth, gridHeight);
  if (cellsProblem !== null) {
    return { ok: false, error: cellsProblem };
  }
  const cells = raw.cells as MatchThreeCell[][];

  return { ok: true, config: { gridWidth, gridHeight, cells } };
}
