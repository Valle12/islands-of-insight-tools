import { balancedColumns } from "./layout";

/**
 * The buttons a phasic dial puzzle offers, drawn the way the game's button
 * panels read: one card per button, and inside it one slot per dial stacking
 * that dial's icon once per turn the button applies.
 *
 * The card also carries its own press count once the puzzle is solved, so the
 * answer sits on the thing you have to press instead of in a list somewhere
 * else on the page.
 */

/**
 * The most icons a slot ever stacks. Past this it shows ONE icon and the
 * count — a wall of tiles stops being countable at a glance long before it
 * stops fitting, and `×7` is the thing you actually read.
 */
const MAX_STACKED_ICONS = 6;

/**
 * How many icons fit across a slot. `.turn-slot` is 122px of content (only
 * `body` is border-box here, so its padding does not eat into that), and an
 * icon is 22px with a 2px gap: `(122 + 2) / (22 + 2)` is five.
 */
const ICONS_PER_ROW = 5;

export interface DialDescriptor {
  color: string;
  label: string;
  image: string;
}

export interface ButtonsViewOptions {
  host: HTMLElement;
  onTurnsChange: (button: number, dial: number, turns: number) => void;
  onRemove: (button: number) => void;
}

export class ButtonsView {
  private readonly host: HTMLElement;
  private readonly onTurnsChange: ButtonsViewOptions["onTurnsChange"];
  private readonly onRemove: ButtonsViewOptions["onRemove"];
  private readonly controller = new AbortController();

  private dials: DialDescriptor[] = [];
  private buttons: number[][] = [];

  constructor(options: ButtonsViewOptions) {
    this.host = options.host;
    this.onTurnsChange = options.onTurnsChange;
    this.onRemove = options.onRemove;
    this.wire();
  }

  dispose() {
    this.controller.abort();
  }

  /** Rebuilds every card. Call after a structural change, not on every edit. */
  render(dials: DialDescriptor[], buttons: number[][]) {
    this.dials = dials;
    this.buttons = buttons;
    this.host.innerHTML = buttons
      .map((turns, index) => this.cardMarkup(index, turns, buttons.length))
      .join("");
  }

  /**
   * Fills in (or clears) the per-card press counts. `null` means "no current
   * answer", which is the state after any edit.
   */
  showPresses(presses: number[] | null) {
    this.host
      .querySelectorAll<HTMLElement>(".button-card")
      .forEach((card, index) => {
        const badge = card.querySelector<HTMLElement>(".button-presses")!;
        const count = presses?.[index];
        if (count === undefined) {
          badge.classList.add("hidden");
          delete card.dataset.unused;
          return;
        }
        badge.classList.remove("hidden");
        badge.textContent = count === 0 ? "not needed" : `press ×${count}`;
        card.dataset.unused = String(count === 0);
      });
  }

  private wire() {
    const { signal } = this.controller;
    this.host.addEventListener("click", e => this.onClick(e), { signal });
    this.host.addEventListener("input", e => this.onInput(e), { signal });
  }

  private onClick(event: Event) {
    const target = event.target as HTMLElement | null;
    const card = target?.closest<HTMLElement>(".button-card");
    if (!card) return;
    const button = Number(card.dataset.button);

    if (target!.closest(".button-delete")) {
      this.onRemove(button);
      return;
    }

    const slot = target!.closest<HTMLElement>(".turn-slot");
    if (!slot) return;
    const step = ButtonsView.stepperDelta(target!);
    if (step === 0) return;

    const dial = Number(slot.dataset.dial);
    const next = Math.max(0, (this.buttons[button]?.[dial] ?? 0) + step);
    this.commit(button, dial, next, slot);
  }

  private static stepperDelta(target: HTMLElement): number {
    if (target.closest(".turn-more")) return 1;
    if (target.closest(".turn-less")) return -1;
    return 0;
  }

