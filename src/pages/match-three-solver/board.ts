import type {
  MatchThreeCell,
  MatchThreeTest,
  MatchThreeTool,
  Position,
} from "../../util/types";
import {
  BLOCKED,
  colorCell,
  colorSlotOf,
  EMPTY,
  isColor,
} from "./cell";
import type { MatchThreeSolverEditor } from "./matchThreeSolver";
import { MAX_COLORS, pickUnusedColor } from "./palette";

export class Board {
  private readonly gridWidth: number;
  private readonly gridHeight: number;
  private isPainting = false;
  private selectedTool: MatchThreeTool;
  private selectedColorIndex: number;
  private readonly solver: MatchThreeSolverEditor;
  private cells: MatchThreeCell[][] = [];
  /** Slot index -> CSS color name. Never empty: a board always has one. */
  private palette: string[] = [];
  /**
   * The rendered cell buttons, indexed like `cells`. Painting rewrites the one
   * button it touched rather than re-running `renderGrid`; on a 32x32 board
   * that is the difference between one attribute write and rebuilding 1024
   * elements per pointermove.
   */
  private cellElements: HTMLButtonElement[][] = [];
  /** Aborts every listener this board registered — see `dispose`. */
  private readonly listeners = new AbortController();
  private readonly grid = document.getElementById("grid") as HTMLDivElement;

  constructor(
    solver: MatchThreeSolverEditor,
    gridWidth: number,
    gridHeight: number,
    selectedTool: MatchThreeTool,
    selectedColorIndex: number,
    palette?: readonly string[],
  ) {
    this.solver = solver;
    this.gridWidth = gridWidth;
    this.gridHeight = gridHeight;
    this.selectedTool = selectedTool;
    this.selectedColorIndex = selectedColorIndex;
    this.resetBoardData(palette);
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

  setSelectedTool(tool: MatchThreeTool) {
    this.selectedTool = tool;
  }

  setSelectedColorIndex(index: number) {
    this.selectedColorIndex = index;
  }

  /**
   * Clears every cell. A palette carries over when one is handed in (resizing
   * the grid keeps the colors the user has already collected); otherwise the
   * board opens on a single random color.
   */
  resetBoardData(palette?: readonly string[]) {
    this.cells = Array.from({ length: this.gridWidth }, () =>
      Array.from({ length: this.gridHeight }, () => EMPTY),
    );
    this.palette =
      palette && palette.length > 0 ? [...palette] : [pickUnusedColor([])!];
  }

  getCells() {
    return this.cells;
  }

  getPalette() {
    return this.palette;
  }

  /**
   * Appends a random still-unused color. Returns false once every name in the
   * curated list is taken, which the editor turns into a warning.
   */
  addColor(): boolean {
    if (this.palette.length >= MAX_COLORS) return false;
    const color = pickUnusedColor(this.palette);
    if (color === null) return false;
    this.palette.push(color);
    return true;
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
        this.dressCell(cell, x, y);
        this.cellElements[x]![y] = cell;
        fragment.appendChild(cell);
      }
    }

    this.grid.replaceChildren(fragment);
  }

  /** Writes the current value of (x, y) onto its button. */
  private dressCell(cell: HTMLButtonElement, x: number, y: number) {
    const value = this.cells[x]?.[y] ?? EMPTY;

    if (isColor(value)) {
      const slot = colorSlotOf(value);
      cell.dataset.kind = "color";
      cell.dataset.colorIndex = String(slot);
      // The color comes from the palette at runtime, so it cannot be a static
      // rule in the stylesheet.
      cell.style.backgroundColor = this.palette[slot] ?? "";
    } else {
      cell.dataset.kind = value === BLOCKED ? "blocked" : "empty";
      delete cell.dataset.colorIndex;
      cell.style.backgroundColor = "";
    }

    cell.setAttribute("aria-label", this.describeCell(x, y, value));
  }

  /**
   * Labels a cell by palette *slot*, never by color name: the palette is
   * randomised, so a name here would make the e2e aria snapshots flaky.
   */
  private describeCell(x: number, y: number, value: MatchThreeCell): string {
    const position = `Column ${x + 1}, Row ${y + 1}`;
    if (isColor(value)) {
      return `${position}, Color ${colorSlotOf(value) + 1}`;
    }
    return `${position}, ${value === BLOCKED ? "Blocked" : "Empty"}`;
  }

  /**
   * Replaces the board contents with a validated config. The caller must have
   * constructed the board with the config's grid size.
   */
  loadConfig(config: MatchThreeTest) {
    this.resetBoardData(config.colors);
    for (let x = 0; x < this.gridWidth; x++) {
      for (let y = 0; y < this.gridHeight; y++) {
        this.cells[x]![y] = config.cells[x]![y]!;
      }
    }
  }

  private addListeners() {
    const { signal } = this.listeners;

    this.grid.addEventListener(
      "pointerdown",
      event => {
        const position = this.extractCellPosition(event.target);
        if (!position) return;
        this.isPainting = true;
        this.paintCell(position);
      },
      { signal },
    );

    this.grid.addEventListener(
      "pointermove",
      event => {
        if (!this.isPainting) return;
        const position = this.extractCellPosition(event.target);
        if (!position) return;
        this.paintCell(position);
      },
      { signal },
    );

    document.addEventListener(
      "pointerup",
      () => {
        this.isPainting = false;
      },
      { signal },
    );
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

  /**
   * Applies the selected tool to one cell and redraws just that button.
   * A no-op when the cell already holds that value, which is the common case
   * while dragging: a pointermove fires many times per cell.
   */
  private paintCell(position: Position) {
    const column = this.cells[position.x];
    if (!column) return;

    const value = this.selectedToolValue();
    if (value === null || column[position.y] === value) return;

    column[position.y] = value;
    const cell = this.cellElements[position.x]?.[position.y];
    if (cell) this.dressCell(cell, position.x, position.y);
    this.solver.hideSolution();
  }

  /** The cell value the selected tool paints, or null for a command tool. */
  private selectedToolValue(): number | null {
    switch (this.selectedTool) {
      case "empty":
        return EMPTY;
      case "blocked":
        return BLOCKED;
      case "color":
        return colorCell(this.selectedColorIndex);
      default:
        return null;
    }
  }
}
