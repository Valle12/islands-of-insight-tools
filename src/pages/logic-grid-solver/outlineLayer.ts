/**
 * The SVG layer that draws every merged cell on a grid.
 *
 * Shared by the editor and the solution view, which both draw the same tiles
 * from the same config. The squares themselves paint nothing once they are part
 * of a merged cell — see `shapeOutline.ts` for why the outline cannot be built
 * out of their borders.
 */

import { colorId, UNKNOWN } from "./cell";
import { outlinePath, type OutlineGeometry } from "./shapeOutline";

const SVG_NS = "http://www.w3.org/2000/svg";

/** Fallbacks for a DOM with no stylesheet, which is what the unit tests mount. */
const DEFAULT_CELL = 42;
const DEFAULT_SEAM = 6;
const DEFAULT_RADIUS = 8;
const STROKE = 1;

/**
 * One shape to outline: its squares, and whether an undecided square of it is
 * drawn as a NEUTRAL part of the tile rather than as the hole it is.
 *
 * A merged cell wants the hole — an unpainted one is an outline around
 * nothing, which is what it has always looked like. A seated galaxy's tile
 * wants the neutral fill: the shape is drawn as soon as ONE of its squares is
 * painted, so the others have to read as part of it and plainly not a color.
 */
export interface OutlineShape {
  readonly squares: readonly number[];
  readonly blank?: boolean;
}

export interface OutlineRequest {
  /** Each shape's squares, as flat `y * gridWidth + x` indices. */
  readonly shapes: readonly OutlineShape[];
  readonly gridWidth: number;
  readonly gridHeight: number;
  /** The color a square holds, for the fill. */
  readonly colorOf: (square: number) => number;
  /**
   * Whether the solver worked this square out, when the answer view is asking.
   *
   * A merged cell has to carry that mark on its OUTLINE rather than on each of
   * its squares: the squares' own ring is drawn per square and cuts the tile
   * into the pieces it is made of, which is the one thing the whole outline
   * exists to stop. Absent in the editor, which marks nothing.
   */
  readonly deducedAt?: (square: number) => boolean;
  /** The element the geometry is read from. */
  readonly host: HTMLElement;
}

/**
 * One per layer ever built, so the clip ids below cannot collide.
 *
 * Two layers are live whenever the answer is open — the editor's is still in
 * the document behind it — and a clip is reached by id from the whole
 * document, so two layers numbering their clips from zero would have the
 * second one's tiles clipped by the first one's rects.
 */
let layerCount = 0;

export function createOutlineLayer(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "shape-outline");
  svg.setAttribute("aria-hidden", "true");
  svg.dataset.layer = String(layerCount++);
  return svg;
}

/**
 * Reads the drawn geometry off the page rather than assuming it: the square
 * size is a custom property that the mobile breakpoint changes, so a hard-coded
 * 42 would put every outline in the wrong place on a narrow screen.
 */
function geometryOf(host: HTMLElement): OutlineGeometry {
  const style = getComputedStyle(host);
  const px = (name: string, fallback: number) => {
    const value = Number.parseFloat(style.getPropertyValue(name));
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  return {
    cell: px("--logic-cell", DEFAULT_CELL),
    gap: px("--logic-seam", DEFAULT_SEAM),
    radius: DEFAULT_RADIUS,
    stroke: STROKE,
  };
}

export function drawShapeOutlines(
  svg: SVGSVGElement,
  request: OutlineRequest,
): void {
  const { shapes, gridWidth, gridHeight, colorOf, deducedAt, host } = request;

  // Sized even when there is nothing to draw, and BEFORE the empty case bails.
  // An `<svg>` with no width, height or viewBox falls back to the replaced
  // element's default 300x150 — and this layer is absolutely positioned inside
  // the grid, so that phantom box lands in the scrollable overflow of the shell
  // around it. Measured on a 4x4 board with no merged cells at all: 186px of
  // grid inside a 214px shell, reporting a 300px scroll width, which is a
  // horizontal scrollbar over nothing plus the 16px of height it reserves. The
  // editor hid it because its shell is stretched wide by the tool rows above;
  // the answer's shell shrinks to its board, so every small board showed it.
  const geometry = geometryOf(host);
  const pitch = geometry.cell + geometry.gap;
  const width = gridWidth * pitch - geometry.gap;
  const height = gridHeight * pitch - geometry.gap;
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));

  if (shapes.length === 0) {
    svg.replaceChildren();
    return;
  }

  const fragment = document.createDocumentFragment();
  shapes.forEach((shape, index) => {
    drawOneShape(fragment, {
      shape: shape.squares,
      blank: shape.blank === true,
      d: outlinePath(shape.squares, gridWidth, geometry),
      id: `${svg.dataset.layer ?? "0"}-${index}`,
      gridWidth,
      geometry,
      colorOf,
      deducedAt,
    });
  });
  svg.replaceChildren(fragment);
}

