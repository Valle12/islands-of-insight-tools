/**
 * Outlining helpers shared by the solution views. Both draw a border around a
 * *set* of cells by putting an edge class on every cell whose neighbour is
 * outside the set — the grid has gaps between cells, so a single border on a
 * wrapper is not an option.
 */

/**
 * Outlines a block: an edge class wherever the neighbour is a different block.
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
 * Outlines a zone (destination, goal): `prefix` on every cell in it, plus
 * `prefix-edge-*` wherever the neighbour is outside it. Zone membership is
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
