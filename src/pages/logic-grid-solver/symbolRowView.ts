import type { LogicGridSymbolValue } from "../../util/types";
import { dressClue } from "./cellView";
import { symbolRowMarkup } from "./toolRowMarkup";
import {
  axisIndex,
  DEFAULT_AXIS,
  DEFAULT_DIRECTION,
  DEFAULT_RAYS,
  directionIndex,
  parseSymbolValue,
  SAMPLE_RAYS,
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
 * (up, the horizontal axis, or the single up ARROW for a kind naming a set),
 * the one the row will light when the kind is first armed with nothing picked
 * yet. */
export function defaultDirections(): number[] {
  // An unaimed kind keeps a slot it never reads, so its 0 stands for nothing.
  return SYMBOL_KINDS.map(kind => defaultAimOf(kind) ?? DEFAULT_DIRECTION);
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

/** Which way clue kind `index` is aimed — an index for a compass or an axis,
 * an arrow MASK for a kind naming a set — or null when it points nowhere. */
export function symbolAimOf(
  aims: readonly number[],
  index: number,
): number | null {
  const kind = symbolKindAt(index);
  if (!kind || kind.aims === "none") return null;
  return aims[index] ?? defaultAimOf(kind) ?? null;
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
  // Always shown in one FIXED aim whatever is currently armed: the chip says
  // which KIND of clue this is, and the toggles beside it are what say where
  // the next one will point.
  SYMBOL_KINDS.forEach(kind => {
    const sample = row.querySelector<HTMLElement>(
      `.symbol-tool[data-symbol="${kind.id}"] .symbol-sample`,
    );
    if (!sample) return;
    dressClue(sample, kind, kind.sample, sampleAimOf(kind));
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
    // A compass or axis choice survives in the aims array to be relit on
    // re-arming; a set-naming kind's mask does NOT — the editor resets it
    // when the kind is re-armed, because relighting a set that went dark
    // restores state the player could no longer see.
    refreshAimToggles(
      tool,
      kind,
      selected ? symbolAimOf(state.aims, index) : null,
    );
  });
}

/**
 * The aim a kind's chip miniature is drawn with. Its default for every kind
 * but one: a kind naming a SET is drawn holding two arrows, because one of
 * them is a picture of a dart rather than of this. See `SAMPLE_RAYS`.
 */
function sampleAimOf(kind: LogicGridSymbolKind): number | undefined {
  return kind.aims === "rays" ? SAMPLE_RAYS : defaultAimOf(kind);
}

/** The aim a kind is ARMED with before anything is picked — its picker's first
 * entry, and what the row lights when the kind is first selected. Undefined
 * for a kind that aims nowhere. */
function defaultAimOf(kind: LogicGridSymbolKind): number | undefined {
  if (kind.aims === "compass") return DEFAULT_DIRECTION;
  if (kind.aims === "rays") return DEFAULT_RAYS;
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

/**
 * One control's aim toggles: the entries `aimed` names lit, or none at all for
 * `null` — the idle state every unarmed kind shows.
 *
 * How many that is depends on the KIND, not on the number: a compass or an
 * axis names one entry and a rays mask names between one and four, so the two
 * readings are told apart by the capability field rather than by whether the
 * number happens to look like a mask.
 */
function refreshAimToggles(
  tool: HTMLElement,
  kind: LogicGridSymbolKind,
  aimed: number | null,
) {
  tool.querySelectorAll<HTMLElement>(".direction-toggle").forEach(arrow => {
    const target = aimTargetOf(arrow);
    const on = aimed !== null && target >= 0 && lit(kind, aimed, target);
    arrow.classList.toggle("selected", on);
    arrow.setAttribute("aria-pressed", String(on));
  });
}

/**
 * Which entry of its own picker a toggle stands for, or -1. Each flavor
 * carries its own attribute, so nothing has to guess which list to read.
 *
 * Exported because the editor's click handler resolves a pressed toggle the
 * same way this lights one, and the two readings must not drift: a `data-ray`
 * read as a `data-direction` is -1, which looks exactly like "not a toggle".
 */
export function aimTargetOf(arrow: HTMLElement): number {
  if (arrow.dataset.ray !== undefined) return directionIndex(arrow.dataset.ray);
  if (arrow.dataset.axis !== undefined) return axisIndex(arrow.dataset.axis);
  return directionIndex(arrow.dataset.direction);
}

/** Whether the toggle standing for `target` is on, given what the kind's aim
 * number means. */
function lit(kind: LogicGridSymbolKind, aimed: number, target: number) {
  return kind.aims === "rays"
    ? (aimed & (1 << target)) !== 0
    : aimed === target;
}
