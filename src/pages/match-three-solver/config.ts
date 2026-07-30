import type { MatchThreeCell, MatchThreeTest } from "../../util/types";
import { cellLimit } from "./cell";
import { isKnownColor, MAX_COLORS } from "./palette";

/**
 * Hard ceiling on either grid side. Real match-three boards in the game are
 * small; this is stress headroom, kept low enough that a full repaint of the
 * grid stays imperceptible.
 */
export const MAX_GRID_SIDE = 32;

export { MAX_COLORS };

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

/** Returns the first problem with the palette, or null when it is valid. */
function colorsError(colors: unknown): string | null {
  if (
    !Array.isArray(colors) ||
    colors.length < 1 ||
    colors.length > MAX_COLORS
  ) {
    return `colors must hold between 1 and ${MAX_COLORS} colors.`;
  }
  if (!colors.every(isKnownColor)) {
    return "colors may only contain known color names.";
  }
  if (new Set(colors).size !== colors.length) {
    return "colors must not repeat a color.";
  }
  return null;
}

/** Returns the first problem with the cells grid, or null when it is valid. */
function cellsError(
  cells: unknown,
  gridWidth: number,
  gridHeight: number,
  colorCount: number,
): string | null {
  if (!Array.isArray(cells) || cells.length !== gridWidth) {
    return `cells must be an array of ${gridWidth} columns.`;
  }
  const maxCell = cellLimit(colorCount) - 1;
  for (const column of cells) {
    if (!Array.isArray(column) || column.length !== gridHeight) {
      return `Every cells column must have ${gridHeight} entries.`;
    }
    if (!column.every(cell => intInRange(cell, 0, maxCell))) {
      return `Cells must be integers between 0 and ${maxCell} (0 empty, 1 blocked, 2+ colors).`;
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

  const colorsProblem = colorsError(raw.colors);
  if (colorsProblem !== null) {
    return { ok: false, error: colorsProblem };
  }
  const colors = raw.colors as string[];

  const cellsProblem = cellsError(
    raw.cells,
    gridWidth,
    gridHeight,
    colors.length,
  );
  if (cellsProblem !== null) {
    return { ok: false, error: cellsProblem };
  }
  const cells = raw.cells as MatchThreeCell[][];

  return { ok: true, config: { gridWidth, gridHeight, colors, cells } };
}
