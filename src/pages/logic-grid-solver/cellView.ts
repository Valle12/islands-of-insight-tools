import type { LogicGridClue } from "../../util/types";
import { colorLabel, colorId } from "./cell";
import {
  AXIS_ICON,
  axisAt,
  DIRECTION_ICON,
  directionAt,
  symbolKindAt,
  VIEWPOINT_ICON,
  type LogicGridSymbolKind,
} from "./symbols";

/**
 * What a cell is called. Colours, clue kinds, directions and axes are all
 * fixed, append-only lists, so naming one here is stable enough to assert on
 * in an aria snapshot.
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
  if (kind.aims === "axis") {
    const axis = axisAt(clue.direction ?? -1);
    const along = axis ? ` along the ${axis.label.toLowerCase()} axis` : "";
    return `${position}, ${kind.label}${along}`;
  }
  // A valueless, axis-less kind — the galaxy — is its name alone: there is no
  // value to say and nothing points anywhere. Without this branch the line
  // below would read "Galaxy undefined".
  if (kind.valueKind === "none") return `${position}, ${kind.label}`;
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
    element.dataset.symbol = kind.id;
    if (kind.valueKind === "none") {
      // A valueless clue writes no value attributes at all: an axis glyph is
      // sized like an icon, never like text.
      delete element.dataset.symbolValue;
      delete element.dataset.labelLength;
      dressClue(element, kind, "", clue.direction, clue.seat);
    } else {
      const label = String(clue.value);
      element.dataset.symbolValue = label;
      // How many characters the cell has to hold, so the stylesheet can size
      // the text to it. CSS cannot measure a string, and an area number is
      // only bounded by the board's own area — 1024 on the largest grid the
      // editor accepts — so one fixed size would either look lost in the cell
      // or spill out of it. Capped at the largest bucket the stylesheet
      // defines.
      element.dataset.labelLength = String(Math.min(label.length, 4));
      dressClue(element, kind, label, clue.direction);
    }
  } else {
    delete element.dataset.symbol;
    delete element.dataset.symbolValue;
    delete element.dataset.labelLength;
    delete element.dataset.direction;
    delete element.dataset.axis;
    delete element.dataset.seat;
    delete element.dataset.viewpoint;
    delete element.dataset.icon;
    element.textContent = "";
  }

  element.setAttribute("aria-label", describeCell(x, y, cell, clue));
}

/**
 * The clue's own contents: a bare text node for an undirected one, a number
 * beside an arrow for a compass-aimed one, the rotated axis glyph alone for an
 * axis-aimed one — and, for a cross-reach one, the number ringed by four
 * outward chevrons, one per ray its sight runs along.
 *
 * The arrow's SEAT is a quarter turn clockwise of the way it points — pointing
 * up puts it right of the number, pointing right puts it below, and so on —
 * which the stylesheet does with one flex direction per `data-direction`. The
 * number is written first either way, so that ordering is all it takes, and
 * the same `data-direction` turns the single arrow glyph to face the right way.
 * An axis-aimed clue is the same trick with nothing beside it: `data-axis`
 * turns one glyph four ways, and `data-seat` slides it onto the cell's grid
 * lines — half a square right for bit 0, down for bit 1. The chevrons are the
 * trick a third time: one glyph, seated and turned per `data-edge`.
 *
 * Exported because the clue-kind CHIP draws a miniature of the tile with it:
 * one function so the chip and what it stamps cannot come to look like two
 * different things.
 */
export function dressClue(
  element: HTMLElement,
  kind: LogicGridSymbolKind,
  label: string,
  direction: number | undefined,
  seat = 0,
): void {
  if (kind.icon) {
    // An ICON kind's clue — the galaxy — is one glyph and nothing else: no
    // value, no direction, no seat. Every other hook is shed and one is set;
    // `data-icon` is presence-only, the stylesheet's centring hook, exactly
    // as `data-viewpoint` is the ring's.
    delete element.dataset.direction;
    delete element.dataset.axis;
    delete element.dataset.seat;
    delete element.dataset.viewpoint;
    element.dataset.icon = "";
    const glyph = document.createElement("md-icon");
    glyph.className = "cell-galaxy";
    glyph.textContent = kind.icon;
    element.replaceChildren(glyph);
    return;
  }
  // Shed here once for every branch below, so a cell restamped from a galaxy
  // to any other kind loses the hook — a stale `data-icon` would keep the
  // icon centring on a clue that is text.
  delete element.dataset.icon;

  if (kind.aims === "axis") {
    const axis = axisAt(direction ?? -1);
    delete element.dataset.direction;
    delete element.dataset.viewpoint;
    element.dataset.axis = axis?.id ?? "horizontal";
    if (seat > 0) element.dataset.seat = String(seat);
    else delete element.dataset.seat;
    // `md-icon`, like the arrow below and for the same reason.
    const glyph = document.createElement("md-icon");
    glyph.className = "cell-axis";
    glyph.textContent = AXIS_ICON;
    element.replaceChildren(glyph);
    return;
  }

  delete element.dataset.axis;
  delete element.dataset.seat;
  if (kind.reach === "cross") {
    delete element.dataset.direction;
    // Presence, not a value: the hook the stylesheet positions the ring by.
    element.dataset.viewpoint = "";
    const value = document.createElement("span");
    value.className = "cell-value";
    value.textContent = label;
    const parts: HTMLElement[] = [value];
    for (const edge of ["up", "right", "down", "left"]) {
      const chevron = document.createElement("md-icon");
      chevron.className = "cell-chevron";
      chevron.dataset.edge = edge;
      chevron.textContent = VIEWPOINT_ICON;
      parts.push(chevron);
    }
    element.replaceChildren(...parts);
    return;
  }

  delete element.dataset.viewpoint;
  const aim =
    kind.aims === "compass" && direction !== undefined
      ? directionAt(direction)
      : null;
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
