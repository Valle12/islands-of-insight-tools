import type { ShiftingMosaicTool } from "../../util/types";
import { Board } from "./board";

export class ShiftingMosaicSolverEditor {
  private static readonly DEFAULT_GRID_WIDTH = 6;
  private static readonly DEFAULT_GRID_HEIGHT = 6;

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
  private placementBanner = document.getElementById(
    "placement-banner",
  ) as HTMLDivElement;
  private warningBanner = document.getElementById(
    "warning-banner",
  ) as HTMLDivElement;
  private warningTimeoutId: number | null = null;

  private solutionPanel = document.getElementById(
    "solution-panel",
  ) as HTMLDivElement;
  private solutionStatus = document.getElementById(
    "solution-status",
  ) as HTMLSpanElement;
  private solutionMessage = document.getElementById(
    "solution-message",
  ) as HTMLDivElement;

  private gridWidth = ShiftingMosaicSolverEditor.DEFAULT_GRID_WIDTH;
  private gridHeight = ShiftingMosaicSolverEditor.DEFAULT_GRID_HEIGHT;
  private selectedTool: ShiftingMosaicTool = "obstruction";
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
        if (button.disabled) return;
        const tool = button.dataset.tool as ShiftingMosaicTool;

        if (tool === "reset") {
          (document.getElementById("reset-dialog") as HTMLDialogElement).show();
          return;
        }

        if (this.board.isInGoalZonePlacementMode()) return;

        this.selectedTool = tool;
        this.board.setSelectedTool(tool);
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
      this.hideSolution();
      this.render();
      resetDialog.close();
    });

    const calculateBtn = document.getElementById("calculate-solution");
    calculateBtn?.addEventListener("click", () => {
      this.showSolverPlaceholder();
    });

    this.widthField.addEventListener("input", () => this.handleSizeUpdate());
    this.heightField.addEventListener("input", () => this.handleSizeUpdate());

    this.blocksListEl.addEventListener("click", event => {
      const target = event.target as HTMLElement;

      const deleteButton = target.closest(
        "md-icon-button[data-block-delete-id]",
      ) as HTMLElement | null;
      if (deleteButton) {
        const id = Number(deleteButton.dataset.blockDeleteId);
        this.board.deleteBlockById(id);
        this.board.renumberBlocks(id);
        this.hideSolution();
        this.render();
        return;
      }

      const placeButton = target.closest(
        "md-icon-button[data-block-place-id]",
      ) as HTMLElement | null;
      if (placeButton) {
        const id = Number(placeButton.dataset.blockPlaceId);
        this.board.startGoalZonePlacement(id);
        this.hideSolution();
        return;
      }
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
    this.hideSolution();
    this.render();
  }

  private parsePositiveInt(value: string): number | null {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) return null;
    return parsed;
  }

  private applyDefaultGridSize() {
    this.gridWidth = ShiftingMosaicSolverEditor.DEFAULT_GRID_WIDTH;
    this.gridHeight = ShiftingMosaicSolverEditor.DEFAULT_GRID_HEIGHT;
    this.widthField.value = String(this.gridWidth);
    this.heightField.value = String(this.gridHeight);
  }

  private resetToDefaults() {
    this.applyDefaultGridSize();
    this.selectedTool = "obstruction";
    this.board = new Board(
      this,
      this.gridWidth,
      this.gridHeight,
      this.selectedTool,
    );
  }

  notifyGoalZonePlacementChanged() {
    this.render();
  }

  showWarning(message: string) {
    this.warningBanner.textContent = message;
    this.warningBanner.classList.remove("hidden");
    if (this.warningTimeoutId !== null) {
      window.clearTimeout(this.warningTimeoutId);
    }
    this.warningTimeoutId = window.setTimeout(() => {
      this.warningBanner.classList.add("hidden");
      this.warningTimeoutId = null;
    }, 3500);
  }

  render() {
    this.board.renderGrid();
    this.renderToolButtons();
    this.renderBlocksList();
    this.renderPlacementBanner();
  }

  private renderPlacementBanner() {
    if (this.board.isInGoalZonePlacementMode()) {
      this.placementBanner.classList.remove("hidden");
    } else {
      this.placementBanner.classList.add("hidden");
    }
  }

  private renderToolButtons() {
    const placing = this.board.isInGoalZonePlacementMode();
    const hasGoal = this.board.hasGoalBlock();

    const toolButtons =
      document.querySelectorAll<HTMLButtonElement>(".tool-button");
    toolButtons.forEach(button => {
      const tool = button.dataset.tool as ShiftingMosaicTool;
      button.classList.toggle("selected", tool === this.selectedTool);

      if (placing) {
        button.disabled = true;
      } else if (tool === "goal" && hasGoal) {
        button.disabled = true;
      } else {
        button.disabled = false;
      }
    });

    let label = "";
    switch (this.selectedTool) {
      case "obstruction":
        label = "Obstruction";
        break;
      case "goal":
        label = "Goal Block";
        break;
      default:
        label = "Obstruction";
    }

    this.statusEl.textContent = placing
      ? "Place the goal zone — click on the grid to drop the hologram"
      : `Selected tool: ${label}`;
  }

  private renderBlocksList() {
    const blocks = this.board.getBlocks();
    if (blocks.size === 0) {
      this.blocksListEl.innerHTML =
        '<p class="empty-state">No blocks defined yet. Pick a tool and drag on the grid to draw a shape.</p>';
      return;
    }

    this.blocksListEl.innerHTML = Array.from(blocks.values())
      .sort((a, b) => a.id - b.id)
      .map(block => {
        const typeLabel = block.type === "goal" ? "Goal" : "Obs";
        const placeBtn =
          block.type === "goal"
            ? `<md-icon-button data-block-place-id="${block.id}" title="Re-place goal zone">
                 <md-icon>edit_location_alt</md-icon>
               </md-icon-button>`
            : "";
        return `
          <div class="block-row block-row-${block.type}${this.board.getHoveredBlockId() === block.id ? " row-hovered" : ""}" data-block-id="${block.id}">
            <span class="block-chip block-chip-${block.type}">${typeLabel} ${block.id}</span>
            <span class="block-row-actions">
              ${placeBtn}
              <md-icon-button data-block-delete-id="${block.id}" title="Delete block">
                <md-icon>delete</md-icon>
              </md-icon-button>
            </span>
          </div>
        `;
      })
      .join("");
  }

  private showSolverPlaceholder() {
    this.solutionPanel.classList.remove("hidden");
    this.solutionStatus.textContent = "Pending";
    this.solutionMessage.textContent =
      "Solver implementation is coming in a follow-up. For now this page only handles puzzle setup.";
    // TODO move this to a real method
    const blocks = this.board
      .getBlocks()
      .values()
      .toArray()
      .sort((a, b) => a.id - b.id);
    if (!blocks.some(block => block.type === "goal")) {
      this.showWarning(
        "No goal block defined! Please add a goal block to calculate a solution.",
      );
      return;
    }

    /*const aStar = new AStar(blocks, this.board.getGoalZoneCells());
    aStar.search();*/
  }

  hideSolution() {
    this.solutionPanel.classList.add("hidden");
  }
}

if (process.env.NODE_ENV !== "test") {
  new ShiftingMosaicSolverEditor();
}
