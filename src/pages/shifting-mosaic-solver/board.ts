import type { BlockType, Position, ShiftingMosaicTool } from "../../util/types";
import { Block } from "./block";
import type { ShiftingMosaicSolverEditor } from "./shiftingMosaicSolver";

export class Board {
  private gridWidth: number;
  private gridHeight: number;
  private nextBlockId = 1;
  private hoveredBlockId = 0;
  private isPainting = false;
  private inProgressCells = new Set<string>();
  private attemptedOverlap = false;
  private isPlacingGoalZone = false;
  private placementCursor: Position | null = null;
  private goalZoneCells: Position[] = [];
  private selectedTool: ShiftingMosaicTool;
  private editor: ShiftingMosaicSolverEditor;
  private blockAssignments: number[][] = [];
  private blocks: Map<number, Block> = new Map();
  private grid = document.getElementById("grid") as HTMLDivElement;

  constructor(
    editor: ShiftingMosaicSolverEditor,
    gridWidth: number,
    gridHeight: number,
    selectedTool: ShiftingMosaicTool,
  ) {
    this.editor = editor;
    this.gridWidth = gridWidth;
    this.gridHeight = gridHeight;
    this.selectedTool = selectedTool;
    this.resetBoardData();
    this.addListeners();
  }

  setSelectedTool(tool: ShiftingMosaicTool) {
    this.selectedTool = tool;
  }

  resetBoardData() {
    this.blockAssignments = Array.from({ length: this.gridWidth }, () =>
      Array.from({ length: this.gridHeight }, () => 0),
    );
    this.blocks.clear();
    this.goalZoneCells = [];
    this.nextBlockId = 1;
    this.isPainting = false;
    this.inProgressCells.clear();
    this.attemptedOverlap = false;
    this.isPlacingGoalZone = false;
    this.placementCursor = null;
  }

  hasGoalBlock(): boolean {
    for (const block of this.blocks.values()) {
      if (block.type === "goal") return true;
    }
    return false;
  }

  isInGoalZonePlacementMode(): boolean {
    return this.isPlacingGoalZone;
  }

  setHoveredBlockId(blockId: number) {
    if (this.hoveredBlockId === blockId) return;
    this.hoveredBlockId = blockId;
    this.editor.render();
  }

  getHoveredBlockId() {
    return this.hoveredBlockId;
  }

  getBlocks() {
    return this.blocks;
  }

  getGoalZoneCells() {
    return this.goalZoneCells;
  }

  deleteBlockById(blockId: number) {
    const block = this.blocks.get(blockId);
    if (!block) return;

    if (block.type === "goal") {
      this.goalZoneCells = [];
      this.isPlacingGoalZone = false;
      this.placementCursor = null;
    }

    this.blocks.delete(blockId);

    for (let y = 0; y < this.gridHeight; y++) {
      for (let x = 0; x < this.gridWidth; x++) {
        const col = this.blockAssignments[x];
        if (col?.[y] === blockId) col[y] = 0;
      }
    }
  }

