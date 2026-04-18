import type { PaintTool } from "./../../util/types";
import { Board } from "./board";

// TODO split this up, maybe at least a grid/cell class with some of the methods
export class RollingBlocksSolverEditor {
  private static readonly DEFAULT_GRID_WIDTH = 5;
  private static readonly DEFAULT_GRID_HEIGHT = 5;

  private blocksListEl: HTMLDivElement;
  private widthField: HTMLInputElement;
  private heightField: HTMLInputElement;
  private statusEl: HTMLDivElement;

  private gridWidth = RollingBlocksSolverEditor.DEFAULT_GRID_WIDTH;
  private gridHeight = RollingBlocksSolverEditor.DEFAULT_GRID_HEIGHT;
  private selectedTool: PaintTool = "regular";
  private board: Board;

  constructor() {
    this.blocksListEl = document.getElementById(
      "blocks-list",
    ) as HTMLDivElement;
    this.widthField = document.getElementById("grid-width") as HTMLInputElement;
    this.heightField = document.getElementById(
      "grid-height",
    ) as HTMLInputElement;
    this.statusEl = document.getElementById("tool-status") as HTMLDivElement;

    this.board = new Board(
      this,
      this.gridWidth,
      this.gridHeight,
      this.selectedTool,
    );
    this.bindEvents();
    this.render();
  }

  private bindEvents() {
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

        // For mustTouch, goal, unplayable, block, set the tool and re-render
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

    // TODO make that an extra method
    const handleSizeUpdate = () => {
      // TODO potentially normal input validation
      const parsedWidth = this.parsePositiveInt(this.widthField.value);
      const parsedHeight = this.parsePositiveInt(this.heightField.value);
      if (!parsedWidth || !parsedHeight) return;
      this.gridWidth = parsedWidth;
      this.gridHeight = parsedHeight;
      // Recreate the board with new size
      this.board = new Board(
        this,
        this.gridWidth,
        this.gridHeight,
        this.selectedTool,
      );
      this.render();
    };

    this.widthField.addEventListener("input", handleSizeUpdate);
    this.heightField.addEventListener("input", handleSizeUpdate);

    // TODO might profit from simplification
    this.blocksListEl.addEventListener("input", event => {
      const target = event.target as HTMLElement;
      const textField = target.closest("md-outlined-text-field") as
        | (HTMLElement & { value: string; dataset: DOMStringMap })
        | null;
      if (!textField) return;

      const id = Number(textField.dataset.blockId);
      if (!Number.isFinite(id)) return;

      const blocks = this.board.getBlocks();
      const block = blocks.get(id);
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

      // TODO delete also needs to happen inside board.ts, so maybe just provide getter for blocks
      this.board.deleteBlockById(id);
      // TODO OLD this.deleteBlockById(id);
      this.board.renumberBlocks();
      this.render();
    });

    this.blocksListEl.addEventListener("mouseover", event => {
      const target = event.target as HTMLElement;
      const row = target.closest(".block-row") as HTMLElement | null;
      if (!row) return;

      const id = Number(row.dataset.blockId);
      if (!Number.isFinite(id)) return;
      this.board.setHoveredBlockId(id);
    });

    this.blocksListEl.addEventListener("mouseleave", () => {
      this.board.setHoveredBlockId(0);
    });
  }

  private parsePositiveInt(value: string): number | null {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return null;
    }
    return parsed;
  }

  // TODO REMOVE
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
    /* TODO check if (
      this.hoveredBlockId !== null &&
      !this.blocks.some(block => block.id === this.hoveredBlockId)
    ) {
      this.hoveredBlockId = null;
    }*/

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

    // TODO this is janky
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
    const blocks = this.board.getBlocks();
    if (blocks.size === 0) {
      this.blocksListEl.innerHTML =
        '<p class="empty-state">No blocks defined yet. Use Block Footprint and drag on the grid.</p>';
      return;
    }

    // TODO the idea could maybe just be getting the id within map and not save for each button
    this.blocksListEl.innerHTML = Array.from(blocks.values())
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

window.addEventListener("DOMContentLoaded", () => {
  new RollingBlocksSolverEditor();
});
