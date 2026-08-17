import type { LogicGridTest } from "../../util/types";
import type { SizedControlKey, SizedControlSpec } from "./rules";
import { SIZED_CONTROLS, sizedControlOf } from "./toolRowMarkup";

/**
 * The rule row's sized controls: the value slots of the four area/run families,
 * the raw text each holds, and the lists they contribute to a download.
 *
 * A class rather than the pure functions `toolRowMarkup.ts` is, because these
 * are the one part of either tool row that CREATES AND DESTROYS elements while
 * the page runs — a `+` appends a field and focuses it, an emptied field
 * disappears when it is left — and a slot's text only means anything beside the
 * element holding it, so the record and the DOM belong to the same owner.
 *
 * This REVISES the seam `toolRowMarkup.ts` used to state. `createSizedField` /
 * `addSizedSlot` were left with the editor because "the editor owns what a slot
 * currently holds"; that is still true, and the owner just stopped being the
 * editor. Still NOT here: the control's own markup — the label, the divider and
 * the `+` are part of the row `ruleRowMarkup` writes, built once.
 *
 * Never cache a field. `#rule-row`'s innerHTML is rewritten by every board
 * replacement, so every method re-queries from the row it was handed.
 */

export interface SizedRuleControlsOptions {
  /** `#rule-row`. Stable across rebuilds — only its innerHTML is replaced. */
  row: HTMLElement;
  /**
   * A typed digit is an edit: the editor drops the answer and refreshes the
   * row. NOT fired by `+` or by an emptied slot leaving — neither changes what
   * a download would say.
   */
  onValuesChanged: () => void;
}

export class SizedRuleControls {
  private readonly row: HTMLElement;
  private readonly onValuesChanged: () => void;
  /**
   * What the value fields hold, raw and per slot — kept like the clue row's
   * `symbolValues` so a refresh never eats a half-typed number. A family is
   * active exactly while it holds at least one usable value.
   */
  private values = emptySlots();

  constructor(options: SizedRuleControlsOptions) {
    this.row = options.row;
    this.onValuesChanged = options.onValuesChanged;
    this.addListeners();
  }

  /**
   * Appends the slots the values already hold. Called from `buildRuleRow` only,
   * i.e. once per board replacement — the row is never rebuilt on interaction.
   */
  fill() {
    for (const spec of SIZED_CONTROLS) {
      const add = this.addButton(spec.key);
      if (!add) continue;
      this.values[spec.key].forEach((raw, slot) => {
        const field = createSizedField(spec, slot);
        field.value = raw;
        fitSizedField(field);
        add.before(field);
      });
    }
    this.syncAddButtons();
  }

  /** A sized control is lit while it holds at least one usable value — active
   * exactly when it will reach the download — and each slot says on itself
   * whether its text is usable. Empty is merely pending, not marked. */
  refresh() {
    for (const spec of SIZED_CONTROLS) {
      const control = this.row.querySelector<HTMLElement>(
        `.rule-sized[data-sized-control="${spec.key}"]`,
      );
      if (!control) continue;
      control.classList.toggle("selected", this.valuesOf(spec.key).length > 0);
      const seen = new Set<number>();
      this.values[spec.key].forEach((raw, slot) => {
        const field = this.fieldAt(spec.key, slot);
        if (!field) return;
        // Never write what is already there: assigning `value` moves the
        // caret to the end, and this runs while the user is typing.
        if (field.value !== raw) field.value = raw;
        fitSizedField(field);
        const value = parsedSizedValue(spec, raw);
        const duplicate = value !== null && seen.has(value);
        if (value !== null) seen.add(value);
        if (raw.trim() !== "" && (value === null || duplicate)) {
          field.setAttribute("aria-invalid", "true");
        } else {
          field.removeAttribute("aria-invalid");
        }
      });
    }
    this.syncAddButtons();
  }

  /** Drops every value: a resize or a reset is a different puzzle. */
  reset() {
    this.values = emptySlots();
  }

