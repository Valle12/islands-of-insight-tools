import type { Position } from "../../util/types";
import { markGroupJoins } from "../../util/gridOutline";
import { dressCell } from "./cellView";
import type { BoardLayers } from "./boardLayers";
import {
  galaxyTiles,
  galaxyTiling,
  sameGalaxyTile,
  type GalaxyTiling,
} from "./galaxyTiles";
import { setGridColumns } from "./gridMetrics";
import { NO_SHAPE } from "./shapes";
import { createOutlineLayer, drawShapeOutlines } from "./outlineLayer";

/** What a board with no galaxies on it draws, for the field initializer. */
function emptyTiling(): GalaxyTiling {
  return galaxyTiling([], { gridWidth: 0, gridHeight: 0 }, () => 0, () => false);
}

/**
 * Everything the board owns that is an element: the `#grid` host, one button
 * per square, and the SVG layer the merged cells are outlined on.
 *
 * Split out of `board.ts` because drawing only ever READS the layers — the seam
 * is one-way — and that is what stops "what does this stroke write" from being
 * a question you answer by reading DOM code. Nothing here decides anything; it
 * is told what changed and repaints exactly that much.
 */
export class BoardView {
  private readonly layers: BoardLayers;
  /** `#grid`, which OUTLIVES the board — see `Board.dispose`. */
  readonly host: HTMLDivElement;
  /**
   * The rendered cell buttons, indexed like the color layer. Painting rewrites
   * the one button it touched rather than re-running `render`; on a 32x32 board
   * that is the difference between one attribute write and rebuilding 1024
   * elements per pointermove.
   */
  private cellElements: HTMLButtonElement[][] = [];
  /** Where every merged cell is drawn — see `outlineLayer.ts`. */
  private outlines: SVGSVGElement | null = null;
  /**
   * The squares each seated galaxy OCCUPIES, held rather than derived.
   *
   * `dressCellAt` runs once per square of a full render, so deriving this
   * there would walk every clue on the board a thousand times over. Pure
   * geometry, so it moves only when a CLUE does.
   */
  private tiles: number[][] = [];
  /**
   * Which of those tiles are actually DRAWN, and in what color.
   *
   * A second, cheaper cache on top of the first, and the split is what keeps
   * dragging affordable: this depends on the colors and so moves on every
   * stroke, while `tiles` above does not — so a color write recomputes only
   * this, and only when it lands on a square some tile occupies.
   */
  private tiling: GalaxyTiling = emptyTiling();
  /**
   * Retraces the outlines when the squares change size. They are traced in
   * PIXELS, at the size actually rendered, so the mobile breakpoint moving a
   * square from 42px to 34px would otherwise leave every tile behind.
   */
  private readonly resize = new ResizeObserver(() => this.drawOutlines());

  constructor(layers: BoardLayers) {
    this.layers = layers;
    this.host = document.getElementById("grid") as HTMLDivElement;
  }

  dispose() {
    this.resize.disconnect();
  }

  /** The only full rebuild. Everything else writes one square in place. */
  render() {
    // Fixed-size tracks, never minmax(0, 1fr): the squares have a hard
    // width, so a track allowed to shrink below it makes the cells OVERLAP
    // while the absolutely-positioned outline SVG keeps its natural size —
    // a squeezed grid under a full-width overlay, i.e. a scrollbar into
    // blank space. Fixed tracks keep grid, cells and SVG the same width and
    // let #grid-shell do the scrolling.
    this.host.style.gridTemplateColumns = `repeat(${this.layers.gridWidth}, var(--logic-cell))`;
    setGridColumns(this.layers.gridWidth);
    this.recomputeTiles();

    // One fragment, one insertion: appending cell by cell to a live #grid
    // makes the browser lay out the whole grid on every one of them.
    const fragment = document.createDocumentFragment();
    // First, so every square paints over it.
    this.outlines = createOutlineLayer();
    fragment.appendChild(this.outlines);
    this.cellElements = Array.from(
      { length: this.layers.gridWidth },
      (): HTMLButtonElement[] => [],
    );

    for (let y = 0; y < this.layers.gridHeight; y++) {
      for (let x = 0; x < this.layers.gridWidth; x++) {
        const cell = document.createElement("button");
        cell.type = "button";
        cell.className = "grid-cell";
        cell.dataset.x = String(x);
        cell.dataset.y = String(y);
        this.cellElements[x]![y] = cell;
        this.dressCellAt(x, y);
        fragment.appendChild(cell);
      }
    }

    this.host.replaceChildren(fragment);
    this.drawOutlines();
    this.resize.observe(this.host);
  }

  /** Writes the current state of (x, y) onto its button. */
  dressCellAt(x: number, y: number) {
    const element = this.cellElements[x]?.[y];
    if (!element) return;
    const color = this.layers.colorAt({ x, y });
    // The TILING, not the raw colors: a seated glyph inks each of its halves
    // against what is actually drawn under it, which for an unpainted square
    // of a pill is its partner's color — see `glyphPieces`.
    dressCell(element, color, this.layers.clueAt({ x, y }), x, y, this.tiling);
    markGroupJoins(element, x, y, (nx, ny) =>
      this.layers.sharesCell(x, y, nx, ny),
    );
    // A second, independent grouping with its own prefix: a seated galaxy's
    // squares are drawn as one tile like a merged cell's, but they are NOT one
    // cell — they keep their own colors, and the seam between them must stay
    // its own hit target rather than becoming part of a tile.
    markGroupJoins(
      element,
      x,
      y,
      (nx, ny) => sameGalaxyTile(this.tiling.tiles, this.size(), x, y, nx, ny),
      "cell-pair",
    );
  }

