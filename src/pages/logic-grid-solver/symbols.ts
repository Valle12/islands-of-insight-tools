import type { LogicGridSymbolValue } from "../../util/types";

/** What kind of value a clue carries, and therefore how it is entered. */
export type LogicGridValueKind = "number" | "letter";

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
   * Whether the clue also carries one of the four directions — which gives it a
   * direction picker beside its value field, an arrow on the tile, and a
   * `direction` key in the config.
   */
  readonly directed: boolean;
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
    directed: false,
  },
  {
    id: "letter",
    label: "Letter",
    sample: "A",
    valueKind: "letter",
    minValue: 0,
    directed: false,
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
    directed: true,
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

/** The board a value is measured against. */
export interface LogicGridSize {
  gridWidth: number;
  gridHeight: number;
}

/**
 * The largest value `kind` can usefully carry on a board of this size.
 *
 * An area number names cells in a region, so the board's area bounds it. A dart
 * counts along ONE straight line, so the longest ray bounds it instead — every
 * square of the longer side except the one the dart sits on.
 *
 * The bound follows from the dart being a line clue rather than from its arrow,
 * and `directed` is only standing in for that because the two coincide today. A
 * directed clue that measured something else would need to say so itself.
 */
export function symbolValueMax(
  kind: LogicGridSymbolKind,
  size: LogicGridSize,
): number {
  return kind.directed
    ? Math.max(size.gridWidth, size.gridHeight) - 1
    : size.gridWidth * size.gridHeight;
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
  if (!kind.directed) {
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
  const trimmed = raw.trim();
  if (trimmed === "") return null;

  const value =
    kind.valueKind === "number" ? Number(trimmed) : trimmed.toUpperCase();
  return symbolValueError(kind, value, size) === null ? value : null;
}
