import type {
  LogicGridCell,
  LogicGridClue,
  LogicGridSymbol,
  LogicGridSymbolValue,
  LogicGridTest,
  LogicGridTool,
  Position,
} from "../../util/types";
import { DARK, isPlayable, LIGHT, UNKNOWN, UNPLAYABLE } from "./cell";
import { dressCell } from "./cellView";
import type { LogicGridSolverEditor } from "./logicGridSolver";
import { symbolKindAt } from "./symbols";

/**
 * What one pointer stroke writes into every cell it touches. Decided once, at
 * pointerdown — see `toggled`.
 */
type Stroke =
  | { kind: "color"; value: LogicGridCell }
  | { kind: "clue"; clue: LogicGridClue | null }
  | { kind: "erase" };

const DIGIT_PATTERN = /^\d$/;
const LETTER_KEY_PATTERN = /^[a-zA-Z]$/;

function sameClue(a: LogicGridClue | null, b: LogicGridClue | null): boolean {
  if (a === null || b === null) return a === b;
  return a.type === b.type && a.value === b.value;
}

export class Board {
  private readonly gridWidth: number;
  private readonly gridHeight: number;
  private selectedTool: LogicGridTool;
  private selectedSymbol: number;
  /** Null while the value field holds nothing usable, which stamps nothing. */
  private symbolValue: LogicGridSymbolValue | null;
  private readonly solver: LogicGridSolverEditor;

  /** The colour layer, column-major. */
  private cells: LogicGridCell[][] = [];
  /** The clue layer, indexed like `cells`. Independent of the colour. */
  private clues: (LogicGridClue | null)[][] = [];
  /**
   * The rendered cell buttons, indexed like `cells`. Painting rewrites the one
   * button it touched rather than re-running `renderGrid`; on a 32x32 board
   * that is the difference between one attribute write and rebuilding 1024
   * elements per pointermove.
   */
  private cellElements: HTMLButtonElement[][] = [];
  /** The stroke in progress, or null when the pointer is up. */
  private stroke: Stroke | null = null;
  /**
   * The cell the current run of digits is typing into. Area numbers run past
   * nine, so consecutive digits on one cell accumulate; anything else ends the
   * run and the next digit starts a fresh number.
   */
  private digitCell: Position | null = null;
  /** Aborts every listener this board registered — see `dispose`. */
  private readonly listeners = new AbortController();
  private readonly grid = document.getElementById("grid") as HTMLDivElement;

  constructor(
    solver: LogicGridSolverEditor,
    gridWidth: number,
    gridHeight: number,
    selectedTool: LogicGridTool,
    selectedSymbol: number,
    symbolValue: LogicGridSymbolValue | null,
  ) {
    this.solver = solver;
    this.gridWidth = gridWidth;
    this.gridHeight = gridHeight;
    this.selectedTool = selectedTool;
    this.selectedSymbol = selectedSymbol;
    this.symbolValue = symbolValue;
    this.resetBoardData();
    this.addListeners();
  }

  /**
   * Drops this board's listeners. The `#grid` element outlives the board it
   * belongs to, so a replaced board that kept listening would keep painting
   * into its own dead `cells` and make every stroke do the work twice.
   */
  dispose() {
    this.listeners.abort();
  }

  setSelectedTool(tool: LogicGridTool) {
    this.selectedTool = tool;
  }

  setSelectedSymbol(index: number) {
    this.selectedSymbol = index;
  }

  setSymbolValue(value: LogicGridSymbolValue | null) {
    this.symbolValue = value;
  }

  /** Clears both layers. */
  resetBoardData() {
    this.cells = Array.from({ length: this.gridWidth }, () =>
      Array.from({ length: this.gridHeight }, () => UNKNOWN),
    );
    this.clues = Array.from({ length: this.gridWidth }, () =>
      Array.from({ length: this.gridHeight }, () => null),
    );
    this.digitCell = null;
  }

  getCells() {
    return this.cells;
  }

  /** The clue layer, sparse and in reading order, as the config stores it. */
  getSymbols(): LogicGridSymbol[] {
    const symbols: LogicGridSymbol[] = [];
    for (let y = 0; y < this.gridHeight; y++) {
      for (let x = 0; x < this.gridWidth; x++) {
        const clue = this.clues[x]?.[y];
        if (clue) symbols.push({ x, y, type: clue.type, value: clue.value });
      }
    }
    return symbols;
  }