  renumberBlocks(deletedId: number) {
    if (deletedId === this.nextBlockId - 1) {
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

  renderGrid() {
    this.grid.style.gridTemplateColumns = `repeat(${this.gridWidth}, minmax(0, 1fr))`;
    this.grid.innerHTML = "";

    const hologramCells = this.computeHologramCells();
    const hologramValid = this.isHologramValid(hologramCells);
    const hologramSet = new Set(hologramCells.map(c => `${c.x},${c.y}`));
    const goalZoneSet = new Set(this.goalZoneCells.map(c => `${c.x},${c.y}`));

    for (let y = 0; y < this.gridHeight; y++) {
      for (let x = 0; x < this.gridWidth; x++) {
        const cell = document.createElement("button");
        cell.type = "button";
        cell.className = "grid-cell";
        cell.dataset.x = String(x);
        cell.dataset.y = String(y);

        const blockId = this.blockAssignments[x]?.[y] ?? 0;
        if (blockId !== 0) {
          const block = this.blocks.get(blockId);
          cell.dataset.blockId = String(blockId);
          cell.dataset.blockType = block?.type ?? "obstruction";

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
        }

        if (this.inProgressCells.has(`${x},${y}`)) {
          cell.classList.add(
            this.selectedTool === "goal" ? "in-progress-goal" : "in-progress",
          );
        }

        if (goalZoneSet.has(`${x},${y}`)) {
          cell.classList.add("goal-zone");
          if (!goalZoneSet.has(`${x},${y - 1}`)) {
            cell.classList.add("goal-zone-edge-top");
          }
          if (!goalZoneSet.has(`${x + 1},${y}`)) {
            cell.classList.add("goal-zone-edge-right");
          }
          if (!goalZoneSet.has(`${x},${y + 1}`)) {
            cell.classList.add("goal-zone-edge-bottom");
          }
          if (!goalZoneSet.has(`${x - 1},${y}`)) {
            cell.classList.add("goal-zone-edge-left");
          }
        }

        if (hologramSet.has(`${x},${y}`)) {
          cell.classList.add(hologramValid ? "hologram" : "hologram-invalid");
        }

        const label = this.describeCell(x, y, blockId);
        cell.setAttribute("aria-label", label);
        cell.dataset.label = label;

        this.grid.appendChild(cell);
      }
    }
  }

  private describeCell(x: number, y: number, blockId: number): string {
    const position = `Column ${x + 1}, Row ${y + 1}`;
    if (blockId !== 0) {
      const block = this.blocks.get(blockId);
      const typeLabel = block?.type === "goal" ? "Goal block" : "Obstruction";
      return `${position}, ${typeLabel} ${blockId}`;
    }
    return `${position}, Empty`;
  }

  private addListeners() {
    this.grid.addEventListener("pointerdown", event => {
      const position = this.extractCellPosition(event.target);
      if (!position) return;

      if (this.isPlacingGoalZone) {
        this.tryPlaceGoalZone(position);
        return;
      }

      if (this.selectedTool === "goal" && this.hasGoalBlock()) return;

      this.isPainting = true;
      this.inProgressCells.clear();
      this.attemptedOverlap = false;
      this.tryAddInProgressCell(position);
      this.editor.hideSolution();
      this.editor.render();
    });

    this.grid.addEventListener("pointermove", event => {
      const position = this.extractCellPosition(event.target);

      if (this.isPlacingGoalZone) {
        if (!position) return;
        if (this.positionsEqual(position, this.placementCursor)) return;
        this.placementCursor = position;
        this.editor.render();
        return;
      }

      if (!this.isPainting || !position) return;
      const key = `${position.x},${position.y}`;
      if (this.inProgressCells.has(key)) return;
      this.tryAddInProgressCell(position);
      this.editor.render();
    });

    this.grid.addEventListener("pointerleave", () => {
      if (!this.isPlacingGoalZone) return;
      this.placementCursor = null;
      this.editor.render();
    });

    document.addEventListener("pointerup", () => {
      if (!this.isPainting) return;
      this.isPainting = false;
      this.commitInProgressBlock();
      this.inProgressCells.clear();
      this.attemptedOverlap = false;
      this.editor.hideSolution();
      this.editor.render();
    });
  }

  private tryAddInProgressCell(position: Position) {
    if (
      position.x < 0 ||
      position.x >= this.gridWidth ||
      position.y < 0 ||
      position.y >= this.gridHeight
    ) {
      return;
    }
    if (this.blockAssignments[position.x]?.[position.y] !== 0) {
      this.attemptedOverlap = true;
      return;
    }
    this.inProgressCells.add(`${position.x},${position.y}`);
  }

  private commitInProgressBlock() {
    if (this.selectedTool !== "obstruction" && this.selectedTool !== "goal") {
      return;
    }
    if (this.selectedTool === "goal" && this.hasGoalBlock()) return;

    if (this.inProgressCells.size === 0) {
      if (this.attemptedOverlap) {
        this.editor.showWarning(
          "Cannot create a block that overlaps with an existing block.",
        );
      }
      return;
    }

    const cells: Position[] = Array.from(this.inProgressCells).map(key => {
      const [x, y] = key.split(",").map(Number) as [number, number];
      return { x, y };
    });

    if (!this.isContiguous(cells)) {
      if (this.attemptedOverlap) {
        this.editor.showWarning(
          "Cannot create a block that overlaps with an existing block.",
        );
      } else {
        this.editor.showWarning(
          "Block must be a single connected area — try drawing more slowly.",
        );
      }
      return;
    }

    const blockId = this.nextBlockId++;
    const type: BlockType =
      this.selectedTool === "goal" ? "goal" : "obstruction";
    const block = new Block(blockId, type, cells);

    for (const cell of cells) {
      const col = this.blockAssignments[cell.x];
      if (!col) continue;
      col[cell.y] = blockId;
    }

    this.blocks.set(blockId, block);

    if (type === "goal") {
      this.beginGoalZonePlacement();
    }
  }

  private beginGoalZonePlacement() {
    this.isPlacingGoalZone = true;
    this.placementCursor = null;
    this.editor.notifyGoalZonePlacementChanged();
  }

  startGoalZonePlacement(blockId: number) {
    const block = this.blocks.get(blockId);
    if (!block || block.type !== "goal") return;
    this.goalZoneCells = [];
    this.beginGoalZonePlacement();
    this.editor.render();
  }

  private tryPlaceGoalZone(position: Position) {
    const cells = this.computeHologramCellsAt(position);
    if (!this.isHologramValid(cells)) return;
    this.goalZoneCells = cells;
    this.isPlacingGoalZone = false;
    this.placementCursor = null;
    this.editor.notifyGoalZonePlacementChanged();
    this.editor.hideSolution();
    this.editor.render();
  }

  private computeHologramCells(): Position[] {
    if (!this.isPlacingGoalZone || !this.placementCursor) return [];
    return this.computeHologramCellsAt(this.placementCursor);
  }

  private computeHologramCellsAt(cursor: Position): Position[] {
    const goalBlock = this.findGoalBlock();
    if (!goalBlock) return [];
    const shape = goalBlock.getRelativePositions();
    return shape.map(offset => ({
      x: cursor.x + offset.x,
      y: cursor.y + offset.y,
    }));
  }

  private isHologramValid(cells: Position[]): boolean {
    if (cells.length === 0) return false;
    for (const cell of cells) {
      if (
        cell.x < 0 ||
        cell.x >= this.gridWidth ||
        cell.y < 0 ||
        cell.y >= this.gridHeight
      ) {
        return false;
      }
    }
    return true;
  }

  private findGoalBlock(): Block | null {
    for (const block of this.blocks.values()) {
      if (block.type === "goal") return block;
    }
    return null;
  }

  private hasBlockAt(x: number, y: number, blockId: number) {
    return this.blockAssignments[x]?.[y] === blockId;
  }

  private isContiguous(cells: Position[]): boolean {
    if (cells.length <= 1) return true;
    const cellSet = new Set(cells.map(c => `${c.x},${c.y}`));
    const visited = new Set<string>();
    const start = cells[0]!;
    const queue: Position[] = [start];
    visited.add(`${start.x},${start.y}`);

    while (queue.length > 0) {
      const current = queue.shift()!;
      const neighbors: Position[] = [
        { x: current.x, y: current.y - 1 },
        { x: current.x + 1, y: current.y },
        { x: current.x, y: current.y + 1 },
        { x: current.x - 1, y: current.y },
      ];
      for (const neighbor of neighbors) {
        const key = `${neighbor.x},${neighbor.y}`;
        if (cellSet.has(key) && !visited.has(key)) {
          visited.add(key);
          queue.push(neighbor);
        }
      }
    }

    return visited.size === cellSet.size;
  }

  private positionsEqual(a: Position | null, b: Position | null): boolean {
    if (a === null && b === null) return true;
    if (a === null || b === null) return false;
    return a.x === b.x && a.y === b.y;
  }

  private extractCellPosition(target: EventTarget | null): Position | null {
    if (!(target instanceof HTMLElement)) return null;

    const cell = target.closest(".grid-cell") as HTMLElement;
    if (!cell) return null;

    const x = Number(cell.dataset.x);
    const y = Number(cell.dataset.y);

    if (!Number.isInteger(x) || !Number.isInteger(y)) return null;

    return { x, y };
  }
}
