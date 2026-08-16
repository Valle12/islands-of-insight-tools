import type {
  PaintTool,
  Position,
  RollingBlocksTest,
  Tile,
} from "../../util/types";
import { markBlockEdges } from "../../util/gridOutline";
import { Block } from "./block";
import { MAX_BLOCKS } from "./config";
import type { RollingBlocksSolverEditor } from "./rollingBlocksSolver";

export class Board {
  private readonly gridWidth: number;
  private readonly gridHeight: number;
  private nextBlockId = 1;
  private hoveredBlockId = 0;
  private isPainting = false;
  private dragStart: Position | null = null;
  private dragCurrent: Position | null = null;
  private selectedTool: PaintTool;
  private readonly solver: RollingBlocksSolverEditor;
  private cells: Tile[][] = [];
  private blockAssignments: number[][] = [];
  private readonly blocks: Map<number, Block> = new Map();
  /** Aborts every listener this board registered — see `dispose`. */
  private readonly listeners = new AbortController();
  private readonly grid = document.getElementById("grid") as HTMLDivElement;

  constructor(
    solver: RollingBlocksSolverEditor,
    gridWidth: number,
    gridHeight: number,
    selectedTool: PaintTool,
  ) {
    this.solver = solver;
    this.gridWidth = gridWidth;
    this.gridHeight = gridHeight;
    this.selectedTool = selectedTool;
    this.resetBoardData();
    this.addListeners();
  }

  /**
   * Drops this board's listeners. `#grid` and `document` outlive the board they
   * belong to, so a replaced board that kept listening would go on painting
   * into its own dead `cells` and rebuild the grid from its own stale
   * dimensions — once more per replacement, on every pointer event.
   */
  dispose() {
    this.listeners.abort();
  }

  setSelectedTool(tool: PaintTool) {
    this.selectedTool = tool;
  }

  resetBoardData() {
    this.cells = Array.from({ length: this.gridWidth }, () =>
      Array.from({ length: this.gridHeight }, () => "regular"),
    );
    this.blockAssignments = Array.from({ length: this.gridWidth }, () =>
      Array.from({ length: this.gridHeight }, () => 0),
    );
    this.blocks.clear();
    this.nextBlockId = 1;
  }

  renderGrid() {
    // Fixed-size tracks, never minmax(0, 1fr): the squares have a hard width,
    // so a track allowed to shrink below it makes the cells overlap sideways
    // at narrow viewports. Fixed tracks let #grid-shell scroll instead.
    this.grid.style.gridTemplateColumns = `repeat(${this.gridWidth}, var(--rb-cell))`;
    this.grid.innerHTML = "";

    for (let y = 0; y < this.gridHeight; y++) {
      for (let x = 0; x < this.gridWidth; x++) {
        this.grid.appendChild(this.buildCell(x, y));
      }
    }
  }

  /**
   * One editor square: the block that owns it (or the tile underneath), the
   * drag preview and the label. Split out of `renderGrid` so that function is
   * just the sweep — the per-cell branches are all of its complexity.
   *
   * `markBlockEdges` comes from `gridOutline.ts`, the same helper the solution
   * view uses; `blockAssignments` is already the `occupant[x][y]` grid it wants.
   */
  private buildCell(x: number, y: number): HTMLButtonElement {
    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = "grid-cell";
    cell.dataset.x = String(x);
    cell.dataset.y = String(y);

    const blockId = this.blockAssignments[x]?.[y] ?? 0;
    if (blockId !== 0) {
      cell.dataset.kind = "block";
      cell.dataset.blockId = String(blockId);
      markBlockEdges(cell, x, y, blockId, this.blockAssignments);
      if (this.hoveredBlockId === blockId) {
        cell.classList.add("block-hovered");
      }
    } else {
      cell.dataset.kind = this.cells[x]?.[y] ?? "regular";
    }

    if (this.shouldPreviewCell(x, y)) {
      cell.classList.add(
        this.selectedTool === "goal" ? "goal-preview" : "preview",
      );
    }

    const label = this.describeCell(x, y, blockId);
    cell.setAttribute("aria-label", label);
    cell.dataset.label = label;

    return cell;
  }

  setHoveredBlockId(blockdId: number) {
    if (this.hoveredBlockId === blockdId) return;
    this.hoveredBlockId = blockdId;
    this.solver.render();
  }

