import type { LogicGridClue, LogicGridTest } from "../../util/types";
import { UNKNOWN } from "./cell";
import { dressCell } from "./cellView";

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
    this.grid.style.gridTemplateColumns = `repeat(${config.gridWidth}, minmax(0, 1fr))`;

    const clues = new Map<string, LogicGridClue>();
    for (const symbol of config.symbols)
      clues.set(`${symbol.x},${symbol.y}`, {
        type: symbol.type,
        value: symbol.value,
      });

    // One fragment, one insertion: appending cell by cell to a live grid makes
    // the browser lay the whole thing out on every one of them.
    const fragment = document.createDocumentFragment();
    for (let y = 0; y < config.gridHeight; y++) {
      for (let x = 0; x < config.gridWidth; x++) {
        const cell = document.createElement("div");
        cell.className = "grid-cell";
        cell.dataset.x = String(x);
        cell.dataset.y = String(y);
        const color = cells[y * config.gridWidth + x] ?? UNKNOWN;
        if (color !== UNKNOWN && config.cells[x]![y] === UNKNOWN)
          cell.dataset.deduced = "true";
        dressCell(cell, color, clues.get(`${x},${y}`) ?? null, x, y);
        fragment.appendChild(cell);
      }
    }
    this.grid.replaceChildren(fragment);

    this.count.textContent = data.underclued
      ? `${data.decided} of ${data.playable} cells deduced`
      : `${data.playable} cells`;
    this.note.textContent = noteFor(data);
  }
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
