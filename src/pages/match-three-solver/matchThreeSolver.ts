import { registerCoiShim } from "./../../common/coiRegister";
import {
  downloadJson,
  readJsonFile,
  setupDragAndDrop,
} from "./../../util/configFile";
import type { MatchThreeTest, MatchThreeTool } from "./../../util/types";
import { Board } from "./board";
import { MAX_GRID_SIDE, validateConfig } from "./config";
import type { SolveProgress, SolveResult } from "./engine";
import { boardProblem, toBoard, type Move } from "./rules";
import { searchMatchThree, type SolveHandle } from "./solveClient";
import { SolutionView } from "./solutionView";
import { BLOCKER_IMAGE, SYMBOLS } from "./symbols";

export class MatchThreeSolverEditor {
  private static readonly DEFAULT_GRID_WIDTH = 6;
  private static readonly DEFAULT_GRID_HEIGHT = 6;

  private readonly widthField = document.getElementById(
    "grid-width",
  ) as HTMLInputElement;
  private readonly heightField = document.getElementById(
    "grid-height",
  ) as HTMLInputElement;
  private readonly statusEl = document.getElementById(
    "tool-status",
  ) as HTMLDivElement;
  private readonly symbolRow = document.getElementById(
    "symbol-row",
  ) as HTMLDivElement;

  private readonly editorSection = document.getElementById(
    "editor-section",
  ) as HTMLDivElement;
  private readonly solutionPanel = document.getElementById(
    "solution-panel",
  ) as HTMLDivElement;
  private readonly solutionStatus = document.getElementById(
    "solution-status",
  ) as HTMLSpanElement;
  private readonly solutionSpinner = document.getElementById(
    "solution-spinner",
  ) as HTMLDivElement;
  private readonly solutionProgress = document.getElementById(
    "solution-progress-text",
  ) as HTMLSpanElement;
  private readonly solutionMessage = document.getElementById(
    "solution-message",
  ) as HTMLDivElement;
  private readonly solutionViewEl = document.getElementById(
    "solution-view",
  ) as HTMLDivElement;
  private readonly solutionCancel = document.getElementById(
    "solution-cancel",
  ) as HTMLButtonElement;
  private readonly solveButton = document.getElementById(
    "solve-puzzle",
  ) as HTMLButtonElement;

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

  private gridWidth = MatchThreeSolverEditor.DEFAULT_GRID_WIDTH;
  private gridHeight = MatchThreeSolverEditor.DEFAULT_GRID_HEIGHT;
  private selectedTool: MatchThreeTool = "symbol";
  private selectedSymbol = 0;
  private board: Board;

  private solutionView: SolutionView | null = null;
  private search: SolveHandle | null = null;
  /**
   * The best solution the running search has streamed so far, and the board
   * it belongs to. This is what makes stopping safe: the Stop button renders
   * this instead of discarding the search.
   */
  private pendingConfig: MatchThreeTest | null = null;
  /**
   * Bumped whenever a running search stops mattering. A worker that reports
   * back under an old generation is answering about a board that no longer
   * exists, so its result is dropped.
   */
  private solveGeneration = 0;

  constructor() {
    this.board = this.createBoard();
    this.addListeners();
    this.render();
  }

  /**
   * Replaces `this.board`. The old one must be disposed: `#grid` outlives it,
   * so its listeners would otherwise stay attached and every later stroke
   * would do the work once per board ever created.
   */
  private replaceBoard() {
    this.board.dispose();
    this.board = this.createBoard();
  }

  private createBoard() {
    return new Board(
      this,
      this.gridWidth,
      this.gridHeight,
      this.selectedTool,
      this.selectedSymbol,
    );
  }

