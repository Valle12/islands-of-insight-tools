import type { PaintTool } from "./../../util/types";
import { Board } from "./board";

export class RollingBlocksSolverEditor {
  private static readonly DEFAULT_GRID_WIDTH = 5;
  private static readonly DEFAULT_GRID_HEIGHT = 5;

  private blocksListEl = document.getElementById(
    "blocks-list",
  ) as HTMLDivElement;
  private widthField = document.getElementById(
    "grid-width",
  ) as HTMLInputElement;
  private heightField = document.getElementById(
    "grid-height",
  ) as HTMLInputElement;
  private statusEl = document.getElementById("tool-status") as HTMLDivElement;

  private gridWidth = RollingBlocksSolverEditor.DEFAULT_GRID_WIDTH;
  private gridHeight = RollingBlocksSolverEditor.DEFAULT_GRID_HEIGHT;
  private selectedTool: PaintTool = "regular";
  private board: Board;

  constructor() {
    this.board = new Board(
      this,
      this.gridWidth,
      this.gridHeight,
      this.selectedTool,
    );
    this.addListeners();
    this.render();
  }

  private addListeners() {
    const toolButtons =
      document.querySelectorAll<HTMLButtonElement>(".tool-button");
    toolButtons.forEach(button => {
      button.addEventListener("click", () => {
        const tool = button.dataset.tool as PaintTool;

        if (tool === "fillRegular") {
          this.board.fillAllCells("regular");
          this.render();
          return;
        }

        if (tool === "fillMustTouch") {
          this.board.fillAllCells("mustTouch");
          this.render();
          return;
        }

        if (tool === "reset") {
          (document.getElementById("reset-dialog") as HTMLDialogElement).show();
          return;
        }

        this.selectedTool = tool;
        this.board.setSelectedTool(tool);
        this.renderToolButtons();
        this.render();
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

    this.widthField.addEventListener("input", () => this.handleSizeUpdate());
    this.heightField.addEventListener("input", () => this.handleSizeUpdate());

    this.blocksListEl.addEventListener("input", event => {
      const target = event.target as HTMLElement;
      const textField = target.closest("md-outlined-text-field");
      if (!textField) return;
      const id = Number(textField.dataset.blockId);
      const blocks = this.board.getBlocks();
      const block = blocks.get(id);
      if (!block) return;
      const parsed = this.parsePositiveInt(textField.value);
      if (!parsed) return;
      block.height = parsed;
    });

    this.blocksListEl.addEventListener("click", event => {
      const target = event.target as HTMLElement;
      const button = target.closest("md-icon-button");
      if (!button) return;
      const id = Number(button.dataset.blockDeleteId);
      this.board.deleteBlockById(id);
      this.board.renumberBlocks(id);
      this.render();
    });

    this.blocksListEl.addEventListener("mouseover", event => {
      const target = event.target as HTMLElement;
      const row = target.closest(".block-row") as HTMLElement;
      if (!row) return;
      const id = Number(row.dataset.blockId);
      this.board.setHoveredBlockId(id);
    });

    this.blocksListEl.addEventListener("mouseleave", () => {
      this.board.setHoveredBlockId(0);
    });
  }

  private handleSizeUpdate() {
    const parsedWidth = this.parsePositiveInt(this.widthField.value);
    const parsedHeight = this.parsePositiveInt(this.heightField.value);
    if (!parsedWidth || !parsedHeight) return;
    this.gridWidth = parsedWidth;
    this.gridHeight = parsedHeight;
    this.board = new Board(
      this,
      this.gridWidth,
      this.gridHeight,
      this.selectedTool,
    );
    this.render();
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
    this.selectedTool = "regular";
    this.board = new Board(
      this,
      this.gridWidth,
      this.gridHeight,
      this.selectedTool,
    );
  }

  render() {
    this.board.renderGrid();
    this.renderToolButtons();
    this.renderBlocksList();
  }

  private renderToolButtons() {
    const toolButtons =
      document.querySelectorAll<HTMLButtonElement>(".tool-button");
    toolButtons.forEach(button => {
      const tool = button.dataset.tool;
      button.classList.toggle("selected", tool === this.selectedTool);
    });

    let label = "";
    switch (this.selectedTool) {
      case "mustTouch":
        label = "Must-Touch";
        break;
      case "unplayable":
        label = "Unplayable";
        break;
      case "block":
        label = "Block Footprint";
        break;
      case "goal":
        label = "Goal";
        break;
      default:
        label = "Regular";
    }

    this.statusEl.textContent = `Selected tool: ${label}`;
  }

  private renderBlocksList() {
    const blocks = this.board.getBlocks();
    if (blocks.size === 0) {
      this.blocksListEl.innerHTML =
        '<p class="empty-state">No blocks defined yet. Use Block Footprint and drag on the grid.</p>';
      return;
    }

    this.blocksListEl.innerHTML = Array.from(blocks.values())
      .sort((a, b) => a.id - b.id)
      .map(
        block => `
          <div class="block-row${this.board.getHoveredBlockId() === block.id ? " row-hovered" : ""}" data-block-id="${block.id}">
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
}

new RollingBlocksSolverEditor();
