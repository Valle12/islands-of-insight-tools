import type { LogicGridSymbolValue } from "../../util/types";

/** What kind of value a clue carries, and therefore how it is entered.
 * `"none"` is the lotus: no value at all, and no field to type one into. */
export type LogicGridValueKind = "number" | "letter" | "none";

/**
 * What a kind's `direction` key means, and therefore which picker it gets.
 * `"none"` carries no key at all; `"compass"` is the dart's four ways to
 * point; `"axis"` is the lotus's four ways a symmetry line can lie —
 * 45-degree clockwise turns from horizontal, reusing the same key.
 */
export type LogicGridAims = "none" | "compass" | "axis";

/**
 * The geometry a kind's number measures, and therefore what bounds it: the
 * whole `"board"` for an area number, one straight `"line"` for the dart, the
 * `"cross"` of a row and a column for the viewpoint. Ignored by a letter or
 * valueless kind, the way `minValue` is.
 */
export type LogicGridReach = "board" | "line" | "cross";

export interface LogicGridSymbolKind {
  /** Stable, lowercase, and never reused — it is what the tests read. */
  readonly id: string;
  /** The chip's accessible name, and the word used in a cell's aria label. */
  readonly label: string;
  /** The glyph the chip shows: these clues are text, not artwork. */
  readonly sample: string;
  readonly valueKind: LogicGridValueKind;
  /** The smallest value the kind accepts. Ignored by a letter kind. */
  readonly minValue: number;
  /**
   * Whether — and how — the clue carries one of the four directions, which
   * gives it a picker beside its chip, a glyph on the tile, and a `direction`
   * key in the config.
   */
  readonly aims: LogicGridAims;
  /**
   * What the number measures. Required rather than defaulted so a new kind has
   * to say — the dart's line bound once rode on `aims: "compass"` because the
   * two happened to coincide, and a viewpoint (direction-less, yet bounded by
   * its rays) is exactly the kind that coincidence would have mis-measured.
   * The `"cross"` reach also draws: it is what puts the four sight chevrons on
   * the tile.
   */
  readonly reach: LogicGridReach;
}

/** An area of zero cells is not a region, so the smallest area clue is 1. */
export const MIN_AREA_VALUE = 1;

const LETTER_PATTERN = /^[A-Z]$/;

/**
 * The clue kinds a puzzle can place, in a FIXED order. A config stores the
 * INDEX of a clue's kind, so entries may only ever be APPENDED — inserting or
 * reordering one silently re-reads every clue ever saved. Appending is safe and
 * needs no migration: a saved puzzle simply never mentions the indices it does
 * not use.
 *
 * A clue has no colour of its own. It takes the colour of the cell it sits on,
 * so a clue on an `UNKNOWN` cell is exactly the game's colourless clue. The
 * dart leans on that hardest: what it counts is the OTHER colour, so until its
 * own cell is decided the clue does not yet say which colour it is counting.
 */
export const SYMBOL_KINDS: readonly LogicGridSymbolKind[] = [
  {
    id: "area",
    label: "Area number",
    sample: "7",
    valueKind: "number",
    minValue: MIN_AREA_VALUE,
    aims: "none",
    reach: "board",
  },
  {
    id: "letter",
    label: "Letter",
    sample: "A",
    valueKind: "letter",
    minValue: 0,
    aims: "none",
    // Inert for a letter, like `minValue`: a letter is not a number and no
    // bound is ever asked of it.
    reach: "board",
  },
  {
    id: "dart",
    label: "Dart",
    // Unused for a directed kind: its chip draws a miniature of the tile
    // instead, so the chip and what it stamps cannot look like two things.
    sample: "3",
    valueKind: "number",
    // Zero is a real dart: it says every square that way holds the dart's own
    // colour, which is one of the two cases that fill in immediately.
    minValue: 0,
    aims: "compass",
    reach: "line",
  },
  {
    id: "lotus",
    label: "Symmetry",
    // Unused twice over: an axis-aimed chip is a miniature drawn by
    // `dressClue`, and a valueless kind has no field to seed either.
    sample: "H",
    // The first kind with NO value: the axis and the seat are the whole clue,
    // so its control is a chip and four axis toggles with no field between.
    valueKind: "none",
    minValue: 0,
    aims: "axis",
    // Inert too: a valueless kind has no number for any reach to bound.
    reach: "board",
  },
  {
    id: "viewpoint",
    label: "Viewpoint",
    // Unused: a cross-reach chip is a miniature drawn by `dressClue`, the
    // number ringed by its four chevrons.
    sample: "3",
    valueKind: "number",
    // Its own square always counts, so there is no viewpoint of zero — unlike
    // the dart, whose count starts beyond its own cell.
    minValue: 1,
    // No direction at all: the four rays ARE the clue, which is exactly what
    // `reach: "cross"` says. The first number-carrying kind with no picker
    // since the area number, so its control is chip + field and nothing else.
    aims: "none",
    reach: "cross",
  },
];

/** How many clue kinds a puzzle can draw from — every known one. */
export const SYMBOL_KIND_COUNT = SYMBOL_KINDS.length;

