import {
  downloadJson,
  readJsonFile,
  setupDragAndDrop,
} from "./../../util/configFile";
import type { MatchThreeTest, MatchThreeTool } from "./../../util/types";
import { Board } from "./board";
import { MAX_COLORS, MAX_GRID_SIDE, validateConfig } from "./config";

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
  private readonly colorRow = document.getElementById(
    "color-row",
  ) as HTMLDivElement;

  private readonly solutionPanel = document.getElementById(
    "solution-panel",
  ) as HTMLDivElement;
  private readonly solutionStatus = document.getElementById(
    "solution-status",
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

  private gridWidth = MatchThreeSolverEditor.DEFAULT_GRID_WIDTH;
  private gridHeight = MatchThreeSolverEditor.DEFAULT_GRID_HEIGHT;
  private selectedTool: MatchThreeTool = "color";
  private selectedColorIndex = 0;
  private board: Board;

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
  private replaceBoard(palette?: readonly string[]) {
    this.board.dispose();
    this.board = this.createBoard(palette);
  }

  private createBoard(palette?: readonly string[]) {
    return new Board(
      this,
      this.gridWidth,
      this.gridHeight,
      this.selectedTool,
      this.selectedColorIndex,
      palette,
    );
  }

  private addListeners() {
    // Scoped to #tool-row: the color chips share the `.tool-button` class for
    // its styling but are driven by the delegated #color-row handler instead.
    const toolButtons = document.querySelectorAll<HTMLButtonElement>(
      "#tool-row .tool-button",
    );
    toolButtons.forEach(button => {
      button.addEventListener("click", () => {
        this.handleToolClick(button.dataset.tool as MatchThreeTool);
      });
    });

    // The color chips are re-rendered on every Add Color, so per-chip
    // listeners would not survive; the row handles their clicks instead.
    this.colorRow.addEventListener("click", event => {
      const target = event.target as HTMLElement;
      const chip = target.closest(".color-chip") as HTMLElement | null;
      if (!chip) return;
      const index = Number(chip.dataset.colorIndex);
      if (!Number.isInteger(index)) return;
      this.selectColor(index);
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

    document.getElementById("solve-puzzle")?.addEventListener("click", () => {
      this.showSolverPlaceholder();
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
  }

  /** Paint tools select; `addColor` and `reset` are commands, not tools. */
  private handleToolClick(tool: MatchThreeTool) {
    if (tool === "addColor") {
      this.addColor();
      return;
    }

    if (tool === "reset") {
      (document.getElementById("reset-dialog") as HTMLDialogElement).show();
      return;
    }

    this.selectedTool = tool;
    this.board.setSelectedTool(tool);
    this.renderTools();
  }

  private addColor() {
    if (!this.board.addColor()) {
      this.showWarning(`A board may use at most ${MAX_COLORS} colors.`);
      return;
    }
    // Selecting the new color is what the user is after nine times out of ten.
    this.selectColor(this.board.getPalette().length - 1);
  }

  private selectColor(index: number) {
    this.selectedTool = "color";
    this.selectedColorIndex = index;
    this.board.setSelectedTool("color");
    this.board.setSelectedColorIndex(index);
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
    // Resizing clears the cells but keeps the colors already collected —
    // losing the palette on every keystroke in the size field would be worse.
    this.replaceBoard(this.board.getPalette());
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
    this.selectedTool = "color";
    this.selectedColorIndex = 0;
    this.replaceBoard();
  }

  /** Full redraw — only needed when the board itself changed. */
  render() {
    this.board.renderGrid();
    this.renderTools();
  }

  /**
   * Redraws the two chip rows alone. Picking a tool or a color leaves every
   * cell untouched, so rebuilding the grid for it would repaint the whole
   * board for nothing.
   */
  private renderTools() {
    this.renderToolButtons();
    this.renderColorTools();
  }

  private renderToolButtons() {
    // Scoped to #tool-row: the color chips share the `.tool-button` class for
    // its styling but are driven by the delegated #color-row handler instead.
    const toolButtons = document.querySelectorAll<HTMLButtonElement>(
      "#tool-row .tool-button",
    );
    toolButtons.forEach(button => {
      const tool = button.dataset.tool;
      button.classList.toggle("selected", tool === this.selectedTool);
    });

    let label: string;
    switch (this.selectedTool) {
      case "blocked":
        label = "Blocked";
        break;
      case "empty":
        label = "Eraser";
        break;
      default:
        label = `Color ${this.selectedColorIndex + 1}`;
    }

    this.statusEl.textContent = `Selected tool: ${label}`;
  }

  private renderColorTools() {
    this.colorRow.innerHTML = this.board
      .getPalette()
      .map((color, index) => {
        const selected =
          this.selectedTool === "color" && this.selectedColorIndex === index;
        return `
          <button class="tool-button color-chip${selected ? " selected" : ""}"
            type="button" data-color-index="${index}"
            style="--chip-color: ${color}">Color ${index + 1}</button>
        `;
      })
      .join("");
  }

  private showSolverPlaceholder() {
    this.solutionPanel.classList.remove("hidden");
    this.solutionStatus.textContent = "Not available yet";
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
    downloadJson(
      {
        gridWidth: this.gridWidth,
        gridHeight: this.gridHeight,
        colors: this.board.getPalette(),
        cells: this.board.getCells(),
      },
      "matchThreeTest.json",
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
  private applyLoadedConfig(config: MatchThreeTest) {
    this.hideSolution();
    this.gridWidth = config.gridWidth;
    this.gridHeight = config.gridHeight;
    this.widthField.value = String(this.gridWidth);
    this.heightField.value = String(this.gridHeight);
    // A config may carry fewer colors than the board had selected.
    this.selectedColorIndex = Math.min(
      this.selectedColorIndex,
      config.colors.length - 1,
    );
    this.replaceBoard(config.colors);
    this.board.loadConfig(config);
    this.board.setSelectedColorIndex(this.selectedColorIndex);
    this.render();
  }

  hideSolution() {
    this.solutionPanel.classList.add("hidden");
  }
}

// Module-scope so the editor (and the DOM listeners it owns) lives as long as
// the page does, rather than reading as an object constructed and dropped.
// A const holder rather than an exported `let`: a mutable export would let
// importers observe the binding change out from under them.
export const page: { editor?: MatchThreeSolverEditor } = {};

if (process.env.NODE_ENV !== "test") {
  page.editor = new MatchThreeSolverEditor();
}