  getHoveredBlockId() {
    return this.hoveredBlockId;
  }

  getBlocks() {
    return this.blocks;
  }

  deleteBlockById(blockId: number) {
    this.blocks.delete(blockId);

    for (let y = 0; y < this.gridHeight; y++) {
      for (let x = 0; x < this.gridWidth; x++) {
        const col = this.blockAssignments[x];
        if (col?.[y] === blockId) col[y] = 0;
      }
    }
  }

  fillAllCells(kind: Tile) {
    for (let y = 0; y < this.gridHeight; y++) {
      for (let x = 0; x < this.gridWidth; x++) {
        const col = this.cells[x];
        if (!col) continue;
        col[y] = kind;
      }
    }
  }

  private describeCell(x: number, y: number, blockId: number): string {
    const position = `Column ${x + 1}, Row ${y + 1}`;
    if (blockId !== 0) {
      return `${position}, Block ${blockId}`;
    }

    const kind = this.cells[x]?.[y];
    let kindLabel = "";
    switch (kind) {
      case "mustTouch":
        kindLabel = "Must-touch";
        break;
      case "goal":
        kindLabel = "Goal";
        break;
      case "unplayable":
        kindLabel = "Unplayable";
        break;
      default:
        kindLabel = "Regular";
    }

    return `${position}, ${kindLabel}`;
  }

  private addListeners() {
    // Every listener carries the board's abort signal, so `dispose()` takes
    // them all off the shared `#grid` / `document` in one call.
    const { signal } = this.listeners;

    this.grid.addEventListener(
      "pointerdown",
      event => {
        const position = this.extractCellPosition(event.target);
        if (!position) return;
        this.isPainting = true;

        if (this.selectedTool === "block" || this.selectedTool === "goal") {
          this.dragStart = position;
          this.dragCurrent = position;
          this.renderGrid();
          return;
        }

        if (!this.paintCell(position)) return;
        this.solver.hideSolution();
        this.solver.render();
      },
      { signal },
    );

    this.grid.addEventListener(
      "pointermove",
      event => {
        if (!this.isPainting) return;
        const position = this.extractCellPosition(event.target);
        if (!position) return;

        if (this.selectedTool === "block" || this.selectedTool === "goal") {
          this.dragCurrent = position;
          this.renderGrid();
          return;
        }

        // Gated on the cell actually changing: a pointermove fires many times
        // per cell while dragging, and `solver.render()` rebuilds the whole
        // grid AND re-upgrades every Material element in the blocks list.
        if (!this.paintCell(position)) return;
        this.solver.hideSolution();
        this.solver.render();
      },
      { signal },
    );

    // pointercancel as well as pointerup: a stroke does not always end in a
    // pointerup — a touch that turns into a system gesture arrives as
    // pointercancel instead, and `renderGrid()` running from pointermove
    // destroys the node holding the implicit pointer capture, which is exactly
    // what provokes one. Without it `isPainting` and the drag rectangle stay
    // latched and the block being drawn is silently discarded.
    const endStroke = () => {
      if (!this.isPainting) return;
      this.isPainting = false;

      if (this.selectedTool === "block" && this.dragStart && this.dragCurrent) {
        this.commitBlockRectangle(this.dragStart, this.dragCurrent);
        this.solver.hideSolution();
      }

      if (this.selectedTool === "goal" && this.dragStart && this.dragCurrent) {
        this.commitGoalRectangle(this.dragStart, this.dragCurrent);
        this.solver.hideSolution();
      }

      this.dragStart = null;
      this.dragCurrent = null;
      this.solver.render();
    };
    document.addEventListener("pointerup", endStroke, { signal });
    document.addEventListener("pointercancel", endStroke, { signal });
  }