/** What `drawOneShape` needs, gathered so it takes one argument. */
interface ShapeRequest {
  readonly shape: readonly number[];
  readonly blank: boolean;
  readonly d: string;
  readonly id: string;
  readonly gridWidth: number;
  readonly geometry: OutlineGeometry;
  readonly colorOf: (square: number) => number;
  readonly deducedAt?: (square: number) => boolean;
}

/**
 * One tile, as one path per COLOR its squares hold.
 *
 * A merged cell is one variable, so its squares never disagree and this draws
 * the single path it always did. A seated galaxy's tile is the other case: two
 * squares or four, each its own variable, and the whole reason the tile is
 * drawn at all is that the color changes across it — at the EDGE where the
 * squares meet, the way the game draws it, rather than across the seam.
 *
 * Each color's copy is clipped to its own squares grown by half the seam, so
 * the boundary falls exactly on the line between them and the outline's own
 * rounded edge still cuts every copy. Clipping the whole path rather than
 * stroking each half separately is what keeps ONE rim around the tile: a clip
 * cuts the stroke it does not add one.
 */
function drawOneShape(
  fragment: DocumentFragment,
  request: ShapeRequest,
): void {
  const { shape, blank, d, id, gridWidth, geometry, colorOf, deducedAt } =
    request;
  const byColor = new Map<number, number[]>();
  for (const square of shape) {
    const color = colorOf(square) ?? UNKNOWN;
    byColor.set(color, [...(byColor.get(color) ?? []), square]);
  }

  let first = true;
  for (const [color, squares] of byColor) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    // Only the NAME goes on the element — the fill and the rim are in the
    // stylesheet with the squares', so a tile and a plain square cannot drift
    // apart.
    // An undecided square of a BLANK shape is named apart from an undecided
    // merged cell, because the two want opposite things: the tile fills the
    // part neutrally so the shape reads as one, the merged cell leaves the
    // hole it has always left.
    path.dataset.color =
      blank && color === UNKNOWN ? "blank" : colorId(color);
    if (deducedAt?.(squares[0] ?? 0)) path.dataset.deduced = "true";
    // The FIRST color is laid whole and unclipped, and the rest are clipped
    // over it. Two clipped halves would meet on a shared edge, and at a
    // fractional browser zoom that edge rounds to a hairline of background
    // down the middle of the tile; painted over a whole base there is nothing
    // for a seam to show through. A merged cell holds one color and so is the
    // base alone, exactly as it always was.
    if (!first) {
      const clipId = `outline-clip-${id}-${color}`;
      fragment.appendChild(clipFor(clipId, squares, gridWidth, geometry));
      path.setAttribute("clip-path", `url(#${clipId})`);
    }
    first = false;
    fragment.appendChild(path);
  }
}

/**
 * The region one color of a tile owns: its squares, each grown by HALF the
 * seam on every side.
 *
 * Half, so two colors meet exactly on the line between their squares — the
 * one pixel of change the game shows. Growing by the whole seam would make
 * them overlap and the later copy would win the whole gap.
 */
function clipFor(
  id: string,
  squares: readonly number[],
  gridWidth: number,
  geometry: OutlineGeometry,
): SVGClipPathElement {
  const clip = document.createElementNS(SVG_NS, "clipPath");
  clip.setAttribute("id", id);
  const pitch = geometry.cell + geometry.gap;
  const half = geometry.gap / 2;
  for (const square of squares) {
    const rect = document.createElementNS(SVG_NS, "rect");
    rect.setAttribute("x", String((square % gridWidth) * pitch - half));
    rect.setAttribute("y", String(Math.floor(square / gridWidth) * pitch - half));
    rect.setAttribute("width", String(geometry.cell + geometry.gap));
    rect.setAttribute("height", String(geometry.cell + geometry.gap));
    clip.appendChild(rect);
  }
  return clip;
}
