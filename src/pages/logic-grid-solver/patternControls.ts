// The drawn patterns' half of the rule row, and the session library behind it.
//
// The parallel to `sizedRuleControls.ts`: the one part of the row whose chips
// are created and destroyed while the page runs, so it owns its own elements
// rather than being spelled once in `toolRowMarkup.ts` and refreshed in place.
// Never cache a chip — `#rule-row`'s innerHTML is rewritten by every board
// replacement, so every method re-queries from the row it was handed.
//
// **Two lists, and the split is the point.** The LIBRARY is every shape drawn
// since the page loaded; the ACTIVE set is which of them this board switches
// on. A new drawing joins both. Loading a config makes its patterns the active
// set and adds them to the library. Reset and resize clear the active set the
// way they clear `activeRules`, and leave the library alone — the next board
// in a group usually wants the same shapes, one click away.
//
// The library lives here and nowhere else: it is instance state on an object
// the page constructs once, so it dies with the page and needs no storage API,
// no clearing convention and no cleanup. That is exactly as long as it should
// live — a group of puzzles shares its rules, a browsing session does not.

import type { LogicGridPattern, LogicGridTest } from "../../util/types";
import { canonicalPatterns, describePattern, patternKey } from "./patterns";
import { patternChipMarkup } from "./toolRowMarkup";

export interface PatternControlsOptions {
  /** `#rule-row` — stable across rebuilds; only its innerHTML is replaced. */
  row: HTMLElement;
  /** Raised by the row's "New pattern" button. */
  onDraw: () => void;
  /**
   * Fired whenever the ACTIVE set changes — a toggle, a new drawing, a delete.
   * Never by a library-only change, because nothing about the board moved.
   */
  onActiveChanged: () => void;
}

export class PatternControls {
  private readonly row: HTMLElement;
  private readonly onDraw: () => void;
  private readonly onActiveChanged: () => void;

  /** Every shape drawn this session, in canonical order. */
  private library: LogicGridPattern[] = [];
  /** The canonical keys of the ones this board switches on. */
  private readonly active = new Set<string>();

  constructor(options: PatternControlsOptions) {
    this.row = options.row;
    this.onDraw = options.onDraw;
    this.onActiveChanged = options.onActiveChanged;
    this.addListeners();
  }

  /** Whether the library already holds this shape, in any rotation. */
  has(pattern: LogicGridPattern): boolean {
    const key = patternKey(pattern);
    return this.library.some(held => patternKey(held) === key);
  }

  /** Takes a freshly drawn shape: into the library, and on for this board. */
  add(pattern: LogicGridPattern) {
    if (this.has(pattern)) return;
    this.library = canonicalPatterns([...this.library, pattern]);
    this.active.add(patternKey(pattern));
    this.build();
    this.onActiveChanged();
  }

  /** Clears the active set. The library survives — see the file's header. */
  reset() {
    if (this.active.size === 0) return;
    this.active.clear();
    this.refresh();
  }

  /**
   * A loaded board's patterns become the active set, and join the library so
   * they are still one click away after a reset.
   */
  load(config: LogicGridTest) {
    this.active.clear();
    for (const pattern of config.patterns ?? []) {
      if (!this.has(pattern)) this.library = [...this.library, pattern];
      this.active.add(patternKey(pattern));
    }
    this.library = canonicalPatterns(this.library);
  }

  /** What the config carries: the active shapes, canonical, omitted if none. */
  configList(): Partial<LogicGridTest> {
    const patterns = canonicalPatterns(
      this.library.filter(pattern => this.active.has(patternKey(pattern))),
    );
    return patterns.length > 0 ? { patterns } : {};
  }

  /** Rebuilds every chip. Called from `render()` and after a library change. */
  build() {
    const chips = this.chipList();
    if (!chips) return;
    chips.innerHTML = this.library
      .map((pattern, index) =>
        patternChipMarkup(
          pattern,
          patternKey(pattern),
          describePattern(pattern, index + 1),
        ),
      )
      .join("");
    this.refresh();
  }

  /** Retoggles in place, without touching the elements. */
  refresh() {
    const chips = this.chipList();
    if (!chips) return;
    for (const toggle of chips.querySelectorAll<HTMLButtonElement>(
      ".pattern-toggle",
    )) {
      const on = this.active.has(toggle.dataset.patternKey ?? "");
      toggle.classList.toggle("selected", on);
      toggle.setAttribute("aria-pressed", String(on));
    }
  }

  private chipList(): HTMLElement | null {
    return this.row.querySelector<HTMLElement>("#pattern-chips");
  }

  /**
   * `#rule-row` carries three delegated click handlers now, and they stay
   * disjoint by CLASS: the editor's matches `.tool-button`, the sized
   * controls' matches `.rule-size-add`, and these match `.pattern-toggle`,
   * `.pattern-delete` and `.rule-pattern-add` — none of which is a
   * `.tool-button`. Delete is tested first, since it sits inside the chip.
   */
  private addListeners() {
    this.row.addEventListener("click", event => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest(".rule-pattern-add")) {
        this.onDraw();
        return;
      }
      const remove = target.closest<HTMLElement>(".pattern-delete");
      if (remove) {
        this.drop(remove.dataset.patternKey ?? "");
        return;
      }
      const toggle = target.closest<HTMLElement>(".pattern-toggle");
      if (toggle) this.toggle(toggle.dataset.patternKey ?? "");
    });
  }

  private toggle(key: string) {
    if (key === "") return;
    if (this.active.has(key)) this.active.delete(key);
    else this.active.add(key);
    this.refresh();
    this.onActiveChanged();
  }

  /**
   * Deleting removes the shape from the LIBRARY, not just from the board —
   * the chip is the only handle on it, so leaving it switched off would leave
   * no way to get rid of it.
   */
  private drop(key: string) {
    if (key === "") return;
    const wasActive = this.active.delete(key);
    this.library = this.library.filter(held => patternKey(held) !== key);
    this.build();
    if (wasActive) this.onActiveChanged();
  }
}
