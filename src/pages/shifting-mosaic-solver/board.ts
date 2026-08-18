import type {
  BlockType,
  Position,
  ShiftingMosaicTest,
  ShiftingMosaicTool,
} from "../../util/types";
import { Block } from "./block";
import {
  extractCellPosition,
  isContiguous,
  positionsEqual,
} from "./boardGeometry";
import { markBlockEdges, markZoneEdges } from "../../util/gridOutline";
import { gridMaxWidthPx } from "./layout";
import type { ShiftingMosaicSolverEditor } from "./shiftingMosaicSolver";

export class Board {
  private gridWidth: number;
  private gridHeight: number;
  private nextBlockId = 1;
  private hoveredBlockId = 0;
  private isPainting = false;
  private readonly inProgressCells = new Set<string>();
  private attemptedOverlap = false;
  private isPlacingGoalZone = false;
  private placementCursor: Position | null = null;
  private goalZoneCells: Position[] = [];
  private selectedTool: ShiftingMosaicTool;
  private readonly editor: ShiftingMosaicSolverEditor;
  private blockAssignments: number[][] = [];
  private readonly blocks: Map<number, Block> = new Map();
  private readonly grid = document.getElementById("grid") as HTMLDivElement;

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

  /**
   * Resizes the board in place. Reuses this instance — and therefore its
   * already-registered event listeners — so resizing never leaks stale
   * listeners onto #grid / document.
   */
  reconfigure(gridWidth: number, gridHeight: number) {
    this.gridWidth = gridWidth;
    this.gridHeight = gridHeight;
    this.resetBoardData();
  }

  /**
   * Replaces the entire board with a saved configuration (the download
   * format): grid size, every block, and the goal zone.
   */
  loadConfig(config: ShiftingMosaicTest) {
    this.gridWidth = config.gridWidth;
    this.gridHeight = config.gridHeight;
    this.resetBoardData();

    for (let i = 0; i < config.shapes.length; i++) {
      const id = i + 1;
      const anchor = config.initialAnchors[i]!;
      const cells: Position[] = config.shapes[i]!.map(offset => ({
        x: anchor.x + offset.x,
        y: anchor.y + offset.y,
      }));
      const type: BlockType =
        i === config.goalIndex ? "goal" : "obstruction";
      this.blocks.set(id, new Block(id, type, cells));
      for (const cell of cells) {
        const col = this.blockAssignments[cell.x];
        if (col) col[cell.y] = id;
      }
    }
    this.nextBlockId = config.shapes.length + 1;

    this.goalZoneCells = config.shapes[config.goalIndex]!.map(offset => ({
      x: config.goalAnchor.x + offset.x,
      y: config.goalAnchor.y + offset.y,
    }));
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
    this.grid.style.maxWidth = `${gridMaxWidthPx(this.gridWidth)}px`;
    this.grid.innerHTML = "";

    const hologramCells = this.computeHologramCells();
    const hologramClass = this.isHologramValid(hologramCells)
      ? "hologram"
      : "hologram-invalid";
    const hologramSet = new Set(hologramCells.map(c => `${c.x},${c.y}`));
    const goalZoneSet = new Set(this.goalZoneCells.map(c => `${c.x},${c.y}`));

    for (let y = 0; y < this.gridHeight; y++) {
      for (let x = 0; x < this.gridWidth; x++) {
        this.grid.appendChild(
          this.buildCell(x, y, hologramSet, hologramClass, goalZoneSet),
        );
      }
    }
  }

  /**
   * One editor square: which block owns it, the three outlines it may carry and
   * its label. Split out of `renderGrid` so that function is just the sweep —
   * the per-cell branches are what made it the most complex thing in the repo.
   *
   * The two edge markers come from `gridOutline.ts`, the same helpers the
   * solution view uses: `blockAssignments` is already the `occupant[x][y]` grid
   * `markBlockEdges` expects, and `hasBlockAt` was its `sameBlock` spelled out.
   */
  private buildCell(
    x: number,
    y: number,
    hologramSet: Set<string>,
    hologramClass: string,
    goalZoneSet: Set<string>,
  ): HTMLButtonElement {
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
      markBlockEdges(cell, x, y, blockId, this.blockAssignments);
      if (this.hoveredBlockId === blockId) {
        cell.classList.add("block-hovered");
      }
    }

    if (this.inProgressCells.has(`${x},${y}`)) {
      cell.classList.add(
        this.selectedTool === "goal" ? "in-progress-goal" : "in-progress",
      );
    }

    markZoneEdges(cell, x, y, goalZoneSet, "goal-zone");

    if (hologramSet.has(`${x},${y}`)) {
      cell.classList.add(hologramClass);
    }

    const label = this.describeCell(x, y, blockId);
    cell.setAttribute("aria-label", label);
    cell.dataset.label = label;

    return cell;
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
      const position = extractCellPosition(event.target);
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
      // Hit-test by coordinate first, NOT event.target. Touch pointers get
      // implicit pointer capture on the pointerdown target, so event.target
      // stays pinned to the first cell for the whole gesture and drag-drawing a
      // multi-cell block was impossible on a touchscreen (#grid sets
      // touch-action: none precisely so these handlers get the gesture).
      // render() also rebuilds the grid DOM between moves, invalidating the
      // captured node. Falls back to event.target where there is no layout to
      // hit-test against (happy-dom in the unit tests returns null here).
      const hit =
        document.elementFromPoint?.(event.clientX, event.clientY) ?? null;
      const position = extractCellPosition(hit ?? event.target);

      if (this.isPlacingGoalZone) {
        if (!position) return;
        if (positionsEqual(position, this.placementCursor)) return;
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

    // pointercancel as well as pointerup: a stroke does not always end in a
    // pointerup — a touch that turns into a system gesture arrives as
    // pointercancel instead, and the in-progress cells would be stranded with
    // `isPainting` still set. Logic-grid ends its stroke on both for the same
    // reason. A canceled stroke commits what it already drew, exactly as a
    // released one does: those cells are drawn either way.
    const endStroke = () => {
      if (!this.isPainting) return;
      this.isPainting = false;
      this.commitInProgressBlock();
      this.inProgressCells.clear();
      this.attemptedOverlap = false;
      this.editor.hideSolution();
      this.editor.render();
    };
    document.addEventListener("pointerup", endStroke);
    document.addEventListener("pointercancel", endStroke);
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

    const cells: Position[] = Array.from(this.inProgressCells).map(key => {
      const [x, y] = key.split(",").map(Number) as [number, number];
      return { x, y };
    });

    // Short-circuits, so `isContiguous` is never handed an empty stroke.
    if (cells.length === 0 || !isContiguous(cells)) {
      this.warnRejectedStroke(cells.length > 0);
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

  /**
   * Why a stroke was thrown away. An overlap outranks discontiguity: a stroke
   * that ran into an existing block is USUALLY discontiguous because of it, so
   * naming the overlap is the more useful of the two messages. An empty stroke
   * that never hit anything is silent — the user drew nothing.
   */
  private warnRejectedStroke(hadCells: boolean) {
    if (this.attemptedOverlap) {
      this.editor.showWarning(
        "Cannot create a block that overlaps with an existing block.",
      );
    } else if (hadCells) {
      this.editor.showWarning(
        "Block must be a single connected area — try drawing more slowly.",
      );
    }
  }

  private beginGoalZonePlacement() {
    this.isPlacingGoalZone = true;
    this.placementCursor = null;
    this.editor.notifyGoalZonePlacementChanged();
  }

  startGoalZonePlacement(blockId: number) {
    const block = this.blocks.get(blockId);
    if (block?.type !== "goal") return;
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
}
