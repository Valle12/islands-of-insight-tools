import type { LogicGridClue } from "../../util/types";
import { colorLabel, colorId } from "./cell";
import { DIRECTION_ICON, directionAt, symbolKindAt } from "./symbols";

/**
 * What a cell is called. Colours, clue kinds and directions are all fixed,
 * append-only lists, so naming one here is stable enough to assert on in an
 * aria snapshot.
 */
export function describeCell(
  x: number,
  y: number,
  cell: number,
  clue: LogicGridClue | null,
): string {
  const position = `Column ${x + 1}, Row ${y + 1}, ${colorLabel(cell)}`;
  const kind = clue ? symbolKindAt(clue.type) : undefined;
  if (!clue || !kind) return position;
  const aim = clue.direction === undefined ? null : directionAt(clue.direction);
  const pointing = aim ? ` pointing ${aim.label.toLowerCase()}` : "";
  return `${position}, ${kind.label} ${clue.value}${pointing}`;
}

/**
 * Writes one cell's two layers onto an element: the colour as `data-color`, and
 * the clue as text plus `data-symbol` / `data-symbol-value`.
 *
 * The clue is drawn as the element's own text rather than as a background,
 * because its ink has to follow the cell's colour — that is what makes a clue
 * on a dark cell a dark clue. A DIRECTED clue is two children instead of one
 * text node, and the arrow is a real element rather than a pseudo-element so
 * the pointer can grab it and swing it round.
 */
export function dressCell(
  element: HTMLElement,
  cell: number,
  clue: LogicGridClue | null,
  x: number,
  y: number,
): void {
  element.dataset.color = colorId(cell);

  const kind = clue ? symbolKindAt(clue.type) : undefined;
  if (clue && kind) {
    const label = String(clue.value);
    element.dataset.symbol = kind.id;
    element.dataset.symbolValue = label;
    // How many characters the cell has to hold, so the stylesheet can size the
    // text to it. CSS cannot measure a string, and an area number is only
    // bounded by the board's own area — 1024 on the largest grid the editor
    // accepts — so one fixed size would either look lost in the cell or spill
    // out of it. Capped at the largest bucket the stylesheet defines.
    element.dataset.labelLength = String(Math.min(label.length, 4));
    dressClue(element, label, clue.direction);
  } else {
    delete element.dataset.symbol;
    delete element.dataset.symbolValue;
    delete element.dataset.labelLength;
    delete element.dataset.direction;
    element.textContent = "";
  }

  element.setAttribute("aria-label", describeCell(x, y, cell, clue));
}

/**
 * The clue's own contents: a bare text node for an undirected one, and a
 * number beside an arrow for a directed one.
 *
 * The arrow's SEAT is a quarter turn clockwise of the way it points — pointing
 * up puts it right of the number, pointing right puts it below, and so on —
 * which the stylesheet does with one flex direction per `data-direction`. The
 * number is written first either way, so that ordering is all it takes, and
 * the same `data-direction` turns the single arrow glyph to face the right way.
 *
 * Exported because the clue-kind CHIP draws a miniature of the tile with it:
 * one function so the chip and what it stamps cannot come to look like two
 * different things.
 */
export function dressClue(
  element: HTMLElement,
  label: string,
  direction: number | undefined,
): void {
  const aim = direction === undefined ? null : directionAt(direction);
  if (!aim) {
    delete element.dataset.direction;
    element.textContent = label;
    return;
  }

  element.dataset.direction = aim.id;
  const value = document.createElement("span");
  value.className = "cell-value";
  value.textContent = label;
  // `md-icon` rather than a glyph: the ligature has to be rendered by the
  // Material Symbols font, and a name outside the subset in common.css comes
  // out as its own text. Only a clued cell ever builds one, so a 32x32 board
  // pays for the handful it really has.
  const arrow = document.createElement("md-icon");
  arrow.className = "cell-arrow";
  arrow.textContent = DIRECTION_ICON;
  element.replaceChildren(value, arrow);
}
