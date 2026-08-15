import { registerCoiShim } from "../../common/coiRegister";
import { downloadJson, readJsonFile } from "./../../util/configFile";
import {
  openResetDialog,
  parsePositiveInt,
  warningBanner,
  wireConfigIo,
  wireResetDialog,
} from "./../../util/editorShell";
import type { PaintTool, RollingBlocksTest } from "./../../util/types";
import { Board } from "./board";
import { MAX_BLOCK_DIM, MAX_GRID_SIDE, validateConfig } from "./config";
import { SolutionView } from "./solutionView";
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
  private readonly editorSection = document.getElementById(
    "editor-section",
  ) as HTMLDivElement;
  private readonly solutionViewEl = document.getElementById(
    "solution-view",
  ) as HTMLDivElement;
  private readonly solutionStepsBtn = document.getElementById(
    "solution-steps",
  ) as HTMLButtonElement;
  private solutionView: SolutionView | null = null;
  // Kept so "Back to editor" can hand the same answer back without re-solving.
  private lastPath: Turn[] | null = null;
  private readonly solutionStatus = document.getElementById(
    "solution-status",
  ) as HTMLSpanElement;
  private readonly solutionProgressText = document.getElementById(
    "solution-progress-text",
  ) as HTMLSpanElement;

  private readonly showWarning = warningBanner(
    document.getElementById("warning-banner") as HTMLDivElement,
  );
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
          openResetDialog();
          return;
        }

        this.selectedTool = tool;
        this.board.setSelectedTool(tool);
        this.renderToolButtons();
        this.render();
      });
    });

    wireResetDialog(() => {
      this.resetToDefaults();
      this.hideSolution();
      this.render();
    });

    const calculateMovesBtn = document.getElementById("calculate-moves");
    calculateMovesBtn?.addEventListener("click", () => {
      this.stopCurrentWorker();
      this.showSolving();

      let phaseLabel = "Searching...";
      this.currentWorker = searchRollingBlocksWasm(
        this.gridWidth,
        this.gridHeight,
        this.board.getCells(),
        this.board.getBlocks().values().toArray(),
        {
          onProgress: nodesExpanded => {
            this.solutionProgressText.textContent = `${phaseLabel} (${nodesExpanded.toLocaleString()} nodes expanded)`;
          },
          onPhase: phase => {
            if (phase === "optimizing") {
              // The optimizer emits no progress ticks; without its own label
              // the spinner reads as stuck on the last node count.
              phaseLabel = "Optimizing solution...";
            } else if (phase === "sequential") {
              phaseLabel = "Trying harder — one strategy at a time...";
            } else {
              phaseLabel = `Searching (${phase})...`;
            }
            this.solutionProgressText.textContent = phaseLabel;
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
      );
    });

    document
      .getElementById("solution-exit")
      ?.addEventListener("click", () => this.exitSolutionView());

    this.solutionStepsBtn.addEventListener("click", () => {
      if (this.lastPath) this.enterSolutionView(this.lastPath);
    });

    wireConfigIo({
      fileInput: this.fileInput,
      dropOverlay: this.dropOverlay,
      onFile: file => void this.loadConfigFromFile(file),
      onDownload: () => this.downloadCurrentConfig(),
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
      const parsed = parsePositiveInt(textField.value, MAX_BLOCK_DIM);
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
    const parsedWidth = parsePositiveInt(this.widthField.value, MAX_GRID_SIDE);
    const parsedHeight = parsePositiveInt(
      this.heightField.value,
      MAX_GRID_SIDE,
    );
    if (!parsedWidth || !parsedHeight) return;
    // Unchanged dimensions are not a resize, and a resize throws the board
    // away. The field fires on every keystroke, so without this, retyping the
    // same number over itself wiped everything on the grid — the guard the
    // three sibling pages already carry.
    if (parsedWidth === this.gridWidth && parsedHeight === this.gridHeight) {
      return;
    }
    this.gridWidth = parsedWidth;
    this.gridHeight = parsedHeight;
    this.board.dispose();
    this.board = new Board(
      this,
      this.gridWidth,
      this.gridHeight,
      this.selectedTool,
    );
    this.hideSolution();
    this.render();
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
    this.board.dispose();
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
    this.solutionStepsBtn.classList.add("hidden");
    this.solutionStatus.textContent = "";
    this.solutionProgressText.textContent = "Searching...";
  }

  private showSolution(path: Turn[]) {
    this.solutionSpinner.classList.add("hidden");
    this.solutionError.classList.add("hidden");

    if (path.length === 0) {
      // Nothing to step through, so the editor stays put and the panel says so.
      this.solutionStatus.textContent = "No solution found";
      return;
    }

    this.solutionStatus.textContent = `${path.length} move${path.length !== 1 ? "s" : ""}`;
    this.lastPath = path;
    this.solutionStepsBtn.classList.remove("hidden");
    this.enterSolutionView(path);
  }

  /** Swaps the editor out for the step-by-step view of `path`. */
  private enterSolutionView(path: Turn[]) {
    this.solutionView?.dispose();
    this.solutionView = new SolutionView(
      {
        gridWidth: this.gridWidth,
        gridHeight: this.gridHeight,
        cells: this.board.getCells(),
        blocks: this.board.getBlocks().values().toArray(),
      },
      path,
    );
    this.editorSection.classList.add("hidden");
    this.solutionPanel.classList.add("hidden");
    this.solutionViewEl.classList.remove("hidden");
  }

  /**
   * Puts the editor back. The answer survives — the panel keeps its move count
   * and offers the step view again, so tweaking nothing costs nothing.
   */
  private exitSolutionView() {
    this.solutionView?.dispose();
    this.solutionView = null;
    this.solutionViewEl.classList.add("hidden");
    this.editorSection.classList.remove("hidden");
    if (this.lastPath) this.solutionPanel.classList.remove("hidden");
  }

  private showError(error: string) {
    this.solutionSpinner.classList.add("hidden");
    this.solutionError.classList.remove("hidden");
    this.solutionError.textContent = `Error: ${error}`;
    this.solutionStatus.textContent = "Failed";
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
    this.board.dispose();
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
    this.lastPath = null;
    this.exitSolutionView();
    this.solutionPanel.classList.add("hidden");
    this.solutionSpinner.classList.add("hidden");
    this.solutionError.classList.add("hidden");
    this.solutionStepsBtn.classList.add("hidden");
  }
}

if (process.env.NODE_ENV !== "test") {
  // Opt this page into cross-origin isolation (wasm threads) where the
  // browser supports the shim; everything degrades to the worker portfolio
  // otherwise.
  registerCoiShim();
  new RollingBlocksSolverEditor();
}
