type PaintTool =
  | "regular"
  | "mustTouch"
  | "goal"
  | "unplayable"
  | "block"
  | "fillRegular"
  | "fillMustTouch"
  | "reset";

type CellKind = "regular" | "must-touch" | "goal" | "unplayable";

type CellPosition = {
  x: number;
  y: number;
};

type BlockDefinition = {
  id: number;
  x: number;
  y: number;
  width: number;
  depth: number;
  height: number;
};

class RollingBlocksSolverEditor {
  private static readonly DEFAULT_GRID_WIDTH = 5;
  private static readonly DEFAULT_GRID_HEIGHT = 5;

  private readonly gridEl = document.getElementById("grid") as HTMLDivElement;
  private readonly blocksListEl = document.getElementById(
    "blocks-list",
  ) as HTMLDivElement;
  private readonly widthField = document.getElementById(
    "grid-width",
  ) as HTMLInputElement;
  private readonly heightField = document.getElementById(
    "grid-height",
  ) as HTMLInputElement;
  private readonly statusEl = document.getElementById(
    "tool-status",
  ) as HTMLDivElement;

  private gridWidth = RollingBlocksSolverEditor.DEFAULT_GRID_WIDTH;
  private gridHeight = RollingBlocksSolverEditor.DEFAULT_GRID_HEIGHT;
  private selectedTool: PaintTool = "regular";

  private cells: CellKind[][] = [];
  private blockMap: (number | null)[][] = [];
  private blocks: BlockDefinition[] = [];
  private nextBlockId = 1;
  private hoveredBlockId: number | null = null;

  private isPainting = false;
  private dragStart: CellPosition | null = null;
  private dragCurrent: CellPosition | null = null;

  constructor() {
    this.applyDefaultGridSize();
    this.resetBoardData();
    this.bindEvents();
    this.render();
  }

  private bindEvents() {
    const toolButtons =
      document.querySelectorAll<HTMLButtonElement>(".tool-button");
    toolButtons.forEach(button => {
      button.addEventListener("click", () => {
        const tool = button.dataset.tool as PaintTool | undefined;
        if (!tool) return;

        if (tool === "fillRegular") {
          this.fillAllCells("regular");
          this.render();
          return;
        }

        if (tool === "fillMustTouch") {
          this.fillAllCells("must-touch");
          this.render();
          return;
        }

        if (tool === "reset") {
          (document.getElementById("reset-dialog") as HTMLDialogElement).show();
          return;
        }

        this.selectedTool = tool;
        this.renderToolButtons();
      });
    });

    const resetCancelBtn = document.getElementById("reset-cancel");
    const resetConfirmBtn = document.getElementById("reset-confirm");
    const resetDialog = document.getElementById(
      "reset-dialog",
    ) as HTMLDialogElement;

    resetCancelBtn?.addEventListener("click", () => {
      resetDialog.close();
    });

    resetConfirmBtn?.addEventListener("click", () => {
      this.resetToDefaults();
      this.render();
      resetDialog.close();
    });

    const calculateMovesBtn = document.getElementById("calculate-moves");
    calculateMovesBtn?.addEventListener("click", () => {
      console.log("Calculate Moves clicked - functionality to be implemented");
    });

    const handleSizeUpdate = () => {
      const parsedWidth = this.parsePositiveInt(this.widthField.value);
      const parsedHeight = this.parsePositiveInt(this.heightField.value);
      if (!parsedWidth || !parsedHeight) return;
      this.gridWidth = parsedWidth;
      this.gridHeight = parsedHeight;
      this.resetBoardData();
      this.render();
    };

    this.widthField.addEventListener("input", handleSizeUpdate);
    this.heightField.addEventListener("input", handleSizeUpdate);

    this.gridEl.addEventListener("pointerdown", event => {
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
      this.render();
    });

    this.gridEl.addEventListener("pointermove", event => {
      if (!this.isPainting) return;
      const position = this.extractCellPosition(event.target);
      if (!position) return;

      if (this.selectedTool === "block" || this.selectedTool === "goal") {
        this.dragCurrent = position;
        this.renderGrid();
        return;
      }

      this.paintCell(position);
      this.renderGrid();
      this.renderBlocksList();
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
      this.render();
    });

    this.blocksListEl.addEventListener("input", event => {
      const target = event.target as HTMLElement;
      const textField = target.closest("md-outlined-text-field") as
        | (HTMLElement & { value: string; dataset: DOMStringMap })
        | null;
      if (!textField) return;

      const id = Number(textField.dataset.blockId);
      if (!Number.isFinite(id)) return;

      const block = this.blocks.find(candidate => candidate.id === id);
      if (!block) return;

      const parsed = this.parsePositiveInt(textField.value);
      if (!parsed) return;

      block.height = parsed;
    });

    this.blocksListEl.addEventListener("click", event => {
      const target = event.target as HTMLElement;
      const button = target.closest("md-icon-button") as
        | (HTMLElement & { dataset: DOMStringMap })
        | null;
      if (!button) return;

      const id = Number(button.dataset.blockDeleteId);
      if (!Number.isFinite(id)) return;

      this.deleteBlockById(id);
      this.renumberBlocks();
      this.render();
    });

    this.blocksListEl.addEventListener("mouseover", event => {
      const target = event.target as HTMLElement;
      const row = target.closest(".block-row") as HTMLElement | null;
      if (!row) return;

      const id = Number(row.dataset.blockId);
      if (!Number.isFinite(id)) return;
      this.setHoveredBlockId(id);
    });

    this.blocksListEl.addEventListener("mouseleave", () => {
      this.setHoveredBlockId(null);
    });

    this.blocksListEl.addEventListener("focusin", event => {
      const target = event.target as HTMLElement;
      const row = target.closest(".block-row") as HTMLElement | null;
      if (!row) return;

      const id = Number(row.dataset.blockId);
      if (!Number.isFinite(id)) return;
      this.setHoveredBlockId(id);
    });

    this.blocksListEl.addEventListener("focusout", event => {
      const nextTarget = event.relatedTarget as HTMLElement | null;
      if (nextTarget && this.blocksListEl.contains(nextTarget)) {
        return;
      }
      this.setHoveredBlockId(null);
    });
  }

