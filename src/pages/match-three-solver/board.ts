import type {
  MatchThreeCell,
  MatchThreeTest,
  MatchThreeTool,
  Position,
} from "../../util/types";
import { BLOCKED, EMPTY, symbolCell } from "./cell";
import { dressCell } from "./cellView";
import type { MatchThreeSolverEditor } from "./matchThreeSolver";

export class Board {
  private readonly gridWidth: number;
  private readonly gridHeight: number;
  private isPainting = false;
  private selectedTool: MatchThreeTool;
  private selectedSymbol: number;
  private readonly solver: MatchThreeSolverEditor;
  private cells: MatchThreeCell[][] = [];
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
    selectedSymbol: number,
  ) {
    this.solver = solver;
    this.gridWidth = gridWidth;
    this.gridHeight = gridHeight;
    this.selectedTool = selectedTool;
    this.selectedSymbol = selectedSymbol;
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

  setSelectedTool(tool: MatchThreeTool) {
    this.selectedTool = tool;
  }

  setSelectedSymbol(index: number) {
    this.selectedSymbol = index;
  }

  /** Clears every cell. */
  resetBoardData() {
    this.cells = Array.from({ length: this.gridWidth }, () =>
      Array.from({ length: this.gridHeight }, () => EMPTY),
    );
  }

  getCells() {
    return this.cells;
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
    dressCell(cell, this.cells[x]?.[y] ?? EMPTY, x, y);
  }

  /**
   * Replaces the board contents with a validated config. The caller must have
   * constructed the board with the config's grid size.
   */
  loadConfig(config: MatchThreeTest) {
    this.resetBoardData();
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
      case "symbol":
        return symbolCell(this.selectedSymbol);
      default:
        return null;
    }
  }
}