  private onInput(event: Event) {
    const input = (event.target as HTMLElement).closest<HTMLInputElement>(
      ".turn-input",
    );
    if (!input) return;
    const slot = input.closest<HTMLElement>(".turn-slot")!;
    const card = input.closest<HTMLElement>(".button-card")!;
    const raw = Math.trunc(Number(input.value));
    const turns = Number.isFinite(raw) && raw > 0 ? raw : 0;
    // Typing is the one path that must not write the field back while it has
    // focus — doing so would fight the caret. Only the icons are refreshed.
    this.commit(
      Number(card.dataset.button),
      Number(slot.dataset.dial),
      turns,
      slot,
      false,
    );
  }

  private commit(
    button: number,
    dial: number,
    turns: number,
    slot: HTMLElement,
    writeInput = true,
  ) {
    const row = this.buttons[button];
    if (!row || dial >= row.length) return;
    row[dial] = turns;

    this.paintIcons(slot, dial, turns);
    slot.dataset.empty = String(turns === 0);
    if (writeInput) {
      slot.querySelector<HTMLInputElement>(".turn-input")!.value =
        String(turns);
    }
    this.onTurnsChange(button, dial, turns);
  }

  private iconsMarkup(dial: number, turns: number): string {
    const info = this.dials[dial]!;
    if (turns === 0) return `<span class="turn-icon-empty"></span>`;

    const icon = `<img class="turn-icon" src="${info.image}" alt="" />`;
    if (turns > MAX_STACKED_ICONS) {
      return icon + `<span class="turn-overflow">×${turns}</span>`;
    }
    return icon.repeat(turns);
  }

  /** Columns the stack is laid out in, so two rows come out even. */
  private static iconColumns(turns: number): number {
    // One icon beside its count is two cells, whatever the count says.
    if (turns > MAX_STACKED_ICONS) return 2;
    return balancedColumns(Math.max(turns, 1), ICONS_PER_ROW);
  }

  /** Redraws one slot's icon stack and the column count it needs. */
  private paintIcons(slot: HTMLElement, dial: number, turns: number) {
    const icons = slot.querySelector<HTMLElement>(".turn-icons")!;
    icons.innerHTML = this.iconsMarkup(dial, turns);
    icons.style.setProperty(
      "--icon-cols",
      String(ButtonsView.iconColumns(turns)),
    );
  }

  private cardMarkup(index: number, turns: number[], total: number): string {
    const name = `Button ${index + 1}`;
    const slots = this.dials
      .map((dial, d) => this.slotMarkup(name, dial, d, turns[d] ?? 0))
      .join("");
    return `
      <div class="button-card" data-button="${index}">
        <div class="button-card-header">
          <span class="button-name">${name}</span>
          <span class="button-presses hidden"></span>
          <md-icon-button
            class="button-delete"
            title="Delete ${name.toLowerCase()}"
            aria-label="Delete ${name.toLowerCase()}"
            ${total <= 1 ? "disabled" : ""}
          >
            <md-icon>delete</md-icon>
          </md-icon-button>
        </div>
        <div class="turn-slots">${slots}</div>
      </div>`;
  }

  private slotMarkup(
    name: string,
    dial: DialDescriptor,
    index: number,
    turns: number,
  ): string {
    const who = `${dial.label.toLowerCase()} turn on ${name.toLowerCase()}`;
    return `
      <div
        class="turn-slot"
        data-dial="${index}"
        data-color="${dial.color}"
        data-empty="${turns === 0}"
      >
        <div
          class="turn-icons"
          style="--icon-cols: ${ButtonsView.iconColumns(turns)}"
        >${this.iconsMarkup(index, turns)}</div>
        <div class="turn-stepper">
          <md-icon-button
            class="turn-less"
            title="One fewer ${who}"
            aria-label="One fewer ${who}"
          >
            <md-icon>remove</md-icon>
          </md-icon-button>
          <input
            class="turn-input"
            type="number"
            min="0"
            inputmode="numeric"
            value="${turns}"
            aria-label="${name} ${dial.label.toLowerCase()} turns"
          />
          <md-icon-button
            class="turn-more"
            title="One more ${who}"
            aria-label="One more ${who}"
          >
            <md-icon>add</md-icon>
          </md-icon-button>
        </div>
        <span class="turn-dial-name">${dial.label}</span>
      </div>`;
  }
}
