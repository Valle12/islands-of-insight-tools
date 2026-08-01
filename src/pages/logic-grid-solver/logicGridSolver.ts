import { downloadJson, readJsonFile } from "./../../util/configFile";
import {
  openResetDialog,
  parsePositiveInt,
  warningBanner,
  wireConfigIo,
  wireResetDialog,
} from "./../../util/editorShell";
import type {
  LogicGridSymbolValue,
  LogicGridTest,
  LogicGridTool,
} from "./../../util/types";
import { Board } from "./board";
import { MAX_GRID_SIDE, validateConfig } from "./config";
import { RULES } from "./rules";
import { solveLogicGrid } from "./solver";
import {
  MIN_AREA_VALUE,
  normalizeSymbolInput,
  parseSymbolValue,
  SYMBOL_KINDS,
  symbolKindAt,
  type LogicGridSymbolKind,
} from "./symbols";

/** What each clue kind's value field starts out holding. */
function defaultValues(): string[] {
  return SYMBOL_KINDS.map(kind => (kind.valueKind === "number" ? "1" : "A"));
}

export class LogicGridSolverEditor {
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
  private readonly ruleRow = document.getElementById(
    "rule-row",
  ) as HTMLDivElement;

  /** An `<output>`, so only what any element has is used on it. */
  private readonly solutionPanel = document.getElementById(
    "solution-panel",
  ) as HTMLElement;
  private readonly solutionStatus = document.getElementById(
    "solution-status",
  ) as HTMLSpanElement;
  private readonly solutionMessage = document.getElementById(
    "solution-message",
  ) as HTMLDivElement;
  private readonly solveButton = document.getElementById(
    "solve-puzzle",
  ) as HTMLButtonElement;

  private readonly showWarning = warningBanner(
    document.getElementById("warning-banner") as HTMLDivElement,
  );
  private readonly fileInput = document.getElementById(
    "config-file-input",
  ) as HTMLInputElement;

