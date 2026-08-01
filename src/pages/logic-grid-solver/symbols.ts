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
}

/**
 * The clue kinds a puzzle can place, in a FIXED order. A config stores the
 * INDEX of a clue's kind, so entries may only ever be APPENDED — inserting or
 * reordering one silently re-reads every clue ever saved. Appending is safe and
 * needs no migration: a saved puzzle simply never mentions the indices it does
 * not use.
 *
 * A clue has no colour of its own. It takes the colour of the cell it sits on,
 * so a clue on an `UNKNOWN` cell is exactly the game's colourless clue.
 */
export const SYMBOL_KINDS: readonly LogicGridSymbolKind[] = [
  { id: "area", label: "Area number", sample: "7", valueKind: "number" },
  { id: "letter", label: "Letter", sample: "A", valueKind: "letter" },
];

/** How many clue kinds a puzzle can draw from — every known one. */
export const SYMBOL_KIND_COUNT = SYMBOL_KINDS.length;

export function symbolKindAt(index: number): LogicGridSymbolKind | undefined {
  return SYMBOL_KINDS[index];
}

/** An area of zero cells is not a region, so the smallest area clue is 1. */
export const MIN_AREA_VALUE = 1;

const LETTER_PATTERN = /^[A-Z]$/;

/**
 * Whether `value` is a usable value for `kind`, given a board of `maxArea`
 * cells — an area can never name more cells than the board has.
 *
 * Shared by the validator and the editor's value field so a file that loads is
 * exactly a file the editor could have produced.
 */
export function symbolValueError(
  kind: LogicGridSymbolKind,
  value: unknown,
  maxArea: number,
): string | null {
  if (kind.valueKind === "number") {
    const ok =
      Number.isInteger(value) &&
      (value as number) >= MIN_AREA_VALUE &&
      (value as number) <= maxArea;
    return ok
      ? null
      : `${kind.label} values must be integers between ${MIN_AREA_VALUE} and ${maxArea}.`;
  }

  return typeof value === "string" && LETTER_PATTERN.test(value)
    ? null
    : `${kind.label} values must be a single letter from A to Z.`;
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
  maxArea: number,
): LogicGridSymbolValue | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;

  const value =
    kind.valueKind === "number" ? Number(trimmed) : trimmed.toUpperCase();
  return symbolValueError(kind, value, maxArea) === null ? value : null;
}
