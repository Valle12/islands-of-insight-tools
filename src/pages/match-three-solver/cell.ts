// Every cell of a match-three board is one number, so `cells` is a flat index
// space with no strings mixed into it. The two structural values take the
// first two slots and the palette follows: color slot `i` is stored as
// `FIRST_COLOR + i`. That keeps a board's serialised form uniform and makes
// "is this a color?" a single comparison.

export const EMPTY = 0;
export const BLOCKED = 1;
export const FIRST_COLOR = 2;

/** The cell value that paints palette slot `slot`. */
export function colorCell(slot: number): number {
  return FIRST_COLOR + slot;
}

/** The palette slot a color cell refers to. Only valid when `isColor`. */
export function colorSlotOf(cell: number): number {
  return cell - FIRST_COLOR;
}

export function isColor(cell: number): boolean {
  return cell >= FIRST_COLOR;
}

/** The first value past the end for a board with `colorCount` colors. */
export function cellLimit(colorCount: number): number {
  return FIRST_COLOR + colorCount;
}
