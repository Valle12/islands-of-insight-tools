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
import {
  CONFIG_VERSION,
  migrationNotice,
} from "../../src/pages/logic-grid-solver/config";
import { LogicGridSolverEditor } from "../../src/pages/logic-grid-solver/logicGridSolver";
import { RULE_ROW, RULES } from "../../src/pages/logic-grid-solver/rules";
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
  <md-dialog id="pattern-dialog">
    <md-outlined-text-field id="pattern-width" type="number" value="2"
      min="1" max="32"></md-outlined-text-field>
    <md-outlined-text-field id="pattern-height" type="number" value="2"
      min="1" max="32"></md-outlined-text-field>
    <div id="pattern-colors">
      <button class="tool-button pattern-color selected" type="button"
        data-pattern-color="dark" aria-pressed="true"></button>
      <button class="tool-button pattern-color" type="button"
        data-pattern-color="light" aria-pressed="false"></button>
    </div>
    <div id="pattern-grid"></div>
    <div id="pattern-error"></div>
    <md-text-button id="pattern-clear">Clear</md-text-button>
    <md-text-button id="pattern-cancel">Cancel</md-text-button>
    <md-filled-button id="pattern-save">Save</md-filled-button>
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
   * One rule chip, by its stable id — a single's full-label chip and a folded
   * pair's Dark/Light segment are the same button either way.
   *
   * The row is laid out by `RULE_ROW`, so a chip's position is neither the
   * index a config stores nor anything a test should lean on — and a case
   * that says which rule it is about keeps saying it when the row is
   * rearranged.
   */
  const ruleChip = (id: string) =>
    document.querySelector<HTMLButtonElement>(
      `#rule-row .rule-chip[data-rule="${id}"]`,
    )!;

  /** One sized family control — the pill holding its value fields. */
  const sizedControl = (key: string) =>
    document.querySelector<HTMLElement>(
      `#rule-row .rule-sized[data-sized-control="${key}"]`,
    )!;

  /** The control's "+" button, which appends another value slot. */
  const sizedAdd = (key: string) =>
    sizedControl(key).querySelector<HTMLButtonElement>(".rule-size-add")!;

  /** A control's value fields, in slot order — insertion keeps them so. */
  const sizedFields = (key: string) => [
    ...document.querySelectorAll<HTMLInputElement>(
      `#rule-row .rule-size[data-sized-control="${key}"]`,
    ),
  ];

  function setSizedValue(key: string, slot: number, raw: string) {
    const field = sizedFields(key)[slot]!;
    field.value = raw;
    field.dispatchEvent(new Event("input", { bubbles: true }));
  }

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
    // The test DOM doesn't register the custom `md-dialog` element, so provide
    // the `show`/`close` implementations the code calls.
    for (const id of ["reset-dialog", "pattern-dialog"]) {
      const dialog = byId(id) as HTMLDialogElement & { show: () => void };
      dialog.show = () => {
        dialog.open = true;
      };
      dialog.close = () => {
        dialog.open = false;
      };
    }
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

    test("offers every clue kind and every flag rule", () => {
      expect(symbolChips()).toHaveLength(SYMBOL_KINDS.length);
      expect(symbolChips()[0]!.dataset.symbol).toBe(SYMBOL_KINDS[0]!.id);
      // One chip per FLAG rule: the 22 sized entries have no chip of their
      // own — their families are the four value controls counted below — and
      // nor do the 10 retired arrangements, which are drawn instead.
      expect(ruleChips()).toHaveLength(
        RULES.filter(rule => !rule.sized && !rule.drawn).length,
      );
      // RULES[0] is half of a folded pair, so its segment wears the color as
      // a SWATCH — the paint tools' own visual — and the full rule name as
      // its accessible one.
      expect(
        ruleChip(RULES[0]!.id).querySelector('.swatch[data-swatch="dark"]'),
      ).not.toBeNull();
      expect(ruleChip(RULES[0]!.id).getAttribute("aria-label")).toBe(
        RULES[0]!.label,
      );
      expect(document.querySelectorAll("#rule-row .rule-sized")).toHaveLength(
        4,
      );
      expect(
        document.querySelectorAll("#rule-row .rule-size-add"),
      ).toHaveLength(4);
      // A fresh board starts every sized family empty: no value fields until
      // the add button makes one.
      expect(document.querySelectorAll("#rule-row .rule-size")).toHaveLength(0);
    });

    /**
     * The row is a reading order and the catalog is the file format. This is
     * what says the page draws the first and still stores the second: a chip's
     * position follows `RULE_ROW`'s bands — a pair contributing its dark then
     * its light segment — while `data-rule-index`, which is what the click
     * handler reads, is the catalog's.
     */
    test("draws the rules in row order, carrying their stored index", () => {
      const rowIds = RULE_ROW.flatMap(band =>
        band.entries.flatMap(entry => {
          if (entry.kind === "single") return [entry.id];
          return entry.kind === "pair" ? [entry.dark, entry.light] : [];
        }),
      );
      expect(ruleChips().map(chip => chip.dataset.rule)).toEqual(rowIds);
      expect(ruleChips().map(chip => Number(chip.dataset.ruleIndex))).toEqual(
        rowIds.map(id => RULES.findIndex(rule => rule.id === id)),
      );
    });

    /**
     * Each band is its own labelled section, in `RULE_ROW`'s order — and the
     * drawn patterns are NOT a band of their own. They say the same sentence
     * the arrangement chips say, so they close that band, even though they
     * come from the BOARD rather than from the catalog and so appear
     * nowhere in `RULE_ROW`.
     */
    test("groups the rules into headed bands", () => {
      const bands = [
        ...document.querySelectorAll<HTMLElement>("#rule-row .rule-band"),
      ];
      expect(bands.map(band => band.dataset.band)).toEqual([
        ...RULE_ROW.map(band => band.band),
      ]);
      expect(
        bands.map(
          band => band.querySelector(".rule-band-heading")!.textContent,
        ),
      ).toEqual([...RULE_ROW.map(band => band.heading)]);
    });

    /** The drawn patterns' container and its `+` close the ARRANGEMENT band. */
    test("puts the drawn patterns at the end of the arrangement band", () => {
      const band = document.querySelector<HTMLElement>(
        '#rule-row .rule-band[data-band="arrangement"] .rule-band-chips',
      )!;
      expect(band.querySelector("#pattern-chips")).not.toBeNull();
      expect(band.lastElementChild!.classList).toContain("rule-pattern-add");
    });

    /** Every kind that CARRIES a value gets its own field, so none has to be
     * named — and a valueless kind renders no field at all, which is why the
     * two counts diverge now the symmetry symbol exists. */
    test("gives every value-carrying clue kind its own value field", () => {
      expect(document.querySelectorAll("#symbol-row .symbol-value")).toHaveLength(
        SYMBOL_KINDS.filter(kind => kind.valueKind !== "none").length,
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

    /** A viewpoint sees its whole row and column at most, its own square
     * counted once — the CROSS, which is neither the board's area nor its
     * longest line, and its floor is one because it always sees itself. */
    test("bounds the viewpoint field by the cross", () => {
      expect(valueField(4).getAttribute("min")).toBe("1");
      expect(valueField(4).getAttribute("max")).toBe("11");
      setSize("3", "2");
      expect(valueField(4).getAttribute("max")).toBe("4");
    });

    /** The galaxy is the first chip-only kind: valueless AND unaimed, so its
     * control is the chip alone, and its miniature is `dressClue`'s icon
     * rather than the sample text. */
    test("gives the galaxy a chip and nothing else", () => {
      const tool = document.querySelector<HTMLElement>(
        '#symbol-row .symbol-tool[data-symbol="galaxy"]',
      )!;
      expect(tool.querySelector(".symbol-value")).toBeNull();
      expect(tool.querySelector(".direction-toggle")).toBeNull();
      const sample = tool.querySelector<HTMLElement>(".symbol-sample")!;
      expect(sample.dataset.icon).toBe("");
      expect(sample.querySelector("md-icon")?.textContent).toBe("cyclone");
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
      // The viewpoint carries a number but points nowhere: chip + field only.
      expect(symbolTool(4).querySelector(".direction-toggle")).toBeNull();
    });

    /**
     * `.symbol-chip` means "the clue kinds", and both the unit sweep above and
     * the e2e suite count it. Four more of them per directed kind would make
     * that number meaningless.
     */
    test("an arrow is not a clue chip", () => {
      expect(symbolChips()).toHaveLength(SYMBOL_KINDS.length);
    });

    /** A lit arrow beside an idle chip reads as "this tool is active", so
     * nothing shows until the dart itself is armed — and then the FIRST
     * arrow, nothing having been picked yet. */
    test("shows no aim until the dart is armed, then the first arrow", () => {
      expect(aimed()).toBe(-1);
      expect(
        arrows().every(one => one.getAttribute("aria-pressed") === "false"),
      ).toBeTrue();

      symbolChips()[DART]!.click();
      expect(aimed()).toBe(0);
      expect(arrows()[0]!.getAttribute("aria-pressed")).toBe("true");
      expect(arrows()[1]!.getAttribute("aria-pressed")).toBe("false");
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
      // Another kind is armed, so the dart's toggles show nothing at all —
      // the choice itself is kept, not shown.
      expect(aimed()).toBe(-1);
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

  describe("Off-by-one bounds", () => {
    /**
     * The rule bends every numeric bound by one at both ends, and the row is
     * NOT rebuilt for a chip toggle — `refreshSymbolRow` re-sets the
     * attributes in place, which is exactly what these pin: the build-time
     * min/max would otherwise go stale the moment the chip is clicked.
     */
    test("toggling the rule widens the fields and back", () => {
      ruleChip("off-by-one").click();
      expect(valueField(0).getAttribute("min")).toBe("0");
      expect(valueField(0).getAttribute("max")).toBe("37");
      expect(valueField(2).getAttribute("max")).toBe("6");
      expect(valueField(4).getAttribute("min")).toBe("0");
      expect(valueField(4).getAttribute("max")).toBe("12");

      ruleChip("off-by-one").click();
      expect(valueField(0).getAttribute("min")).toBe("1");
      expect(valueField(0).getAttribute("max")).toBe("36");
      expect(valueField(4).getAttribute("min")).toBe("1");
      expect(valueField(4).getAttribute("max")).toBe("11");
    });

    /** A displayed zero is a value exactly while the rule is on, and the
     * field's own validity says so either way round. */
    test("a zero area value is usable only under the rule", () => {
      setValue(0, "0");
      expect(valueField(0).getAttribute("aria-invalid")).toBe("true");
      ruleChip("off-by-one").click();
      expect(valueField(0).getAttribute("aria-invalid")).toBeNull();
      ruleChip("off-by-one").click();
      expect(valueField(0).getAttribute("aria-invalid")).toBe("true");
    });
  });

  describe("Rules", () => {
    test("a chip toggles its rule on and off", () => {
      ruleChip("no-dark-t").click();
      expect(ruleChip("no-dark-t").classList.contains("selected")).toBeTrue();
      expect(ruleChip("no-dark-t").getAttribute("aria-pressed")).toBe("true");
      ruleChip("no-dark-t").click();
      expect(ruleChip("no-dark-t").classList.contains("selected")).toBeFalse();
      expect(ruleChip("no-dark-t").getAttribute("aria-pressed")).toBe("false");
    });

    /** The fold is layout, not linkage: a pair's segments are two independent
     * switches, and both colors can be on at once. */
    test("a pair's segments toggle independently", () => {
      ruleChip("no-dark-t").click();
      expect(ruleChip("no-light-t").getAttribute("aria-pressed")).toBe("false");
      ruleChip("no-light-t").click();
      expect(ruleChip("no-dark-t").getAttribute("aria-pressed")).toBe("true");
      expect(ruleChip("no-light-t").getAttribute("aria-pressed")).toBe("true");
    });

    /** A different size is a different puzzle, and it brings its own rules. */
    test("rules go with a resize, along with the board", () => {
      ruleChip("connect-light").click();
      setSize("4", "4");
      const chip = ruleChip("connect-light");
      expect(chip.classList.contains("selected")).toBeFalse();
      expect(chip.getAttribute("aria-pressed")).toBe("false");
    });
  });

  describe("Sized rules", () => {
    test("the add button appends an empty slot and focuses it", () => {
      sizedAdd("run-dark").click();
      const fields = sizedFields("run-dark");
      expect(fields).toHaveLength(1);
      expect(fields[0]!.value).toBe("");
      expect(document.activeElement).toBe(fields[0]!);
      // Empty is merely pending — not yet a value, not yet an error.
      expect(fields[0]!.hasAttribute("aria-invalid")).toBeFalse();
      expect(
        sizedControl("run-dark").classList.contains("selected"),
      ).toBeFalse();
    });

    test("a usable value lights its own control and no other", () => {
      sizedAdd("area-dark").click();
      setSizedValue("area-dark", 0, "4");
      expect(
        sizedControl("area-dark").classList.contains("selected"),
      ).toBeTrue();
      expect(
        sizedFields("area-dark")[0]!.hasAttribute("aria-invalid"),
      ).toBeFalse();
      expect(
        sizedControl("area-light").classList.contains("selected"),
      ).toBeFalse();
    });

    /** The bounds are the format's: runs 2..8, areas 1..9999. A value outside
     * them contributes nothing, and the field says so on itself. */
    test.each([
      ["run-dark", "1"],
      ["run-dark", "9"],
      ["area-dark", "0"],
      ["area-dark", "10000"],
    ])("%s marks %s as unusable", (key, raw) => {
      sizedAdd(key).click();
      setSizedValue(key, 0, raw);
      expect(sizedFields(key)[0]!.getAttribute("aria-invalid")).toBe("true");
      expect(sizedControl(key).classList.contains("selected")).toBeFalse();
    });

    test("a duplicate marks the later slot, not the first", () => {
      sizedAdd("run-light").click();
      setSizedValue("run-light", 0, "3");
      sizedAdd("run-light").click();
      setSizedValue("run-light", 1, "3");
      const fields = sizedFields("run-light");
      expect(fields[0]!.hasAttribute("aria-invalid")).toBeFalse();
      expect(fields[1]!.getAttribute("aria-invalid")).toBe("true");
    });

    // Driven through a RUN control, the family that still takes several values
    // per color — an area control has only ever one slot to renumber.
    test("leaving an emptied slot removes it and renumbers the rest", () => {
      sizedAdd("run-dark").click();
      setSizedValue("run-dark", 0, "2");
      sizedAdd("run-dark").click();
      setSizedValue("run-dark", 1, "5");

      setSizedValue("run-dark", 0, "");
      // Still there while focused: clearing keeps the field for more digits.
      expect(sizedFields("run-dark")).toHaveLength(2);

      sizedFields("run-dark")[0]!.dispatchEvent(
        new Event("focusout", { bubbles: true }),
      );

      const fields = sizedFields("run-dark");
      expect(fields).toHaveLength(1);
      expect(fields[0]!.value).toBe("5");
      expect(fields[0]!.dataset.slot).toBe("0");
      expect(fields[0]!.getAttribute("aria-label")).toBe(
        "No dark 1x value 1",
      );
    });

    /**
     * "Every dark region has area 2" and "…area 3" hold together only where
     * dark is absent from the board, so an area control takes ONE value and
     * gives up its `+` as soon as it has a slot to put one in. The run family
     * keeps its button: two bans on one color are merely redundant.
     */
    test("an area control drops its + at one value and a run control does not", () => {
      expect(sizedAdd("area-dark").classList.contains("hidden")).toBeFalse();

      sizedAdd("area-dark").click();
      setSizedValue("area-dark", 0, "3");
      expect(sizedAdd("area-dark").classList.contains("hidden")).toBeTrue();
      expect(sizedFields("area-dark")).toHaveLength(1);

      // A click that reaches the hidden button anyway adds nothing: the cap is
      // a rule, not a piece of styling.
      sizedAdd("area-dark").click();
      expect(sizedFields("area-dark")).toHaveLength(1);

      sizedAdd("run-dark").click();
      setSizedValue("run-dark", 0, "3");
      expect(sizedAdd("run-dark").classList.contains("hidden")).toBeFalse();

      // Emptying the area slot and leaving it hands the button back.
      setSizedValue("area-dark", 0, "");
      sizedFields("area-dark")[0]!.dispatchEvent(
        new Event("focusout", { bubbles: true }),
      );
      expect(sizedFields("area-dark")).toHaveLength(0);
      expect(sizedAdd("area-dark").classList.contains("hidden")).toBeFalse();
    });

    /**
     * The refresh runs on every rule toggle and re-asserts each slot's text.
     * Assigning `value` moves the caret even when the string is unchanged, so
     * the guard has to SKIP the write — pinned by counting writes, since the
     * value itself would look identical either way.
     */
    test("an unrelated refresh leaves a slot's text alone", () => {
      sizedAdd("run-dark").click();
      setSizedValue("run-dark", 0, "4");
      const field = sizedFields("run-dark")[0]!;
      let rewrites = 0;
      Object.defineProperty(field, "value", {
        get: () => "4",
        set: () => {
          rewrites++;
        },
        configurable: true,
      });

      ruleChip("no-checkerboard").click();

      expect(rewrites).toBe(0);
    });

    test("a resize clears the sized values with the rest of the rules", () => {
      sizedAdd("run-dark").click();
      setSizedValue("run-dark", 0, "3");
      setSize("4", "4");
      expect(sizedFields("run-dark")).toHaveLength(0);
      expect(
        sizedControl("run-dark").classList.contains("selected"),
      ).toBeFalse();
    });

    test("reset clears them too", () => {
      sizedAdd("area-light").click();
      setSizedValue("area-light", 0, "2");
      toolButton("reset").click();
      byId("reset-confirm").click();
      expect(sizedFields("area-light")).toHaveLength(0);
    });

    test("an uploaded config replaces the slots wholesale", async () => {
      sizedAdd("run-dark").click();
      setSizedValue("run-dark", 0, "5");

      pick(
        configFile({
          version: CONFIG_VERSION,
          gridWidth: 2,
          gridHeight: 1,
          rules: [],
          areas: [{ color: "light", size: 3 }],
          cells: [[UNKNOWN], [UNKNOWN]],
          symbols: [],
        }),
      );
      await flush();

      expect(sizedFields("run-dark")).toHaveLength(0);
      expect(sizedFields("area-light").map(field => field.value)).toEqual([
        "3",
      ]);
      expect(
        sizedControl("area-light").classList.contains("selected"),
      ).toBeTrue();
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

    test("canceling leaves the board alone", () => {
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

    test("toggling a drawn pattern drops it too", async () => {
      byId("rule-row")
        .querySelector<HTMLButtonElement>(".rule-pattern-add")!
        .click();
      document
        .querySelector<HTMLButtonElement>("#pattern-grid .pattern-cell")!
        .dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      byId("pattern-save").click();

      byId("solve-puzzle").click();
      await flush();
      document
        .querySelector<HTMLButtonElement>("#rule-row .pattern-toggle")!
        .click();

      expect(byId("solution-view").classList.contains("hidden")).toBeTrue();
    });

    test("typing a sized value drops it too", async () => {
      byId("solve-puzzle").click();
      await flush();

      // The + button alone changes no config, so the answer stays up…
      sizedAdd("run-dark").click();
      expect(byId("solution-view").classList.contains("hidden")).toBeFalse();

      // …and the first digit is an edit like any other.
      setSizedValue("run-dark", 0, "2");
      expect(byId("solution-view").classList.contains("hidden")).toBeTrue();
    });
  });

  describe("Drawn patterns", () => {
    const patternChips = () => [
      ...document.querySelectorAll<HTMLButtonElement>(
        "#rule-row .pattern-toggle",
      ),
    ];
    const patternCells = () => [
      ...document.querySelectorAll<HTMLButtonElement>(
        "#pattern-grid .pattern-cell",
      ),
    ];
    const openDialog = () =>
      byId("rule-row")
        .querySelector<HTMLButtonElement>(".rule-pattern-add")!
        .click();
    /** A press on one square: the left button unless `button` says otherwise. */
    const press = (at: number, button = 0) => {
      patternCells()[at]!.dispatchEvent(
        new MouseEvent("pointerdown", { button, bubbles: true }),
      );
    };
    /** Arms a color the way the two chips do. */
    const arm = (color: "dark" | "light") => {
      byId("pattern-dialog")
        .querySelector<HTMLButtonElement>(
          `.pattern-color[data-pattern-color="${color}"]`,
        )!
        .click();
    };
    const paint = (at: number) => {
      press(at);
    };
    /** Draws a 2x2 dark block and saves it. */
    const drawSquare = () => {
      openDialog();
      for (let at = 0; at < 4; at++) paint(at);
      byId("pattern-save").click();
    };

    test("the band starts empty behind a New pattern button", () => {
      expect(patternChips()).toHaveLength(0);
      expect(byId("pattern-chips")).not.toBeNull();
      expect(
        byId("rule-row").querySelector(".rule-pattern-add"),
      ).not.toBeNull();
    });

    test("drawing one adds a chip, switched on for this board", () => {
      drawSquare();
      expect(patternChips()).toHaveLength(1);
      expect(patternChips()[0]!.getAttribute("aria-pressed")).toBe("true");
      expect((byId("pattern-dialog") as HTMLDialogElement).open).toBeFalse();
    });

    /** The chip's whole identity: the drawing, and no borrowed name. */
    test("the chip shows the squares that were drawn", () => {
      drawSquare();
      const squares = patternChips()[0]!.querySelectorAll(".pattern-square");
      expect(squares).toHaveLength(4);
      expect(
        [...squares].every(
          square => square.getAttribute("data-square") === "dark",
        ),
      ).toBeTrue();
      expect(patternChips()[0]!.getAttribute("aria-label")).toContain(
        "Forbidden pattern 1",
      );
    });

    /**
     * The board's own gesture, in miniature: the armed color under the left
     * button, the OTHER under the right, and a press writing what is already
     * there clearing it instead. That last rule is what keeps both colors and
     * the eraser reachable from either chip, which is what someone with no
     * right button needs.
     */
    test("the left button paints the armed color and the right the other", () => {
      openDialog();
      expect(patternCells()[0]!.dataset.square).toBe("unknown");
      press(0);
      expect(patternCells()[0]!.dataset.square).toBe("dark");
      press(0, 2);
      expect(patternCells()[0]!.dataset.square).toBe("light");
      press(0);
      expect(patternCells()[0]!.dataset.square).toBe("dark");
    });

    test("pressing the color a square already holds clears it", () => {
      openDialog();
      press(0);
      expect(patternCells()[0]!.dataset.square).toBe("dark");
      press(0);
      expect(patternCells()[0]!.dataset.square).toBe("unknown");
      press(0, 2);
      expect(patternCells()[0]!.dataset.square).toBe("light");
      press(0, 2);
      expect(patternCells()[0]!.dataset.square).toBe("unknown");
    });

    test("arming light paints light, and the chips say which is armed", () => {
      openDialog();
      arm("light");
      press(0);
      expect(patternCells()[0]!.dataset.square).toBe("light");
      // ...and the right button now writes dark, the two chips having swapped
      // which color each button carries.
      press(1, 2);
      expect(patternCells()[1]!.dataset.square).toBe("dark");
      const chips = [
        ...byId("pattern-dialog").querySelectorAll<HTMLElement>(
          ".pattern-color",
        ),
      ];
      expect(chips.map(chip => chip.getAttribute("aria-pressed"))).toEqual([
        "false",
        "true",
      ]);
      // The armed color survives a close, and the chips have to keep saying
      // so — they are markup and are never rebuilt.
      byId("pattern-cancel").click();
      openDialog();
      expect(
        chips.map(chip => chip.getAttribute("aria-pressed")),
      ).toEqual(["false", "true"]);
      press(0);
      expect(patternCells()[0]!.dataset.square).toBe("light");
    });

    test("resizing the box keeps what still fits", () => {
      openDialog();
      paint(0);
      (byId("pattern-width") as HTMLInputElement).value = "3";
      byId("pattern-width").dispatchEvent(new Event("input"));
      expect(patternCells()).toHaveLength(6);
      expect(patternCells()[0]!.dataset.square).toBe("dark");
    });

    test("saving nothing says so and keeps the dialog up", () => {
      openDialog();
      byId("pattern-save").click();
      expect(byId("pattern-error").textContent).toContain("at least one");
      expect((byId("pattern-dialog") as HTMLDialogElement).open).toBeTrue();
    });

    /** By the canonical form, so this fires on a ROTATION of a shape already
     * held — the same rule facing another way. */
    test("refuses a shape the library already holds", () => {
      openDialog();
      paint(0);
      paint(3);
      byId("pattern-save").click();
      expect(patternChips()).toHaveLength(1);

      openDialog();
      paint(1);
      paint(2);
      byId("pattern-save").click();
      expect(byId("pattern-error").textContent).toContain("already");
      expect(patternChips()).toHaveLength(1);
    });

    test("clicking a chip toggles it off and on again", () => {
      drawSquare();
      patternChips()[0]!.click();
      expect(patternChips()[0]!.getAttribute("aria-pressed")).toBe("false");
      patternChips()[0]!.click();
      expect(patternChips()[0]!.getAttribute("aria-pressed")).toBe("true");
    });

    test("deleting one takes it out of the row for good", () => {
      drawSquare();
      byId("rule-row")
        .querySelector<HTMLButtonElement>(".pattern-delete")!
        .click();
      expect(patternChips()).toHaveLength(0);
    });

    /** A reset is about this BOARD. The library is session state, and the next
     * puzzle in a group usually wants the same shapes one click away. */
    test("reset switches them off but keeps them drawn", () => {
      drawSquare();
      toolButton("reset").click();
      byId("reset-confirm").click();
      expect(patternChips()).toHaveLength(1);
      expect(patternChips()[0]!.getAttribute("aria-pressed")).toBe("false");
    });

    test("a resize switches them off the same way", () => {
      drawSquare();
      setSize("4", "4");
      expect(patternChips()).toHaveLength(1);
      expect(patternChips()[0]!.getAttribute("aria-pressed")).toBe("false");
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
        version: CONFIG_VERSION,
        gridWidth: 2,
        gridHeight: 2,
        rules: [0, 10],
        cells: [
          [DARK, UNKNOWN],
          [LIGHT, UNPLAYABLE],
        ],
        symbols: [{ x: 0, y: 1, type: 1, value: "E" }],
      });
      // `shapes` is not written at all on a board with no merged cells, and
      // `toEqual` above already proves `areas`/`runs` are omitted rather than
      // written empty — the captured fixtures round-trip byte-identically.
      expect("shapes" in JSON.parse(await blobs[0]!.text())).toBeFalse();
    });

    test("writes the drawn patterns when a board carries any", async () => {
      setSize("2", "2");
      byId("rule-row")
        .querySelector<HTMLButtonElement>(".rule-pattern-add")!
        .click();
      for (const cell of document.querySelectorAll<HTMLButtonElement>(
        "#pattern-grid .pattern-cell",
      ))
        cell.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      byId("pattern-save").click();

      byId("download-config").click();
      expect(JSON.parse(await blobs[0]!.text()).patterns).toEqual([
        { width: 2, height: 2, cells: [DARK, DARK, DARK, DARK] },
      ]);

      // Switched off, the shape is still DRAWN but no longer this board's, so
      // the key goes away entirely rather than being written empty.
      document
        .querySelector<HTMLButtonElement>("#rule-row .pattern-toggle")!
        .click();
      byId("download-config").click();
      expect("patterns" in JSON.parse(await blobs[1]!.text())).toBeFalse();
    });

    test("loads a board's patterns back as chips", async () => {
      const file = configFile({
        version: CONFIG_VERSION,
        gridWidth: 2,
        gridHeight: 2,
        rules: [],
        patterns: [{ width: 2, height: 2, cells: [DARK, 0, 0, DARK] }],
        cells: [
          [UNKNOWN, UNKNOWN],
          [UNKNOWN, UNKNOWN],
        ],
        symbols: [],
      });
      pick(file);
      await flush();

      const chips = document.querySelectorAll<HTMLButtonElement>(
        "#rule-row .pattern-toggle",
      );
      expect(chips).toHaveLength(1);
      expect(chips[0]!.getAttribute("aria-pressed")).toBe("true");
      // And back out unchanged, which is what a captured board has to do.
      byId("download-config").click();
      expect(JSON.parse(await blobs[0]!.text()).patterns).toEqual([
        { width: 2, height: 2, cells: [DARK, 0, 0, DARK] },
      ]);
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
      sizedAdd("run-dark").click();
      setSizedValue("run-dark", 0, "3");

      byId("download-config").click();
      const downloaded = await blobs[0]!.text();

      toolButton("reset").click();
      byId("reset-confirm").click();
      expect(cellAt(1, 0).dataset.color).toBe("unknown");
      expect(sizedFields("run-dark")).toHaveLength(0);

      pick(new File([downloaded], "logicGridTest.json"));
      await flush();

      expect(document.querySelectorAll("#grid .grid-cell")).toHaveLength(6);
      expect(cellAt(1, 0).dataset.color).toBe("dark");
      expect(cellAt(2, 1).textContent).toBe("3");
      expect(sizedFields("run-dark").map(field => field.value)).toEqual(["3"]);
      expect(
        sizedControl("run-dark").classList.contains("selected"),
      ).toBeTrue();
    });

    /**
     * The row/catalog split, end to end. This segment is drawn folded into
     * the "Connect all cells" pair, and the file it writes says 12 — which is
     * what keeps every puzzle saved before the fold meaning the same thing.
     */
    test("writes a rule's stored index, not its position in the row", async () => {
      ruleChip("connect-light").click();

      byId("download-config").click();

      const written = JSON.parse(await blobs[0]!.text()) as LogicGridTest;
      expect(written.rules).toEqual([12]);
    });

    /**
     * A sized value never lands in `rules` at all: since format version 2 the
     * number rides in its family list, dark before light and values ascending,
     * whatever order it was typed in.
     */
    test("writes sized values as family entries in canonical order", async () => {
      // Dark before light across the areas; values ascending within the runs,
      // which is the family that can still hold two of one color.
      sizedAdd("area-light").click();
      setSizedValue("area-light", 0, "3");
      sizedAdd("area-dark").click();
      setSizedValue("area-dark", 0, "5");
      sizedAdd("run-dark").click();
      setSizedValue("run-dark", 0, "4");
      sizedAdd("run-dark").click();
      setSizedValue("run-dark", 1, "2");

      byId("download-config").click();

      const written = JSON.parse(await blobs[0]!.text()) as LogicGridTest;
      expect(written.rules).toEqual([]);
      expect(written.areas).toEqual([
        { color: "dark", size: 5 },
        { color: "light", size: 3 },
      ]);
      expect(written.runs).toEqual([
        { color: "dark", length: 2 },
        { color: "dark", length: 4 },
      ]);
    });
  });

  describe("Upload", () => {
    const config: LogicGridTest = {
      version: CONFIG_VERSION,
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

    /**
     * An older file loads in full and then warns about the copy on disk. A
     * file with no version key at all IS version 1, and its sized index — 2,
     * "no dark 1x2" — lands as a value in the run control, not as a flag.
     */
    test("migrates a version 1 file and says so", async () => {
      pick(
        configFile({
          gridWidth: 2,
          gridHeight: 1,
          rules: [2],
          cells: [[UNKNOWN], [UNKNOWN]],
          symbols: [],
        }),
      );
      await flush();

      expect(byId("warning-banner").classList.contains("hidden")).toBeFalse();
      expect(byId("warning-banner").textContent).toBe(migrationNotice(1));
      expect(sizedFields("run-dark").map(field => field.value)).toEqual(["2"]);
      expect(
        ruleChips().some(chip => chip.classList.contains("selected")),
      ).toBeFalse();
    });
  });
});