export function symbolKindAt(index: number): LogicGridSymbolKind | undefined {
  return SYMBOL_KINDS[index];
}

export interface LogicGridDirection {
  /** Stable, lowercase, and never reused — it is what the tests read. */
  readonly id: string;
  /** Said in a cell's aria label and on the picker's buttons. */
  readonly label: string;
  readonly dx: number;
  readonly dy: number;
}

/**
 * The one arrow every direction is drawn with, TURNED into place by the
 * stylesheet.
 *
 * Material Symbols only ships this one pointing right, so the alternative was
 * the four `arrow_upward`-style glyphs — which are a different, stubbier arrow
 * and read badly at the size a tile can spare. One glyph plus four rotations
 * also keeps the icon subset in `common.css` one name shorter.
 */
export const DIRECTION_ICON = "arrow_right_alt";

/**
 * The one chevron a viewpoint's four sight marks are drawn with, turned into
 * place by the stylesheet exactly as the dart's arrow is — and already in the
 * `icon_names` subset in common.css, where the home page's cards use it, so
 * the viewpoint costs the subset nothing. The `keyboard_arrow_*` family is
 * the same chevron four times over, which is what it would have cost.
 */
export const VIEWPOINT_ICON = "chevron_right";

/**
 * The four directions a clue can point, in a FIXED order — a config stores the
 * INDEX, so this list is the file format just as `SYMBOL_KINDS` is. There is no
 * fifth direction to append, but the ORDER still may not change.
 *
 * It is the repo's canonical one: clockwise from up, which is what
 * `DIRECTION_MAP` decodes in the rolling-blocks and shifting-mosaic bridges and
 * what `nearestVertex(dx, dy, 4)` returns — so a dragged arrow lands on the
 * right entry with no translation table.
 */
export const DIRECTIONS: readonly LogicGridDirection[] = [
  { id: "up", label: "Up", dx: 0, dy: -1 },
  { id: "right", label: "Right", dx: 1, dy: 0 },
  { id: "down", label: "Down", dx: 0, dy: 1 },
  { id: "left", label: "Left", dx: -1, dy: 0 },
];

export const DIRECTION_COUNT = DIRECTIONS.length;

/** Right, because these boards read left to right like everything else. */
export const DEFAULT_DIRECTION = 1;

export function directionAt(index: number): LogicGridDirection | undefined {
  return DIRECTIONS[index];
}

/** The position of a direction by its stable id, or -1. */
export function directionIndex(id: string | undefined): number {
  return DIRECTIONS.findIndex(direction => direction.id === id);
}

export interface LogicGridAxis {
  /** Stable, lowercase, and never reused — it is what the tests read. */
  readonly id: string;
  /** Said in a cell's aria label and on the picker's buttons. */
  readonly label: string;
}

/**
 * The one glyph every axis is drawn with, TURNED into place by the stylesheet
 * exactly as the dart's arrow is. Its native stroke is a VERTICAL bar with an
 * arrow either side pointing at it — mirroring onto a line — so the stylesheet
 * rotates from vertical: 90 degrees for the horizontal axis, 45-degree steps
 * for the diagonals. A name outside the `icon_names` subset in common.css
 * renders as its own text, so this one is listed there.
 */
export const AXIS_ICON = "horizontal_align_center";

/**
 * The four ways a lotus's symmetry line can lie, in a FIXED order — a config
 * stores the INDEX in the `direction` key, so this list is the file format
 * just as `DIRECTIONS` is. Successive 45-degree CLOCKWISE turns from
 * horizontal, so the falling diagonal (`\`) comes before vertical.
 */
export const AXES: readonly LogicGridAxis[] = [
  { id: "horizontal", label: "Horizontal" },
  { id: "diagonal-down", label: "Falling diagonal" },
  { id: "vertical", label: "Vertical" },
  { id: "diagonal-up", label: "Rising diagonal" },
];

export const AXIS_COUNT = AXES.length;

/** Horizontal — the axis the row's first toggle offers. */
export const DEFAULT_AXIS = 0;

export function axisAt(index: number): LogicGridAxis | undefined {
  return AXES[index];
}

/** The position of an axis by its stable id, or -1. */
export function axisIndex(id: string | undefined): number {
  return AXES.findIndex(axis => axis.id === id);
}

/** Whether an axis index names one of the two diagonal strokes — the pair a
 * grid-line seat cannot carry, since their reflection would land on square
 * corners. Resolved through the catalogue like everything else here. */
export function isDiagonalAxis(index: number | undefined): boolean {
  return (
    index === axisIndex("diagonal-down") || index === axisIndex("diagonal-up")
  );
}

/**
 * A lotus's SEAT: where inside its merged cell the axis point sits, as two
 * half-square offsets from its home square's centre — bit 0 half a square
 * right, bit 1 half a square down. 0 is the centre itself (and is OMITTED
 * from the config, like a missing `direction`); 1 and 2 are the midpoints of
 * the edges to the right and below; 3 is a corner where squares meet.
 */
