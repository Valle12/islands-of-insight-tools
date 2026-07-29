import {
  downloadJson,
  readJsonFile,
  setupDragAndDrop,
} from "./../../util/configFile";
import type { PaintTool, RollingBlocksTest } from "./../../util/types";
import { Board } from "./board";
import { MAX_BLOCK_DIM, MAX_GRID_SIDE, validateConfig } from "./config";
import type { Turn } from "./turn";
import { searchRollingBlocksWasm, type SolverHandle } from "./wasmBridge";

export class RollingBlocksSolverEditor {
  private static readonly DEFAULT_GRID_WIDTH = 5;
  private static readonly DEFAULT_GRID_HEIGHT = 5;

  private readonly blocksListEl = document.getElementById(
    "blocks-list",
  ) as HTMLDivElement;
  private readonly widthField = document.getElementById(
    "grid-width",
  ) as HTMLInputElement;
  private readonly heightField = document.getElementById(
    "grid-height",
  ) as HTMLInputElement;
  private readonly statusEl = document.getElementById("tool-status") as HTMLDivElement;

  private readonly solutionPanel = document.getElementById(
    "solution-panel",
  ) as HTMLDivElement;
  private readonly solutionSpinner = document.getElementById(
    "solution-spinner",
  ) as HTMLDivElement;
  private readonly solutionError = document.getElementById(
    "solution-error",
  ) as HTMLDivElement;
  private readonly solutionMoves = document.getElementById(
    "solution-moves",
  ) as HTMLOListElement;
  private readonly solutionStatus = document.getElementById(
    "solution-status",
  ) as HTMLSpanElement;
  private readonly solutionProgressText = document.getElementById(
    "solution-progress-text",
  ) as HTMLSpanElement;

  private readonly warningBanner = document.getElementById(
    "warning-banner",
  ) as HTMLDivElement;
  private warningTimeoutId: number | null = null;
  private readonly fileInput = document.getElementById(
    "config-file-input",
  ) as HTMLInputElement;
  private readonly dropOverlay = document.getElementById(
    "drop-overlay",
  ) as HTMLDivElement;

