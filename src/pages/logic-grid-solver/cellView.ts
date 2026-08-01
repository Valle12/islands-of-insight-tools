import type { LogicGridCell, LogicGridClue } from "../../util/types";
import { colorLabel, colorId } from "./cell";
import { symbolKindAt } from "./symbols";

/**
 * What a cell is called. Colours and clue kinds are both fixed, append-only
 * lists, so naming one here is stable enough to assert on in an aria snapshot.
 */
export function describeCell(
  x: number,
  y: number,
  cell: LogicGridCell,
  clue: LogicGridClue | null,
): string {
  const position = `Column ${x + 1}, Row ${y + 1}, ${colorLabel(cell)}`;
  const kind = clue ? symbolKindAt(clue.type) : undefined;
  if (!clue || !kind) return position;
  return `${position}, ${kind.label} ${clue.value}`;
}

/**
 * Writes one cell's two layers onto an element: the colour as `data-color`, and
 * the clue as text plus `data-symbol` / `data-symbol-value`.
 *
 * The clue is drawn as the element's own text rather than as a background,
 * because its ink has to follow the cell's colour — that is what makes a clue
 * on a dark cell a dark clue.
 */
export function dressCell(
  element: HTMLElement,
  cell: LogicGridCell,
  clue: LogicGridClue | null,
  x: number,
  y: number,
): void {
  element.dataset.color = colorId(cell);

  const kind = clue ? symbolKindAt(clue.type) : undefined;
  if (clue && kind) {
    element.dataset.symbol = kind.id;
    element.dataset.symbolValue = String(clue.value);
    element.textContent = String(clue.value);
  } else {
    delete element.dataset.symbol;
    delete element.dataset.symbolValue;
    element.textContent = "";
  }

  element.setAttribute("aria-label", describeCell(x, y, cell, clue));
}
