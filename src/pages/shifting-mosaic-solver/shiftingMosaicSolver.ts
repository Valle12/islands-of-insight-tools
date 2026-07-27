import { registerCoiShim } from "../../common/coiRegister";
import type {
  Position,
  ShiftingMosaicTest,
  ShiftingMosaicTool,
} from "../../util/types";
import { Board } from "./board";
import { MAX_GRID_SIDE, validateConfig } from "./config";
import {
  computeGoalAnchor,
  downloadConfig,
  parsePositiveInt,
} from "./editorHelpers";
import { cardWidthPx } from "./layout";
import { SolutionView } from "./solutionView";
import type { Turn } from "./turn";
import {
  searchShiftingMosaicWasm,
  type ShiftingMosaicPuzzle,
  type SolverHandle,
} from "./wasmBridge";

export class ShiftingMosaicSolverEditor {
  private static readonly DEFAULT_GRID_WIDTH = 6;
  private static readonly DEFAULT_GRID_HEIGHT = 6;

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
  private readonly placementBanner = document.getElementById(
    "placement-banner",
  ) as HTMLDivElement;
  private readonly warningBanner = document.getElementById(
    "warning-banner",
  ) as HTMLDivElement;
  private warningTimeoutId: number | null = null;

  private readonly editorCard = document.getElementById(
    "editor-card",
  ) as HTMLDivElement;
  private readonly editorSection = document.getElementById(
    "editor-section",
  ) as HTMLDivElement;
  private readonly solutionViewEl = document.getElementById(
    "solution-view",
  ) as HTMLDivElement;

  private readonly solutionPanel = document.getElementById(
    "solution-panel",
  ) as HTMLDivElement;
  private readonly solutionStatus = document.getElementById(
    "solution-status",
  ) as HTMLSpanElement;
  private readonly solutionMessage = document.getElementById(
    "solution-message",
  ) as HTMLDivElement;
  private readonly solutionSpinner = document.getElementById(
    "solution-spinner",
  ) as HTMLDivElement;
  private readonly solutionProgressText = document.getElementById(
    "solution-progress-text",
  ) as HTMLSpanElement;
  private readonly calculateBtn = document.getElementById(
    "calculate-solution",
  ) as HTMLButtonElement;
  private readonly fileInput = document.getElementById(
    "config-file-input",
  ) as HTMLInputElement;
  private readonly dropOverlay = document.getElementById(
    "drop-overlay",
  ) as HTMLDivElement;

  private gridWidth = ShiftingMosaicSolverEditor.DEFAULT_GRID_WIDTH;
  private gridHeight = ShiftingMosaicSolverEditor.DEFAULT_GRID_HEIGHT;
  private selectedTool: ShiftingMosaicTool = "obstruction";
  private board: Board;
  private currentWorker: SolverHandle | null = null;
  private solutionView: SolutionView | null = null;

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