  /** The slot texts a loaded config fills the controls with. */
  load(config: LogicGridTest) {
    const slots = emptySlots();
    for (const rule of config.areas ?? []) {
      const key = rule.color === "dark" ? "area-dark" : "area-light";
      slots[key].push(String(rule.size));
    }
    for (const rule of config.runs ?? []) {
      const key = rule.color === "dark" ? "run-dark" : "run-light";
      slots[key].push(String(rule.length));
    }
    this.values = slots;
  }

  /** The sized lists as the download stores them: dark before light, values
   * ascending — `validateConfig`'s canonical order — and omitted when empty,
   * the `shapes` discipline. */
  configLists(): Partial<LogicGridTest> {
    const areas = [
      ...this.valuesOf("area-dark").map(size => ({
        color: "dark" as const,
        size,
      })),
      ...this.valuesOf("area-light").map(size => ({
        color: "light" as const,
        size,
      })),
    ];
    const runs = [
      ...this.valuesOf("run-dark").map(length => ({
        color: "dark" as const,
        length,
      })),
      ...this.valuesOf("run-light").map(length => ({
        color: "light" as const,
        length,
      })),
    ];
    const lists: Partial<LogicGridTest> = {};
    if (areas.length > 0) lists.areas = areas;
    if (runs.length > 0) lists.runs = runs;
    return lists;
  }

  private addListeners() {
    // The add button rides the row's delegated click, like the rule chips do.
    // The two handlers are disjoint: `.rule-size-add` is deliberately not a
    // `.tool-button`, so the editor's own chip lookup never matches it.
    this.row.addEventListener("click", event => {
      const add = addButtonFrom(event.target);
      if (add) this.addSlot(add.dataset.sizedControl as SizedControlKey);
    });

    // The value fields live INSIDE the row, so this cannot rebuild it —
    // see `refresh`.
    this.row.addEventListener("input", event => {
      const field = event.target;
      if (!(field instanceof HTMLInputElement)) return;
      const key = field.dataset.sizedControl as SizedControlKey | undefined;
      const slot = Number(field.dataset.slot);
      if (key && Number.isInteger(slot)) this.handleInput(key, slot, field.value);
    });

    // An EMPTIED field disappears when it is left, never mid-typing: clearing
    // a value while focused keeps the field for the next digits.
    this.row.addEventListener("focusout", event => {
      const field = event.target;
      if (!(field instanceof HTMLInputElement)) return;
      const key = field.dataset.sizedControl as SizedControlKey | undefined;
      if (key && field.value.trim() === "") this.dropSlot(field, key);
    });
  }

  /** The + button: one more empty field, focused, in place — a rebuild would
   * drop the very focus this exists to hand over. The empty slot changes no
   * config until something is typed, so nothing else moves yet. */
  private addSlot(key: SizedControlKey) {
    const add = this.addButton(key);
    if (!add) return;
    // The button is hidden at the cap rather than removed, so a stray click
    // through the keyboard or a test can still reach it. Refusing here is what
    // makes the cap a rule and not just a piece of styling.
    if (sizedControlOf(key).onePerColor && this.values[key].length > 0) return;
    const field = createSizedField(sizedControlOf(key), this.values[key].length);
    this.values[key].push("");
    add.before(field);
    this.syncAddButtons();
    field.focus();
  }

  private handleInput(key: SizedControlKey, slot: number, raw: string) {
    const slots = this.values[key];
    if (slot < 0 || slot >= slots.length) return;
    slots[slot] = raw;
    this.onValuesChanged();
  }

