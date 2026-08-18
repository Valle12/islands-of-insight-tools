/**
 * Outlining helpers shared by the solution views. Both draw a border around a
 * *set* of cells by putting an edge class on every cell whose neighbor is
 * outside the set — the grid has gaps between cells, so a single border on a
 * wrapper is not an option.
 */

/**
 * Outlines a block: an edge class wherever the neighbor is a different block.
 * `occupant[x][y]` identifies the block on a cell; any value that is not
 * `block` counts as outside.
 */
export function markBlockEdges(
  cell: HTMLElement,
  x: number,
  y: number,
  block: number,
  occupant: number[][],
) {
  const sameBlock = (nx: number, ny: number) => occupant[nx]?.[ny] === block;
  if (!sameBlock(x, y - 1)) cell.classList.add("block-edge-top");
  if (!sameBlock(x + 1, y)) cell.classList.add("block-edge-right");
  if (!sameBlock(x, y + 1)) cell.classList.add("block-edge-bottom");
  if (!sameBlock(x - 1, y)) cell.classList.add("block-edge-left");
}

/**
 * The inverse of the other two: a class per side whose neighbor is INSIDE the
 * same group, for a group that has to read as one solid tile rather than as an
 * outlined set. The stylesheet then drops that side's border and bridges the
 * grid gap, so the seams between the cells disappear while the outline stays.
 *
 * `-corner` marks the little square BETWEEN two gaps, where four cells of one
 * group meet — and only where all four are in it, so an L-shaped group keeps
 * the notch at its inner corner.
 *
 * Membership comes in as a predicate rather than a grid: the caller may store
 * it any way it likes, and `toggle` rather than `add` because this runs again
 * every time a group changes.
 */
export function markGroupJoins(
  cell: HTMLElement,
  x: number,
  y: number,
  sameGroup: (x: number, y: number) => boolean,
  prefix = "cell-join",
) {
  const right = sameGroup(x + 1, y);
  const bottom = sameGroup(x, y + 1);
  cell.classList.toggle(`${prefix}-top`, sameGroup(x, y - 1));
  cell.classList.toggle(`${prefix}-right`, right);
  cell.classList.toggle(`${prefix}-bottom`, bottom);
  cell.classList.toggle(`${prefix}-left`, sameGroup(x - 1, y));
  cell.classList.toggle(
    `${prefix}-corner`,
    right && bottom && sameGroup(x + 1, y + 1),
  );
}

/**
 * Outlines a zone (destination, goal): `prefix` on every cell in it, plus
 * `prefix-edge-*` wherever the neighbor is outside it. Zone membership is
 * keyed by `"x,y"`.
 */
export function markZoneEdges(
  cell: HTMLElement,
  x: number,
  y: number,
  zone: Set<string>,
  prefix: string,
) {
  if (!zone.has(`${x},${y}`)) return;
  cell.classList.add(prefix);
  if (!zone.has(`${x},${y - 1}`)) cell.classList.add(`${prefix}-edge-top`);
  if (!zone.has(`${x + 1},${y}`)) cell.classList.add(`${prefix}-edge-right`);
  if (!zone.has(`${x},${y + 1}`)) cell.classList.add(`${prefix}-edge-bottom`);
  if (!zone.has(`${x - 1},${y}`)) cell.classList.add(`${prefix}-edge-left`);
}
