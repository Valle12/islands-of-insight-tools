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
  BLOCKED,
  symbolCell,
  EMPTY,
} from "../../src/pages/match-three-solver/cell";
import { MatchThreeSolverEditor } from "../../src/pages/match-three-solver/matchThreeSolver";
import type { SolveHandlers } from "../../src/pages/match-three-solver/solveClient";
import { SYMBOLS } from "../../src/pages/match-three-solver/symbols";
import type { MatchThreeTest } from "../../src/util/types";

/**
 * The real client starts a Web Worker, which the test DOM has no use for. The
 * editor's side of the exchange is what matters here: what it hands over, and
 * what it does with each kind of answer.
 */
const searches: { config: MatchThreeTest; handlers: SolveHandlers }[] = [];
let cancelled = 0;

mock.module("../../src/pages/match-three-solver/solveClient", () => ({
  searchMatchThree: (config: MatchThreeTest, handlers: SolveHandlers) => {
    searches.push({ config, handlers });
    return {
      cancel: () => {
        cancelled++;
      },
    };
  },
}));

const lastSearch = () => searches[searches.length - 1]!;

/** `loadConfigFromFile` awaits the file read before it touches the page. */
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

/**
 * The page's own markup, trimmed to the ids and hooks the editor reaches for.
 * It is mounted for real rather than stubbed through `getElementById` because
 * the editor also runs `querySelectorAll` over `#tool-row` and `#symbol-row`.
 */
const MARKUP = `
  <div id="editor-section">
    <div id="warning-banner" class="hidden"></div>
    <input id="grid-width" />
    <input id="grid-height" />
    <div id="grid"></div>
    <div id="tool-status"></div>
    <div id="tool-row">
      <button class="tool-button icon-tool" data-tool="empty" type="button">Eraser</button>
      <button class="tool-button icon-tool" data-tool="reset" type="button">Reset</button>
    </div>
    <div id="symbol-row"></div>
    <md-filled-button id="solve-puzzle">Solve Puzzle</md-filled-button>
    <md-icon-button id="upload-config"></md-icon-button>
    <md-icon-button id="download-config"></md-icon-button>
    <input id="config-file-input" type="file" />
    <div id="solution-panel" class="hidden">
      <span id="solution-status"></span>
      <div id="solution-spinner" class="hidden">
        <span id="solution-progress-text"></span>
        <md-text-button id="solution-cancel">Cancel</md-text-button>
      </div>
      <div id="solution-message"></div>
    </div>
  </div>
  <div id="solution-view" class="hidden">
    <span id="solution-step-counter"></span>
    <div id="solution-grid"></div>
    <div id="solution-step-text"></div>
    <md-text-button id="solution-prev">Previous</md-text-button>
    <md-filled-button id="solution-next">Next</md-filled-button>
    <md-text-button id="solution-exit">Back to editor</md-text-button>
  </div>
  <md-dialog id="reset-dialog">
    <md-text-button id="reset-cancel">Cancel</md-text-button>
    <md-filled-button id="reset-confirm">Reset</md-filled-button>
  </md-dialog>
  <div id="drop-overlay" class="hidden"></div>
`;

