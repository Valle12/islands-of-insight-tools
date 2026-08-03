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

export interface OutlineRequest {
  /** Each merged cell's squares, as flat `y * gridWidth + x` indices. */
  readonly shapes: readonly number[][];
  readonly gridWidth: number;
  readonly gridHeight: number;
  /** The colour a square holds, for the fill. */
  readonly colorOf: (square: number) => number;
  /** The element the geometry is read from. */
  readonly host: HTMLElement;
}

export function createOutlineLayer(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "shape-outline");
  svg.setAttribute("aria-hidden", "true");
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
  const { shapes, gridWidth, gridHeight, colorOf, host } = request;
  if (shapes.length === 0) {
    svg.replaceChildren();
    return;
  }

  const geometry = geometryOf(host);
  const pitch = geometry.cell + geometry.gap;
  const width = gridWidth * pitch - geometry.gap;
  const height = gridHeight * pitch - geometry.gap;
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));

  const fragment = document.createDocumentFragment();
  for (const shape of shapes) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", outlinePath(shape, gridWidth, geometry));
    // The first square's colour speaks for the cell: they are one variable, so
    // they never disagree. Only the NAME goes on the element — the fill and the
    // rim are in the stylesheet with the squares', so a merged cell and a plain
    // one cannot drift apart.
    path.dataset.color = colorId(colorOf(shape[0] ?? 0) ?? UNKNOWN);
    fragment.appendChild(path);
  }
  svg.replaceChildren(fragment);
}
