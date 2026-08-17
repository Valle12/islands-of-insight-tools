import { markGroupJoins } from "../../util/gridOutline";
import type { LogicGridClue, LogicGridTest } from "../../util/types";
import { UNKNOWN } from "./cell";
import { dressCell } from "./cellView";
import { setGridColumns } from "./gridMetrics";
import { createOutlineLayer, drawShapeOutlines } from "./outlineLayer";

export interface SolutionViewData {
  readonly config: LogicGridTest;
  /** The answer, flat row-major — see `verify.ts`. */
  readonly cells: number[];
  /** How many playable cells the answer settles, and how many there are. */
  readonly decided: number;
  readonly playable: number;
  /**
   * Underclued only. `false` means the solver ran out of time with cells it
   * could not settle either way, so the board below is a sound part of the
   * answer rather than the whole of it.
   */
  readonly proven?: boolean;
  readonly underclued: boolean;
}

/**
 * The finished board.
 *
 * There are no steps to walk here, unlike the other three solution views — a
 * logic grid is worked out, not played — so this draws one grid and stops. The
 * section it lives in has room beside it for the reason each cell was deduced,
 * which is what a step view would become if the solver ever explains itself.
 *
 * Cells the solver decided are marked `data-deduced`, so an underclued answer
 * reads as "these are the ones you can paint" rather than as a board someone
 * half-filled in.
 */
export class SolutionView {
  private readonly grid = document.getElementById(
    "solution-grid",
  ) as HTMLDivElement;
  private readonly count = document.getElementById(
    "solution-count",
  ) as HTMLSpanElement;
  private readonly note = document.getElementById(
    "solution-note",
  ) as HTMLDivElement;

  constructor(data: SolutionViewData) {
    this.render(data);
  }

  /**
   * Nothing here registers a listener — the exit button belongs to the editor,
   * which outlives every view. Kept so callers can drop a view the same way
   * they drop the other pages', and so adding one later has an obvious home.
   */
  dispose() {
    this.grid.replaceChildren();
  }

  private render(data: SolutionViewData) {
    const { config, cells } = data;
    // Fixed tracks for the same reason the editor's renderGrid uses them: a
    // shrinkable track overlaps the fixed-width squares under the outline SVG.
    this.grid.style.gridTemplateColumns = `repeat(${config.gridWidth}, var(--logic-cell))`;
    // The answer is the same board at the same width, so the card it is shown
    // in needs the same column count the editor's grid set — stated here too
    // rather than relied on, since this view outlives no render of its own.
    setGridColumns(config.gridWidth);

    const clues = cluesByPosition(config);

    // Which merged cell each square is in, so the answer is drawn with the same
    // tiles the editor showed. A square with no entry is its own cell.
    const cellOf = new Map<number, number>();
    (config.shapes ?? []).forEach((shape, id) => {
      for (const square of shape) cellOf.set(square, id);
    });
    const sameCell = (x: number, y: number, nx: number, ny: number) => {
      if (nx < 0 || nx >= config.gridWidth || ny < 0 || ny >= config.gridHeight)
        return false;
      const id = cellOf.get(y * config.gridWidth + x);
      return id !== undefined && cellOf.get(ny * config.gridWidth + nx) === id;
    };

    // One fragment, one insertion: appending cell by cell to a live grid makes
    // the browser lay the whole thing out on every one of them.
    const fragment = document.createDocumentFragment();
    // First, so every square paints over it — the merged cells are drawn as one
    // path each, exactly as the editor draws them.
    const outlines = createOutlineLayer();
    fragment.appendChild(outlines);
    for (let y = 0; y < config.gridHeight; y++) {
      for (let x = 0; x < config.gridWidth; x++) {
        const cell = document.createElement("div");
        cell.className = "grid-cell";
        cell.dataset.x = String(x);
        cell.dataset.y = String(y);
        const color = cells[y * config.gridWidth + x] ?? UNKNOWN;
        // A square inside a merged cell leaves the mark to the outline: the
        // ring is drawn per square and would cut the tile into its pieces.
        if (
          color !== UNKNOWN &&
          config.cells[x]![y] === UNKNOWN &&
          !cellOf.has(y * config.gridWidth + x)
        )
          cell.dataset.deduced = "true";
        dressCell(cell, color, clues.get(`${x},${y}`) ?? null, x, y);
        markGroupJoins(cell, x, y, (nx, ny) => sameCell(x, y, nx, ny));
        fragment.appendChild(cell);
      }
    }
    this.grid.replaceChildren(fragment);
    drawShapeOutlines(outlines, {
      shapes: config.shapes ?? [],
      gridWidth: config.gridWidth,
      gridHeight: config.gridHeight,
      colorOf: square => cells[square] ?? UNKNOWN,
      deducedAt: square =>
        (cells[square] ?? UNKNOWN) !== UNKNOWN &&
        config.cells[square % config.gridWidth]![
          Math.floor(square / config.gridWidth)
        ] === UNKNOWN,
      host: this.grid,
    });

    // "squares" once the board has merged cells, because that is what these
    // two numbers count — the solver measures the board in squares throughout,
    // and a 20-cell board made of 25 squares would otherwise report "25 cells".
    const unit = config.shapes?.length ? "squares" : "cells";
    this.count.textContent = data.underclued
      ? `${data.decided} of ${data.playable} ${unit} deduced`
      : `${data.playable} ${unit}`;
    this.note.textContent = noteFor(data);
  }
}

/**
 * The clues by position, carrying exactly the optional keys the config does —
 * arrows, axes and seats included. A dart with no direction here would come
 * out as a bare number, and a seated lotus would slide back to its square's
 * centre, either of which reads as a different puzzle from the one just
 * solved.
 */
function cluesByPosition(config: LogicGridTest): Map<string, LogicGridClue> {
  const clues = new Map<string, LogicGridClue>();
  for (const symbol of config.symbols)
    clues.set(`${symbol.x},${symbol.y}`, {
      type: symbol.type,
      ...(symbol.value === undefined ? {} : { value: symbol.value }),
      ...(symbol.direction === undefined
        ? {}
        : { direction: symbol.direction }),
      ...(symbol.seat === undefined ? {} : { seat: symbol.seat }),
    });
  return clues;
}

function noteFor(data: SolutionViewData): string {
  if (!data.underclued) return "";
  if (data.proven === false) {
    return (
      "The time limit ran out before every cell could be settled. Everything " +
      "painted above is proven — the blank cells are the ones still unknown, " +
      "not necessarily the ones that cannot be deduced."
    );
  }
  if (data.decided === data.playable)
    return "Every cell is forced, so this board has exactly one solution.";
  return (
    "The blank cells are not forced: each of them takes both colours in some " +
    "valid solution, so there is nothing to paint there."
  );
}