  renderGrid() {
    this.grid.style.gridTemplateColumns = `repeat(${this.gridWidth}, minmax(0, 1fr))`;

    // One fragment, one insertion: appending cell by cell to a live #grid
    // makes the browser lay out the whole grid on every one of them.
    const fragment = document.createDocumentFragment();
    this.cellElements = Array.from(
      { length: this.gridWidth },
      (): HTMLButtonElement[] => [],
    );

    for (let y = 0; y < this.gridHeight; y++) {
      for (let x = 0; x < this.gridWidth; x++) {
        const cell = document.createElement("button");
        cell.type = "button";
        cell.className = "grid-cell";
        cell.dataset.x = String(x);
        cell.dataset.y = String(y);
        this.cellElements[x]![y] = cell;
        this.dressCellAt(x, y);
        fragment.appendChild(cell);
      }
    }

    this.grid.replaceChildren(fragment);
  }

  /**
   * Replaces the board contents with a validated config. The caller must have
   * constructed the board with the config's grid size.
   */
  loadConfig(config: LogicGridTest) {
    this.resetBoardData();
    for (let x = 0; x < this.gridWidth; x++) {
      for (let y = 0; y < this.gridHeight; y++) {
        this.cells[x]![y] = config.cells[x]![y]!;
      }
    }
    for (const symbol of config.symbols) {
      const column = this.clues[symbol.x];
      if (column) column[symbol.y] = { type: symbol.type, value: symbol.value };
    }
  }

  /** Writes the current state of (x, y) onto its button. */
  private dressCellAt(x: number, y: number) {
    const element = this.cellElements[x]?.[y];
    if (!element) return;
    const color = this.cells[x]?.[y] ?? UNKNOWN;
    dressCell(element, color, this.clues[x]?.[y] ?? null, x, y);
  }

  private addListeners() {
    const { signal } = this.listeners;

    this.grid.addEventListener(
      "pointerdown",
      event => this.beginStroke(event),
      { signal },
    );

    this.grid.addEventListener(
      "pointermove",
      event => {
        if (!this.stroke) return;
        const position = this.extractCellPosition(event.target);
        if (position) this.applyStroke(position);
      },
      { signal },
    );

    document.addEventListener(
      "pointerup",
      () => {
        this.stroke = null;
      },
      { signal },
    );

    // Right-dragging the light colour across the board would otherwise open the
    // context menu on the first cell and end the stroke there.
    this.grid.addEventListener("contextmenu", event => event.preventDefault(), {
      signal,
    });

    this.grid.addEventListener("keydown", event => this.handleKey(event), {
      signal,
    });
  }

  private extractCellPosition(target: EventTarget | null): Position | null {
    if (!(target instanceof HTMLElement)) {
      return null;
    }

    const cell = target.closest(".grid-cell") as HTMLElement;
    if (!cell) return null;

    const x = Number(cell.dataset.x);
    const y = Number(cell.dataset.y);

    if (!Number.isInteger(x) || !Number.isInteger(y)) {
      return null;
    }

    return { x, y };
  }

  private beginStroke(event: PointerEvent) {
    // Left and right only. The middle button and the browser-back buttons all
    // arrive here as pointerdowns and must not paint.
    if (event.button !== 0 && event.button !== 2) return;
    const position = this.extractCellPosition(event.target);
    if (!position) return;

    const stroke = this.strokeFor(event.button === 2);
    if (!stroke) return;

    this.stroke = this.toggled(stroke, position);
    this.digitCell = null;
    this.applyStroke(position);
  }

  /**
   * What a button press writes, before the re-click rule.
   *
   * The selected chip drives the left button; the right one paints the other
   * colour where there is one, and erases where there is not. With Dark
   * selected — the default — that is left-dark, right-light with nothing
   * clicked, which is how the boards are drawn.
   */
  private strokeFor(secondary: boolean): Stroke | null {
    switch (this.selectedTool) {
      case "dark":
        return { kind: "color", value: secondary ? LIGHT : DARK };
      case "light":
        return { kind: "color", value: secondary ? DARK : LIGHT };
      case "unplayable":
        return secondary
          ? { kind: "erase" }
          : { kind: "color", value: UNPLAYABLE };
      case "erase":
        return { kind: "erase" };
      case "symbol":
        // The right button lifts the clue and leaves the colour alone.
        return secondary ? { kind: "clue", clue: null } : this.clueStroke();
      default:
        // Command tools paint nothing.
        return null;
    }
  }

  private clueStroke(): Stroke | null {
    if (this.symbolValue === null) return null;
    return {
      kind: "clue",
      clue: { type: this.selectedSymbol, value: this.symbolValue },
    };
  }

