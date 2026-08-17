import type { Position } from "../../util/types";
import { markGroupJoins } from "../../util/gridOutline";
import { dressCell } from "./cellView";
import type { BoardLayers } from "./boardLayers";
import { setGridColumns } from "./gridMetrics";
import { createOutlineLayer, drawShapeOutlines } from "./outlineLayer";

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
   * The rendered cell buttons, indexed like the colour layer. Painting rewrites
   * the one button it touched rather than re-running `render`; on a 32x32 board
   * that is the difference between one attribute write and rebuilding 1024
   * elements per pointermove.
   */
  private cellElements: HTMLButtonElement[][] = [];
  /** Where every merged cell is drawn — see `outlineLayer.ts`. */
  private outlines: SVGSVGElement | null = null;
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
    dressCell(element, color, this.layers.clueAt({ x, y }), x, y);
    markGroupJoins(element, x, y, (nx, ny) =>
      this.layers.sharesCell(x, y, nx, ny),
    );
  }

  /**
   * Redraws every merged cell's outline. Called whenever membership changes,
   * whenever one is painted, and when the squares change size — the outline is
   * traced in pixels, so it has to be retraced at the size actually rendered.
   */
  drawOutlines() {
    if (!this.outlines) return;
    drawShapeOutlines(this.outlines, {
      shapes: this.layers.getShapes() ?? [],
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
   * neighbours' membership, which that loop was still moving around.
   */
  redress(squares: Iterable<number>) {
    for (const square of squares) {
      const { x, y } = this.layers.shapes.position(square);
      this.dressCellAt(x, y);
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