  /** Removes a slot the player emptied and left. Dropping an EMPTY slot never
   * changes the config — it was contributing nothing — so no solution is
   * invalidated here; the emptying keystroke already did that. */
  private dropSlot(field: HTMLInputElement, key: SizedControlKey) {
    const slot = Number(field.dataset.slot);
    const slots = this.values[key];
    if (!Number.isInteger(slot) || slot < 0 || slot >= slots.length) return;
    slots.splice(slot, 1);
    field.remove();
    const spec = sizedControlOf(key);
    this.row
      .querySelectorAll<HTMLInputElement>(
        `.rule-size[data-sized-control="${key}"]`,
      )
      .forEach((survivor, index) => {
        survivor.dataset.slot = String(index);
        survivor.setAttribute("aria-label", `${spec.label} value ${index + 1}`);
      });
    this.syncAddButtons();
  }

  /**
   * Shows each `+` exactly where another value would mean something. A
   * one-per-colour control loses its button the moment it holds a slot — even
   * an empty one, since that slot is where the number is about to go — and
   * gets it back when an emptied slot is dropped.
   *
   * Called from the two element-creating paths as well as `refresh`, because
   * neither `addSlot` nor `dropSlot` fires `onValuesChanged`: an empty slot
   * appearing or leaving changes no download, so the editor is deliberately
   * not told, and `refresh` does not run after them.
   */
  private syncAddButtons() {
    for (const spec of SIZED_CONTROLS) {
      const add = this.addButton(spec.key);
      add?.classList.toggle(
        "hidden",
        spec.onePerColor && this.values[spec.key].length > 0,
      );
    }
  }

  private addButton(key: SizedControlKey) {
    return this.row.querySelector<HTMLButtonElement>(
      `.rule-size-add[data-sized-control="${key}"]`,
    );
  }

  private fieldAt(key: SizedControlKey, slot: number) {
    return this.row.querySelector<HTMLInputElement>(
      `.rule-size[data-sized-control="${key}"][data-slot="${slot}"]`,
    );
  }

  /** The values one control contributes to the config: parsed, in bounds,
   * de-duplicated, ascending. */
  private valuesOf(key: SizedControlKey): number[] {
    const spec = sizedControlOf(key);
    const values = new Set<number>();
    for (const raw of this.values[key]) {
      const value = parsedSizedValue(spec, raw);
      if (value !== null) values.add(value);
    }
    return [...values].sort((a, b) => a - b);
  }
}

/** Every sized control starts with no value fields: a family is off until a
 * number is typed into it. */
function emptySlots(): Record<SizedControlKey, string[]> {
  return { "run-dark": [], "run-light": [], "area-dark": [], "area-light": [] };
}

function parsedSizedValue(spec: SizedControlSpec, raw: string): number | null {
  const text = raw.trim();
  if (!/^\d+$/.test(text)) return null;
  const value = Number(text);
  return value >= spec.min && value <= spec.max ? value : null;
}

/** Deliberately NOT a `.tool-button`: a chip lookup means "a rule or clue
 * chip", and the add button toggles nothing. */
function addButtonFrom(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof HTMLElement)) return null;
  return target.closest(".rule-size-add");
}

/** The one place a slot field is spelled — the initial fill and the add button
 * go through it alike, so the two cannot drift. */
function createSizedField(
  spec: SizedControlSpec,
  slot: number,
): HTMLInputElement {
  const field = document.createElement("input");
  field.className = "rule-size";
  field.type = "number";
  field.min = String(spec.min);
  field.max = String(spec.max);
  field.dataset.sizedControl = spec.key;
  field.dataset.slot = String(slot);
  fitSizedField(field);
  field.setAttribute("aria-label", `${spec.label} value ${slot + 1}`);
  return field;
}

/**
 * Sizes a slot to what it HOLDS, not to the widest number its control could
 * take: an area field is four digits at most but one or two nearly always, and
 * a field padded for 9999 leaves a gap around a lone 4. The floor keeps an
 * empty field clickable; growth happens as digits arrive, since `refresh` runs
 * on every keystroke.
 */
function fitSizedField(field: HTMLInputElement) {
  const chars = String(Math.max(1, field.value.length));
  if (field.style.getPropertyValue("--value-chars") !== chars)
    field.style.setProperty("--value-chars", chars);
}
