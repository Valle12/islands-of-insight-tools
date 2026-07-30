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
  colorCell,
  EMPTY,
} from "../../src/pages/match-three-solver/cell";
import { MatchThreeSolverEditor } from "../../src/pages/match-three-solver/matchThreeSolver";
import {
  COLOR_NAMES,
  MAX_COLORS,
} from "../../src/pages/match-three-solver/palette";

/** `loadConfigFromFile` awaits the file read before it touches the page. */
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

/**
 * The page's own markup, trimmed to the ids and hooks the editor reaches for.
 * It is mounted for real rather than stubbed through `getElementById` because
 * the editor also runs `querySelectorAll` over `#tool-row` and `#color-row`.
 */
const MARKUP = `
  <div id="warning-banner" class="hidden"></div>
  <input id="grid-width" />
  <input id="grid-height" />
  <div id="grid"></div>
  <div id="tool-status"></div>
  <div id="tool-row">
    <button class="tool-button" data-tool="blocked" type="button">Blocked</button>
    <button class="tool-button" data-tool="empty" type="button">Eraser</button>
    <button class="tool-button" data-tool="addColor" type="button">Add Color</button>
    <button class="tool-button" data-tool="reset" type="button">Reset</button>
  </div>
  <div id="color-row"></div>
  <md-filled-button id="solve-puzzle">Solve Puzzle</md-filled-button>
  <md-icon-button id="upload-config"></md-icon-button>
  <md-icon-button id="download-config"></md-icon-button>
  <input id="config-file-input" type="file" />
  <div id="solution-panel" class="hidden">
    <span id="solution-status"></span>
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
    document.querySelectorAll<HTMLButtonElement>("#color-row .color-chip");
  const toolButton = (tool: string) =>
    document.querySelector<HTMLButtonElement>(
      `#tool-row .tool-button[data-tool="${tool}"]`,
    )!;
  const cellAt = (x: number, y: number) =>
    document.querySelector<HTMLElement>(
      `.grid-cell[data-x="${x}"][data-y="${y}"]`,
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
    // pickUnusedColor picks at random; pin it so the palette is predictable.
    spyOn(crypto, "getRandomValues").mockImplementation((array: unknown) => {
      (array as Uint32Array)[0] = 0;
      return array as Uint32Array;
    });
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

    test("opens on the one color it has", () => {
      expect(chips()).toHaveLength(1);
      expect(chips()[0]!.textContent?.trim()).toBe("Color 1");
      expect(chips()[0]!.classList.contains("selected")).toBeTrue();
      expect(byId("tool-status").textContent).toBe("Selected tool: Color 1");
    });
  });

  describe("Tool selection", () => {
    test("selecting a paint tool marks it and updates the status", () => {
      toolButton("blocked").click();
      expect(toolButton("blocked").classList.contains("selected")).toBeTrue();
      expect(byId("tool-status").textContent).toBe("Selected tool: Blocked");
    });

    test("the eraser reads as Eraser", () => {
      toolButton("empty").click();
      expect(byId("tool-status").textContent).toBe("Selected tool: Eraser");
    });

    test("painting uses the selected tool", () => {
      toolButton("blocked").click();
      paint(1, 2);
      expect(cellAt(1, 2).dataset.kind).toBe("blocked");
    });

    test("switching tools deselects the previous one", () => {
      toolButton("blocked").click();
      toolButton("empty").click();
      expect(toolButton("blocked").classList.contains("selected")).toBeFalse();
    });
  });

  describe("Colors", () => {
    test("Add Color appends a chip and selects it", () => {
      toolButton("addColor").click();
      expect(chips()).toHaveLength(2);
      expect(chips()[1]!.classList.contains("selected")).toBeTrue();
      expect(byId("tool-status").textContent).toBe("Selected tool: Color 2");
    });

    test("the new color is the one that gets painted", () => {
      toolButton("addColor").click();
      paint(0, 0);
      expect(cellAt(0, 0).dataset.colorIndex).toBe("1");
    });

    test("an earlier color can be picked back up", () => {
      toolButton("addColor").click();
      paint(0, 0);
      chips()[0]!.click();
      paint(1, 0);
      expect(cellAt(0, 0).dataset.colorIndex).toBe("1");
      expect(cellAt(1, 0).dataset.colorIndex).toBe("0");
      expect(byId("tool-status").textContent).toBe("Selected tool: Color 1");
    });

    test("selecting a color after a paint tool switches back to painting", () => {
      toolButton("blocked").click();
      chips()[0]!.click();
      expect(toolButton("blocked").classList.contains("selected")).toBeFalse();
      paint(2, 2);
      expect(cellAt(2, 2).dataset.kind).toBe("color");
    });

    test("a click on the color row background is ignored", () => {
      byId("color-row").dispatchEvent(new Event("click", { bubbles: true }));
      expect(byId("tool-status").textContent).toBe("Selected tool: Color 1");
    });

    test("warns instead of adding once every color is taken", () => {
      for (let i = 1; i < MAX_COLORS; i++) toolButton("addColor").click();
      expect(chips()).toHaveLength(MAX_COLORS);

      toolButton("addColor").click();

      expect(chips()).toHaveLength(MAX_COLORS);
      expect(byId("warning-banner").textContent).toBe(
        `A board may use at most ${MAX_COLORS} colors.`,
      );
      expect(byId("warning-banner").classList.contains("hidden")).toBeFalse();
    });
  });

  describe("Grid size", () => {
    test("resizing redraws the grid", () => {
      setSize("3", "2");
      expect(document.querySelectorAll(".grid-cell")).toHaveLength(6);
    });

    test("resizing keeps the colors already collected", () => {
      toolButton("addColor").click();
      setSize("3", "2");
      expect(chips()).toHaveLength(2);
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
    test("shows the placeholder panel", () => {
      byId("solve-puzzle").click();
      expect(byId("solution-panel").classList.contains("hidden")).toBeFalse();
      expect(byId("solution-status").textContent).toBe("Not available yet");
    });

    test("editing the board hides it again", () => {
      byId("solve-puzzle").click();
      paint(0, 0);
      expect(byId("solution-panel").classList.contains("hidden")).toBeTrue();
    });
  });

  describe("Reset", () => {
    test("the Reset tool only opens the dialog", () => {
      toolButton("blocked").click();
      toolButton("reset").click();
      expect((byId("reset-dialog") as HTMLDialogElement).open).toBeTrue();
      expect(toolButton("blocked").classList.contains("selected")).toBeTrue();
    });

    test("cancelling leaves the board alone", () => {
      toolButton("addColor").click();
      toolButton("reset").click();
      byId("reset-cancel").click();
      expect((byId("reset-dialog") as HTMLDialogElement).open).toBeFalse();
      expect(chips()).toHaveLength(2);
    });

    test("confirming clears the board back to one color", () => {
      toolButton("addColor").click();
      paint(0, 0);
      setSize("3", "2");

      toolButton("reset").click();
      byId("reset-confirm").click();

      expect(chips()).toHaveLength(1);
      expect(document.querySelectorAll(".grid-cell")).toHaveLength(36);
      expect(cellAt(0, 0).dataset.kind).toBe("empty");
      expect(widthField().value).toBe("6");
      expect(heightField().value).toBe("6");
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
      toolButton("blocked").click();
      paint(0, 0);
      chips()[0]!.click();
      paint(1, 1);

      byId("download-config").click();

      expect(blobs).toHaveLength(1);
      expect(JSON.parse(await blobs[0]!.text())).toEqual({
        gridWidth: 2,
        gridHeight: 2,
        colors: [COLOR_NAMES[0]!],
        cells: [
          [BLOCKED, EMPTY],
          [EMPTY, colorCell(0)],
        ],
      });
    });

    test("round-trips a downloaded board back into the editor", async () => {
      toolButton("addColor").click();
      paint(2, 3);
      byId("download-config").click();
      const downloaded = await blobs[0]!.text();

      toolButton("reset").click();
      byId("reset-confirm").click();
      expect(cellAt(2, 3).dataset.kind).toBe("empty");

      pick(new File([downloaded], "matchThreeTest.json"));
      await flush();

      expect(chips()).toHaveLength(2);
      expect(cellAt(2, 3).dataset.colorIndex).toBe("1");
    });
  });

  describe("Upload", () => {
    const CONFIG = {
      gridWidth: 2,
      gridHeight: 3,
      colors: ["teal", "gold"],
      cells: [
        [colorCell(0), BLOCKED, EMPTY],
        [colorCell(1), colorCell(1), colorCell(0)],
      ],
    };

    test("populates the editor from a valid config", async () => {
      pick(new File([JSON.stringify(CONFIG)], "matchThreeTest.json"));
      await flush();

      expect(widthField().value).toBe("2");
      expect(heightField().value).toBe("3");
      expect(document.querySelectorAll(".grid-cell")).toHaveLength(6);
      expect(chips()).toHaveLength(2);
      expect(cellAt(0, 1).dataset.kind).toBe("blocked");
      expect(cellAt(1, 2).dataset.colorIndex).toBe("0");
      expect(byId("warning-banner").classList.contains("hidden")).toBeTrue();
    });

    test("clamps a selected color the loaded palette no longer has", async () => {
      toolButton("addColor").click();
      toolButton("addColor").click();
      expect(byId("tool-status").textContent).toBe("Selected tool: Color 3");

      pick(new File([JSON.stringify(CONFIG)], "matchThreeTest.json"));
      await flush();

      expect(byId("tool-status").textContent).toBe("Selected tool: Color 2");
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

    test("loads a real downloaded fixture", async () => {
      const fixture = await Bun.file(
        `${import.meta.dir}/../resources/match-three-solver/matchThreeTest1.json`,
      ).text();
      pick(new File([fixture], "matchThreeTest1.json"));
      await flush();

      expect(chips()).toHaveLength(3);
      expect(cellAt(2, 3).dataset.kind).toBe("blocked");
      expect(cellAt(0, 0).dataset.kind).toBe("empty");
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