    this.calculateBtn.addEventListener("click", () => {
      this.calculateSolution();
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

    this.setupDragAndDrop();

    document
      .getElementById("solution-exit")
      ?.addEventListener("click", () => this.exitSolutionView());

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
    const parsedWidth = parsePositiveInt(this.widthField.value);
    const parsedHeight = parsePositiveInt(this.heightField.value);
    if (!parsedWidth || !parsedHeight) return;
    this.gridWidth = parsedWidth;
    this.gridHeight = parsedHeight;
    this.board.reconfigure(this.gridWidth, this.gridHeight);
    this.hideSolution();
    this.render();
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
    this.board.setSelectedTool(this.selectedTool);
    this.board.reconfigure(this.gridWidth, this.gridHeight);
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
    this.updateLayoutWidth();
    this.board.renderGrid();
    this.renderToolButtons();
    this.renderBlocksList();
    this.renderPlacementBanner();
  }

  /**
   * Widens the editor card so a wide grid renders at full cell size, capped
   * to the viewport. Small grids keep the default width.
   */
  private updateLayoutWidth() {
    this.editorCard.style.width = `min(100%, ${cardWidthPx(this.gridWidth)}px)`;
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

  // -------------------------------------------------------------------------
  // Solver
  // -------------------------------------------------------------------------

  /**
   * Collects the current board into a solver puzzle. Returns null (and shows
   * a warning) if the puzzle is incomplete.
   */
  private buildPuzzle(): ShiftingMosaicPuzzle | null {
    const blocks = this.board
      .getBlocks()
      .values()
      .toArray()
      .sort((a, b) => a.id - b.id);

    const goalIndex = blocks.findIndex(block => block.type === "goal");
    if (goalIndex === -1) {
      this.showWarning(
        "No goal block defined! Please add a goal block to calculate a solution.",
      );
      return null;
    }

    const goalZoneCells = this.board.getGoalZoneCells();
    if (goalZoneCells.length === 0) {
      this.showWarning(
        "Goal zone has not been placed yet — drop the hologram first.",
      );
      return null;
    }

    return {
      gridWidth: this.gridWidth,
      gridHeight: this.gridHeight,
      shapes: blocks.map(block => block.getRelativePositions()),
      initialAnchors: blocks.map(block => ({
        x: block.anchor.x,
        y: block.anchor.y,
      })),
      goalIndex,
      goalAnchor: computeGoalAnchor(goalZoneCells),
    };
  }

  private calculateSolution() {
    const puzzle = this.buildPuzzle();
    if (!puzzle) return;

    this.stopCurrentWorker();
    this.showSolving();

    // Set by onPhase; prefixes the progress line so the slower second attempt
    // is visible rather than looking like the first one has stalled.
    let phaseLabel = "Searching…";
    this.currentWorker = searchShiftingMosaicWasm(puzzle, {
      onProgress: nodesExpanded => {
        this.solutionProgressText.textContent = `${phaseLabel} (${nodesExpanded.toLocaleString()} nodes explored)`;
      },
      onPhase: (phase, arm) => {
        if (phase !== "sequential") return;
        // The sequential phase can run for minutes. Naming the current strategy
        // is the one piece of solver internals worth showing: it is the only
        // visible sign that a long wait is progressing rather than hung.
        phaseLabel = arm
          ? `Trying harder — strategy ${arm} (slower, one at a time)…`
          : "First attempt found nothing — trying harder (slower, one strategy at a time)…";
        this.solutionProgressText.textContent = phaseLabel;
      },
      onDone: turns => {
        this.currentWorker = null;
        this.handleSolution(puzzle, turns);
      },
      onError: error => {
        this.currentWorker = null;
        this.showSolverError(error);
      },
    });
  }

  private handleSolution(puzzle: ShiftingMosaicPuzzle, turns: Turn[]) {
    this.solutionSpinner.classList.add("hidden");
    // The search is over — re-enable Calculate. showSolving() disabled it, and
    // this path (unlike showSolverError/stopCurrentWorker) used to leave it
    // disabled forever, so after "No solution" the user could not retry without
    // editing the board first.
    this.calculateBtn.toggleAttribute("disabled", false);

    if (turns.length === 0) {
      // The solver returns an empty path both when the goal block already
      // sits on the goal zone and when no solution exists. Distinguish by
      // checking the start state.
      const goal = puzzle.initialAnchors[puzzle.goalIndex]!;
      const alreadySolved =
        goal.x === puzzle.goalAnchor.x && goal.y === puzzle.goalAnchor.y;
      this.solutionStatus.textContent = alreadySolved ? "Solved" : "No solution";
      this.solutionMessage.textContent = alreadySolved
        ? "The goal block is already in the goal zone."
        : "No solution was found within the search budget.";
      return;
    }

    this.solutionPanel.classList.add("hidden");
    this.enterSolutionView(puzzle, turns);
  }

  private enterSolutionView(puzzle: ShiftingMosaicPuzzle, turns: Turn[]) {
    this.editorSection.classList.add("hidden");
    this.solutionViewEl.classList.remove("hidden");
    this.solutionView?.dispose();
    this.solutionView = new SolutionView({
      gridWidth: puzzle.gridWidth,
      gridHeight: puzzle.gridHeight,
      shapes: puzzle.shapes,
      initialAnchors: puzzle.initialAnchors,
      goalIndex: puzzle.goalIndex,
      goalAnchor: puzzle.goalAnchor,
      turns,
    });
  }

  private exitSolutionView() {
    this.solutionView?.dispose();
    this.solutionView = null;
    this.solutionViewEl.classList.add("hidden");
    this.editorSection.classList.remove("hidden");
    this.solutionPanel.classList.add("hidden");
    this.render();
  }

  private showSolving() {
    this.calculateBtn.toggleAttribute("disabled", true);
    this.solutionPanel.classList.remove("hidden");
    this.solutionSpinner.classList.remove("hidden");
    this.solutionStatus.textContent = "";
    this.solutionMessage.textContent = "";
    this.solutionProgressText.textContent = "Searching…";
  }

  private showSolverError(error: string) {
    this.calculateBtn.toggleAttribute("disabled", false);
    this.solutionSpinner.classList.add("hidden");
    this.solutionStatus.textContent = "Failed";
    this.solutionMessage.textContent = `Solver error: ${error}`;
  }

  private stopCurrentWorker() {
    if (this.currentWorker) {
      this.currentWorker.terminate();
      this.currentWorker = null;
    }
    this.calculateBtn.toggleAttribute("disabled", false);
  }

  private downloadCurrentConfig() {
    const puzzle = this.buildPuzzle();
    if (!puzzle) return;
    downloadConfig({
      gridWidth: puzzle.gridWidth,
      gridHeight: puzzle.gridHeight,
      shapes: puzzle.shapes,
      initialAnchors: puzzle.initialAnchors,
      goalIndex: puzzle.goalIndex,
      goalAnchor: puzzle.goalAnchor,
    });
  }

  /** Reads a dropped/picked file, validates it, and populates the editor. */
  private async loadConfigFromFile(file: File) {
    if (
      !file.name.toLowerCase().endsWith(".json") &&
      file.type !== "application/json"
    ) {
      this.showWarning("Please choose a JSON config file.");
      return;
    }

    let text: string;
    try {
      text = await file.text();
    } catch {
      this.showWarning("Could not read the selected file.");
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.showWarning("The file is not valid JSON.");
      return;
    }

    const result = validateConfig(parsed);
    if (!result.ok) {
      this.showWarning(`Invalid config: ${result.error}`);
      return;
    }

    this.applyLoadedConfig(result.config);
  }

  /** Applies a validated config to the board and returns to the editor. */
  private applyLoadedConfig(config: ShiftingMosaicTest) {
    this.gridWidth = config.gridWidth;
    this.gridHeight = config.gridHeight;
    this.widthField.value = String(this.gridWidth);
    this.heightField.value = String(this.gridHeight);
    this.selectedTool = "obstruction";
    this.board.setSelectedTool(this.selectedTool);
    this.board.loadConfig(config);
    this.hideSolution();
    this.solutionViewEl.classList.add("hidden");
    this.editorSection.classList.remove("hidden");
    this.render();
  }

  /** Lets the user drop a config JSON anywhere on the page to load it. */
  private setupDragAndDrop() {
    let dragDepth = 0;
    const hasFiles = (event: DragEvent) =>
      event.dataTransfer != null &&
      Array.from(event.dataTransfer.types).includes("Files");

    window.addEventListener("dragenter", event => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragDepth++;
      this.dropOverlay.classList.remove("hidden");
    });
    window.addEventListener("dragover", event => {
      if (!hasFiles(event)) return;
      event.preventDefault();
    });
    window.addEventListener("dragleave", event => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) this.dropOverlay.classList.add("hidden");
    });
    window.addEventListener("drop", event => {
      dragDepth = 0;
      this.dropOverlay.classList.add("hidden");
      const file = event.dataTransfer?.files?.[0];
      if (!file) return;
      event.preventDefault();
      void this.loadConfigFromFile(file);
    });
  }

  hideSolution() {
    this.stopCurrentWorker();
    this.solutionPanel.classList.add("hidden");
    this.solutionSpinner.classList.add("hidden");
  }
}

// Module-scope so the editor (and the DOM listeners it owns) lives as long as
// the page does, rather than reading as an object constructed and dropped.
let editor: ShiftingMosaicSolverEditor | undefined;

if (process.env.NODE_ENV !== "test") {
  // Opt this page into cross-origin isolation (wasm threads) where the
  // browser supports the shim; everything degrades to the worker portfolio
  // otherwise.
  registerCoiShim();
  editor = new ShiftingMosaicSolverEditor();
}

export { editor };
