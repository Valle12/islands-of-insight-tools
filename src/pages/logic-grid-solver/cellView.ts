import type { LogicGridClue } from "../../util/types";
import { colorLabel, colorId } from "./cell";
import type { GalaxyTiling } from "./galaxyTiles";
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
 * What a cell is called. Colors, clue kinds, directions and axes are all
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

/** Which quarter of a seated glyph a copy draws, and what lies under it. */
interface GlyphPiece {
  readonly part: string;
  readonly under: number;
}

/**
 * The squares a seated glyph lies across, one per copy the cell will draw.
 *
 * A seat puts the glyph's CENTER on a grid line or a corner, so half or a
 * quarter of it hangs over each neighboring square, and the color DRAWN
 * under each of them is the whole of what its ink has to contrast with. Two
 * cases return nothing and get one plain glyph instead: seat 0, where the
 * glyph is inside its own square and the cell's ink is already right, and a
 * seat whose tile is not being drawn — an unpainted pair, a gap, a merged
 * cell — where there is no boundary to line the split up with, so splitting
 * would only cut the glyph in half for nothing.
 *
 * The ink follows what is drawn UNDER each half — the square's own color, or
 * the neutral fill where a square of the pill is not painted. Inheriting the
 * clue's own cell instead is what left a half-glyph black on black in dark
 * mode, over a square that had just been cleared.
 *
 * Bit 0 of the seat is half a square right, bit 1 half a square down, which is
 * what `--seat-x` / `--seat-y` translate by — so the parts named here and the
 * clip paths keyed on them in the stylesheet are two halves of one fact.
 */
function glyphPieces(
  seat: number,
  x: number,
  y: number,
  tiling: GalaxyTiling | undefined,
): GlyphPiece[] {
  if (seat <= 0 || !tiling?.drawnAt(x, y)) return [];
  const under = (dx: number, dy: number) => ({
    under: tiling.colorAt(x + dx, y + dy),
  });
  const right = (seat & 1) !== 0;
  const down = (seat & 2) !== 0;
  if (right && down)
    return [
      { part: "top-left", ...under(0, 0) },
      { part: "top-right", ...under(1, 0) },
      { part: "bottom-left", ...under(0, 1) },
      { part: "bottom-right", ...under(1, 1) },
    ];
  if (right)
    return [
      { part: "left", ...under(0, 0) },
      { part: "right", ...under(1, 0) },
    ];
  return [
    { part: "top", ...under(0, 0) },
    { part: "bottom", ...under(0, 1) },
  ];
}

/**
 * Writes one cell's two layers onto an element: the color as `data-color`, and
 * the clue as text plus `data-symbol` / `data-symbol-value`.
 *
 * The clue is drawn as the element's own text rather than as a background,
 * because its ink has to follow the cell's color — that is what makes a clue
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
  tiling?: GalaxyTiling,
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
      dressClue(
        element,
        kind,
        "",
        clue.direction,
        clue.seat,
        glyphPieces(clue.seat ?? 0, x, y, tiling),
      );
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
/**
 * The galaxy's glyph — one copy, or one per square its center sits between.
 *
 * A SEATED galaxy straddles two squares or four, and those squares may be
 * different colors: on a dark one beside a light one, a glyph of a single
 * color is invisible over one half of itself. So each piece is drawn as its
 * own copy, clipped by the stylesheet to the part of the glyph over one square
 * and inked against THAT square rather than against the cell the clue belongs
 * to. Where the squares agree the copies come out identical, which is the
 * unseated case arriving at the same answer by a longer road.
 *
 * `data-under` names the square's color rather than the ink, so the palette
 * stays in the stylesheet beside `--logic-ink-on-dark` and this file keeps no
 * second copy of it.
 */
function galaxyGlyphs(
  icon: string,
  pieces: readonly GlyphPiece[],
): HTMLElement[] {
  const glyph = (part?: GlyphPiece) => {
    const element = document.createElement("md-icon");
    element.className = "cell-galaxy";
    element.textContent = icon;
    if (part) {
      element.dataset.part = part.part;
      element.dataset.under = colorId(part.under);
    }
    return element;
  };
  return pieces.length === 0 ? [glyph()] : pieces.map(part => glyph(part));
}

export function dressClue(
  element: HTMLElement,
  kind: LogicGridSymbolKind,
  label: string,
  direction: number | undefined,
  seat = 0,
  pieces: readonly GlyphPiece[] = [],
): void {
  if (kind.icon) {
    // An ICON kind's clue — the galaxy — is one glyph and no value, no
    // direction and no rotation. It DOES take a seat: its center may sit on a
    // grid line or a corner, and `data-seat` slides the glyph onto it exactly
    // as it slides the lotus's. Every other hook is shed; `data-icon` is
    // presence-only, the stylesheet's centring hook, exactly as
    // `data-viewpoint` is the ring's.
    delete element.dataset.direction;
    delete element.dataset.axis;
    delete element.dataset.viewpoint;
    if (seat > 0) element.dataset.seat = String(seat);
    else delete element.dataset.seat;
    element.dataset.icon = "";
    element.replaceChildren(...galaxyGlyphs(kind.icon, pieces));
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