  /**
   * The re-click-erases rule, applied ONCE per stroke: pressing a button on a
   * cell that already holds what that button writes clears it instead.
   *
   * Deciding it per cell would make a drag across a half-painted row alternate
   * between painting and erasing, so the whole stroke commits here and every
   * cell it goes on to touch gets the same effect.
   */
  private toggled(stroke: Stroke, position: Position): Stroke {
    if (stroke.kind === "color") {
      return this.colorAt(position) === stroke.value
        ? { kind: "color", value: UNKNOWN }
        : stroke;
    }
    if (stroke.kind === "clue" && stroke.clue) {
      return sameClue(this.clueAt(position), stroke.clue)
        ? { kind: "clue", clue: null }
        : stroke;
    }
    return stroke;
  }

  private applyStroke(position: Position) {
    const stroke = this.stroke;
    if (!stroke) return;

    if (stroke.kind === "erase") {
      this.writeCell(position, UNKNOWN, null);
      return;
    }

    if (stroke.kind === "color") {
      // A gap in the board is not a cell the puzzle clues, so painting one
      // drops whatever clue was there.
      const clue = stroke.value === UNPLAYABLE ? null : this.clueAt(position);
      this.writeCell(position, stroke.value, clue);
      return;
    }

    // A clue cannot be placed on a gap; lifting one always may.
    if (stroke.clue && !isPlayable(this.colorAt(position))) return;
    this.writeCell(position, this.colorAt(position), stroke.clue);
  }

  private colorAt(position: Position): LogicGridCell {
    return this.cells[position.x]?.[position.y] ?? UNKNOWN;
  }

  private clueAt(position: Position): LogicGridClue | null {
    return this.clues[position.x]?.[position.y] ?? null;
  }

  /**
   * The one place either layer changes. A no-op when nothing moves, which is
   * the common case while dragging: a pointermove fires many times per cell.
   */
  private writeCell(
    position: Position,
    color: LogicGridCell,
    clue: LogicGridClue | null,
  ) {
    const column = this.cells[position.x];
    const clueColumn = this.clues[position.x];
    if (!column || !clueColumn) return;
    if (position.y < 0 || position.y >= this.gridHeight) return;
    const existing = clueColumn[position.y] ?? null;
    if (column[position.y] === color && sameClue(existing, clue)) return;

    column[position.y] = color;
    clueColumn[position.y] = clue;
    this.dressCellAt(position.x, position.y);
    this.solver.hideSolution();
  }

  /**
   * Typing on a focused cell. Clicking a cell focuses its button, so this is
   * the quick way to correct a clue without going back to the value field.
   */
  private handleKey(event: KeyboardEvent) {
    const position = this.extractCellPosition(event.target);
    if (!position) return;

    if (event.key === "Backspace" || event.key === "Delete") {
      event.preventDefault();
      this.digitCell = null;
      this.writeCell(position, this.colorAt(position), null);
      return;
    }

    const clue = this.nextClue(position, event.key);
    if (!clue) return;
    event.preventDefault();
    this.writeCell(position, this.colorAt(position), clue);
  }

  /**
   * The clue a keystroke produces. A key edits the clue already on the cell
   * when it suits that clue's kind, and otherwise stamps the selected kind — so
   * a digit types into an area number and a letter into a letter, without the
   * chip row having to be touched first.
   */
  private nextClue(position: Position, key: string): LogicGridClue | null {
    if (!isPlayable(this.colorAt(position))) return null;

    const existing = this.clueAt(position);
    const type = existing ? existing.type : this.selectedSymbol;
    const kind = symbolKindAt(type);
    if (!kind) return null;

    if (kind.valueKind === "letter") {
      return LETTER_KEY_PATTERN.test(key)
        ? { type, value: key.toUpperCase() }
        : null;
    }

    if (!DIGIT_PATTERN.test(key)) return null;
    const value = this.nextAreaValue(position, existing, Number(key));
    return value === null ? null : { type, value };
  }

  /**
   * Digits accumulate while one cell keeps taking them, so 12 is "1" then "2".
   * Painting, or moving to another cell, ends the run and the next digit starts
   * a fresh number. A number that would outgrow the board is refused rather
   * than truncated, so a slip leaves the last good value standing.
   */
  private nextAreaValue(
    position: Position,
    existing: LogicGridClue | null,
    digit: number,
  ): number | null {
    const previous = this.digitCell;
    const continuing =
      previous?.x === position.x && previous?.y === position.y;
    const current =
      existing && typeof existing.value === "number" ? existing.value : null;
    this.digitCell = { x: position.x, y: position.y };

    if (!continuing || current === null) {
      // A leading zero is not an area, so it is ignored rather than clamped.
      return digit === 0 ? null : digit;
    }

    const grown = current * 10 + digit;
    return grown <= this.gridWidth * this.gridHeight ? grown : current;
  }
}
