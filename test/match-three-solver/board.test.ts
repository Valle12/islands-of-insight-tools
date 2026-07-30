import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { Board } from "../../src/pages/match-three-solver/board";
import {
  BLOCKED,
  colorCell,
  EMPTY,
} from "../../src/pages/match-three-solver/cell";
import type { MatchThreeSolverEditor } from "../../src/pages/match-three-solver/matchThreeSolver";
import {
  COLOR_NAMES,
  MAX_COLORS,
} from "../../src/pages/match-three-solver/palette";
import type { MatchThreeTool } from "../../src/util/types";

describe("Board (match-three)", () => {
  let editorMock: {
    render: ReturnType<typeof mock>;
    hideSolution: ReturnType<typeof mock>;
  };

  /** Builds a board on a fresh `#grid`, with the palette pinned. */
  function makeBoard(
    width = 4,
    height = 3,
    tool: MatchThreeTool = "color",
    colorIndex = 0,
    palette?: readonly string[],
  ) {
    return new Board(
      editorMock as unknown as MatchThreeSolverEditor,
      width,
      height,
      tool,
      colorIndex,
      palette,
    );
  }

  function cellAt(x: number, y: number): HTMLElement {
    const cell = document.querySelector(
      `.grid-cell[data-x="${x}"][data-y="${y}"]`,
    ) as HTMLElement | null;
    if (!cell) throw new Error(`Cell at (${x}, ${y}) not found`);
    return cell;
  }

  function dispatch(el: EventTarget, type: string) {
    el.dispatchEvent(new Event(type, { bubbles: true }));
  }

  beforeEach(() => {
    document.body.innerHTML = '<div id="grid"></div>';
    editorMock = { render: mock(() => {}), hideSolution: mock(() => {}) };
    // pickUnusedColor picks at random; pin it so the palette is predictable.
    spyOn(crypto, "getRandomValues").mockImplementation((array: unknown) => {
      (array as Uint32Array)[0] = 0;
      return array as Uint32Array;
    });
  });

  afterEach(() => {
    mock.restore();
    document.body.innerHTML = "";
  });

  describe("Initial state", () => {
    test("starts fully empty", () => {
      const board = makeBoard();
      expect(board.getCells()).toEqual([
        [EMPTY, EMPTY, EMPTY],
        [EMPTY, EMPTY, EMPTY],
        [EMPTY, EMPTY, EMPTY],
        [EMPTY, EMPTY, EMPTY],
      ]);
    });

    test("starts with exactly one color", () => {
      expect(makeBoard().getPalette()).toEqual([COLOR_NAMES[0]!]);
    });

    test("keeps a palette handed to the constructor", () => {
      const board = makeBoard(2, 2, "color", 0, ["teal", "gold"]);
      expect(board.getPalette()).toEqual(["teal", "gold"]);
    });

    test("copies the handed-in palette instead of aliasing it", () => {
      const palette = ["teal"];
      const board = makeBoard(2, 2, "color", 0, palette);
      board.addColor();
      expect(palette).toEqual(["teal"]);
    });
  });

  describe("Cell encoding", () => {
    test("empty and blocked share the index space with the colors", () => {
      expect(EMPTY).toBe(0);
      expect(BLOCKED).toBe(1);
      expect(colorCell(0)).toBe(2);
      expect(colorCell(3)).toBe(5);
    });

    test("every cell value is a number", () => {
      const board = makeBoard(2, 2, "blocked");
      board.getCells()[0]![0] = BLOCKED;
      board.getCells()[1]![1] = colorCell(0);
      for (const column of board.getCells()) {
        for (const cell of column) expect(typeof cell).toBe("number");
      }
    });
  });

  describe("RenderGrid", () => {
    test("renders gridWidth x gridHeight cells", () => {
      makeBoard(4, 3).renderGrid();
      expect(document.querySelectorAll(".grid-cell")).toHaveLength(12);
    });

    test("sets grid template columns from gridWidth", () => {
      makeBoard(4, 3).renderGrid();
      expect(document.getElementById("grid")!.style.gridTemplateColumns).toBe(
        "repeat(4, minmax(0, 1fr))",
      );
    });

    test("clears existing children before rendering", () => {
      const board = makeBoard(4, 3);
      board.renderGrid();
      board.renderGrid();
      expect(document.querySelectorAll(".grid-cell")).toHaveLength(12);
    });

    test("empty cells carry kind and an index-free label", () => {
      makeBoard().renderGrid();
      const cell = cellAt(0, 0);
      expect(cell.dataset.kind).toBe("empty");
      expect(cell.dataset.colorIndex).toBeUndefined();
      expect(cell.getAttribute("aria-label")).toBe("Column 1, Row 1, Empty");
    });

    test("blocked cells carry kind and label", () => {
      const board = makeBoard(2, 2, "blocked");
      board.getCells()[1]![0] = BLOCKED;
      board.renderGrid();
      const cell = cellAt(1, 0);
      expect(cell.dataset.kind).toBe("blocked");
      expect(cell.getAttribute("aria-label")).toBe("Column 2, Row 1, Blocked");
    });

    test("color cells label by slot, never by color name", () => {
      const board = makeBoard(2, 2, "color", 0, ["teal", "gold"]);
      board.getCells()[0]![1] = colorCell(1);
      board.renderGrid();
      const cell = cellAt(0, 1);
      expect(cell.dataset.kind).toBe("color");
      expect(cell.dataset.colorIndex).toBe("1");
      expect(cell.getAttribute("aria-label")).toBe("Column 1, Row 2, Color 2");
      expect(cell.style.backgroundColor).toBe("gold");
    });
  });

  describe("AddColor", () => {
    test("appends a color that is not already in the palette", () => {
      const board = makeBoard(2, 2, "color", 0, [COLOR_NAMES[0]!]);
      expect(board.addColor()).toBe(true);
      expect(board.getPalette()).toEqual([COLOR_NAMES[0]!, COLOR_NAMES[1]!]);
    });

    test("refuses once every color is taken", () => {
      const board = makeBoard(2, 2, "color", 0, COLOR_NAMES);
      expect(board.getPalette()).toHaveLength(MAX_COLORS);
      expect(board.addColor()).toBe(false);
      expect(board.getPalette()).toHaveLength(MAX_COLORS);
    });
  });

  describe("Painting", () => {
    test("pointerdown paints with the selected color", () => {
      const board = makeBoard(3, 3, "color", 0, ["teal", "gold"]);
      board.setSelectedColorIndex(1);
      board.renderGrid();
      dispatch(cellAt(2, 1), "pointerdown");
      expect(board.getCells()[2]![1]).toBe(colorCell(1));
      expect(editorMock.hideSolution).toHaveBeenCalled();
    });

    test("the blocked tool paints obstacles", () => {
      const board = makeBoard(3, 3, "blocked");
      board.renderGrid();
      dispatch(cellAt(0, 2), "pointerdown");
      expect(board.getCells()[0]![2]).toBe(BLOCKED);
    });

    test("the eraser clears a painted cell", () => {
      const board = makeBoard(3, 3, "blocked");
      board.renderGrid();
      dispatch(cellAt(0, 0), "pointerdown");
      board.setSelectedTool("empty");
      dispatch(cellAt(0, 0), "pointerdown");
      expect(board.getCells()[0]![0]).toBe(EMPTY);
    });

    test("ignores a pointerdown on the grid background", () => {
      const board = makeBoard(3, 3, "blocked");
      board.renderGrid();
      dispatch(document.getElementById("grid")!, "pointerdown");
      expect(board.getCells()[0]![0]).toBe(EMPTY);
      expect(editorMock.hideSolution).not.toHaveBeenCalled();
    });

    test("pointermove drags the paint across cells", () => {
      const board = makeBoard(3, 3, "blocked");
      board.renderGrid();
      dispatch(cellAt(0, 0), "pointerdown");
      dispatch(cellAt(1, 0), "pointermove");
      expect(board.getCells()[1]![0]).toBe(BLOCKED);
    });

    test("pointermove without a pointerdown paints nothing", () => {
      const board = makeBoard(3, 3, "blocked");
      board.renderGrid();
      dispatch(cellAt(1, 0), "pointermove");
      expect(board.getCells()[1]![0]).toBe(EMPTY);
    });

    test("pointerup ends the drag", () => {
      const board = makeBoard(3, 3, "blocked");
      board.renderGrid();
      dispatch(cellAt(0, 0), "pointerdown");
      dispatch(document, "pointerup");
      dispatch(cellAt(1, 0), "pointermove");
      expect(board.getCells()[1]![0]).toBe(EMPTY);
    });

    test("repainting the same value is a no-op", () => {
      const board = makeBoard(3, 3, "blocked");
      board.renderGrid();
      dispatch(cellAt(0, 0), "pointerdown");
      expect(editorMock.hideSolution).toHaveBeenCalledTimes(1);

      // A drag fires pointermove many times over the same cell; none of them
      // may repeat the work.
      dispatch(cellAt(0, 0), "pointermove");
      dispatch(cellAt(0, 0), "pointermove");
      expect(editorMock.hideSolution).toHaveBeenCalledTimes(1);
    });

    test("updates the painted button in place, without a full rebuild", () => {
      const board = makeBoard(3, 3, "blocked");
      board.renderGrid();
      const painted = cellAt(1, 1);
      const untouched = cellAt(2, 2);

      dispatch(painted, "pointerdown");

      // Same nodes as before: only the attributes of one of them changed.
      expect(cellAt(1, 1)).toBe(painted);
      expect(cellAt(2, 2)).toBe(untouched);
      expect(painted.dataset.kind).toBe("blocked");
      expect(painted.getAttribute("aria-label")).toBe(
        "Column 2, Row 2, Blocked",
      );
      expect(untouched.dataset.kind).toBe("empty");
      expect(editorMock.render).not.toHaveBeenCalled();
    });

    test("clears the color fill when a color cell is erased", () => {
      const board = makeBoard(3, 3, "color", 0, ["teal"]);
      board.renderGrid();
      dispatch(cellAt(0, 0), "pointerdown");
      expect(cellAt(0, 0).style.backgroundColor).toBe("teal");

      board.setSelectedTool("empty");
      dispatch(cellAt(0, 0), "pointerdown");
      expect(cellAt(0, 0).style.backgroundColor).toBe("");
      expect(cellAt(0, 0).dataset.colorIndex).toBeUndefined();
    });
  });

  describe("Dispose", () => {
    test("a disposed board stops listening on the shared #grid", () => {
      const board = makeBoard(3, 3, "blocked");
      board.renderGrid();
      board.dispose();

      dispatch(cellAt(0, 0), "pointerdown");

      expect(board.getCells()[0]![0]).toBe(EMPTY);
      expect(editorMock.hideSolution).not.toHaveBeenCalled();
    });
  });

  describe("LoadConfig", () => {
    test("replaces cells and palette", () => {
      const board = makeBoard(2, 2);
      board.loadConfig({
        gridWidth: 2,
        gridHeight: 2,
        colors: ["teal", "gold"],
        cells: [
          [colorCell(0), BLOCKED],
          [EMPTY, colorCell(1)],
        ],
      });
      expect(board.getPalette()).toEqual(["teal", "gold"]);
      expect(board.getCells()).toEqual([
        [colorCell(0), BLOCKED],
        [EMPTY, colorCell(1)],
      ]);
    });

    test("drops whatever was painted before", () => {
      const board = makeBoard(2, 2, "blocked");
      board.getCells()[0]![0] = BLOCKED;
      board.loadConfig({
        gridWidth: 2,
        gridHeight: 2,
        colors: ["teal"],
        cells: [
          [EMPTY, EMPTY],
          [EMPTY, colorCell(0)],
        ],
      });
      expect(board.getCells()[0]![0]).toBe(EMPTY);
    });
  });
});
