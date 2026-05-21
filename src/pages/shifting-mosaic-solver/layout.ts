// Shared sizing for the shifting-mosaic grids (editor + solution viewer).
//
// Cells never render larger than CELL_MAX_PX. A grid that would be wider than
// the available space shrinks its cells to share the row instead of letting
// fixed-size cells overflow and overlap.

export const CELL_MAX_PX = 44;
export const GRID_GAP_PX = 6;

const CARD_PADDING_PX = 20;
const CARD_BORDER_PX = 1;
const GRID_SHELL_PADDING_PX = 14;
const DEFAULT_CARD_WIDTH_PX = 960;

/** Pixel width of an `columns`-wide grid drawn at full cell size. */
export function gridMaxWidthPx(columns: number): number {
  return CELL_MAX_PX * columns + GRID_GAP_PX * Math.max(0, columns - 1);
}

/**
 * Editor-card width (border-box) that lets an `columns`-wide grid render at
 * full cell size — never narrower than the default card. Callers clamp this
 * to the viewport with `min(100%, …)`.
 */
export function cardWidthPx(columns: number): number {
  const chrome =
    2 * (CARD_PADDING_PX + CARD_BORDER_PX + GRID_SHELL_PADDING_PX);
  return Math.max(DEFAULT_CARD_WIDTH_PX, gridMaxWidthPx(columns) + chrome);
}
