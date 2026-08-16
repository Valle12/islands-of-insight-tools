import { BLOCKED, isSymbol, symbolIndexOf } from "./cell";
import { BLOCKER_IMAGE, symbolAt } from "./symbols";

/**
 * What a cell is called. Symbols are a fixed, append-only list, so naming one
 * here is stable enough to assert on in an aria snapshot.
 */
export function describeCell(
  x: number,
  y: number,
  value: number,
): string {
  const position = `Column ${x + 1}, Row ${y + 1}`;
  if (isSymbol(value)) {
    const index = symbolIndexOf(value);
    const name = symbolAt(index)?.label ?? `Symbol ${index + 1}`;
    return `${position}, ${name}`;
  }
  return `${position}, ${value === BLOCKED ? "Blocked" : "Empty"}`;
}

/**
 * Writes one cell value onto an element. Shared by the editor grid and the
 * solution grid so a cell reads and tests the same in both — the solution view
 * is the same board, only further along.
 */
export function dressCell(
  element: HTMLElement,
  value: number,
  x: number,
  y: number,
): void {
  const symbol = isSymbol(value) ? symbolAt(symbolIndexOf(value)) : undefined;

  // Handed to the stylesheet as a variable rather than set as
  // `background-image` directly: which image is a runtime choice, but *that*
  // it is the background is a rule, and belongs in the CSS.
  if (symbol) {
    element.dataset.kind = "symbol";
    element.dataset.symbol = symbol.id;
    element.style.setProperty("--symbol-image", `url("${symbol.image}")`);
  } else if (value === BLOCKED) {
    element.dataset.kind = "blocked";
    delete element.dataset.symbol;
    element.style.setProperty("--symbol-image", `url("${BLOCKER_IMAGE}")`);
  } else {
    element.dataset.kind = "empty";
    delete element.dataset.symbol;
    element.style.removeProperty("--symbol-image");
  }

  element.setAttribute("aria-label", describeCell(x, y, value));
}
