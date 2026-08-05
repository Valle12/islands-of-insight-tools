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
import { CONFIG_VERSION, MAX_GRID_SIDE, validateConfig } from "./config";
import { RULE_DISPLAY_ORDER, RULES } from "./rules";
import {
  solveLogicGrid,
  type LogicGridSolveResult,
  type SolveHandle,
} from "./solver";
import { SolutionView } from "./solutionView";
import { UNDERCLUED } from "./verify";
import { dressClue } from "./cellView";
import {
  AXES,
  AXIS_ICON,
  axisIndex,
  DEFAULT_AXIS,
  DEFAULT_DIRECTION,
  DIRECTION_ICON,
  DIRECTIONS,
  directionIndex,
  normalizeSymbolInput,
  parseSymbolValue,
  SYMBOL_KINDS,
  symbolKindAt,
  symbolValueMax,
  type LogicGridSymbolKind,
} from "./symbols";

/** What each clue kind's value field starts out holding. A valueless kind has
 * no field, so its slot is never read. */
function defaultValues(): string[] {
  return SYMBOL_KINDS.map(kind => {
    if (kind.valueKind === "number") return "1";
    return kind.valueKind === "letter" ? "A" : "";
  });
}

/** Which way each directed kind starts out aimed — compass kinds point right,
 * axis kinds lie horizontal. */
function defaultDirections(): number[] {
  return SYMBOL_KINDS.map(kind =>
    kind.aims === "axis" ? DEFAULT_AXIS : DEFAULT_DIRECTION,
  );
}

/** The aim a kind's chip miniature is drawn with — always its DEFAULT: the
 * chip says which kind this is, and the toggles say where the next one will
 * point. Undefined for a kind that aims nowhere. */
