// The dialog a forbidden pattern is drawn in.
//
// A miniature of the board editor, and drawn the way the board is: two size
// fields, an armed color, and a grid the left button paints with it while the
// right button clears. It used to cycle dark -> light -> empty on one gesture,
// which is fewer controls but a different idiom from the page around it — and
// the shape being drawn IS a board, so it should be drawn like one.
//
// No eraser chip, and none needed: it is the board's gesture exactly. The
// armed color is under the left button and the other one under the right, and
// pressing a square with the button that writes what is already there clears
// it instead. That last part is what keeps BOTH colors and the eraser
// reachable from either chip — someone with no right button can arm the other
// color and still paint it, and still clear.
//
// It owns its own elements the way `sizedRuleControls.ts` owns its value
// fields, and for the same reason: the grid is created and destroyed while the
// page runs, every time the size changes. `#rule-row` is never touched from
// here — the caller is handed the finished shape and decides what to do with
// it.

import { parsePositiveInt } from "../../util/editorShell";
import type { LogicGridPattern } from "../../util/types";
import { colorId, DARK, LIGHT, UNKNOWN } from "./cell";
import { normalizePattern } from "./patterns";

/** The colors the dialog can arm, by the `data-pattern-color` they carry. */
const ARMED: Record<string, number> = { dark: DARK, light: LIGHT };

/** What the caller has to answer for the dialog to do its job. */
export interface PatternDialogOptions {
  /**
   * The board's dimensions, which cap the box: a pattern larger than the board
   * can never occur on it. It stays LEGAL in the format — a board loaded later
   * may be bigger — so this is the drawing cap only.
   */
  boardSize: () => { gridWidth: number; gridHeight: number };
  /**
   * Whether this shape is already in the library, which is asked of the
   * CANONICAL form: two drawings that are rotations of each other are one
   * rule, and the second is refused with a message rather than silently
   * collapsed.
   */
  isKnown: (pattern: LogicGridPattern) => boolean;
  /** Called with the trimmed shape once the player saves. */
  onSave: (pattern: LogicGridPattern) => void;
}

export class PatternDialog {
  private readonly dialog = document.getElementById(
    "pattern-dialog",
  ) as HTMLDialogElement;
  private readonly grid = document.getElementById(
    "pattern-grid",
  ) as HTMLElement;
  private readonly error = document.getElementById(
    "pattern-error",
  ) as HTMLElement;
  private readonly widthField = document.getElementById(
    "pattern-width",
  ) as HTMLInputElement;
  private readonly heightField = document.getElementById(
    "pattern-height",
  ) as HTMLInputElement;

  /** The box being drawn: row-major, one entry per square. */
  private width = 2;
  private height = 2;
  private squares: number[] = [];
  /** What the left button paints. Survives a close, like the box's size. */
  private armed = DARK;

  constructor(private readonly options: PatternDialogOptions) {
    this.addListeners();
  }

  /** Opens on a blank box of the size it was last left at, capped to the board. */
  open() {
    const { gridWidth, gridHeight } = this.options.boardSize();
    this.width = Math.min(this.width, gridWidth);
    this.height = Math.min(this.height, gridHeight);
    this.widthField.max = String(gridWidth);
    this.heightField.max = String(gridHeight);
    this.widthField.value = String(this.width);
    this.heightField.value = String(this.height);
    this.squares = new Array<number>(this.width * this.height).fill(UNKNOWN);
    // The chips are markup, not built here, so they hold whatever the last
    // visit left them showing — which is right, but only once it is said out
    // loud: an armed color that survives a close has to survive it visibly.
    this.arm(this.armed === LIGHT ? "light" : "dark");
    this.say("");
    this.render();
    // Raised directly rather than through `editorShell`, which only knows the
    // reset dialog: this one confirms nothing, so it follows the phasic dial
    // page's help dialog instead.
    this.dialog.show();
  }

  private addListeners() {
    document.getElementById("pattern-cancel")?.addEventListener("click", () => {
      this.dialog.close();
    });
    document.getElementById("pattern-clear")?.addEventListener("click", () => {
      this.squares.fill(UNKNOWN);
      this.say("");
      this.squares.forEach((_square, at) => {
        this.repaint(at);
      });
    });
    document.getElementById("pattern-save")?.addEventListener("click", () => {
      this.save();
    });
    for (const field of [this.widthField, this.heightField]) {
      field.addEventListener("input", () => {
        this.resize();
      });
    }
    this.dialog.addEventListener("click", event => {
      const chip = (event.target as HTMLElement | null)?.closest<HTMLElement>(
        ".pattern-color",
      );
      if (chip) this.arm(chip.dataset.patternColor ?? "");
    });
    // Delegated, because `render` replaces every square when the box changes.
    // `pointerdown`, not `click`: a right press raises no click at all, so the
    // eraser would never fire — the same reason `board.ts` listens for it.
    this.grid.addEventListener("pointerdown", event => {
      const square = (event.target as HTMLElement | null)?.closest(
        ".pattern-cell",
      );
      if (!(square instanceof HTMLElement)) return;
      if (event.button !== 0 && event.button !== 2) return;
      this.paint(Number(square.dataset.at), event.button === 2);
    });
    // Or the right button opens the browser's menu over the square it just
    // cleared, exactly as it would over the board.
    this.grid.addEventListener("contextmenu", event => {
      event.preventDefault();
    });
  }