  private gridWidth = LogicGridSolverEditor.DEFAULT_GRID_WIDTH;
  private gridHeight = LogicGridSolverEditor.DEFAULT_GRID_HEIGHT;
  /** Dark is the default so the untouched page paints dark left, light right. */
  private selectedTool: LogicGridTool = "dark";
  private selectedSymbol = 0;
  private readonly activeRules = new Set<number>();
  /**
   * What the value field holds, per clue kind — kept per kind so switching
   * chips does not throw away the number you were part way through typing.
   */
  private symbolValues = defaultValues();
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
      this.currentSymbolValue(),
    );
  }

  /** An area can never name more cells than the board has. */
  private maxArea() {
    return this.gridWidth * this.gridHeight;
  }

  /** What clue kind `index` would stamp, or null while its field is unusable. */
  private valueOf(index: number): LogicGridSymbolValue | null {
    const kind = symbolKindAt(index);
    if (!kind) return null;
    const raw = this.symbolValues[index] ?? "";
    return parseSymbolValue(kind, raw, this.maxArea());
  }

  /** The value the symbol tool stamps, or null while its field is unusable. */
  private currentSymbolValue(): LogicGridSymbolValue | null {
    return this.valueOf(this.selectedSymbol);
  }

  /**
   * The tool buttons, across every row that holds them. Keyed on `data-tool`
   * rather than on a row id: the clue chips beside them share the
   * `.tool-button` class for its styling but are driven by the delegated
   * `#symbol-row` handler instead, and the rows themselves are a layout
   * decision that has already changed once.
   */
  private toolButtons() {
    return document.querySelectorAll<HTMLButtonElement>(
      "#paint-tools .tool-button[data-tool]",
    );
  }

  private addListeners() {
    this.toolButtons().forEach(button => {
      button.addEventListener("click", () => {
        this.handleToolClick(button.dataset.tool as LogicGridTool);
      });
    });

    // Both rows are built by JS from their append-only lists, so their clicks
    // are delegated to the rows rather than bound per chip.
    this.symbolRow.addEventListener("click", event => {
      const chip = this.chipFrom(event.target);
      if (!chip) return;
      const index = Number(chip.dataset.symbolIndex);
      if (Number.isInteger(index)) this.selectSymbol(index);
    });

    // The value fields live INSIDE the row, so this cannot rebuild it — see
    // `refreshSymbolRow`.
    this.symbolRow.addEventListener("input", event => {
      const field = event.target;
      if (!(field instanceof HTMLInputElement)) return;
      const index = Number(field.dataset.symbolIndex);
      if (Number.isInteger(index)) this.handleValueInput(index, field.value);
    });

    this.ruleRow.addEventListener("click", event => {
      const chip = this.chipFrom(event.target);
      if (!chip) return;
      const index = Number(chip.dataset.ruleIndex);
      if (Number.isInteger(index)) this.toggleRule(index);
    });

    wireResetDialog(() => {
      this.resetToDefaults();
      this.hideSolution();
      this.render();
    });

    this.solveButton.addEventListener("click", () => this.solve());

    wireConfigIo({
      fileInput: this.fileInput,
      dropOverlay: document.getElementById("drop-overlay") as HTMLDivElement,
      onFile: file => void this.loadConfigFromFile(file),
      onDownload: () => this.downloadCurrentConfig(),
    });

    this.widthField.addEventListener("input", () => this.handleSizeUpdate());
    this.heightField.addEventListener("input", () => this.handleSizeUpdate());
  }

  private chipFrom(target: EventTarget | null): HTMLElement | null {
    if (!(target instanceof HTMLElement)) return null;
    return target.closest(".tool-button");
  }

  /** Paint tools select; `reset` is a command, not a tool. */
  private handleToolClick(tool: LogicGridTool) {
    if (tool === "reset") {
      openResetDialog();
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
    this.board.setSymbolValue(this.currentSymbolValue());
    this.renderTools();
  }

  /**
   * Typing a value is a declaration of intent to place that clue, so it selects
   * the kind as well — otherwise the field beside a chip could be edited while
   * a different chip stayed armed.
   */
  private handleValueInput(index: number, raw: string) {
    const kind = symbolKindAt(index);
    this.symbolValues[index] = kind ? normalizeSymbolInput(kind, raw) : raw;
    if (this.selectedTool !== "symbol" || this.selectedSymbol !== index) {
      this.selectSymbol(index);
      return;
    }
    this.board.setSymbolValue(this.currentSymbolValue());
    this.refreshSymbolRow();
  }

  /** Rules are board-wide flags, so a chip is a plain on/off toggle. */
  private toggleRule(index: number) {
    if (this.activeRules.has(index)) {
      this.activeRules.delete(index);
    } else {
      this.activeRules.add(index);
    }
    this.hideSolution();
    this.refreshRuleRow();
  }

  private handleSizeUpdate() {
    const parsedWidth = parsePositiveInt(this.widthField.value, MAX_GRID_SIDE);
    const parsedHeight = parsePositiveInt(
      this.heightField.value,
      MAX_GRID_SIDE,
    );
    if (!parsedWidth || !parsedHeight) return;
    if (parsedWidth === this.gridWidth && parsedHeight === this.gridHeight) {
      return;
    }
    this.gridWidth = parsedWidth;
    this.gridHeight = parsedHeight;
    // A resize means a different puzzle, so both cell layers go with it. The
    // rules describe the puzzle rather than the board, so they stay.
    this.replaceBoard();
    this.hideSolution();
    this.render();
  }

  private resetToDefaults() {
    this.gridWidth = LogicGridSolverEditor.DEFAULT_GRID_WIDTH;
    this.gridHeight = LogicGridSolverEditor.DEFAULT_GRID_HEIGHT;
    this.widthField.value = String(this.gridWidth);
    this.heightField.value = String(this.gridHeight);
    this.selectedTool = "dark";
    this.selectedSymbol = 0;
    this.activeRules.clear();
    this.symbolValues = defaultValues();
    this.replaceBoard();
  }

  /** Full redraw — only needed when the board itself changed. */
  render() {
    this.board.renderGrid();
    this.buildSymbolRow();
    this.buildRuleRow();
    this.renderTools();
    this.refreshRuleRow();
  }

  /**
   * Restyles the chip rows in place. Picking a tool or a clue kind leaves every
   * cell untouched, so rebuilding the grid for it would repaint the whole board
   * for nothing — and rebuilding the CHIP ROWS would throw away the focus and
   * caret of whichever value field is being typed into.
   */
  private renderTools() {
    this.renderToolButtons();
    this.refreshSymbolRow();
  }

  private renderToolButtons() {
    this.toolButtons().forEach(button => {
      const tool = button.dataset.tool;
      button.classList.toggle("selected", tool === this.selectedTool);
    });

    const [primary, secondary] = this.toolLabels();
    this.statusEl.textContent = `Selected tool: ${primary} · Right-click: ${secondary}`;
  }

  /**
   * What the two mouse buttons do, as the status line says it. The right button
   * paints the other colour where there is one and lifts what is there where
   * there is not.
   */
  private toolLabels(): [string, string] {
    switch (this.selectedTool) {
      case "light":
        return ["Light", "Dark"];
      case "unplayable":
        return ["Unplayable", "Erase"];
      case "erase":
        return ["Eraser", "Erase"];
      case "symbol":
        return [
          symbolKindAt(this.selectedSymbol)?.label ?? "Symbol",
          "Remove symbol",
        ];
      default:
        return ["Dark", "Light"];
    }
  }

  /**
   * One clue kind as a split control: the chip that selects it, a hairline
   * divider, and the value it will stamp.
   *
   * The value belongs beside its own chip rather than in one shared field
   * below the row — a single field has to keep saying which clue it is for,
   * and every kind added makes that worse. Both current kinds carry a value;
   * a kind that carried none would render the chip alone.
   */
  private symbolTool(kind: LogicGridSymbolKind, index: number) {
    const numeric = kind.valueKind === "number";
    const limits = numeric
      ? `type="number" min="${MIN_AREA_VALUE}" max="${this.maxArea()}"`
      : 'type="text" maxlength="1"';
    return `
      <div class="symbol-tool" data-symbol="${kind.id}">
        <button class="tool-button symbol-chip" type="button"
          data-symbol-index="${index}" data-symbol="${kind.id}"
          title="${kind.label}" aria-label="${kind.label}"
        ><span class="symbol-sample">${kind.sample}</span></button>
        <span class="symbol-divider" aria-hidden="true"></span>
        <input class="symbol-value" data-symbol-index="${index}" ${limits}
          aria-label="${kind.label} value" />
      </div>
    `;
  }

  /**
   * Built from the list rather than written into the HTML: `SYMBOL_KINDS` is
   * append-only and a new kind must cost no markup edit. Called only when the
   * board is replaced, because it destroys the value fields — everything else
   * goes through `refreshSymbolRow`.
   */
  private buildSymbolRow() {
    this.symbolRow.innerHTML = SYMBOL_KINDS.map((kind, index) =>
      this.symbolTool(kind, index),
    ).join("");
  }

  /**
   * Restyles the clue row without rebuilding it, and shows each field's own
   * validity: an unusable value stamps nothing, so it has to say so.
   */
  private refreshSymbolRow() {
    SYMBOL_KINDS.forEach((kind, index) => {
      const tool = this.symbolRow.querySelector<HTMLElement>(
        `.symbol-tool[data-symbol="${kind.id}"]`,
      );
      const field = tool?.querySelector<HTMLInputElement>(".symbol-value");
      if (!tool || !field) return;

      const selected =
        this.selectedTool === "symbol" && this.selectedSymbol === index;
      tool.classList.toggle("selected", selected);

      const raw = this.symbolValues[index] ?? "";
      // Never write what is already there: assigning `value` moves the caret
      // to the end, and this runs while the user is typing into the field.
      if (field.value !== raw) field.value = raw;

      if (this.valueOf(index) === null) {
        field.setAttribute("aria-invalid", "true");
      } else {
        field.removeAttribute("aria-invalid");
      }
    });
  }

  /** Same reasoning as the clue row: `RULES` is append-only. */
  private buildRuleRow() {
    this.ruleRow.innerHTML = RULES.map(
      (rule, index) => `
      <button class="tool-button rule-chip" type="button"
        data-rule-index="${index}" data-rule="${rule.id}"
      >${rule.label}</button>
    `,
    ).join("");
  }

  /**
   * Toggles the rule chips in place. Rebuilding the row would replace the chip
   * that was just clicked, which drops the focus a keyboard user was holding.
   */
  private refreshRuleRow() {
    RULES.forEach((rule, index) => {
      const chip = this.ruleRow.querySelector<HTMLButtonElement>(
        `.rule-chip[data-rule="${rule.id}"]`,
      );
      if (!chip) return;
      const active = this.activeRules.has(index);
      chip.classList.toggle("selected", active);
      chip.setAttribute("aria-pressed", String(active));
    });
  }

  private currentConfig(): LogicGridTest {
    return {
      gridWidth: this.gridWidth,
      gridHeight: this.gridHeight,
      rules: [...this.activeRules].sort((a, b) => a - b),
      cells: this.board.getCells(),
      symbols: this.board.getSymbols(),
    };
  }

  private solve() {
    const result = solveLogicGrid(this.currentConfig());
    this.solutionPanel.classList.remove("hidden");
    this.solutionStatus.textContent = "Not implemented";
    this.solutionMessage.textContent =
      `The solver is not written yet. Your puzzle (${result.summary}) is ` +
      "complete though — download it, and it will load straight back in once " +
      "the search lands.";
  }

  private downloadCurrentConfig() {
    downloadJson(this.currentConfig(), "logicGridTest.json");
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
  private applyLoadedConfig(config: LogicGridTest) {
    this.hideSolution();
    this.gridWidth = config.gridWidth;
    this.gridHeight = config.gridHeight;
    this.widthField.value = String(this.gridWidth);
    this.heightField.value = String(this.gridHeight);
    this.activeRules.clear();
    for (const rule of config.rules) this.activeRules.add(rule);
    this.replaceBoard();
    this.board.loadConfig(config);
    this.render();
  }

  /**
   * Drops whatever the solver last said. Called on every board edit, so it does
   * nothing unless there is something to drop — a drag fires it once per cell
   * and must stay free.
   */
  hideSolution() {
    this.solutionPanel.classList.add("hidden");
  }
}

// Module-scope so the editor (and the DOM listeners it owns) lives as long as
// the page does, rather than reading as an object constructed and dropped.
// A const holder rather than an exported `let`: a mutable export would let
// importers observe the binding change out from under them.
export const page: { editor?: LogicGridSolverEditor } = {};

if (process.env.NODE_ENV !== "test") {
  page.editor = new LogicGridSolverEditor();
}