  private gridWidth = RollingBlocksSolverEditor.DEFAULT_GRID_WIDTH;
  private gridHeight = RollingBlocksSolverEditor.DEFAULT_GRID_HEIGHT;
  private selectedTool: PaintTool = "regular";
  private board: Board;
  private currentWorker: SolverHandle | null = null;
  // Ceiling for a single browser solve; without it a hopeless search would
  // spin until the tab dies. Mirrors the shifting-mosaic page's budget.
  private static readonly SOLVE_BUDGET_MS = 300_000;

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
          this.hideSolution();
          this.render();
          return;
        }

        if (tool === "fillMustTouch") {
          this.board.fillAllCells("mustTouch");
          this.hideSolution();
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
      this.hideSolution();
      this.render();
      resetDialog.close();
    });

    const calculateMovesBtn = document.getElementById("calculate-moves");
    calculateMovesBtn?.addEventListener("click", () => {
      this.stopCurrentWorker();
      this.showSolving();

      this.currentWorker = searchRollingBlocksWasm(
        this.gridWidth,
        this.gridHeight,
        this.board.getCells(),
        this.board.getBlocks().values().toArray(),
        {
          onProgress: nodesExpanded => {
            this.solutionProgressText.textContent = `Searching... (${nodesExpanded.toLocaleString()} nodes expanded)`;
          },
          onDone: path => {
            this.currentWorker = null;
            this.showSolution(path);
          },
          onError: err => {
            this.currentWorker = null;
            this.showError(err);
          },
        },
        { maxMs: RollingBlocksSolverEditor.SOLVE_BUDGET_MS },
      );
    });

    document
      .getElementById("download-config")
      ?.addEventListener("click", () => this.downloadCurrentConfig());

    document
      .getElementById("upload-config")
      ?.addEventListener("click", () => this.fileInput.click());

    this.fileInput.addEventListener("change", () => {
      const file = this.fileInput.files?.[0];
      if (file) void this.loadConfigFromFile(file);
      // Clear the value so re-selecting the same file fires "change" again.
      this.fileInput.value = "";
    });

    setupDragAndDrop(this.dropOverlay, file => {
      void this.loadConfigFromFile(file);
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
      const parsed = this.parsePositiveInt(textField.value, MAX_BLOCK_DIM);
      if (!parsed) return;
      block.height = parsed;
      this.hideSolution();
    });

    this.blocksListEl.addEventListener("click", event => {
      const target = event.target as HTMLElement;
      const button = target.closest("md-icon-button");
      if (!button) return;
      const id = Number(button.dataset.blockDeleteId);
      this.board.deleteBlockById(id);
      this.board.renumberBlocks(id);
      this.hideSolution();
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
    const parsedWidth = this.parsePositiveInt(
      this.widthField.value,
      MAX_GRID_SIDE,
    );
    const parsedHeight = this.parsePositiveInt(
      this.heightField.value,
      MAX_GRID_SIDE,
    );
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

  private parsePositiveInt(value: string, max: number): number | null {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > max) {
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
  private stopCurrentWorker() {
    if (this.currentWorker) {
      this.currentWorker.terminate();
      this.currentWorker = null;
    }
  }

  private showSolving() {
    this.solutionPanel.classList.remove("hidden");
    this.solutionSpinner.classList.remove("hidden");
    this.solutionError.classList.add("hidden");
    this.solutionMoves.classList.add("hidden");
    this.solutionStatus.textContent = "";
    this.solutionProgressText.textContent = "Searching...";
  }

  private showSolution(path: Turn[]) {
    this.solutionSpinner.classList.add("hidden");
    this.solutionError.classList.add("hidden");

    if (path.length === 0) {
      this.solutionStatus.textContent = "No solution found";
      this.solutionMoves.classList.add("hidden");
      return;
    }

    this.solutionStatus.textContent = `${path.length} move${path.length !== 1 ? "s" : ""}`;
    this.solutionMoves.classList.remove("hidden");
    this.solutionMoves.innerHTML = path
      .map(
        turn =>
          `<li><span class="move-block">Block ${turn.blockId}</span> <span class="move-direction">${turn.direction.toLowerCase()}</span></li>`,
      )
      .join("");
  }

  private showError(error: string) {
    this.solutionSpinner.classList.add("hidden");
    this.solutionMoves.classList.add("hidden");
    this.solutionError.classList.remove("hidden");
    this.solutionError.textContent = `Error: ${error}`;
    this.solutionStatus.textContent = "Failed";
  }

  private showWarning(message: string) {
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

  private downloadCurrentConfig() {
    const blocks = Array.from(this.board.getBlocks().values()).sort(
      (a, b) => a.id - b.id,
    );
    downloadJson(
      {
        gridWidth: this.gridWidth,
        gridHeight: this.gridHeight,
        cells: this.board.getCells(),
        blocks: blocks.map(b => ({
          id: b.id,
          x: b.x,
          y: b.y,
          width: b.width,
          depth: b.depth,
          height: b.height,
        })),
      },
      "rollingBlocksTest.json",
    );
  }

  /** Reads a dropped/picked file, validates it, and populates the editor. */
  private async loadConfigFromFile(file: File) {
    const read = await readJsonFile(file);
    if (!read.ok) {
      this.showWarning(read.error);
      return;
    }

    const result = validateConfig(read.data);
    if (!result.ok) {
      this.showWarning(`Invalid config: ${result.error}`);
      return;
    }

    this.applyLoadedConfig(result.config);
  }

  /** Applies a validated config to the board. */
  private applyLoadedConfig(config: RollingBlocksTest) {
    this.hideSolution();
    this.gridWidth = config.gridWidth;
    this.gridHeight = config.gridHeight;
    this.widthField.value = String(this.gridWidth);
    this.heightField.value = String(this.gridHeight);
    this.board = new Board(
      this,
      this.gridWidth,
      this.gridHeight,
      this.selectedTool,
    );
    this.board.loadConfig(config);
    this.render();
  }

  hideSolution() {
    this.stopCurrentWorker();
    this.solutionPanel.classList.add("hidden");
    this.solutionSpinner.classList.add("hidden");
    this.solutionError.classList.add("hidden");
    this.solutionMoves.classList.add("hidden");
  }
}

if (process.env.NODE_ENV !== "test") {
  new RollingBlocksSolverEditor();
}
