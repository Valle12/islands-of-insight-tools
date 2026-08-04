import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import {
  DARK,
  LIGHT,
  UNKNOWN,
  UNPLAYABLE,
} from "../../src/pages/logic-grid-solver/cell";
import { LogicGridSolverEditor } from "../../src/pages/logic-grid-solver/logicGridSolver";
import {
  RULE_DISPLAY_ORDER,
  RULES,
} from "../../src/pages/logic-grid-solver/rules";
import { SYMBOL_KINDS } from "../../src/pages/logic-grid-solver/symbols";
import type { LogicGridTest } from "../../src/util/types";

/**
 * The page's own markup, trimmed to the ids and hooks the editor reaches for.
 * It is mounted for real rather than stubbed through `getElementById` because
 * the editor also runs `querySelectorAll` over `#paint-tools` and delegates the
 * clicks on `#symbol-row` and `#rule-row` to the rows themselves.
 *
 * The tool buttons are split across the same rows the page uses, so a selector
 * that only ever found them in one of them fails here too.
 */
const MARKUP = `
  <div id="editor-section">
    <div id="warning-banner" class="hidden"></div>
    <input id="grid-width" />
    <input id="grid-height" />
    <div id="grid"></div>
    <div id="tool-status"></div>
    <div id="paint-tools">
      <div id="command-row" class="tool-row">
        <button class="tool-button icon-tool" data-tool="erase" type="button">Eraser</button>
        <button class="tool-button icon-tool" data-tool="reset" type="button">Reset</button>
      </div>
      <div id="color-row" class="tool-row">
        <button class="tool-button icon-tool" data-tool="dark" type="button">Dark</button>
        <button class="tool-button icon-tool" data-tool="light" type="button">Light</button>
        <button class="tool-button icon-tool" data-tool="unplayable" type="button">Unplayable</button>
        <button class="tool-button icon-tool" data-tool="merge" type="button">Merge cells</button>
      </div>
      <div id="symbol-row" class="tool-row"></div>
    </div>
    <div id="rule-section">
      <div id="rule-row"></div>
    </div>
    <md-filled-button id="solve-puzzle">Solve Grid</md-filled-button>
    <md-icon-button id="upload-config"></md-icon-button>
    <md-icon-button id="download-config"></md-icon-button>
    <input id="config-file-input" type="file" />
    <output id="solution-panel" class="hidden">
      <span id="solution-status"></span>
      <div id="solution-spinner" class="hidden">
        <span id="solution-progress-text"></span>
        <md-text-button id="solution-cancel">Cancel</md-text-button>
      </div>
      <div id="solution-message"></div>
    </output>
  </div>
  <div id="solution-view" class="hidden">
    <span id="solution-count"></span>
    <div id="solution-grid"></div>
    <div id="solution-note"></div>
    <md-text-button id="solution-exit">Back to editor</md-text-button>
  </div>
  <md-dialog id="reset-dialog">
    <md-text-button id="reset-cancel">Cancel</md-text-button>
    <md-filled-button id="reset-confirm">Reset</md-filled-button>
  </md-dialog>
  <div id="drop-overlay" class="hidden"></div>
`;

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe("LogicGridSolverEditor", () => {
  const byId = (id: string) => document.getElementById(id)!;

  // Scoped to #grid throughout: nothing else on this page renders `.grid-cell`
  // today, and scoping it keeps that true if a solution grid ever arrives.
  const cellAt = (x: number, y: number) =>
    document.querySelector<HTMLElement>(
      `#grid .grid-cell[data-x="${x}"][data-y="${y}"]`,
    )!;

  const toolButton = (tool: string) =>
    document.querySelector<HTMLButtonElement>(
      `#paint-tools .tool-button[data-tool="${tool}"]`,
    )!;

  const symbolChips = () => [
    ...document.querySelectorAll<HTMLButtonElement>("#symbol-row .symbol-chip"),
  ];

  const ruleChips = () => [
    ...document.querySelectorAll<HTMLButtonElement>("#rule-row .rule-chip"),
  ];

  /**
   * One rule chip, by its stable id.
   *
   * The row is drawn in `RULE_DISPLAY_ORDER`, so a chip's position is neither
   * the index a config stores nor anything a test should lean on — and a case
   * that says which rule it is about keeps saying it when the row is
   * rearranged.
   */
  const ruleChip = (id: string) =>
    document.querySelector<HTMLButtonElement>(
      `#rule-row .rule-chip[data-rule="${id}"]`,
    )!;

  /** The value field belonging to clue kind `index`. */
  const valueField = (index: number) =>
    document.querySelector<HTMLInputElement>(
      `#symbol-row .symbol-value[data-symbol-index="${index}"]`,
    )!;

  /** The split control as a whole — chip, divider and field. */
  const symbolTool = (index: number) =>
    valueField(index).closest(".symbol-tool")!;

  function press(x: number, y: number, button = 0) {
    cellAt(x, y).dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, button }),
    );
    document.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
  }

  function typeKey(x: number, y: number, key: string) {
    cellAt(x, y).dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, key }),
    );
  }

  function setSize(width: string, height: string) {
    (byId("grid-width") as HTMLInputElement).value = width;
    (byId("grid-height") as HTMLInputElement).value = height;
    byId("grid-width").dispatchEvent(new Event("input", { bubbles: true }));
  }

  function setValue(index: number, raw: string) {
    valueField(index).value = raw;
    valueField(index).dispatchEvent(new Event("input", { bubbles: true }));
  }

  /** Hands the editor a file as if it had been picked in the file dialog. */
  function pick(file: File) {
    const input = byId("config-file-input") as HTMLInputElement;
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function configFile(config: unknown, name = "logicGridTest.json") {
    return new File([JSON.stringify(config)], name, {
      type: "application/json",
    });
  }

  beforeEach(() => {
    document.body.innerHTML = MARKUP;
    const dialog = byId("reset-dialog") as HTMLDialogElement & {
      show: () => void;
    };
    // The test DOM doesn't register the custom `md-dialog` element, so provide
    // the `show`/`close` implementations the code calls.
    dialog.show = () => {
      dialog.open = true;
    };
    dialog.close = () => {
      dialog.open = false;
    };
    new LogicGridSolverEditor();
  });

  afterEach(() => {
    mock.restore();
    document.body.innerHTML = "";
  });

  describe("Initial render", () => {
    test("draws the default grid", () => {
      expect(document.querySelectorAll("#grid .grid-cell")).toHaveLength(36);
      expect(cellAt(0, 0).dataset.color).toBe("unknown");
    });

    /** Dark selected out of the box is what makes left-dark/right-light work. */
    test("starts on the dark tool and says what both buttons do", () => {
      expect(toolButton("dark").classList.contains("selected")).toBeTrue();
      expect(byId("tool-status").textContent).toBe(
        "Selected tool: Dark · Right-click: Light",
      );
    });

    test("offers every clue kind and every rule", () => {
      expect(symbolChips()).toHaveLength(SYMBOL_KINDS.length);
      expect(ruleChips()).toHaveLength(RULES.length);
      expect(symbolChips()[0]!.dataset.symbol).toBe(SYMBOL_KINDS[0]!.id);
      expect(ruleChip(RULES[0]!.id).textContent).toBe(RULES[0]!.label);
    });

    /**
     * The row is a reading order and the catalogue is the file format. This is
     * what says the page draws the first and still stores the second: a chip's
     * position is `RULE_DISPLAY_ORDER`'s, and `data-rule-index` — which is what
     * the click handler reads — is the catalogue's.
     */
    test("draws the rules in row order, carrying their stored index", () => {
      expect(ruleChips().map(chip => chip.dataset.rule)).toEqual(
        RULE_DISPLAY_ORDER.map(index => RULES[index]!.id),
      );
      expect(ruleChips().map(chip => Number(chip.dataset.ruleIndex))).toEqual([
        ...RULE_DISPLAY_ORDER,
      ]);
    });

    /** Every kind carries its own field, so none of them has to be named. */
    test("gives every clue kind its own value field", () => {
      expect(document.querySelectorAll("#symbol-row .symbol-value")).toHaveLength(
        SYMBOL_KINDS.length,
      );
      expect(valueField(0).type).toBe("number");
      expect(valueField(0).value).toBe("1");
      expect(valueField(0).getAttribute("aria-label")).toBe(
        `${SYMBOL_KINDS[0]!.label} value`,
      );
      expect(valueField(1).type).toBe("text");
      expect(valueField(1).value).toBe("A");
    });

    test("bounds the area field by the board it is on", () => {
      expect(valueField(0).getAttribute("max")).toBe("36");
      setSize("3", "2");
      expect(valueField(0).getAttribute("max")).toBe("6");
    });
  });

  describe("Tool selection", () => {
    test.each([
      ["light", "Selected tool: Light · Right-click: Dark"],
      ["unplayable", "Selected tool: Unplayable · Right-click: Erase"],
      ["erase", "Selected tool: Eraser · Right-click: Erase"],
      ["merge", "Selected tool: Merge cells · Right-click: Split cells"],
    ])("%s names both buttons", (tool, status) => {
      toolButton(tool).click();
      expect(toolButton(tool).classList.contains("selected")).toBeTrue();
      expect(byId("tool-status").textContent).toBe(status);
    });

    test("switching tools deselects the previous one", () => {
      toolButton("light").click();
      expect(toolButton("dark").classList.contains("selected")).toBeFalse();
    });

    test("painting uses the selected tool", () => {
      toolButton("unplayable").click();
      press(1, 2);
      expect(cellAt(1, 2).dataset.color).toBe("unplayable");
    });

    test("reset is a command, not a selection", () => {
      toolButton("reset").click();
      expect((byId("reset-dialog") as HTMLDialogElement).open).toBeTrue();
      expect(toolButton("reset").classList.contains("selected")).toBeFalse();
      expect(toolButton("dark").classList.contains("selected")).toBeTrue();
    });
  });

  describe("Clue kinds", () => {
    test("picking one selects the symbol tool and its split control", () => {
      symbolChips()[1]!.click();
      expect(symbolTool(1).classList.contains("selected")).toBeTrue();
      expect(symbolTool(0).classList.contains("selected")).toBeFalse();
      expect(byId("tool-status").textContent).toBe(
        "Selected tool: Letter · Right-click: Remove symbol",
      );
    });

    /** The field has to agree with the clue it is about to stamp. */
    test("a lower-case letter is shown upper case in its own field", () => {
      setValue(1, "c");
      expect(valueField(1).value).toBe("C");
      press(0, 0);
      expect(cellAt(0, 0).textContent).toBe("C");
    });

    test("a number is left exactly as typed", () => {
      setValue(0, "12");
      expect(valueField(0).value).toBe("12");
    });

    test("editing a field keeps the other kind's value", () => {
      setValue(0, "4");
      expect(valueField(1).value).toBe("A");
      expect(valueField(0).value).toBe("4");
    });

    /** The field belongs to its chip, so typing in it arms that chip. */
    test("typing a value selects the kind it belongs to", () => {
      toolButton("light").click();
      setValue(1, "K");
      expect(symbolTool(1).classList.contains("selected")).toBeTrue();
      press(2, 1);
      expect(cellAt(2, 1).textContent).toBe("K");
    });

    test("stamping places the typed value", () => {
      symbolChips()[0]!.click();
      setValue(0, "9");
      press(2, 1);
      expect(cellAt(2, 1).textContent).toBe("9");
      expect(cellAt(2, 1).dataset.symbol).toBe("area");
    });

    /** An unusable value stamps nothing, so the field has to say so. */
    test("a value the kind cannot use marks the field and stamps nothing", () => {
      symbolChips()[0]!.click();
      setValue(0, "0");
      expect(valueField(0).getAttribute("aria-invalid")).toBe("true");
      press(2, 1);
      expect(cellAt(2, 1).textContent).toBe("");
      setValue(0, "2");
      expect(valueField(0).hasAttribute("aria-invalid")).toBeFalse();
    });

    /** Each field reports its own validity, not the selected kind's. */
    test("one bad field does not mark the other", () => {
      setValue(1, "??");
      expect(valueField(1).getAttribute("aria-invalid")).toBe("true");
      expect(valueField(0).hasAttribute("aria-invalid")).toBeFalse();
    });
  });

  /**
   * The dart is the first kind whose control carries more than a value, so its
   * aim is picked in the row and stamped with the number — otherwise every dart
   * would have to be placed and then turned.
   */
  describe("Dart direction", () => {
    const DART = 2;
    const arrows = () => [
      ...symbolTool(DART).querySelectorAll<HTMLButtonElement>(
        ".direction-toggle",
      ),
    ];
    const aimed = () =>
      arrows().findIndex(one => one.classList.contains("selected"));

    test("only a directed kind is given arrows", () => {
      expect(arrows()).toHaveLength(4);
      expect(symbolTool(0).querySelector(".direction-toggle")).toBeNull();
    });

    /**
     * `.symbol-chip` means "the clue kinds", and both the unit sweep above and
     * the e2e suite count it. Four more of them per directed kind would make
     * that number meaningless.
     */
    test("an arrow is not a clue chip", () => {
      expect(symbolChips()).toHaveLength(SYMBOL_KINDS.length);
    });

    test("starts aimed right, with exactly one arrow on", () => {
      expect(aimed()).toBe(1);
      expect(arrows()[1]!.getAttribute("aria-pressed")).toBe("true");
      expect(arrows()[0]!.getAttribute("aria-pressed")).toBe("false");
    });

    /** Aiming is a declaration of intent to place, exactly as typing is. */
    test("clicking an arrow selects the dart and stamps that way", () => {
      arrows()[2]!.click();
      expect(symbolTool(DART).classList.contains("selected")).toBeTrue();
      expect(aimed()).toBe(2);
      setValue(DART, "1");
      press(1, 1);
      expect(cellAt(1, 1).dataset.direction).toBe("down");
    });

    test("the aim survives switching kinds and coming back", () => {
      arrows()[3]!.click();
      symbolChips()[0]!.click();
      expect(aimed()).toBe(3);
      symbolChips()[DART]!.click();
      expect(aimed()).toBe(3);
    });

    /** A dart's line is the longest one on the board, not the board's area. */
    test("bounds the dart field by the longest line, and allows zero", () => {
      expect(valueField(DART).getAttribute("min")).toBe("0");
      expect(valueField(DART).getAttribute("max")).toBe("5");
      setSize("3", "2");
      expect(valueField(DART).getAttribute("max")).toBe("2");
    });
  });

  describe("Rules", () => {
    test("a chip toggles its rule on and off", () => {
      ruleChip("no-dark-1x2").click();
      expect(ruleChip("no-dark-1x2").classList.contains("selected")).toBeTrue();
      expect(ruleChip("no-dark-1x2").getAttribute("aria-pressed")).toBe("true");
      ruleChip("no-dark-1x2").click();
      expect(ruleChip("no-dark-1x2").classList.contains("selected")).toBeFalse();
      expect(ruleChip("no-dark-1x2").getAttribute("aria-pressed")).toBe("false");
    });

    /** A different size is a different puzzle, and it brings its own rules. */
    test("rules go with a resize, along with the board", () => {
      ruleChip("no-light-1x2").click();
      setSize("4", "4");
      const chip = ruleChip("no-light-1x2");
      expect(chip.classList.contains("selected")).toBeFalse();
      expect(chip.getAttribute("aria-pressed")).toBe("false");
    });
  });

  describe("Grid size", () => {
    test("resizing redraws the board and clears it", () => {
      press(0, 0);
      setSize("3", "2");
      expect(document.querySelectorAll("#grid .grid-cell")).toHaveLength(6);
      expect(cellAt(0, 0).dataset.color).toBe("unknown");
    });

    test("a size outside the range is ignored", () => {
      setSize("0", "6");
      expect(document.querySelectorAll("#grid .grid-cell")).toHaveLength(36);
      setSize("33", "6");
      expect(document.querySelectorAll("#grid .grid-cell")).toHaveLength(36);
    });
  });

  describe("Reset", () => {
    test("confirming clears the board, the rules and the tool", () => {
      setSize("3", "3");
      toolButton("light").click();
      press(0, 0);
      ruleChip("no-light-2x2").click();

      toolButton("reset").click();
      byId("reset-confirm").click();

      expect(document.querySelectorAll("#grid .grid-cell")).toHaveLength(36);
      expect(cellAt(0, 0).dataset.color).toBe("unknown");
      expect(
        ruleChip("no-light-2x2").classList.contains("selected"),
      ).toBeFalse();
      expect(toolButton("dark").classList.contains("selected")).toBeTrue();
      expect((byId("reset-dialog") as HTMLDialogElement).open).toBeFalse();
    });

    test("cancelling leaves the board alone", () => {
      press(0, 0);
      toolButton("reset").click();
      byId("reset-cancel").click();
      expect(cellAt(0, 0).dataset.color).toBe("dark");
    });
  });

  /**
   * The arms are wasm in a worker, which this DOM has neither of, so each one
   * is answered by a stub. What these pin is the wiring the page owns — the
   * panel, the spinner, the button, entering and leaving the solution view, and
   * every edit dropping what was said. The answers themselves are checked
   * against the real module in `wasm.slow.test.ts` and end to end in e2e.
   *
   * Note the stub still has to send a LEGAL board: `solver.ts` replays every
   * answer through `verify.ts` before showing it, and refuses one that fails —
   * which is the point of that gate, and means a stub cannot fake its way past.
   */
  describe("Solve", () => {
    let reply: Record<string, unknown> | null;
    let originalWorker: unknown;

    const solved = (cells: number[]) => ({
      type: "done",
      status: "solved",
      cells,
      proven: true,
      decided: cells.length,
      playable: cells.length,
      witnesses: [],
      stats: { nodes: 1, wallMs: 1 },
    });

    beforeEach(() => {
      reply = solved([DARK, DARK, DARK, DARK]);
      originalWorker = (globalThis as Record<string, unknown>).Worker;
      (globalThis as Record<string, unknown>).Worker = class {
        onmessage: ((event: MessageEvent) => void) | null = null;
        onerror: ((event: ErrorEvent) => void) | null = null;
        postMessage() {
          queueMicrotask(() => {
            if (reply) this.onmessage?.({ data: reply } as MessageEvent);
            else this.onerror?.({ message: "no engine" } as ErrorEvent);
          });
        }
        terminate() {}
      };
      setSize("2", "2");
    });

    afterEach(() => {
      (globalThis as Record<string, unknown>).Worker = originalWorker;
    });

    test("shows the finished board in place of the editor", async () => {
      byId("solve-puzzle").click();
      expect(byId("solution-spinner").classList.contains("hidden")).toBeFalse();
      await flush();

      expect(byId("solution-view").classList.contains("hidden")).toBeFalse();
      expect(byId("editor-section").classList.contains("hidden")).toBeTrue();
      // By selector, not by child index: the merged cells' outline layer is the
      // grid's first child, and only the squares are `.grid-cell`.
      const solved = byId("solution-grid").querySelectorAll(".grid-cell");
      expect(solved).toHaveLength(4);
      expect((solved[0] as HTMLElement).dataset.color).toBe("dark");
      expect((byId("solve-puzzle") as HTMLButtonElement).disabled).toBeFalse();
    });

    test("Back to editor restores the board", async () => {
      byId("solve-puzzle").click();
      await flush();
      byId("solution-exit").click();

      expect(byId("solution-view").classList.contains("hidden")).toBeTrue();
      expect(byId("editor-section").classList.contains("hidden")).toBeFalse();
      expect(byId("solution-panel").classList.contains("hidden")).toBeTrue();
    });

    test("reports an arm that could not start at all", async () => {
      reply = null;
      byId("solve-puzzle").click();
      await flush();

      expect(byId("solution-panel").classList.contains("hidden")).toBeFalse();
      expect(byId("solution-status").textContent).toBe("Failed");
      // What the module threw is kept, but it reads as a parenthetical after a
      // sentence a player can act on — "Out of bounds memory access" on its own
      // told them nothing.
      expect(byId("solution-message").textContent).toContain(
        "The solver stopped before it could answer",
      );
      expect(byId("solution-message").textContent).toContain("(no engine)");
      expect(byId("solution-spinner").classList.contains("hidden")).toBeTrue();
    });

    test("refuses an answer that does not satisfy the rules", async () => {
      // A 2x2 all-dark board with "no dark 2x2" switched on: the stub says
      // solved, `verify.ts` says otherwise, and the page believes `verify.ts`.
      ruleChip("no-dark-2x2").click();
      byId("solve-puzzle").click();
      await flush();

      expect(byId("solution-view").classList.contains("hidden")).toBeTrue();
      expect(byId("solution-status").textContent).toBe("Gave up");
    });

    test("editing the board drops the answer again", async () => {
      byId("solve-puzzle").click();
      await flush();
      press(0, 0);

      expect(byId("solution-panel").classList.contains("hidden")).toBeTrue();
      expect(byId("solution-view").classList.contains("hidden")).toBeTrue();
      expect(byId("editor-section").classList.contains("hidden")).toBeFalse();
    });

    test("toggling a rule drops it too", async () => {
      byId("solve-puzzle").click();
      await flush();
      ruleChip("no-dark-2x2").click();

      expect(byId("solution-view").classList.contains("hidden")).toBeTrue();
    });
  });

  describe("Download", () => {
    let blobs: Blob[];

    beforeEach(() => {
      blobs = [];
      spyOn(URL, "createObjectURL").mockImplementation((blob: Blob) => {
        blobs.push(blob);
        return "blob:mock";
      });
      spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    });

    test("writes both layers and the active rules", async () => {
      setSize("2", "2");
      press(0, 0);
      toolButton("light").click();
      press(1, 0);
      toolButton("unplayable").click();
      press(1, 1);
      symbolChips()[1]!.click();
      setValue(1, "E");
      press(0, 1);
      ruleChip("no-checkerboard").click();
      ruleChip("no-dark-2x2").click();

      byId("download-config").click();

      expect(blobs).toHaveLength(1);
      expect(JSON.parse(await blobs[0]!.text())).toEqual({
        gridWidth: 2,
        gridHeight: 2,
        rules: [0, 10],
        cells: [
          [DARK, UNKNOWN],
          [LIGHT, UNPLAYABLE],
        ],
        symbols: [{ x: 0, y: 1, type: 1, value: "E" }],
      });
      // Not written at all on a board with no merged cells — the 139 captured
      // fixtures predate the key and have to keep round-tripping unchanged.
      expect("shapes" in JSON.parse(await blobs[0]!.text())).toBeFalse();
    });

    test("writes the merged cells when a board has any", async () => {
      setSize("3", "1");
      toolButton("merge").click();
      // Keyboard rather than a drag: happy-dom has no layout, so pointermove
      // hit-testing needs a stubbed elementFromPoint that this mount does not
      // set up. Enter joins each square to the one before it.
      typeKey(1, 0, "Enter");
      typeKey(2, 0, "Enter");

      byId("download-config").click();
      expect(JSON.parse(await blobs[0]!.text()).shapes).toEqual([[0, 1, 2]]);
    });

    test("round-trips a downloaded puzzle back into the editor", async () => {
      setSize("3", "2");
      press(1, 0);
      symbolChips()[0]!.click();
      setValue(0, "3");
      press(2, 1);
      ruleChip("no-dark-1x3").click();

      byId("download-config").click();
      const downloaded = await blobs[0]!.text();

      toolButton("reset").click();
      byId("reset-confirm").click();
      expect(cellAt(1, 0).dataset.color).toBe("unknown");

      pick(new File([downloaded], "logicGridTest.json"));
      await flush();

      expect(document.querySelectorAll("#grid .grid-cell")).toHaveLength(6);
      expect(cellAt(1, 0).dataset.color).toBe("dark");
      expect(cellAt(2, 1).textContent).toBe("3");
      expect(ruleChip("no-dark-1x3").classList.contains("selected")).toBeTrue();
    });

    /**
     * The row/catalogue split, end to end. This chip is drawn beside the connect
     * rules, roughly two thirds along the row, and the file it writes says 16 —
     * which is what keeps every puzzle saved before it existed meaning the same
     * thing.
     */
    test("writes a rule's stored index, not its position in the row", async () => {
      ruleChip("area-two-dark").click();

      byId("download-config").click();

      const written = JSON.parse(await blobs[0]!.text()) as LogicGridTest;
      expect(written.rules).toEqual([16]);
    });
  });

  describe("Upload", () => {
    const config: LogicGridTest = {
      gridWidth: 2,
      gridHeight: 1,
      rules: [11],
      cells: [
        [DARK, UNKNOWN],
        [UNKNOWN, UNKNOWN],
      ].map(column => [column[0]!]),
      symbols: [{ x: 1, y: 0, type: 0, value: 2 }],
    };

    test("applies a valid config", async () => {
      pick(configFile(config));
      await flush();

      expect(document.querySelectorAll("#grid .grid-cell")).toHaveLength(2);
      expect((byId("grid-width") as HTMLInputElement).value).toBe("2");
      expect(cellAt(0, 0).dataset.color).toBe("dark");
      expect(cellAt(1, 0).textContent).toBe("2");
      expect(ruleChip("connect-dark").classList.contains("selected")).toBeTrue();
      expect(byId("warning-banner").classList.contains("hidden")).toBeTrue();
    });

    test("warns and keeps the board on an invalid config", async () => {
      pick(configFile({ ...config, rules: [999] }));
      await flush();

      expect(byId("warning-banner").classList.contains("hidden")).toBeFalse();
      expect(byId("warning-banner").textContent).toContain("Invalid config:");
      expect(document.querySelectorAll("#grid .grid-cell")).toHaveLength(36);
    });

    test("warns on a file that is not JSON", async () => {
      pick(new File(["nope"], "board.txt", { type: "text/plain" }));
      await flush();

      expect(byId("warning-banner").textContent).toBe(
        "Please choose a JSON config file.",
      );
    });
  });
});
