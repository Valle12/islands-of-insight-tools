/**
 * Row balancing for the two wrapping lists on the page — the dial cards and
 * the icon stack inside a button's slot.
 *
 * Plain `flex-wrap` fills each row to capacity and dumps the remainder on the
 * last one, so six dials in a five-wide list read as 5 + 1. Splitting them
 * evenly instead needs a fixed column count, which is what these two compute.
 */

/**
 * How many items of `itemWidth` (plus `gap` between them) fit across `width`.
 * Both are the OUTER widths — padding and border included — because that is
 * what actually has to fit. Returns `Infinity` when either is unmeasured:
 * with no width to go on, "everything on one row" is the only honest answer.
 */
export function columnCapacity(
  width: number,
  itemWidth: number,
  gap: number,
): number {
  if (width <= 0 || itemWidth <= 0) return Infinity;
  return Math.max(1, Math.floor((width + gap) / (itemWidth + gap)));
}

/**
 * The column count that splits `count` items into rows as equal as possible
 * without any row exceeding `capacity`. Grid fills row by row, so the earlier
 * rows take the extra item — never more than one more than the last.
 */
export function balancedColumns(count: number, capacity: number): number {
  if (count <= 1) return 1;
  if (!Number.isFinite(capacity) || capacity < 1 || count <= capacity) {
    return count;
  }
  const rows = Math.ceil(count / capacity);
  return Math.ceil(count / rows);
}