  /** Arms a color, and shows which one on the two chips. */
  private arm(name: string) {
    const color = ARMED[name];
    if (color === undefined) return;
    this.armed = color;
    for (const chip of this.dialog.querySelectorAll<HTMLElement>(
      ".pattern-color",
    )) {
      const on = chip.dataset.patternColor === name;
      chip.classList.toggle("selected", on);
      chip.setAttribute("aria-pressed", String(on));
    }
  }

  /**
   * A resize KEEPS whatever is still inside the new box rather than clearing.
   * Nudging a 3 to a 4 while drawing is a correction, not a fresh start, and
   * losing the drawing to a typo is what that would feel like.
   */
  private resize() {
    const { gridWidth, gridHeight } = this.options.boardSize();
    const width = parsePositiveInt(this.widthField.value, gridWidth);
    const height = parsePositiveInt(this.heightField.value, gridHeight);
    if (width === null || height === null) return;
    if (width === this.width && height === this.height) return;
    const kept = new Array<number>(width * height).fill(UNKNOWN);
    for (let y = 0; y < Math.min(height, this.height); y++) {
      for (let x = 0; x < Math.min(width, this.width); x++)
        kept[y * width + x] = this.squares[y * this.width + x]!;
    }
    this.width = width;
    this.height = height;
    this.squares = kept;
    this.render();
  }

  /**
   * The board's own stroke, in miniature: the armed color under the left
   * button, the other under the right, and a press writing what is already
   * there clears it instead — `strokes.ts`'s `strokeFor` and `toggled` for the
   * two color tools, which is the whole of what this dialog needs.
   */
  private paint(at: number, secondary: boolean) {
    if (!Number.isInteger(at) || at < 0 || at >= this.squares.length) return;
    const other = this.armed === DARK ? LIGHT : DARK;
    const writes = secondary ? other : this.armed;
    const wanted = this.squares[at] === writes ? UNKNOWN : writes;
    if (this.squares[at] === wanted) return;
    this.squares[at] = wanted;
    this.say("");
    // In place, never a rebuild: `render` replaces every square, which would
    // take the focus off the one that was just pressed — so a keyboard user
    // could color one square and no more. Same reason `refreshRuleRow` never
    // rebuilds the row it toggles.
    this.repaint(at);
  }

  /** Writes one square's color back onto the button that already exists. */
  private repaint(at: number) {
    const square = this.grid.querySelector<HTMLButtonElement>(
      `.pattern-cell[data-at="${at}"]`,
    );
    if (!square) return;
    square.dataset.square = colorId(this.squares[at]!);
    square.setAttribute("aria-label", this.squareName(at));
  }

  private squareName(at: number): string {
    const x = (at % this.width) + 1;
    const y = Math.floor(at / this.width) + 1;
    return `Row ${y} column ${x}, ${colorId(this.squares[at]!)}`;
  }

  /** The drawn box before trimming — what the player sees, not what is stored. */
  private drawn(): LogicGridPattern {
    return { width: this.width, height: this.height, cells: [...this.squares] };
  }

  private save() {
    const trimmed = normalizePattern(this.drawn());
    if (!trimmed) {
      this.say("Color at least one square first.");
      return;
    }
    if (this.options.isKnown(trimmed)) {
      // By the canonical form, so this fires on a rotation of a shape already
      // held — which is the same rule, drawn facing another way.
      this.say("You already have this pattern.");
      return;
    }
    this.options.onSave(trimmed);
    this.dialog.close();
  }

  private say(message: string) {
    this.error.textContent = message;
    this.error.classList.toggle("hidden", message === "");
  }

  /** Rebuilds the grid. Only where the BOX changed — opening and resizing. */
  private render() {
    this.grid.style.setProperty("--pattern-width", String(this.width));
    this.grid.style.setProperty("--pattern-height", String(this.height));
    this.grid.innerHTML = this.squares
      .map(
        (square, at) =>
          `<button class="pattern-cell" type="button" data-at="${at}"
            data-square="${colorId(square)}"
            aria-label="${this.squareName(at)}"
          ></button>`,
      )
      .join("");
  }
}
