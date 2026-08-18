// The color layer of a logic grid cell is one number, so `cells` is a flat
// index space with no strings mixed into it. Clues do NOT live here: a square
// carries a color and, independently, at most one clue, which is what lets a
// clue be placed before its color is known and colored over afterwards — and
// what lets a merged cell carry several clues, one per square.

export const UNKNOWN = 0;
export const DARK = 1;
export const LIGHT = 2;
export const UNPLAYABLE = 3;

/** The first value past the end of the color space. */
export const CELL_LIMIT = 4;

/**
 * Stable, lowercase names — written to `data-color`, so the stylesheet and the
 * e2e selectors both read them. Indexed by the constants above.
 */
const COLOR_IDS = ["unknown", "dark", "light", "unplayable"] as const;

/** Indexed by the constants above; what a cell is called out loud. */
const COLOR_LABELS = ["Unknown", "Dark", "Light", "Unplayable"] as const;

export function colorId(cell: number): string {
  return COLOR_IDS[cell] ?? COLOR_IDS[UNKNOWN];
}

export function colorLabel(cell: number): string {
  return COLOR_LABELS[cell] ?? COLOR_LABELS[UNKNOWN];
}

/** Whether a cell is part of the board at all. Gaps take no color and no clue. */
export function isPlayable(cell: number): boolean {
  return cell !== UNPLAYABLE;
}
