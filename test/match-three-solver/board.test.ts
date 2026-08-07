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
  symbolCell,
  EMPTY,
} from "../../src/pages/match-three-solver/cell";
import type { MatchThreeSolverEditor } from "../../src/pages/match-three-solver/matchThreeSolver";
import { SYMBOLS } from "../../src/pages/match-three-solver/symbols";
import type { MatchThreeTool } from "../../src/util/types";

describe("Board (match-three)", () => {
  let editorMock: {
    render: ReturnType<typeof mock>;
    hideSolution: ReturnType<typeof mock>;
  };

  /** Builds a board on a fresh `#grid`. */
  function makeBoard(
    width = 4,
    height = 3,
    tool: MatchThreeTool = "symbol",
    symbol = 0,
  ) {
    return new Board(
      editorMock as unknown as MatchThreeSolverEditor,
      width,
      height,
      tool,
      symbol,
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

  });

  describe("Cell encoding", () => {
    test("empty and blocked share the index space with the symbols", () => {
      expect(EMPTY).toBe(0);
      expect(BLOCKED).toBe(1);
      expect(symbolCell(0)).toBe(2);
      expect(symbolCell(3)).toBe(5);
    });

    test("every cell value is a number", () => {
      const board = makeBoard(2, 2, "blocked");
      board.getCells()[0]![0] = BLOCKED;
      board.getCells()[1]![1] = symbolCell(0);
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
      // Fixed tracks, not minmax(0, 1fr): shrinkable tracks overlap the
      // fixed-width squares at narrow viewports (the shell scrolls instead).
      expect(document.getElementById("grid")!.style.gridTemplateColumns).toBe(
        "repeat(4, var(--mt-cell))",
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
      expect(cell.dataset.symbol).toBeUndefined();
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

    test("block cells carry their symbol and its name", () => {
      const board = makeBoard(2, 2);
      board.getCells()[0]![1] = symbolCell(1);
      board.renderGrid();
      const cell = cellAt(0, 1);
      expect(cell.dataset.kind).toBe("symbol");
      expect(cell.dataset.symbol).toBe(SYMBOLS[1]!.id);
      expect(cell.getAttribute("aria-label")).toBe(
        `Column 1, Row 2, ${SYMBOLS[1]!.label}`,
      );
    });

    /**
     * Two symbols have to *look* different, which no selector can assert — the
     * e2e suite reads `data-symbol`, so the artwork itself is pinned here.
     */
    test("two symbols render as two different images", () => {
      const board = makeBoard(2, 1);
      board.getCells()[0]![0] = symbolCell(0);
      board.getCells()[1]![0] = symbolCell(1);
      board.renderGrid();

      const image = (x: number, y: number) =>
        cellAt(x, y).style.getPropertyValue("--symbol-image");
      const first = image(0, 0);
      const second = image(1, 0);
      expect(first).not.toBe("");
      expect(second).not.toBe("");
      expect(first).not.toBe(second);
    });
  });

  describe("Painting", () => {
    test("pointerdown paints with the selected symbol", () => {
      const board = makeBoard(3, 3);
      board.setSelectedSymbol(1);
      board.renderGrid();
      dispatch(cellAt(2, 1), "pointerdown");
      expect(board.getCells()[2]![1]).toBe(symbolCell(1));
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

    test("clears the artwork when a block is erased", () => {
      const board = makeBoard(3, 3);
      board.renderGrid();
      dispatch(cellAt(0, 0), "pointerdown");
      expect(
        cellAt(0, 0).style.getPropertyValue("--symbol-image"),
      ).not.toBe("");

      board.setSelectedTool("empty");
      dispatch(cellAt(0, 0), "pointerdown");
      expect(cellAt(0, 0).style.getPropertyValue("--symbol-image")).toBe("");
      expect(cellAt(0, 0).dataset.symbol).toBeUndefined();
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
    test("replaces every cell", () => {
      const board = makeBoard(2, 2);
      board.loadConfig({
        gridWidth: 2,
        gridHeight: 2,
        cells: [
          [symbolCell(0), BLOCKED],
          [EMPTY, symbolCell(1)],
        ],
      });
      expect(board.getCells()).toEqual([
        [symbolCell(0), BLOCKED],
        [EMPTY, symbolCell(1)],
      ]);
    });

    test("drops whatever was painted before", () => {
      const board = makeBoard(2, 2, "blocked");
      board.getCells()[0]![0] = BLOCKED;
      board.loadConfig({
        gridWidth: 2,
        gridHeight: 2,
        cells: [
          [EMPTY, EMPTY],
          [EMPTY, symbolCell(0)],
        ],
      });
      expect(board.getCells()[0]![0]).toBe(EMPTY);
    });
  });
});