function defaultAimOf(kind: LogicGridSymbolKind): number | undefined {
  if (kind.aims === "compass") return DEFAULT_DIRECTION;
  return kind.aims === "axis" ? DEFAULT_AXIS : undefined;
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
  private readonly solutionSpinner = document.getElementById(
    "solution-spinner",
  ) as HTMLDivElement;
  private readonly solutionProgressText = document.getElementById(
    "solution-progress-text",
  ) as HTMLSpanElement;
  private readonly editorSection = document.getElementById(
    "editor-section",
  ) as HTMLDivElement;
  private readonly solutionViewEl = document.getElementById(
    "solution-view",
  ) as HTMLDivElement;
  private readonly solveButton = document.getElementById(
    "solve-puzzle",
  ) as HTMLButtonElement;

  private solutionView: SolutionView | null = null;
  /** The search in flight, or null. */
  private search: SolveHandle | null = null;
  /**
   * Which solve the page is waiting for. A result from an earlier one is
   * dropped rather than drawn: the board it answers no longer exists.
   */
  private solveGeneration = 0;

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
      this.currentSymbolDirection(),
    );
  }

  /** The board a clue's value is measured against. */
  private gridSize() {
    return { gridWidth: this.gridWidth, gridHeight: this.gridHeight };
  }

  /** What clue kind `index` would stamp, or null while its field is unusable. */
  private valueOf(index: number): LogicGridSymbolValue | null {
    const kind = symbolKindAt(index);
    if (!kind) return null;
    const raw = this.symbolValues[index] ?? "";
    return parseSymbolValue(kind, raw, this.gridSize());
  }

  /** Which way clue kind `index` is aimed, or null when it points nowhere. */
  private directionOf(index: number): number | null {
    const kind = symbolKindAt(index);
    if (!kind || kind.aims === "none") return null;
    return (
      this.symbolDirections[index] ??
      (kind.aims === "axis" ? DEFAULT_AXIS : DEFAULT_DIRECTION)
    );
  }

  /** The value the symbol tool stamps, or null while its field is unusable. */
  private currentSymbolValue(): LogicGridSymbolValue | null {
    return this.valueOf(this.selectedSymbol);
  }

  /** The direction the symbol tool stamps, or null for an undirected kind. */
  private currentSymbolDirection(): number | null {
    return this.directionOf(this.selectedSymbol);
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
      const arrow = this.arrowFrom(event.target);
      if (arrow) {
        const aim =
          arrow.dataset.axis === undefined
            ? directionIndex(arrow.dataset.direction)
            : axisIndex(arrow.dataset.axis);
        this.selectDirection(Number(arrow.dataset.symbolIndex), aim);
        return;
      }
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
    document
      .getElementById("solution-cancel")
      ?.addEventListener("click", () => this.cancelSearch());
    document
      .getElementById("solution-exit")
      ?.addEventListener("click", () => this.exitSolutionView());

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

  private arrowFrom(target: EventTarget | null): HTMLElement | null {
    if (!(target instanceof HTMLElement)) return null;
    return target.closest(".direction-toggle");
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
    this.symbolDirections = defaultDirections();
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
      case "merge":
        return ["Merge cells", "Split cells"];
      default:
        return ["Dark", "Light"];
    }
  }

  /**
   * The four arrows a directed kind is aimed with, as one segmented end to its
   * control.
   *
   * Inline rather than behind a menu: there are only four, one click has to be
   * enough to change aim, and which way the clue points is worth seeing without
   * opening anything. They deliberately do NOT carry `.symbol-chip` — that
   * class means "the clue kinds", and the tests count it.
   */
  private directionToggles(kind: LogicGridSymbolKind, index: number) {
    // Each toggle carries `data-direction` on itself, which is the same hook
    // the stylesheet turns a tile's arrow with — so one glyph faces four ways
    // here exactly as it does on the board.
    const buttons = DIRECTIONS.map(
      direction => `
        <button class="direction-toggle" type="button"
          data-symbol-index="${index}" data-direction="${direction.id}"
          title="${direction.label}"
          aria-label="${kind.label} pointing ${direction.label.toLowerCase()}"
          aria-pressed="false"
        ><md-icon class="cell-arrow">${DIRECTION_ICON}</md-icon></button>
      `,
    ).join("");
    return `
      <span class="symbol-divider" aria-hidden="true"></span>
      <div class="symbol-directions" role="group"
        aria-label="${kind.label} direction"
      >${buttons}</div>
    `;
  }

  /**
   * The value field of a kind that carries one, with its leading divider. A
   * valueless kind renders nothing here: its control is the chip and the axis
   * toggles with no field between.
   */
  private valueField(kind: LogicGridSymbolKind, index: number) {
    if (kind.valueKind === "none") return "";
    const numeric = kind.valueKind === "number";
    const max = symbolValueMax(kind, this.gridSize());
    const limits = numeric
      ? `type="number" min="${kind.minValue}" max="${max}"`
      : 'type="text" maxlength="1"';
    // The field is sized to the longest value its own kind could hold, rather
    // than every kind paying for the widest: an area on a 32x32 board runs to
    // four digits, a letter is one character, and a dart can never outgrow the
    // board's longest line. Without that the four arrows below made the dart's
    // control much wider than it had any need to be.
    const chars = numeric ? String(max).length : 1;
    return `
        <span class="symbol-divider" aria-hidden="true"></span>
        <input class="symbol-value" data-symbol-index="${index}" ${limits}
          style="--value-chars: ${chars}" aria-label="${kind.label} value" />
    `;
  }

  /**
   * The four axes an axis-aimed kind is laid along — the lotus's counterpart
   * to `directionToggles`, one glyph turned four ways by `data-axis` exactly
   * as the tile turns it. Same class as the compass arrows on purpose: the
   * styling and the "not a `.symbol-chip`" rule are about being a segmented
   * picker, not about what the segments mean.
   */
  private axisToggles(kind: LogicGridSymbolKind, index: number) {
    const buttons = AXES.map(
      axis => `
        <button class="direction-toggle" type="button"
          data-symbol-index="${index}" data-axis="${axis.id}"
          title="${axis.label}"
          aria-label="${kind.label} along the ${axis.label.toLowerCase()} axis"
          aria-pressed="false"
        ><md-icon class="cell-axis">${AXIS_ICON}</md-icon></button>
      `,
    ).join("");
    return `
      <span class="symbol-divider" aria-hidden="true"></span>
      <div class="symbol-directions" role="group"
        aria-label="${kind.label} axis"
      >${buttons}</div>
    `;
  }

  /** The picker a kind's aims call for, or nothing for an unaimed kind. */
  private aimToggles(kind: LogicGridSymbolKind, index: number) {
    if (kind.aims === "compass") return this.directionToggles(kind, index);
    return kind.aims === "axis" ? this.axisToggles(kind, index) : "";
  }

  /**
   * One clue kind as a split control: the chip that selects it, then — each
   * with its own hairline divider — the value it will stamp and the aim it
   * will stamp, for the kinds that carry one.
   *
   * Everything belongs beside its own chip rather than in one shared field
   * below the row — a single field has to keep saying which clue it is for,
   * and every kind added makes that worse.
   */
  private symbolTool(kind: LogicGridSymbolKind, index: number) {
    return `
      <div class="symbol-tool" data-symbol="${kind.id}">
        <button class="tool-button symbol-chip" type="button"
          data-symbol-index="${index}" data-symbol="${kind.id}"
          title="${kind.label}" aria-label="${kind.label}"
        ><span class="symbol-sample"></span></button>
        ${this.valueField(kind, index)}
        ${this.aimToggles(kind, index)}
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

    // The sample is filled AFTERWARDS rather than written into the markup
    // above, because a directed kind's chip is a miniature of the tile and
    // `dressClue` is what draws one. A chip that spelled its own arrow out
    // would be a second drawing of the same thing, free to drift from it.
    //
    // Always shown in its DEFAULT aim — right, or the horizontal axis —
    // whatever is currently armed: the chip says which KIND of clue this is,
    // and the toggles beside it are what say where the next one will point.
    SYMBOL_KINDS.forEach(kind => {
      const sample = this.symbolRow.querySelector<HTMLElement>(
        `.symbol-tool[data-symbol="${kind.id}"] .symbol-sample`,
      );
      if (!sample) return;
      dressClue(sample, kind, kind.sample, defaultAimOf(kind));
    });
  }

  /**
   * Restyles the clue row without rebuilding it, and shows each field's own
   * validity: an unusable value stamps nothing, so it has to say so.
   *
   * The field is refreshed only where one exists — a valueless kind renders
   * none — while the selected state and the aim toggles refresh regardless.
   * An early return on the missing field would silently skip both.
   */
  private refreshSymbolRow() {
    SYMBOL_KINDS.forEach((kind, index) => {
      const tool = this.symbolRow.querySelector<HTMLElement>(
        `.symbol-tool[data-symbol="${kind.id}"]`,
      );
      if (!tool) return;

      const selected =
        this.selectedTool === "symbol" && this.selectedSymbol === index;
      tool.classList.toggle("selected", selected);

      const field = tool.querySelector<HTMLInputElement>(".symbol-value");
      if (field) {
        const raw = this.symbolValues[index] ?? "";
        // Never write what is already there: assigning `value` moves the caret
        // to the end, and this runs while the user is typing into the field.
        if (field.value !== raw) field.value = raw;

        if (this.valueOf(index) === null) {
          field.setAttribute("aria-invalid", "true");
        } else {
          field.removeAttribute("aria-invalid");
        }
      }

      const aimed = this.directionOf(index);
      tool.querySelectorAll<HTMLElement>(".direction-toggle").forEach(arrow => {
        const target =
          arrow.dataset.axis === undefined
            ? directionIndex(arrow.dataset.direction)
            : axisIndex(arrow.dataset.axis);
        const on = target === aimed;
        arrow.classList.toggle("selected", on);
        arrow.setAttribute("aria-pressed", String(on));
      });
    });
  }

  /**
   * Same reasoning as the clue row: `RULES` is append-only.
   *
   * Which is why the row is drawn in `RULE_DISPLAY_ORDER` and not in catalogue
   * order — a rule appended to keep saved puzzles working still belongs beside
   * its family on screen. The index written into the chip is the STORED one, so
   * everything downstream keeps reading that attribute rather than counting
   * chips.
   */
  private buildRuleRow() {
    this.ruleRow.innerHTML = RULE_DISPLAY_ORDER.map(index => {
      const rule = RULES[index]!;
      return `
      <button class="tool-button rule-chip" type="button"
        data-rule-index="${index}" data-rule="${rule.id}"
      >${rule.label}</button>
    `;
    }).join("");
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
    const shapes = this.board.getShapes();
    return {
      // First, so a downloaded file says which format it is in before it says
      // anything else. Always the current version: this is what the editor
      // holds, whatever version the file it came from was written in.
      version: CONFIG_VERSION,
      gridWidth: this.gridWidth,
      gridHeight: this.gridHeight,
      rules: [...this.activeRules].sort((a, b) => a - b),
      cells: this.board.getCells(),
      symbols: this.board.getSymbols(),
      // Omitted rather than written empty: every captured fixture predates the
      // key, and `config.test.ts` asserts they all round-trip byte-identically.
      ...(shapes ? { shapes } : {}),
    };
  }

  private solve() {
    if (this.search) return;
    const config = this.currentConfig();
    const generation = ++this.solveGeneration;

    this.solutionPanel.classList.remove("hidden");
    this.solutionSpinner.classList.remove("hidden");
    this.solutionStatus.textContent = "Working";
    this.solutionMessage.textContent = "";
    this.solutionProgressText.textContent = "Deducing…";
    this.solveButton.disabled = true;

    this.search = solveLogicGrid(config, {
      onProgress: (nodes, decided) => {
        if (generation !== this.solveGeneration) return;
        // The step count is the part that keeps moving. `decided` comes from
        // the deduction pass, which finishes in milliseconds and then never
        // changes again — on a board that needs the long search it would sit
        // frozen at its number for the whole minute, which reads as a hang.
        const steps = `${nodes.toLocaleString()} steps`;
        this.solutionProgressText.textContent =
          decided > 0
            ? `Deducing… ${decided} cells settled, ${steps}`
            : `Deducing… ${steps}`;
      },
      onDone: result => {
        if (generation !== this.solveGeneration) return;
        this.finishSolve(config, result);
      },
    });
  }

  private cancelSearch() {
    this.search?.cancel();
    this.search = null;
    this.solveGeneration++;
    this.solutionSpinner.classList.add("hidden");
    this.solveButton.disabled = false;
  }

  private finishSolve(config: LogicGridTest, result: LogicGridSolveResult) {
    this.search = null;
    this.solutionSpinner.classList.add("hidden");
    this.solveButton.disabled = false;

    if (result.status === "failed") {
      // Every arm died. The raw text is whatever the module threw — useful in a
      // bug report and meaningless to a player — so it goes after a sentence
      // that says what actually happened and what to do about it.
      this.solutionStatus.textContent = "Failed";
      this.solutionMessage.textContent =
        "The solver stopped before it could answer. Reloading the page and " +
        `trying again usually clears it. (${result.error})`;
      return;
    }
    if (result.status === "unsolvable") {
      this.solutionStatus.textContent = "No solution";
      this.solutionMessage.textContent = result.reason
        ? `This board cannot be completed: ${result.reason.toLowerCase()}.`
        : "No colouring of this board satisfies every rule and clue. Every " +
          "puzzle in the game is solvable, so something on the board is not " +
          "what the game showed.";
      return;
    }
    if (result.status === "budget") {
      // Not the same claim as "no solution": the search stopped looking, it did
      // not rule anything out. The nudge about the board is still worth making
      // — every puzzle the game ships can be finished, so a board that runs the
      // clock out is far more often mis-entered than genuinely hard.
      this.solutionStatus.textContent = "Gave up";
      this.solutionMessage.textContent =
        (result.decided > 0
          ? `The time limit ran out. ${result.decided} cells were settled ` +
            "before it did, but the rest are still open. "
          : "The time limit ran out before anything could be settled. ") +
        "Every puzzle in the game can be finished, so it is worth checking " +
        "the board against the one on screen — a missing gap or clue is the " +
        "usual reason.";
      return;
    }
    this.enterSolutionView(config, result);
  }

  private enterSolutionView(
    config: LogicGridTest,
    result: Extract<LogicGridSolveResult, { status: "solved" | "deduced" }>,
  ) {
    this.solutionPanel.classList.add("hidden");
    this.editorSection.classList.add("hidden");
    this.solutionViewEl.classList.remove("hidden");
    this.solutionView?.dispose();
    this.solutionView = new SolutionView({
      config,
      cells: result.cells,
      decided: result.decided,
      playable: result.playable,
      proven: result.status === "deduced" ? result.proven : true,
      underclued: config.rules.includes(UNDERCLUED),
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
      this.showWarning(
        `This board was saved in format version ${result.migratedFrom} and ` +
          `has been updated to version ${CONFIG_VERSION}. Download it again ` +
          `to save the file in the current format.`,
      );
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
    this.replaceBoard();
    this.board.loadConfig(config);
    this.render();
  }

  /**
   * Drops whatever the solver last said. Called on every board edit, so it has
   * to stay cheap — a drag fires it once per cell — which is why the two
   * branches below are guarded rather than run unconditionally.
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
