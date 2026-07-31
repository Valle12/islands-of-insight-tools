// Every cell of a match-three board is one number, so `cells` is a flat index
// space with no strings mixed into it. The two structural values take the
// first two slots and the symbols follow: the symbol at index `i` of
// `symbols.ts` is stored as `FIRST_SYMBOL + i`. That keeps a board's
// serialised form uniform and makes "is this a block?" a single comparison.

export const EMPTY = 0;
export const BLOCKED = 1;
export const FIRST_SYMBOL = 2;

/** The cell value that paints the symbol at `index`. */
export function symbolCell(index: number): number {
  return FIRST_SYMBOL + index;
}

/** The symbol a block cell shows. Only valid when `isSymbol`. */
export function symbolIndexOf(cell: number): number {
  return cell - FIRST_SYMBOL;
}

export function isSymbol(cell: number): boolean {
  return cell >= FIRST_SYMBOL;
}

/** The first value past the end for a board drawing on `symbolCount` symbols. */
export function cellLimit(symbolCount: number): number {
  return FIRST_SYMBOL + symbolCount;
}