  private size() {
    return {
      gridWidth: this.layers.gridWidth,
      gridHeight: this.layers.gridHeight,
    };
  }

  /** Both caches, for a change that could have moved either. */
  private recomputeTiles() {
    this.tiles = galaxyTiles(this.layers.getSymbols(), this.size());
    this.recomputeTiling();
  }

  private recomputeTiling() {
    this.tiling = galaxyTiling(
      this.tiles,
      this.size(),
      (x, y) => this.layers.colorAt({ x, y }),
      square =>
        this.layers.cellIdAt({
          x: square % this.layers.gridWidth,
          y: Math.floor(square / this.layers.gridWidth),
        }) !== NO_SHAPE,
    );
  }

  /** Every square of every tile this one occupies, itself included. */
  private tileAround(position: Position): number[] {
    const square = position.y * this.layers.gridWidth + position.x;
    return this.tiles.filter(tile => tile.includes(square)).flat();
  }

  /**
   * Brings the drawing back in step after a COLOR moved.
   *
   * A color cannot move a tile's geometry, but it decides whether the tile is
   * drawn at all and what every square of it is filled with — so the whole
   * tile is repainted, not just the square written. The glyph lives on the
   * clue's square, so painting its PARTNER and repainting only that partner is
   * what left one paint order working and the other not.
   */
  refreshGalaxyFill(position: Position) {
    const squares = this.tileAround(position);
    if (squares.length === 0) return;
    this.recomputeTiling();
    for (const square of squares) {
      this.dressCellAt(
        square % this.layers.gridWidth,
        Math.floor(square / this.layers.gridWidth),
      );
    }
    this.drawOutlines();
  }

  /**
   * Brings the tiles back in step after a CLUE moved.
   *
   * Re-dresses the square's whole neighborhood as well as every tiled square:
   * a seat joins its square to ones that carry no clue at all, so lifting a
   * galaxy has to reach squares nothing else would think to repaint, and the
   * furthest of them is one step away.
   */
  refreshGalaxyTiles(position: Position) {
    const before = this.tiles.flat();
    this.recomputeTiles();
    for (const square of new Set([...before, ...this.tiles.flat()])) {
      this.dressCellAt(
        square % this.layers.gridWidth,
        Math.floor(square / this.layers.gridWidth),
      );
    }
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++)
        this.dressCellAt(position.x + dx, position.y + dy);
    }
    this.drawOutlines();
  }

  /**
   * Redraws every merged cell's outline. Called whenever membership changes,
   * whenever one is painted, and when the squares change size — the outline is
   * traced in pixels, so it has to be retraced at the size actually rendered.
   */
  drawOutlines() {
    if (!this.outlines) return;
    drawShapeOutlines(this.outlines, {
      // The merged cells and the galaxy tiles are drawn the same way and by
      // the same code — one outlined tile each — so they arrive as one list.
      // Only the tiles are `blank`: an unpainted square of one is part of the
      // shape, while an unpainted merged cell is an outline around nothing.
      shapes: [
        ...(this.layers.getShapes() ?? []).map(squares => ({ squares })),
        ...this.tiling.tiles.map(squares => ({ squares, blank: true })),
      ],
      gridWidth: this.layers.gridWidth,
      gridHeight: this.layers.gridHeight,
      colorOf: square =>
        this.layers.colorAt({
          x: square % this.layers.gridWidth,
          y: Math.floor(square / this.layers.gridWidth),
        }),
      host: this.host,
    });
  }

  /**
   * Redraws squares after their membership changed. A second pass rather than
   * part of the loop that moved them: which sides a square joins depends on its
   * neighbors' membership, which that loop was still moving around.
   */
  redress(squares: Iterable<number>) {
    // Membership decides whether a galaxy TILE may be drawn at all — a merged
    // cell already draws itself, so a tile touching one is dropped — and
    // merging a pill's partner into a cell moves no clue and writes no color,
    // so nothing else here would notice.
    this.recomputeTiles();
    for (const square of squares) {
      const { x, y } = this.layers.shapes.position(square);
      this.dressCellAt(x, y);
    }
    for (const square of this.tiles.flat()) {
      this.dressCellAt(
        square % this.layers.gridWidth,
        Math.floor(square / this.layers.gridWidth),
      );
    }
    // Membership moved, so every outline is retraced rather than patched.
    this.drawOutlines();
  }

  /**
   * The drawn box of a square, or null when there is none to measure — an
   * unrendered square, or a DOM that has laid nothing out. Both read the same
   * to a caller: it cannot tell where inside the square a press landed.
   */
  rectAt(position: Position): DOMRect | null {
    const element = this.cellElements[position.x]?.[position.y];
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return rect.width <= 0 || rect.height <= 0 ? null : rect;
  }
}
