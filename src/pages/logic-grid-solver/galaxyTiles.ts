/**
 * The squares a SEATED galaxy is drawn across, as one tile each.
 *
 * A seat puts the galaxy's center on a grid line or a corner, so its glyph
 * lies across two squares or four — and the game draws those squares TOUCHING,
 * with the color changing at the edge where they meet rather than across the
 * gap between them. Ours are laid out with a seam, so the pair has to be drawn
 * the way a merged cell is: one outlined tile, by the SVG layer, with the
 * squares themselves painting nothing. Several boxes cannot draw one straight
 * edge — the reason `shapeOutline.ts` exists — and here they cannot draw one
 * color boundary either.
 *
 * What is NOT shared with a merged cell is the color: a merged cell is one
 * variable and its squares always agree, while these are independent and the
 * whole point is that they may differ. That is why the fill is answered per
 * SQUARE here and `outlineLayer.ts` draws a tile once per color it holds.
 *
 * Two questions, deliberately separate, because they change at different
 * times and the drag path cannot afford to ask both:
 *
 *  - `galaxyTiles` is pure GEOMETRY — which squares each galaxy occupies. It
 *    moves only when a clue does.
 *  - `galaxyTiling` is what is actually DRAWN, which depends on the colors
 *    and so moves on every stroke.
 *
 * A square of a drawn tile that is not painted is drawn NEUTRAL — part of the
 * shape, plainly not a color. The tile says the squares are joined; it does
 * not say they agree.
 */

import type { LogicGridSymbol } from "../../util/types";
import { DARK, LIGHT, UNPLAYABLE } from "./cell";
import { symbolKindAt } from "./symbols";

/** Where a square sits. Both callers have this; neither has a whole config. */
interface Size {
  readonly gridWidth: number;
  readonly gridHeight: number;
}

/**
 * Whether this kind's center may sit anywhere on the grid, which is the
 * galaxy and nothing else today.
 *
 * Keyed on the CAPABILITY rather than on the kind's index or its icon: a seat
 * that may fall between any two squares is exactly what makes a tile, so a
 * later kind with the same freedom should get the same drawing without this
 * file learning its name. The lotus's `"cell"` seat is deliberately not it —
 * that one only ever sits inside a merged cell, whose squares are one variable
 * and so can never disagree about color.
 */
export function isTiledKind(type: number): boolean {
  return symbolKindAt(type)?.seating === "board";
}

/** How many squares across and down a seat spans. */
function seatSpan(seat: number): { wide: number; tall: number } {
  return { wide: (seat & 1) !== 0 ? 2 : 1, tall: (seat & 2) !== 0 ? 2 : 1 };
}

/**
 * Every square a galaxy OCCUPIES: its own for seat 0, two for a line seat,
 * four for a corner.
 *
 * The identity question rather than the drawing one, which is why seat 0
 * counts here and not in `galaxyTiles`. It is what says two galaxies are on
 * top of each other — a centered one and one on the same square's edge occupy
 * the same square, which is exactly the placement the editor refuses.
 *
 * A seat whose partner is off the edge answers with the clue's own square
 * alone, exactly as a seat of 0 does. That placement is refused by
 * `seatLegalAt` and by `boardSeatError`, so this only has to not report half a
 * footprint — half of one would draw half a pill, which is worse than none.
 */
export function galaxyFootprint(
  clue: LogicGridSymbol,
  size: Size,
): number[] {
  if (!isTiledKind(clue.type)) return [];
  const { wide, tall } = seatSpan(clue.seat ?? 0);
  const squares: number[] = [];
  for (let dy = 0; dy < tall; dy++) {
    for (let dx = 0; dx < wide; dx++) {
      const [x, y] = [clue.x + dx, clue.y + dy];
      if (x < size.gridWidth && y < size.gridHeight)
        squares.push(y * size.gridWidth + x);
    }
  }
  // A seat whose partner is off the board is refused by `seatLegalAt` when
  // placed and by `boardSeatError` when loaded, so this only has to not report
  // half a footprint: it is the clue's own square alone, as a seat of 0 is.
  return squares.length === wide * tall ? squares : squares.slice(0, 1);
}

/**
 * Every square a galaxy's presence CLAIMS: its footprint, grown to whole cells.
 *
 * Two galaxies may not share a claim, and the unit is the CELL rather than the
 * square because that is the unit the puzzle reasons in. Two galaxies in one
 * merged cell are two centers of rotational symmetry for one region, and
 * composing two point reflections about different centers is a translation —
 * which no finite region survives. So it is not merely undrawable, it is
 * unsatisfiable, and it cannot be seen by looking at squares: the two sit on
 * different ones.
 */
export function galaxyClaim(
  clue: LogicGridSymbol,
  size: Size,
  cellOf: (square: number) => readonly number[],
): number[] {
  const claim = new Set<number>();
  for (const square of galaxyFootprint(clue, size)) {
    for (const mate of cellOf(square)) claim.add(mate);
  }
  return [...claim];
}

