import type { LogicGridSymbolValue } from "../../util/types";
import { dressClue } from "./cellView";
import { symbolRowMarkup } from "./toolRowMarkup";
import {
  axisIndex,
  DEFAULT_AXIS,
  DEFAULT_DIRECTION,
  directionIndex,
  parseSymbolValue,
  SYMBOL_KINDS,
  symbolKindAt,
  symbolValueMax,
  symbolValueMin,
  type LogicGridSize,
  type LogicGridSymbolKind,
} from "./symbols";

/**
 * The clue row once it exists: what each kind's value field and arrows are set
 * to, and how the row is restyled from that.
 *
 * Split out of `logicGridSolver.ts` because none of it needs the editor — every
 * function takes the row element plus the per-kind arrays and hands back
 * nothing — so the file that reads as "which clue is armed and what does the
 * board do about it" no longer has thirty lines of attribute writing in the
 * middle of it. The build-once rule is unchanged: `buildSymbolRow` still runs
 * only from `render()`, everything else writes in place, and the field's text
 * is still only assigned when it differs, because assigning it moves the caret
 * while the user is typing.
 *
 * What is deliberately NOT here: the arrays themselves. `symbolValues` and
 * `symbolDirections` are the armed TOOL's state — the same numbers are pushed
 * into `Board` on every selection — so the editor keeps them and passes them in.
 */

export interface SymbolToolState {
  readonly size: LogicGridSize;
  /** The armed kind's index, or null while a paint tool is armed. */
  readonly armed: number | null;
  /** Raw field text per kind, indexed like `SYMBOL_KINDS`. */
  readonly values: readonly string[];
  /** Aim index per kind, indexed the same. */
  readonly aims: readonly number[];
}

/** What each clue kind's value field starts out holding. A valueless kind has
 * no field, so its slot is never read. */
export function defaultValues(): string[] {
  return SYMBOL_KINDS.map(kind => {
    if (kind.valueKind === "number") return "1";
    return kind.valueKind === "letter" ? "A" : "";
  });
}

/** Which way each directed kind starts out aimed — its picker's FIRST entry
 * (up, or the horizontal axis), the one the row will light when the kind is
 * first armed with nothing picked yet. */
export function defaultDirections(): number[] {
  return SYMBOL_KINDS.map(kind =>
    kind.aims === "axis" ? DEFAULT_AXIS : DEFAULT_DIRECTION,
  );
}

/** What clue kind `index` would stamp, or null while its field is unusable. */
export function symbolValueOf(
  values: readonly string[],
  index: number,
  size: LogicGridSize,
): LogicGridSymbolValue | null {
  const kind = symbolKindAt(index);
  if (!kind) return null;
  return parseSymbolValue(kind, values[index] ?? "", size);
}

/** Which way clue kind `index` is aimed, or null when it points nowhere. */
export function symbolAimOf(
  aims: readonly number[],
  index: number,
): number | null {
  const kind = symbolKindAt(index);
  if (!kind || kind.aims === "none") return null;
  return (
    aims[index] ?? (kind.aims === "axis" ? DEFAULT_AXIS : DEFAULT_DIRECTION)
  );
}

/**
 * The clue row, rebuilt. Only `render()` may reach this: the value fields live
 * inside the row, so rebuilding it on a selection would destroy the one being
 * typed into.
 */
export function buildSymbolRow(row: HTMLElement, size: LogicGridSize) {
  row.innerHTML = symbolRowMarkup(size);

  // The sample is filled AFTERWARDS rather than written into the markup
  // above, because a directed kind's chip is a miniature of the tile and
  // `dressClue` is what draws one. A chip that spelled its own arrow out
  // would be a second drawing of the same thing, free to drift from it.
  //
  // Always shown in its DEFAULT aim — up, or the horizontal axis —
  // whatever is currently armed: the chip says which KIND of clue this is,
  // and the toggles beside it are what say where the next one will point.
  SYMBOL_KINDS.forEach(kind => {
    const sample = row.querySelector<HTMLElement>(
      `.symbol-tool[data-symbol="${kind.id}"] .symbol-sample`,
    );
    if (!sample) return;
    dressClue(sample, kind, kind.sample, defaultAimOf(kind));
  });
}

/**
 * Restyles the clue row without rebuilding it, and shows each field's own
 * validity: an unusable value stamps nothing, so it has to say so.
 *
 * The field is refreshed only where one exists — a valueless kind renders
 * none — while the selected state and the aim toggles refresh regardless.
 * An early return on the missing field would silently skip both.
 */
export function refreshSymbolRow(row: HTMLElement, state: SymbolToolState) {
  SYMBOL_KINDS.forEach((kind, index) => {
    const tool = row.querySelector<HTMLElement>(
      `.symbol-tool[data-symbol="${kind.id}"]`,
    );
    if (!tool) return;

    const selected = state.armed === index;
    tool.classList.toggle("selected", selected);

    const field = tool.querySelector<HTMLInputElement>(".symbol-value");
    if (field) refreshSymbolField(kind, index, field, state);

    // An aim shows only while ITS kind is the armed tool — a lit arrow
    // beside an idle chip reads as "this tool is active" when it is not.
    // The choice itself survives in the aims array, so re-arming the kind
    // lights whatever was picked last (or the first entry, untouched).
    refreshAimToggles(tool, selected ? symbolAimOf(state.aims, index) : null);
  });
}

/** The aim a kind's chip miniature is drawn with — always its DEFAULT: the
 * chip says which kind this is, and the toggles say where the next one will
 * point. Undefined for a kind that aims nowhere. */
function defaultAimOf(kind: LogicGridSymbolKind): number | undefined {
  if (kind.aims === "compass") return DEFAULT_DIRECTION;
  return kind.aims === "axis" ? DEFAULT_AXIS : undefined;
}

/** One kind's value field, refreshed in place: bounds, text and validity. */
function refreshSymbolField(
  kind: LogicGridSymbolKind,
  index: number,
  field: HTMLInputElement,
  state: SymbolToolState,
) {
  // The numeric bounds move when the off-by-one chip is toggled, and the
  // row is not rebuilt for that — so the attributes written at build time
  // are refreshed here, idempotently, beside the validity.
  if (kind.valueKind === "number") {
    const min = String(symbolValueMin(kind, state.size));
    const max = String(symbolValueMax(kind, state.size));
    if (field.min !== min) field.min = min;
    if (field.max !== max) field.max = max;
    const chars = String(max.length);
    if (field.style.getPropertyValue("--value-chars") !== chars)
      field.style.setProperty("--value-chars", chars);
  }

  const raw = state.values[index] ?? "";
  // Never write what is already there: assigning `value` moves the caret
  // to the end, and this runs while the user is typing into the field.
  if (field.value !== raw) field.value = raw;

  if (symbolValueOf(state.values, index, state.size) === null) {
    field.setAttribute("aria-invalid", "true");
  } else {
    field.removeAttribute("aria-invalid");
  }
}

/** One control's aim toggles: exactly the `aimed` entry lit, or none at
 * all for `null` — the idle state every unarmed kind shows. */
function refreshAimToggles(tool: HTMLElement, aimed: number | null) {
  tool.querySelectorAll<HTMLElement>(".direction-toggle").forEach(arrow => {
    const target =
      arrow.dataset.axis === undefined
        ? directionIndex(arrow.dataset.direction)
        : axisIndex(arrow.dataset.axis);
    const on = target === aimed;
    arrow.classList.toggle("selected", on);
    arrow.setAttribute("aria-pressed", String(on));
  });
}