describe("MatchThreeSolverEditor", () => {
  let editor: MatchThreeSolverEditor;

  const byId = (id: string) => document.getElementById(id)!;
  const widthField = () => byId("grid-width") as HTMLInputElement;
  const heightField = () => byId("grid-height") as HTMLInputElement;
  const fileInput = () => byId("config-file-input") as HTMLInputElement;
  const chips = () =>
    document.querySelectorAll<HTMLButtonElement>(
      "#symbol-row .symbol-chip[data-symbol-index]",
    );
  /** The blockade leads the same row but paints a structural value. */
  const blockedChip = () =>
    document.querySelector<HTMLButtonElement>(
      '#symbol-row .symbol-chip[data-tool="blocked"]',
    )!;
  const toolButton = (tool: string) =>
    document.querySelector<HTMLButtonElement>(
      `#tool-row .tool-button[data-tool="${tool}"]`,
    )!;
  // Scoped to #grid: the solution view renders a second grid of `.grid-cell`s
  // with the same coordinates on it.
  const cellAt = (x: number, y: number) =>
    document.querySelector<HTMLElement>(
      `#grid .grid-cell[data-x="${x}"][data-y="${y}"]`,
    )!;

  function setSize(width: string, height: string) {
    widthField().value = width;
    heightField().value = height;
    widthField().dispatchEvent(new Event("input", { bubbles: true }));
  }

  /** Hands the editor a file as if it had been picked in the file dialog. */
  function pick(file: File) {
    Object.defineProperty(fileInput(), "files", {
      value: [file],
      configurable: true,
    });
    fileInput().dispatchEvent(new Event("change", { bubbles: true }));
  }

  function paint(x: number, y: number) {
    cellAt(x, y).dispatchEvent(new Event("pointerdown", { bubbles: true }));
  }

  /**
   * Paints a whole board from the picture form the rules tests use: `.` empty,
   * `#` blocked, a letter per symbol index.
   */
  function paintBoard(rows: string[]) {
    setSize(String(rows[0]!.length), String(rows.length));

    for (let y = 0; y < rows.length; y++) {
      for (let x = 0; x < rows[y]!.length; x++) {
        const char = rows[y]![x]!;
        if (char === ".") continue;
        if (char === "#") blockedChip().click();
        else chips()[char.charCodeAt(0) - 97]!.click();
        paint(x, y);
      }
    }
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
    searches.length = 0;
    cancelled = 0;
    editor = new MatchThreeSolverEditor();
  });

  afterEach(() => {
    mock.restore();
    document.body.innerHTML = "";
  });

  describe("Initial render", () => {
    test("draws the default grid", () => {
      expect(document.querySelectorAll(".grid-cell")).toHaveLength(36);
    });

    test("offers every symbol, with the first selected", () => {
      expect(chips()).toHaveLength(SYMBOLS.length);
      expect(chips()[0]!.getAttribute("aria-label")).toBe(SYMBOLS[0]!.label);
      expect(chips()[0]!.querySelector("img")).not.toBeNull();
      // Tile only: a name beside every chip was noise once there were eight.
      expect(chips()[0]!.textContent?.trim()).toBe("");
      expect(chips()[0]!.classList.contains("selected")).toBeTrue();
      // The status names the kind of tool, never the tile.
      expect(byId("tool-status").textContent).toBe("Selected tool: Color");
    });
  });

  describe("Tool selection", () => {
    test("selecting a paint tool marks it and updates the status", () => {
      blockedChip().click();
      expect(blockedChip().classList.contains("selected")).toBeTrue();
      expect(byId("tool-status").textContent).toBe("Selected tool: Blocked");
    });

    test("the blockade sits with the tiles, not with the tools", () => {
      // It must never take a symbol index — that would shift every saved board.
      expect(blockedChip().dataset.symbolIndex).toBeUndefined();
      expect(blockedChip().querySelector("img")).not.toBeNull();
      expect(document.querySelectorAll("#tool-row .tool-button")).toHaveLength(
        2,
      );
    });

    test("the eraser reads as Eraser", () => {
      toolButton("empty").click();
      expect(byId("tool-status").textContent).toBe("Selected tool: Eraser");
    });

    test("painting uses the selected tool", () => {
      blockedChip().click();
      paint(1, 2);
      expect(cellAt(1, 2).dataset.kind).toBe("blocked");
    });

    test("switching tools deselects the previous one", () => {
      blockedChip().click();
      toolButton("empty").click();
      expect(blockedChip().classList.contains("selected")).toBeFalse();
    });
  });

  describe("Symbols", () => {
    test("picking a symbol moves the selection to its chip", () => {
      chips()[1]!.click();
      expect(chips()[1]!.classList.contains("selected")).toBeTrue();
      expect(chips()[0]!.classList.contains("selected")).toBeFalse();
      // Which tile is selected is the chip's job to show; the status only
      // says that a color is being painted at all.
      expect(byId("tool-status").textContent).toBe("Selected tool: Color");
    });

    test("the selected symbol is the one that gets painted", () => {
      chips()[1]!.click();
      paint(0, 0);
      expect(cellAt(0, 0).dataset.symbol).toBe(SYMBOLS[1]!.id);
    });

    test("an earlier symbol can be picked back up", () => {
      chips()[1]!.click();
      paint(0, 0);
      chips()[0]!.click();
      paint(1, 0);
      expect(cellAt(0, 0).dataset.symbol).toBe(SYMBOLS[1]!.id);
      expect(cellAt(1, 0).dataset.symbol).toBe(SYMBOLS[0]!.id);
    });

    test("selecting a symbol after a paint tool switches back to painting", () => {
      blockedChip().click();
      chips()[0]!.click();
      expect(blockedChip().classList.contains("selected")).toBeFalse();
      paint(2, 2);
      expect(cellAt(2, 2).dataset.kind).toBe("symbol");
    });

    test("a click on the symbol row background is ignored", () => {
      byId("symbol-row").dispatchEvent(new Event("click", { bubbles: true }));
      expect(byId("tool-status").textContent).toBe("Selected tool: Color");
      expect(chips()[0]!.classList.contains("selected")).toBeTrue();
    });

    test("the symbol row survives a board resize", () => {
      setSize("3", "3");
      expect(chips()).toHaveLength(SYMBOLS.length);
    });
  });

  describe("Grid size", () => {
    test("resizing redraws the grid", () => {
      setSize("3", "2");
      expect(document.querySelectorAll(".grid-cell")).toHaveLength(6);
    });

    test("resizing keeps the selected symbol", () => {
      chips()[1]!.click();
      setSize("3", "2");
      expect(chips()[1]!.classList.contains("selected")).toBeTrue();
      paint(0, 0);
      expect(cellAt(0, 0).dataset.symbol).toBe(SYMBOLS[1]!.id);
    });

    test("an out-of-range size is ignored", () => {
      setSize("0", "4");
      expect(document.querySelectorAll(".grid-cell")).toHaveLength(36);
    });

    test("a non-numeric size is ignored", () => {
      setSize("abc", "4");
      expect(document.querySelectorAll(".grid-cell")).toHaveLength(36);
    });
  });

  describe("Solve button", () => {
    /** One swap turns `aab`/`bba` into two full lines and empties the board. */
    const ONE_MOVE = ["aab", "bba"];
    const THE_MOVE = { a: { x: 2, y: 0 }, b: { x: 2, y: 1 } };

    const solve = () => byId("solve-puzzle").click();
    const hidden = (id: string) => byId(id).classList.contains("hidden");

    test("hands the solver the board as painted", () => {
      paintBoard(ONE_MOVE);
      solve();

      expect(searches).toHaveLength(1);
      expect(lastSearch().config.gridWidth).toBe(3);
      expect(lastSearch().config.gridHeight).toBe(2);
      expect(lastSearch().config.cells[0]).toEqual([
        symbolCell(0),
        symbolCell(1),
      ]);
    });

    test("shows the spinner while the search runs", () => {
      paintBoard(ONE_MOVE);
      solve();

      expect(hidden("solution-panel")).toBeFalse();
      expect(hidden("solution-spinner")).toBeFalse();
      expect(byId("solve-puzzle").hasAttribute("disabled")).toBeTrue();
    });

    test("reports how far the search has got", () => {
      paintBoard(ONE_MOVE);
      solve();
      lastSearch().handlers.onProgress?.({ depth: 3, nodes: 4000 });

      expect(byId("solution-progress-text").textContent).toContain("3 moves");
      expect(byId("solution-progress-text").textContent).toContain(
        "positions checked",
      );
    });

    test("refuses a board the game could never show", () => {
      paintBoard(["a", "."]);
      solve();

      expect(searches).toBeEmpty();
      expect(byId("warning-banner").textContent).toContain("floats above");
      expect(hidden("warning-banner")).toBeFalse();
    });

    test("refuses a board that still has a line standing", () => {
      paintBoard(["aaa"]);
      solve();

      expect(searches).toBeEmpty();
      expect(byId("warning-banner").textContent).toContain("line of three");
    });

    test("an unsolvable board is said to be unsolvable", () => {
      paintBoard(ONE_MOVE);
      solve();
      lastSearch().handlers.onResult({ status: "unsolvable" });

      expect(byId("solution-status").textContent).toBe("No solution");
      expect(byId("solution-message").textContent).toContain("cannot be cleared");
      expect(hidden("solution-view")).toBeTrue();
      expect(hidden("solution-spinner")).toBeTrue();
    });

    test("a search that ran out of time reports no length at all", () => {
      paintBoard(ONE_MOVE);
      solve();
      lastSearch().handlers.onResult({ status: "budget", depth: 4 });

      expect(byId("solution-status").textContent).toBe("Gave up");
      expect(byId("solution-message").textContent).toContain("4 moves or fewer");
      expect(hidden("solution-view")).toBeTrue();
    });

    test("an empty board needs no moves", () => {
      solve();
      lastSearch().handlers.onResult({
        status: "solved",
        moves: [],
        groupingProven: true,
      });

      expect(byId("solution-status").textContent).toBe("Already solved");
      expect(hidden("solution-view")).toBeTrue();
    });

    test("a solution opens the step viewer over the editor", () => {
      paintBoard(ONE_MOVE);
      solve();
      lastSearch().handlers.onResult({
        status: "solved",
        moves: [THE_MOVE],
        groupingProven: true,
      });

      expect(hidden("solution-view")).toBeFalse();
      expect(hidden("editor-section")).toBeTrue();
      expect(byId("solution-step-counter").textContent).toBe("Step 1 of 1");
    });

    test("Back to editor returns to the board", () => {
      paintBoard(ONE_MOVE);
      solve();
      lastSearch().handlers.onResult({
        status: "solved",
        moves: [THE_MOVE],
        groupingProven: true,
      });
      byId("solution-exit").click();

      expect(hidden("solution-view")).toBeTrue();
      expect(hidden("editor-section")).toBeFalse();
      expect(cellAt(0, 0).dataset.symbol).toBe(SYMBOLS[0]!.id);
    });

    test("a failed search says so instead of hanging on the spinner", () => {
      paintBoard(ONE_MOVE);
      solve();
      lastSearch().handlers.onError("The solver stopped unexpectedly.");

      expect(hidden("solution-spinner")).toBeTrue();
      expect(byId("solution-message").textContent).toBe(
        "The solver stopped unexpectedly.",
      );
    });

    test("Cancel stops the search", () => {
      paintBoard(ONE_MOVE);
      solve();
      byId("solution-cancel").click();

      expect(cancelled).toBe(1);
      expect(hidden("solution-spinner")).toBeTrue();
      expect(byId("solution-status").textContent).toBe("Cancelled");
    });

    /** Painting a cell the value it already holds is a deliberate no-op. */
    const erase = (x: number, y: number) => {
      toolButton("empty").click();
      paint(x, y);
    };

    test("a result for a board that has moved on is dropped", () => {
      paintBoard(ONE_MOVE);
      solve();
      const stale = lastSearch().handlers;
      erase(0, 0);

      stale.onResult({ status: "unsolvable" });

      expect(byId("solution-status").textContent).not.toBe("No solution");
      expect(hidden("solution-panel")).toBeTrue();
      expect(cancelled).toBe(1);
    });

    test("editing the board hides the panel again", () => {
      paintBoard(ONE_MOVE);
      solve();
      lastSearch().handlers.onResult({ status: "unsolvable" });
      erase(0, 0);

      expect(hidden("solution-panel")).toBeTrue();
    });

    test("editing the board closes an open step viewer", () => {
      paintBoard(ONE_MOVE);
      solve();
      lastSearch().handlers.onResult({
        status: "solved",
        moves: [THE_MOVE],
        groupingProven: true,
      });
      byId("solution-exit").click();
      erase(0, 0);

      expect(hidden("solution-view")).toBeTrue();
      expect(hidden("editor-section")).toBeFalse();
    });
  });

  describe("Reset", () => {
    test("the Reset tool only opens the dialog", () => {
      blockedChip().click();
      toolButton("reset").click();
      expect((byId("reset-dialog") as HTMLDialogElement).open).toBeTrue();
      expect(blockedChip().classList.contains("selected")).toBeTrue();
    });

    test("cancelling leaves the board alone", () => {
      paint(0, 0);
      toolButton("reset").click();
      byId("reset-cancel").click();
      expect((byId("reset-dialog") as HTMLDialogElement).open).toBeFalse();
      expect(cellAt(0, 0).dataset.kind).toBe("symbol");
    });

    test("confirming clears the board and the size", () => {
      chips()[1]!.click();
      paint(0, 0);
      setSize("3", "2");

      toolButton("reset").click();
      byId("reset-confirm").click();

      expect(document.querySelectorAll(".grid-cell")).toHaveLength(36);
      expect(cellAt(0, 0).dataset.kind).toBe("empty");
      expect(widthField().value).toBe("6");
      expect(heightField().value).toBe("6");
      expect(chips()[0]!.classList.contains("selected")).toBeTrue();
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

    test("writes the current board", async () => {
      setSize("2", "2");
      blockedChip().click();
      paint(0, 0);
      chips()[0]!.click();
      paint(1, 1);

      byId("download-config").click();

      expect(blobs).toHaveLength(1);
      expect(JSON.parse(await blobs[0]!.text())).toEqual({
        gridWidth: 2,
        gridHeight: 2,
        cells: [
          [BLOCKED, EMPTY],
          [EMPTY, symbolCell(0)],
        ],
      });
    });

    test("round-trips a downloaded board back into the editor", async () => {
      chips()[1]!.click();
      paint(2, 3);
      byId("download-config").click();
      const downloaded = await blobs[0]!.text();

      toolButton("reset").click();
      byId("reset-confirm").click();
      expect(cellAt(2, 3).dataset.kind).toBe("empty");

      pick(new File([downloaded], "matchThreeTest.json"));
      await flush();

      expect(cellAt(2, 3).dataset.symbol).toBe(SYMBOLS[1]!.id);
    });
  });

  describe("Upload", () => {
    const CONFIG = {
      gridWidth: 2,
      gridHeight: 3,
      cells: [
        [symbolCell(0), BLOCKED, EMPTY],
        [symbolCell(1), symbolCell(1), symbolCell(0)],
      ],
    };

    test("populates the editor from a valid config", async () => {
      pick(new File([JSON.stringify(CONFIG)], "matchThreeTest.json"));
      await flush();

      expect(widthField().value).toBe("2");
      expect(heightField().value).toBe("3");
      expect(document.querySelectorAll(".grid-cell")).toHaveLength(6);
      expect(cellAt(0, 1).dataset.kind).toBe("blocked");
      expect(cellAt(1, 2).dataset.symbol).toBe(SYMBOLS[0]!.id);
      expect(byId("warning-banner").classList.contains("hidden")).toBeTrue();
    });

    test("warns and keeps the board on a file that is not JSON", async () => {
      pick(new File(["not json"], "matchThreeTest.json"));
      await flush();

      expect(byId("warning-banner").textContent).toBe(
        "The file is not valid JSON.",
      );
      expect(byId("warning-banner").classList.contains("hidden")).toBeFalse();
      expect(document.querySelectorAll(".grid-cell")).toHaveLength(36);
    });

    test("warns and keeps the board on an invalid config", async () => {
      pick(
        new File([JSON.stringify({ gridWidth: 0 })], "matchThreeTest.json"),
      );
      await flush();

      expect(byId("warning-banner").textContent).toBe(
        "Invalid config: gridWidth must be an integer between 1 and 32.",
      );
      expect(document.querySelectorAll(".grid-cell")).toHaveLength(36);
    });

    test("loads a board captured from the game", async () => {
      // 6x6 with blockades down both bottom corners; see engine.test.ts for
      // the sweep that proves every captured board solves.
      const fixture = await Bun.file(
        `${import.meta.dir}/../resources/match-three-solver/matchThreeTest28.json`,
      ).text();
      pick(new File([fixture], "matchThreeTest28.json"));
      await flush();

      expect(document.querySelectorAll(".grid-cell")).toHaveLength(36);
      expect(cellAt(0, 4).dataset.kind).toBe("blocked");
      expect(cellAt(0, 0).dataset.kind).toBe("empty");
      expect(cellAt(2, 0).dataset.kind).toBe("symbol");
    });

    test("the upload button opens the file picker", () => {
      const click = spyOn(fileInput(), "click").mockImplementation(() => {});
      byId("upload-config").click();
      expect(click).toHaveBeenCalled();
    });

    test("clears the input so the same file can be picked twice", async () => {
      pick(new File([JSON.stringify(CONFIG)], "matchThreeTest.json"));
      await flush();
      expect(fileInput().value).toBe("");
    });
  });

  test("is exported without being constructed at import time", () => {
    // The module-scope bootstrap is gated behind NODE_ENV !== "test"; this test
    // only exists to pin that the class itself is what the page exports.
    expect(editor).toBeInstanceOf(MatchThreeSolverEditor);
  });
});