/** Whether two galaxies would sit on one cell — see `galaxyClaim`. */
export function galaxiesClash(
  clue: LogicGridSymbol,
  others: Iterable<LogicGridSymbol>,
  size: Size,
  cellOf: (square: number) => readonly number[],
): boolean {
  const mine = new Set(galaxyClaim(clue, size, cellOf));
  if (mine.size === 0) return false;
  return [...others].some(other =>
    galaxyClaim(other, size, cellOf).some(square => mine.has(square)),
  );
}

/**
 * The tiles this board's seated galaxies ask to be drawn as, disjoint.
 *
 * Geometry only: no color is read, so this moves only when a clue does. Two
 * galaxies whose footprints touch are BOTH dropped — the editor refuses to
 * place them and `validateConfig` refuses to load them, so this is the
 * display's own guard against a file that got past neither, and it makes the
 * tiles disjoint by construction. A seat-0 galaxy takes part: it draws no tile
 * of its own, but a square it sits on is still occupied, which is what stops a
 * pill being drawn straight through another galaxy.
 */
export function galaxyTiles(
  clues: Iterable<LogicGridSymbol>,
  size: Size,
): number[][] {
  const footprints = [...clues].map(clue => galaxyFootprint(clue, size));
  const clash = (mine: number, square: number) =>
    footprints.some(
      (other, at) => at !== mine && other.includes(square),
    );
  const tiles: number[][] = [];
  footprints.forEach((footprint, at) => {
    if (footprint.length < 2) return; // not a galaxy, or seated nowhere
    // BOTH of a clashing pair are dropped, not the later one. Dropping one
    // would make the picture depend on the order the clues happen to be
    // stored in, which is stable but arbitrary; dropping both is
    // order-independent and reads as "something here is wrong", which is what
    // a board the editor and the validator both refuse should look like.
    if (footprint.some(square => clash(at, square))) return;
    tiles.push(footprint);
  });
  return tiles;
}

/** What both views draw, answered once so they cannot disagree. */
export interface GalaxyTiling {
  /** The tiles actually drawn — a subset of the geometry's. */
  readonly tiles: readonly (readonly number[])[];
  /** Whether this square is part of a tile that is drawn at all. */
  readonly drawnAt: (x: number, y: number) => boolean;
  /**
   * A square's own color, carried so a seated glyph can ink each of its halves
   * without the cell view needing a second lookup of its own — one object
   * answers everything the drawing asks.
   */
  readonly colorAt: (x: number, y: number) => number;
}

const painted = (color: number) => color === DARK || color === LIGHT;

/**
 * Which of the tiles are actually drawn.
 *
 * ONE square painted is enough, and the ones that are not keep their own
 * absence: they are drawn as a NEUTRAL part of the tile, never borrowed from
 * their partner. Borrowing was tried and is wrong — on a corner seat it turned
 * three squares nobody had touched into solid color, and the board stopped
 * saying which squares were really painted. What the pill has to show is that
 * the squares are JOINED, not that they agree.
 *
 * A tile is dropped — and its squares then behave exactly as they did before
 * pills existed, dashed neighbors with the glyph sitting on the line between
 * them — when any of these holds:
 *
 *  - one of its squares is in a MERGED cell, which already draws itself as one
 *    outlined shape; a second outline over the same squares would draw it
 *    twice. Nothing is lost, since one merged cell holds one color.
 *  - one of its squares is a GAP. A pill is cells joined into one shape, and a
 *    square the puzzle does not color cannot be part of one.
 *  - NOTHING is painted. There is no shape to show yet, and an empty pill is a
 *    merged-cell-looking tile that behaves like nothing else on the board.
 */
export function galaxyTiling(
  tiles: readonly (readonly number[])[],
  size: Size,
  colorAt: (x: number, y: number) => number,
  inMergedCell: (square: number) => boolean,
): GalaxyTiling {
  const colorOf = (square: number) =>
    colorAt(square % size.gridWidth, Math.floor(square / size.gridWidth));
  const drawn: (readonly number[])[] = [];
  const inside = new Set<number>();
  for (const tile of tiles) {
    if (tile.some(square => inMergedCell(square) || colorOf(square) === UNPLAYABLE))
      continue;
    if (!tile.some(square => painted(colorOf(square)))) continue;
    drawn.push(tile);
    for (const square of tile) inside.add(square);
  }
  return {
    tiles: drawn,
    drawnAt: (x, y) => inside.has(y * size.gridWidth + x),
    colorAt,
  };
}

/**
 * Whether two squares are drawn as one tile, for `markGroupJoins`.
 *
 * Out of bounds answers false: `markGroupJoins` asks about all four
 * neighbors, and a square on the board's edge has none on that side.
 */
export function sameGalaxyTile(
  tiles: readonly (readonly number[])[],
  size: Size,
  x: number,
  y: number,
  nx: number,
  ny: number,
): boolean {
  if (nx < 0 || nx >= size.gridWidth || ny < 0 || ny >= size.gridHeight)
    return false;
  const here = y * size.gridWidth + x;
  const there = ny * size.gridWidth + nx;
  return tiles.some(tile => tile.includes(here) && tile.includes(there));
}