  private setHoveredBlockId(id: number | null) {
    if (this.hoveredBlockId === id) {
      return;
    }
    this.hoveredBlockId = id;
    this.renderGrid();
    this.renderBlocksList();
  }

  private parsePositiveInt(value: string): number | null {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return null;
    }
    return parsed;
  }

  private applyDefaultGridSize() {
    this.gridWidth = RollingBlocksSolverEditor.DEFAULT_GRID_WIDTH;
    this.gridHeight = RollingBlocksSolverEditor.DEFAULT_GRID_HEIGHT;
    this.widthField.value = String(this.gridWidth);
    this.heightField.value = String(this.gridHeight);
  }

  private resetToDefaults() {
    this.applyDefaultGridSize();
    this.resetBoardData();
  }

  private resetBoardData() {
    this.cells = Array.from({ length: this.gridHeight }, () =>
      Array.from({ length: this.gridWidth }, () => "regular" as const),
    );

    this.blockMap = Array.from({ length: this.gridHeight }, () =>
      Array.from({ length: this.gridWidth }, () => null),
    );

    this.blocks = [];
    this.nextBlockId = 1;
  }

  private render() {
    if (
      this.hoveredBlockId !== null &&
      !this.blocks.some(block => block.id === this.hoveredBlockId)
    ) {
      this.hoveredBlockId = null;
    }

    this.renderGrid();
    this.renderToolButtons();
    this.renderBlocksList();
  }

  private hasBlockAt(x: number, y: number, blockId: number): boolean {
    if (x < 0 || y < 0 || x >= this.gridWidth || y >= this.gridHeight) {
      return false;
    }

    return this.blockMap[y]?.[x] === blockId;
  }

  private renderGrid() {
    this.gridEl.style.gridTemplateColumns = `repeat(${this.gridWidth}, minmax(0, 1fr))`;
    this.gridEl.innerHTML = "";

    for (let y = 0; y < this.gridHeight; y++) {
      for (let x = 0; x < this.gridWidth; x++) {
        const cell = document.createElement("button");
        cell.type = "button";
        cell.className = "grid-cell";
        cell.dataset.x = String(x);
        cell.dataset.y = String(y);

        const blockId = this.blockMap[y]?.[x] ?? null;
        if (blockId !== null) {
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
          cell.dataset.kind = this.cells[y]?.[x] ?? "regular";
        }

        if (this.shouldPreviewCell(x, y)) {
          cell.classList.add(
            this.selectedTool === "goal" ? "goal-preview" : "preview",
          );
        }

        const label = this.describeCell(x, y, blockId);
        cell.setAttribute("aria-label", label);
        cell.title = label;

        this.gridEl.appendChild(cell);
      }
    }
  }

  private describeCell(x: number, y: number, blockId: number | null): string {
    const position = `Column ${x + 1}, Row ${y + 1}`;
    if (blockId !== null) {
      return `${position}, Block ${blockId}`;
    }

    const kind = this.cells[y]?.[x] ?? "regular";
    const kindLabel =
      kind === "must-touch"
        ? "Must-touch"
        : kind === "goal"
          ? "Goal"
          : kind === "unplayable"
            ? "Unplayable"
            : "Regular";
    return `${position}, ${kindLabel}`;
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

  private renderToolButtons() {
    const toolButtons =
      document.querySelectorAll<HTMLButtonElement>(".tool-button");
    toolButtons.forEach(button => {
      const tool = button.dataset.tool;
      button.classList.toggle("selected", tool === this.selectedTool);
    });

    const label =
      this.selectedTool === "mustTouch"
        ? "Must-Touch"
        : this.selectedTool === "unplayable"
          ? "Unplayable"
          : this.selectedTool === "block"
            ? "Block Footprint"
            : this.selectedTool === "goal"
              ? "Goal"
              : "Regular";

    this.statusEl.textContent = `Selected tool: ${label}`;
  }

  private renderBlocksList() {
    if (this.blocks.length === 0) {
      this.blocksListEl.innerHTML =
        '<p class="empty-state">No blocks defined yet. Use Block Footprint and drag on the grid.</p>';
      return;
    }

    this.blocksListEl.innerHTML = this.blocks
      .map(
        block => `
          <div class="block-row${this.hoveredBlockId === block.id ? " row-hovered" : ""}" data-block-id="${block.id}">
            <span class="block-chip">Block ${block.id}</span>
            <span class="block-footprint">Footprint ${block.width}x${block.depth}</span>
            <md-outlined-text-field
              label="Height"
              type="number"
              value="${block.height}"
              data-block-id="${block.id}"
            ></md-outlined-text-field>
            <md-icon-button data-block-delete-id="${block.id}" title="Delete block">
              <md-icon>delete</md-icon>
            </md-icon-button>
          </div>
        `,
      )
      .join("");
  }

  private extractCellPosition(target: EventTarget | null): CellPosition | null {
    if (!(target instanceof HTMLElement)) {
      return null;
    }

    const cell = target.closest(".grid-cell") as HTMLElement | null;
    if (!cell) {
      return null;
    }

    const x = Number(cell.dataset.x);
    const y = Number(cell.dataset.y);

    if (!Number.isInteger(x) || !Number.isInteger(y)) {
      return null;
    }

    return { x, y };
  }

  private paintCell(position: CellPosition) {
    const row = this.cells[position.y];
    if (!row) return;

    switch (this.selectedTool) {
      case "regular":
        row[position.x] = "regular";
        return;
      case "mustTouch":
        row[position.x] = "must-touch";
        return;
      case "goal":
        row[position.x] = "goal";
        return;
      case "unplayable":
        row[position.x] = "unplayable";
        return;
      case "block":
        return;
      default:
        return;
    }
  }

  private commitBlockRectangle(start: CellPosition, end: CellPosition) {
    const minX = Math.min(start.x, end.x);
    const maxX = Math.max(start.x, end.x);
    const minY = Math.min(start.y, end.y);
    const maxY = Math.max(start.y, end.y);

    // Check if any cell already has a block or is unplayable
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        if (this.blockMap[y]?.[x] !== null) {
          return;
        }
        if (this.cells[y]?.[x] === "unplayable") {
          return;
        }
      }
    }

    const id = this.nextBlockId++;

    const newBlock: BlockDefinition = {
      id,
      x: minX,
      y: minY,
      width: maxX - minX + 1,
      depth: maxY - minY + 1,
      height: 1,
    };

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const blockRow = this.blockMap[y];
        if (!blockRow) continue;
        blockRow[x] = id;
      }
    }

    this.blocks.push(newBlock);
  }

  private commitGoalRectangle(start: CellPosition, end: CellPosition) {
    const minX = Math.min(start.x, end.x);
    const maxX = Math.max(start.x, end.x);
    const minY = Math.min(start.y, end.y);
    const maxY = Math.max(start.y, end.y);

    // Paint all cells in the rectangle as goal cells
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const cellRow = this.cells[y];
        if (!cellRow) continue;
        cellRow[x] = "goal";
      }
    }
  }

  private deleteBlockById(id: number) {
    this.blocks = this.blocks.filter(block => block.id !== id);

    for (let y = 0; y < this.gridHeight; y++) {
      for (let x = 0; x < this.gridWidth; x++) {
        const blockRow = this.blockMap[y];
        if (blockRow?.[x] === id) {
          blockRow[x] = null;
        }
      }
    }
  }

  private renumberBlocks() {
    if (this.blocks.length === 0) {
      this.nextBlockId = 1;
      return;
    }

    // Rebuild the blockMap with new sequential IDs
    const newBlockMap: (number | null)[][] = Array.from(
      { length: this.gridHeight },
      () => Array.from({ length: this.gridWidth }, () => null),
    );

    let newId = 1;
    const idMap = new Map<number, number>();

    for (const block of this.blocks) {
      idMap.set(block.id, newId);
      block.id = newId;
      newId++;
    }

    for (let y = 0; y < this.gridHeight; y++) {
      for (let x = 0; x < this.gridWidth; x++) {
        const oldId = this.blockMap[y]?.[x];
        if (oldId !== null && oldId !== undefined) {
          const mappedId = idMap.get(oldId);
          if (mappedId !== undefined) {
            const newBlockRow = newBlockMap[y];
            if (!newBlockRow) continue;
            newBlockRow[x] = mappedId;
          }
        }
      }
    }

    this.blockMap = newBlockMap;
    this.nextBlockId = newId;
  }

  private fillAllCells(kind: CellKind) {
    for (let y = 0; y < this.gridHeight; y++) {
      for (let x = 0; x < this.gridWidth; x++) {
        const cellRow = this.cells[y];
        if (!cellRow) continue;
        cellRow[x] = kind;
      }
    }
  }
}

new RollingBlocksSolverEditor();