  private rectangleIsFree(
    minX: number,
    maxX: number,
    minY: number,
    maxY: number,
  ): boolean {
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        if (this.blockAssignments[x]?.[y] !== 0) return false;
        if (this.cells[x]?.[y] === "unplayable") return false;
      }
    }
    return true;
  }

  private commitBlockRectangle(start: Position, end: Position) {
    // Block ids are uint8_t in the solver, with 0 reserved for "no block".
    if (this.blocks.size >= MAX_BLOCKS) return;

    const minX = Math.min(start.x, end.x);
    const maxX = Math.max(start.x, end.x);
    const minY = Math.min(start.y, end.y);
    const maxY = Math.max(start.y, end.y);

    if (!this.rectangleIsFree(minX, maxX, minY, maxY)) return;

    const blockId = this.nextBlockId++;
    const block = new Block(
      blockId,
      minX,
      minY,
      maxX - minX + 1,
      maxY - minY + 1,
      1,
    );

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const col = this.blockAssignments[x];
        if (!col) continue;
        col[y] = blockId;
      }
    }

    this.blocks.set(blockId, block);
  }

  renumberBlocks(deletedId: number) {
    if (deletedId === this.blocks.size + 1) {
      this.nextBlockId--;
      return;
    }

    if (this.blocks.size === 0) {
      this.nextBlockId = 1;
      return;
    }

    this.nextBlockId--;
    const block = this.blocks.get(this.nextBlockId);
    if (!block) return;
    block.id = deletedId;
    this.blocks.set(deletedId, block);
    this.blocks.delete(this.nextBlockId);

    for (let y = 0; y < this.gridHeight; y++) {
      for (let x = 0; x < this.gridWidth; x++) {
        if (this.blockAssignments[x]?.[y] === this.nextBlockId) {
          const col = this.blockAssignments[x];
          if (!col) continue;
          col[y] = deletedId;
        }
      }
    }
  }

  getCells() {
    return this.cells;
  }

  /**
   * Replaces the board contents with a validated config. The caller must have
   * constructed the board with the config's grid size; blocks arrive with
   * ids 1..n from the validator, matching the renumbering invariant.
   */
  loadConfig(config: RollingBlocksTest) {
    this.resetBoardData();
    for (let x = 0; x < this.gridWidth; x++) {
      for (let y = 0; y < this.gridHeight; y++) {
        this.cells[x]![y] = config.cells[x]![y]!;
      }
    }
    for (const block of config.blocks) {
      this.blocks.set(
        block.id,
        new Block(
          block.id,
          block.x,
          block.y,
          block.width,
          block.depth,
          block.height,
        ),
      );
      for (let x = block.x; x < block.x + block.width; x++) {
        for (let y = block.y; y < block.y + block.depth; y++) {
          this.blockAssignments[x]![y] = block.id;
        }
      }
    }
    this.nextBlockId = config.blocks.length + 1;
  }

  private commitGoalRectangle(start: Position, end: Position) {
    const minX = Math.min(start.x, end.x);
    const maxX = Math.max(start.x, end.x);
    const minY = Math.min(start.y, end.y);
    const maxY = Math.max(start.y, end.y);

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const col = this.cells[x];
        if (!col) continue;
        col[y] = "goal";
      }
    }
  }

  private shouldPreviewCell(x: number, y: number): boolean {
    if (!this.dragStart || !this.dragCurrent) {
      return false;
    }

    if (this.selectedTool !== "block" && this.selectedTool !== "goal") {
      return false;
    }

    const minX = Math.min(this.dragStart.x, this.dragCurrent.x);
    const maxX = Math.max(this.dragStart.x, this.dragCurrent.x);
    const minY = Math.min(this.dragStart.y, this.dragCurrent.y);
    const maxY = Math.max(this.dragStart.y, this.dragCurrent.y);

    return x >= minX && x <= maxX && y >= minY && y <= maxY;
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

  /** Applies the selected tool to one cell. False when nothing changed. */
  private paintCell(position: Position): boolean {
    const col = this.cells[position.x];
    if (!col) return false;

    const tool = this.selectedTool;
    if (
      tool !== "regular" &&
      tool !== "mustTouch" &&
      tool !== "goal" &&
      tool !== "unplayable"
    ) {
      return false;
    }
    // A block may not stand on an unplayable cell — `rectangleIsFree` already
    // refuses to draw one there, and `config.ts` refuses to LOAD one ("Block N
    // sits on an unplayable cell."). Painting the gap under an existing block
    // is the other order into the same state, and it is invisible: `renderGrid`
    // draws the block over it. Left alone, the editor writes a file it cannot
    // read back, and Solve searches a board whose blocks start on walls.
    if (tool === "unplayable" && this.blockAssignments[position.x]?.[position.y])
      return false;
    if (col[position.y] === tool) return false;
    col[position.y] = tool;
    return true;
  }
}
