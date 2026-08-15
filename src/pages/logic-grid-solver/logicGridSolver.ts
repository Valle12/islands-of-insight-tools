import { registerCoiShim } from "./../../common/coiRegister";
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
import {
  CONFIG_VERSION,
  MAX_GRID_SIDE,
  migrationNotice,
  validateConfig,
} from "./config";
import { RULES } from "./rules";
import { SizedRuleControls } from "./sizedRuleControls";
import { SolveController } from "./solveController";
import {
  buildSymbolRow,
  defaultDirections,
  defaultValues,
  refreshSymbolRow,
  symbolAimOf,
  symbolValueOf,
  type SymbolToolState,
} from "./symbolRowView";
import { ruleRowMarkup, toolLabels } from "./toolRowMarkup";
import { OFF_BY_ONE } from "./verify";
import {
  axisIndex,
  directionIndex,
  normalizeSymbolInput,
  symbolKindAt,
} from "./symbols";

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
  /**
   * Which way each directed kind points, kept per kind for the same reason the
   * values are. Carried by the TOOL rather than set on the tile afterwards, so
   * a row of darts can be placed the same way a row of anything else is — the
   * arrow on a placed dart can still be dragged round to change it.
   */
  private symbolDirections = defaultDirections();

  // Declared AFTER `ruleRow`: class field initialisers run in order, and this
  // one reads it.
  private readonly sized = new SizedRuleControls({
    row: this.ruleRow,
    // The order matters. `hideSolution` can reach `render()`, which rebuilds
    // the row and re-fills the slots — so the refresh has to run after it.
    onValuesChanged: () => {
      this.hideSolution();
      this.refreshRuleRow();
    },
  });
  private readonly solution = new SolveController({
    configOf: () => this.currentConfig(),
    onReturnToEditor: () => this.render(),
  });

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
    const board = new Board(
      this,
      this.gridWidth,
      this.gridHeight,
      this.selectedTool,
      this.selectedSymbol,
      this.currentSymbolValue(),
      this.currentSymbolDirection(),
    );
    // The board cannot see `activeRules`, so the off-by-one flag is pushed in
    // here — every path that replaces the board settles the rules first.
    board.setOffByOne(this.gridSize().offByOne);
    return board;
  }

  /** The board a clue's value is measured against — and whether the
   * off-by-one rule is bending every numeric bound by one right now. */
  private gridSize() {
    return {
      gridWidth: this.gridWidth,
      gridHeight: this.gridHeight,
      offByOne: this.activeRules.has(OFF_BY_ONE),
    };
  }

  /** The clue row as `symbolRowView.ts` reads it. */
  private symbolState(): SymbolToolState {
    return {
      size: this.gridSize(),
      armed: this.selectedTool === "symbol" ? this.selectedSymbol : null,
      values: this.symbolValues,
      aims: this.symbolDirections,
    };
  }

  /** The value the symbol tool stamps, or null while its field is unusable. */
  private currentSymbolValue(): LogicGridSymbolValue | null {
    return symbolValueOf(this.symbolValues, this.selectedSymbol, this.gridSize());
  }

  /** The direction the symbol tool stamps, or null for an undirected kind. */
  private currentSymbolDirection(): number | null {
    return symbolAimOf(this.symbolDirections, this.selectedSymbol);
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
      // The arrows sit INSIDE a kind's control, so they are asked about first:
      // one of them is a direction change, not a change of kind. An axis
      // toggle carries `data-axis` where a compass one carries
      // `data-direction`; both resolve to an index in the same key.
      const arrow = arrowFrom(event.target);
      if (arrow) {
        const aim =
          arrow.dataset.axis === undefined
            ? directionIndex(arrow.dataset.direction)
            : axisIndex(arrow.dataset.axis);
        this.selectDirection(Number(arrow.dataset.symbolIndex), aim);
        return;
      }
      const chip = chipFrom(event.target);
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

    // Only the rule CHIPS. The sized controls' add button, value fields and
    // focusout all belong to `sizedRuleControls.ts`, which listens on this
    // same row — the two never match the same target.
    this.ruleRow.addEventListener("click", event => {
      const chip = chipFrom(event.target);
      if (!chip) return;
      const index = Number(chip.dataset.ruleIndex);
      if (Number.isInteger(index)) this.toggleRule(index);
    });

    wireResetDialog(() => {
      this.resetToDefaults();
      this.hideSolution();
      this.render();
    });

    wireConfigIo({
      fileInput: this.fileInput,
      dropOverlay: document.getElementById("drop-overlay") as HTMLDivElement,
      onFile: file => void this.loadConfigFromFile(file),
      onDownload: () => this.downloadCurrentConfig(),
    });

    this.widthField.addEventListener("input", () => this.handleSizeUpdate());
    this.heightField.addEventListener("input", () => this.handleSizeUpdate());
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
    this.board.setSymbolDirection(this.currentSymbolDirection());
    this.renderTools();
  }

  /**
   * Aiming a clue is a declaration of intent to place it, exactly as typing its
   * value is — so an arrow beside an unselected chip selects that chip too,
   * rather than quietly re-aiming a clue that is not armed.
   */
  private selectDirection(index: number, direction: number) {
    if (!Number.isInteger(index) || direction < 0) return;
    this.symbolDirections[index] = direction;
    if (this.selectedTool !== "symbol" || this.selectedSymbol !== index) {
      this.selectSymbol(index);
      return;
    }
    this.board.setSymbolDirection(this.currentSymbolDirection());
    this.refreshSymbolRow();
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
    // Off-by-one moves every numeric bound, and the board checks keystrokes
    // against its own copy of the flag — while the value fields' min/max were
    // written at build time, so the clue row is refreshed too. A placed value
    // the narrowed bounds no longer allow is left standing on purpose: Solve
    // names it, which beats silently editing the player's board.
    this.board.setOffByOne(this.gridSize().offByOne);
    this.refreshSymbolRow();
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
    // A resize means a different puzzle, so everything describing the old one
    // goes with it: both cell layers AND the rule set. Keeping the rules would
    // be the worse default — a new board is entered from a fresh screen in the
    // game, and carrying over a rule silently solves a puzzle nobody set.
    this.activeRules.clear();
    this.sized.reset();
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
    this.sized.reset();
    this.symbolValues = defaultValues();
    this.symbolDirections = defaultDirections();
    this.replaceBoard();
  }

  /** Full redraw — only needed when the board itself changed. */
  render() {
    this.board.renderGrid();
    buildSymbolRow(this.symbolRow, this.gridSize());
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

    const [primary, secondary] = toolLabels(
      this.selectedTool,
      this.selectedSymbol,
    );
    this.statusEl.textContent = `Selected tool: ${primary} · Right-click: ${secondary}`;
  }

  private refreshSymbolRow() {
    refreshSymbolRow(this.symbolRow, this.symbolState());
  }

  /**
   * The rule row, drawn from `RULE_ROW`: bands of folded controls — a pair's
   * two segments toggling independently, a single as its own chip, and one
   * value control per sized family and colour. The index written into a
   * segment is the STORED one, so everything downstream keeps reading that
   * attribute rather than counting chips. Called only from `render()`; the
   * slot values are written afterwards by the sized controls, so user-typed
   * text never lands inside an HTML string.
   */
  private buildRuleRow() {
    this.ruleRow.innerHTML = ruleRowMarkup();
    this.sized.fill();
  }

  /**
   * Toggles the rule controls in place. Rebuilding the row would replace the
   * chip that was just clicked — dropping the focus a keyboard user was
   * holding — and eat the caret of whichever value field is being typed into.
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
    this.sized.refresh();
  }

  private currentConfig(): LogicGridTest {
    const shapes = this.board.getShapes();
    return {
      // First, so a downloaded file says which format it is in before it says
      // anything else. Always the current version: this is what the editor
      // holds, whatever version the file it came from was written in.
      version: CONFIG_VERSION,
      gridWidth: this.gridWidth,
      gridHeight: this.gridHeight,
      rules: [...this.activeRules].sort((a, b) => a - b),
      ...this.sized.configLists(),
      cells: this.board.getCells(),
      symbols: this.board.getSymbols(),
      // Omitted rather than written empty: every captured fixture predates the
      // key, and `config.test.ts` asserts they all round-trip byte-identically.
      ...(shapes ? { shapes } : {}),
    };
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

    // After the board is on screen, not instead of it: an older file is read
    // in full and is not a failure. What the banner is for is the COPY on
    // disk, which is still in the old format until it is written out again.
    if (result.migratedFrom !== undefined) {
      this.showWarning(migrationNotice(result.migratedFrom));
    }
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
    this.sized.load(config);
    this.replaceBoard();
    this.board.loadConfig(config);
    this.render();
  }

  /** Drops whatever the solver last said — `Board` calls this on every edit. */
  hideSolution() {
    this.solution.hide();
  }
}

function chipFrom(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof HTMLElement)) return null;
  return target.closest(".tool-button");
}

function arrowFrom(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof HTMLElement)) return null;
  return target.closest(".direction-toggle");
}

// Module-scope so the editor (and the DOM listeners it owns) lives as long as
// the page does, rather than reading as an object constructed and dropped.
// A const holder rather than an exported `let`: a mutable export would let
// importers observe the binding change out from under them.
export const page: { editor?: LogicGridSolverEditor } = {};

if (process.env.NODE_ENV !== "test") {
  // Registers the COOP/COEP shim and reloads once, which is what lets the
  // pthreads build run its arms on real threads. The page works without it —
  // everything falls back to one worker per arm — but the underclued mode is
  // where the threads earn their keep, so every e2e visit here has to go
  // through gotoIsolated.
  registerCoiShim();
  page.editor = new LogicGridSolverEditor();
}