export const SEAT_COUNT = 4;

/** The board a value is measured against. */
export interface LogicGridSize {
  gridWidth: number;
  gridHeight: number;
}

/**
 * The largest value `kind` can usefully carry on a board of this size, read
 * off the geometry its `reach` names.
 *
 * An area number names cells in a region, so the board's area bounds it. A
 * dart counts along ONE straight line, so the longest ray bounds it instead —
 * every square of the longer side except the one the dart sits on. A
 * viewpoint sees its whole row and its whole column at most, its own square
 * counted once. A valueless kind has no number to bound, and 0 says so
 * without a special case at every caller.
 */
export function symbolValueMax(
  kind: LogicGridSymbolKind,
  size: LogicGridSize,
): number {
  if (kind.valueKind === "none") return 0;
  if (kind.reach === "line")
    return Math.max(size.gridWidth, size.gridHeight) - 1;
  if (kind.reach === "cross") return size.gridWidth + size.gridHeight - 1;
  return size.gridWidth * size.gridHeight;
}

/**
 * Whether `value` is a usable value for `kind` on a board of this size — an
 * area can never name more cells than the board has, and a dart can never name
 * more squares than its line holds.
 *
 * Shared by the validator and the editor's value field so a file that loads is
 * exactly a file the editor could have produced.
 */
export function symbolValueError(
  kind: LogicGridSymbolKind,
  value: unknown,
  size: LogicGridSize,
): string | null {
  if (kind.valueKind === "none") {
    // Not merely ignored, for the same reason a stray direction is not: a
    // value stored on a clue that never reads one would look like part of the
    // puzzle and change nothing about it.
    return value === undefined
      ? null
      : `${kind.label} symbols carry no value.`;
  }
  if (kind.valueKind === "number") {
    const max = symbolValueMax(kind, size);
    const ok =
      Number.isInteger(value) &&
      (value as number) >= kind.minValue &&
      (value as number) <= max;
    return ok
      ? null
      : `${kind.label} values must be integers between ${kind.minValue} and ${max}.`;
  }

  return typeof value === "string" && LETTER_PATTERN.test(value)
    ? null
    : `${kind.label} values must be a single letter from A to Z.`;
}

/**
 * Whether `direction` is one this clue could carry. A kind that points nowhere
 * must not carry the key at all: a stored direction it never reads would look
 * like part of the puzzle and change nothing, which is the worst of both.
 */
export function symbolDirectionError(
  kind: LogicGridSymbolKind,
  direction: unknown,
): string | null {
  if (kind.aims === "none") {
    return direction === undefined
      ? null
      : `Only a directed symbol carries a direction, and ${kind.label} is not one.`;
  }
  const ok =
    Number.isInteger(direction) &&
    (direction as number) >= 0 &&
    (direction as number) < DIRECTION_COUNT;
  return ok
    ? null
    : `${kind.label} directions must be integers between 0 and ${DIRECTION_COUNT - 1}.`;
}

/**
 * Whether `seat` is one this clue could carry — the kind-level half. Whether
 * the seat's squares really surround a point of the clue's own merged cell is
 * the validator's question, asked once the shapes are known.
 */
export function symbolSeatError(
  kind: LogicGridSymbolKind,
  seat: unknown,
): string | null {
  if (kind.aims !== "axis") {
    return seat === undefined
      ? null
      : `Only a symmetry symbol carries a seat, and ${kind.label} is not one.`;
  }
  if (seat === undefined) return null;
  const ok =
    Number.isInteger(seat) &&
    (seat as number) >= 0 &&
    (seat as number) < SEAT_COUNT;
  return ok
    ? null
    : `${kind.label} seats must be integers between 0 and ${SEAT_COUNT - 1}.`;
}

/**
 * What the value field should hold for what was typed into it. A letter is
 * stored, shown and stamped upper case, so a lower-case keystroke is corrected
 * in the field rather than only on the way to the board — otherwise the field
 * reads `c` while the cell it stamps reads `C`.
 *
 * Numbers pass through untouched, which is what keeps the caret where it is
 * while a multi-digit area is being typed (see `refreshSymbolRow`).
 */
export function normalizeSymbolInput(
  kind: LogicGridSymbolKind,
  raw: string,
): string {
  return kind.valueKind === "letter" ? raw.toUpperCase() : raw;
}

/**
 * Reads what the user typed into the value field. Returns null when it is not
 * a value of that kind, which is what stops a half-typed field from stamping.
 *
 * It upper-cases a letter itself rather than trusting `normalizeSymbolInput` to
 * have run: this is also the boundary a config file crosses.
 */
export function parseSymbolValue(
  kind: LogicGridSymbolKind,
  raw: string,
  size: LogicGridSize,
): LogicGridSymbolValue | null {
  // A valueless kind has no field, so nothing typed can ever be its value.
  if (kind.valueKind === "none") return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;

  const value =
    kind.valueKind === "number" ? Number(trimmed) : trimmed.toUpperCase();
  return symbolValueError(kind, value, size) === null ? value : null;
}