  private addListeners() {
    // Scoped to #tool-row: the symbol chips share the `.tool-button` class for
    // its styling but are driven by the delegated #symbol-row handler instead.
    const toolButtons = document.querySelectorAll<HTMLButtonElement>(
      "#tool-row .tool-button",
    );
    toolButtons.forEach(button => {
      button.addEventListener("click", () => {
        this.handleToolClick(button.dataset.tool as MatchThreeTool);
      });
    });

    // The chips are re-rendered whenever the selection moves, so per-chip
    // listeners would not survive; the row handles their clicks.
    this.symbolRow.addEventListener("click", event => {
      const target = event.target as HTMLElement;
      const chip = target.closest(".symbol-chip") as HTMLElement | null;
      if (!chip) return;
      // The blockade shares the row but paints a structural value, so it
      // carries `data-tool` where the symbols carry an index.
      if (chip.dataset.tool) {
        this.handleToolClick(chip.dataset.tool as MatchThreeTool);
        return;
      }
      const index = Number(chip.dataset.symbolIndex);
      if (!Number.isInteger(index)) return;
      this.selectSymbol(index);
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

    this.solveButton.addEventListener("click", () => this.solve());

    this.solutionCancel.addEventListener("click", () => {
      // There is never a partial answer to keep: the search ends itself the
      // moment it has one, so reaching this button means nothing was found.
      this.cancelSearch();
      this.solutionStatus.textContent = "Cancelled";
    });

    document
      .getElementById("solution-exit")
      ?.addEventListener("click", () => this.exitSolutionView());

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
  }

  /** Paint tools select; `reset` is a command, not a tool. */
  private handleToolClick(tool: MatchThreeTool) {
    if (tool === "reset") {
      (document.getElementById("reset-dialog") as HTMLDialogElement).show();
      return;
    }

    this.selectedTool = tool;
    this.board.setSelectedTool(tool);
    this.renderTools();
  }

  private selectSymbol(index: number) {
    this.selectedTool = "symbol";
    this.selectedSymbol = index;
    this.board.setSelectedTool("symbol");
    this.board.setSelectedSymbol(index);
    this.renderTools();
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
    if (parsedWidth === this.gridWidth && parsedHeight === this.gridHeight) {
      return;
    }
    this.gridWidth = parsedWidth;
    this.gridHeight = parsedHeight;
    // A resize means a different puzzle, so the cells go with it. The symbols
    // are the game's own fixed set, so there is nothing there to reset.
    this.replaceBoard();
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

  private resetToDefaults() {
    this.gridWidth = MatchThreeSolverEditor.DEFAULT_GRID_WIDTH;
    this.gridHeight = MatchThreeSolverEditor.DEFAULT_GRID_HEIGHT;
    this.widthField.value = String(this.gridWidth);
    this.heightField.value = String(this.gridHeight);
    this.selectedTool = "symbol";
    this.selectedSymbol = 0;
    this.replaceBoard();
  }

  /** Full redraw — only needed when the board itself changed. */
  render() {
    this.board.renderGrid();
    this.renderTools();
  }

  /**
   * Redraws the two chip rows alone. Picking a tool or a symbol leaves every
   * cell untouched, so rebuilding the grid for it would repaint the whole
   * board for nothing.
   */
  private renderTools() {
    this.renderToolButtons();
    this.renderSymbolTools();
  }

  private renderToolButtons() {
    // Scoped to #tool-row: the symbol chips share the `.tool-button` class for
    // its styling but are driven by the delegated #symbol-row handler instead.
    const toolButtons = document.querySelectorAll<HTMLButtonElement>(
      "#tool-row .tool-button",
    );
    toolButtons.forEach(button => {
      const tool = button.dataset.tool;
      button.classList.toggle("selected", tool === this.selectedTool);
    });

    // The kind of tool, not which tile: the selected chip already shows that,
    // and naming the tile meant printing "Purple 2" at the player.
    let label: string;
    switch (this.selectedTool) {
      case "blocked":
        label = "Blocked";
        break;
      case "empty":
        label = "Eraser";
        break;
      default:
        label = "Color";
    }

    this.statusEl.textContent = `Selected tool: ${label}`;
  }

  private chip(
    label: string,
    image: string,
    selected: boolean,
    attributes: string,
  ) {
    return `
      <button class="tool-button symbol-chip${selected ? " selected" : ""}"
        type="button" ${attributes} title="${label}" aria-label="${label}">
        <img src="${image}" alt="" width="28" height="28" />
      </button>
    `;
  }

  /**
   * The paint tiles: the blockade first, then every symbol the game has. The
   * chip is the tile and nothing else — the artwork is what the player matches
   * against on screen, and a name beside each only added noise. The name stays
   * as the accessible one, which is also what the e2e suite reads.
   *
   * The blockade leads the row but is NOT a symbol: it paints the structural
   * `BLOCKED` value, so it carries `data-tool` rather than a `data-symbol-index`
   * and never shifts the indices a saved board refers to.
   */
  private renderSymbolTools() {
    const blocked = this.chip(
      "Blocked",
      BLOCKER_IMAGE,
      this.selectedTool === "blocked",
      'data-tool="blocked"',
    );

    const symbols = SYMBOLS.map((symbol, index) =>
      this.chip(
        symbol.label,
        symbol.image,
        this.selectedTool === "symbol" && this.selectedSymbol === index,
        `data-symbol-index="${index}" data-symbol="${symbol.id}"`,
      ),
    ).join("");

    this.symbolRow.innerHTML = blocked + symbols;
  }

  private currentConfig(): MatchThreeTest {
    return {
      gridWidth: this.gridWidth,
      gridHeight: this.gridHeight,
      cells: this.board.getCells(),
    };
  }

  private solve() {
    const config = this.currentConfig();

    // A board the game could never show — a block hanging in mid-air, or a
    // line still standing — would be solved from a position the player never
    // had, so it is refused rather than quietly settled first.
    const problem = boardProblem(toBoard(config));
    if (problem !== null) {
      this.hideSolution();
      this.showWarning(problem);
      return;
    }

    const generation = ++this.solveGeneration;
    const isCurrent = () => generation === this.solveGeneration;
    this.pendingConfig = config;
    this.showSolving();

    this.search = searchMatchThree(config, {
      onProgress: progress => {
        if (!isCurrent()) return;
        this.solutionProgress.textContent = this.progressText(progress);
      },
      // The first solution the search can play is the answer. Nothing waits
      // to find out whether a shorter one exists, so this is where a solve
      // normally ends — `onResult` only gets there on an unsolvable board, an
      // empty one, or a board nothing cracked inside the budget.
      onBest: moves => {
        if (!isCurrent()) return;
        this.finishWith(config, moves);
      },
      onResult: result => {
        if (!isCurrent()) return;
        this.search = null;
        this.showResult(config, result);
      },
      onError: message => {
        if (!isCurrent()) return;
        this.search = null;
        this.setSolving(false);
        this.solutionMessage.textContent = message;
      },
    });
  }

  /** One line saying how hard the search is still looking. */
  private progressText(progress: SolveProgress): string {
    const checked = `${progress.nodes.toLocaleString()} positions checked`;
    return `Looking for a solution — ${checked}`;
  }

  /** Stops the search and shows the solution it just produced. */
  private finishWith(config: MatchThreeTest, moves: Move[]) {
    this.cancelSearch();
    this.showResult(config, { status: "solved", moves });
  }

  private showResult(config: MatchThreeTest, result: SolveResult) {
    this.setSolving(false);

    if (result.status === "unsolvable") {
      this.solutionStatus.textContent = "No solution";
      this.solutionMessage.textContent =
        "This board cannot be cleared. Every sequence of swaps was tried.";
      return;
    }

    if (result.status === "budget") {
      this.solutionStatus.textContent = "Gave up";
      this.solutionMessage.textContent =
        "No solution was found within the time limit.";
      return;
    }

    if (result.moves.length === 0) {
      this.solutionStatus.textContent = "Already solved";
      this.solutionMessage.textContent = "This board has no blocks to clear.";
      return;
    }

    this.enterSolutionView(config, result.moves);
  }

  private enterSolutionView(config: MatchThreeTest, moves: Move[]) {
    this.solutionPanel.classList.add("hidden");
    this.editorSection.classList.add("hidden");
    this.solutionViewEl.classList.remove("hidden");
    this.solutionView?.dispose();
    this.solutionView = new SolutionView({ board: toBoard(config), moves });
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
    this.solutionPanel.classList.remove("hidden");
    this.solutionStatus.textContent = "";
    this.solutionMessage.textContent = "";
    this.solutionProgress.textContent = "Searching…";
    this.solutionCancel.textContent = "Cancel";
    this.setSolving(true);
  }

  private setSolving(solving: boolean) {
    this.solveButton.toggleAttribute("disabled", solving);
    this.solutionSpinner.classList.toggle("hidden", !solving);
  }

  private cancelSearch() {
    this.solveGeneration++;
    this.search?.cancel();
    this.search = null;
    this.pendingConfig = null;
    this.setSolving(false);
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
    downloadJson(this.currentConfig(), "matchThreeTest.json");
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
  private applyLoadedConfig(config: MatchThreeTest) {
    this.hideSolution();
    this.gridWidth = config.gridWidth;
    this.gridHeight = config.gridHeight;
    this.widthField.value = String(this.gridWidth);
    this.heightField.value = String(this.gridHeight);
    this.replaceBoard();
    this.board.loadConfig(config);
    this.render();
  }

  /**
   * Drops whatever the solver last said. Called on every board edit, so it
   * does nothing unless there is something to drop — a drag fires it once per
   * cell and must stay free.
   */
  hideSolution() {
    if (this.search) this.cancelSearch();
    this.solutionPanel.classList.add("hidden");
    if (this.solutionView) this.exitSolutionView();
  }
}

// Module-scope so the editor (and the DOM listeners it owns) lives as long as
// the page does, rather than reading as an object constructed and dropped.
// A const holder rather than an exported `let`: a mutable export would let
// importers observe the binding change out from under them.
export const page: { editor?: MatchThreeSolverEditor } = {};

if (process.env.NODE_ENV !== "test") {
  // SharedArrayBuffer is what the wasm arms' threads build needs, and GitHub
  // Pages cannot grant it with real headers. The shim reloads the page once
  // when its service worker activates, which is why every e2e visit here has
  // to go through gotoIsolated.
  registerCoiShim();
  page.editor = new MatchThreeSolverEditor();
}
