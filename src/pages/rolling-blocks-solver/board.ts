import type { PaintTool, Position, Tile } from "../../util/types";
import { Block } from "./block";
import type { RollingBlocksSolverEditor } from "./rollingBlocksSolver";

export class Board {
  private gridWidth: number;
  private gridHeight: number;
  private nextBlockId = 1;
  private hoveredBlockId = 0;
  private isPainting = false;
  private dragStart: Position | null = null;
  private dragCurrent: Position | null = null;
  private selectedTool: PaintTool;
  private solver: RollingBlocksSolverEditor;
  private cells: Tile[][] = [];
  private blockAssignments: number[][] = [];
  private blocks: Map<number, Block> = new Map();
  private grid = document.getElementById("grid") as HTMLDivElement;

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
    this.grid.style.gridTemplateColumns = `repeat(${this.gridWidth}, minmax(0, 1fr))`;
    this.grid.innerHTML = "";

    for (let y = 0; y < this.gridHeight; y++) {
      for (let x = 0; x < this.gridWidth; x++) {
        const cell = document.createElement("button");
        cell.type = "button";
        cell.className = "grid-cell";
        cell.dataset.x = String(x);
        cell.dataset.y = String(y);

        const blockId = this.blockAssignments[x]?.[y] ?? 0;
        if (blockId !== 0) {
          cell.dataset.kind = "block";
          cell.dataset.blockId = String(blockId);

          if (!this.hasBlockAt(x, y - 1, blockId)) {
            cell.classList.add("block-edge-top");
          }

          if (!this.hasBlockAt(x + 1, y, blockId)) {
            cell.classList.add("block-edge-right");
          }

          if (!this.hasBlockAt(x, y + 1, blockId)) {
            cell.classList.add("block-edge-bottom");
          }

          if (!this.hasBlockAt(x - 1, y, blockId)) {
            cell.classList.add("block-edge-left");
          }

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

        this.grid.appendChild(cell);
      }
    }
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
    this.grid.addEventListener("pointerdown", event => {
      const position = this.extractCellPosition(event.target);
      if (!position) return;
      this.isPainting = true;

      if (this.selectedTool === "block" || this.selectedTool === "goal") {
        this.dragStart = position;
        this.dragCurrent = position;
        this.renderGrid();
        return;
      }

      this.paintCell(position);
      this.solver.render();
    });

    this.grid.addEventListener("pointermove", event => {
      if (!this.isPainting) return;
      const position = this.extractCellPosition(event.target);
      if (!position) return;

      if (this.selectedTool === "block" || this.selectedTool === "goal") {
        this.dragCurrent = position;
        this.renderGrid();
        return;
      }

      this.paintCell(position);
      this.solver.render();
    });

    document.addEventListener("pointerup", () => {
      if (!this.isPainting) return;
      this.isPainting = false;

      if (this.selectedTool === "block" && this.dragStart && this.dragCurrent) {
        this.commitBlockRectangle(this.dragStart, this.dragCurrent);
      }

      if (this.selectedTool === "goal" && this.dragStart && this.dragCurrent) {
        this.commitGoalRectangle(this.dragStart, this.dragCurrent);
      }

      this.dragStart = null;
      this.dragCurrent = null;
      this.solver.render();
    });
  }

  private commitBlockRectangle(start: Position, end: Position) {
    const minX = Math.min(start.x, end.x);
    const maxX = Math.max(start.x, end.x);
    const minY = Math.min(start.y, end.y);
    const maxY = Math.max(start.y, end.y);

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        if (this.blockAssignments[x]?.[y] !== 0) return;
        if (this.cells[x]?.[y] === "unplayable") return;
      }
    }

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

  private hasBlockAt(x: number, y: number, blockId: number) {
    return this.blockAssignments[x]?.[y] === blockId;
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

  private paintCell(position: Position) {
    const col = this.cells[position.x];
    if (!col) return;

    const tool = this.selectedTool;
    if (
      tool === "regular" ||
      tool === "mustTouch" ||
      tool === "goal" ||
      tool === "unplayable"
    ) {
      col[position.y] = tool;
    }
  }
}
