import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { Board } from "../../src/pages/logic-grid-solver/board";
import {
  DARK,
  LIGHT,
  UNKNOWN,
  UNPLAYABLE,
} from "../../src/pages/logic-grid-solver/cell";
import type { LogicGridSolverEditor } from "../../src/pages/logic-grid-solver/logicGridSolver";
import type {
  LogicGridSymbolValue,
  LogicGridTool,
} from "../../src/util/types";

const LEFT = 0;
const RIGHT = 2;

describe("Board (logic grid)", () => {
  let editorMock: { hideSolution: ReturnType<typeof mock> };

  function makeBoard(
    width = 4,
    height = 3,
    tool: LogicGridTool = "dark",
    symbol = 0,
    value: LogicGridSymbolValue | null = 1,
  ) {
    const board = new Board(
      editorMock as unknown as LogicGridSolverEditor,
      width,
      height,
      tool,
      symbol,
      value,
    );
    board.renderGrid();
    return board;
  }

  function cellAt(x: number, y: number): HTMLElement {
    const cell = document.querySelector(
      `#grid .grid-cell[data-x="${x}"][data-y="${y}"]`,
    ) as HTMLElement | null;
    if (!cell) throw new Error(`Cell at (${x}, ${y}) not found`);
    return cell;
  }

  /**
   * `MouseEvent` rather than `Event`: the board reads `event.button` to tell
   * the two colours apart, and a bare Event carries none.
   */
  function press(x: number, y: number, button = LEFT) {
    cellAt(x, y).dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, button }),
    );
  }

  /**
   * A move is hit-tested by coordinate, not by `event.target` — a touch pointer
   * is implicitly captured by the cell the stroke began on. happy-dom has no
   * layout, so `elementFromPoint` is stubbed to name the cell being dragged
   * over; the coordinates themselves are what the browser resolves.
   */
  function drag(x: number, y: number) {
    const cell = cellAt(x, y);
    spyOn(document, "elementFromPoint").mockReturnValue(cell);
    cellAt(0, 0).dispatchEvent(
      new MouseEvent("pointermove", { bubbles: true }),
    );
  }

  function release(type = "pointerup") {
    document.dispatchEvent(new MouseEvent(type, { bubbles: true }));
  }

  function type(x: number, y: number, key: string) {
    cellAt(x, y).dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, key }),
    );
  }

  beforeEach(() => {
    document.body.innerHTML = '<div id="grid"></div>';
    editorMock = { hideSolution: mock(() => {}) };
  });

  afterEach(() => {
    mock.restore();
    document.body.innerHTML = "";
  });

  describe("Initial state", () => {
    test("starts fully uncoloured and unclued", () => {
      const board = makeBoard(2, 2);
      expect(board.getCells()).toEqual([
        [UNKNOWN, UNKNOWN],
        [UNKNOWN, UNKNOWN],
      ]);
      expect(board.getSymbols()).toEqual([]);
      expect(cellAt(0, 0).dataset.color).toBe("unknown");
      expect(cellAt(0, 0).getAttribute("aria-label")).toBe(
        "Column 1, Row 1, Unknown",
      );
    });

    test("sets grid template columns from gridWidth", () => {
      makeBoard(4, 3);
      expect(document.getElementById("grid")!.style.gridTemplateColumns).toBe(
        "repeat(4, minmax(0, 1fr))",
      );
    });
  });

  describe("Mouse buttons", () => {
    test("left paints the selected colour, right paints the other", () => {
      const board = makeBoard(3, 1);
      press(0, 0, LEFT);
      release();
      press(1, 0, RIGHT);
      release();
      expect(board.getCells()[0]![0]).toBe(DARK);
      expect(board.getCells()[1]![0]).toBe(LIGHT);
      expect(editorMock.hideSolution).toHaveBeenCalled();
    });

    test("the light tool swaps which button paints which", () => {
      const board = makeBoard(3, 1, "light");
      press(0, 0, LEFT);
      release();
      press(1, 0, RIGHT);
      release();
      expect(board.getCells()[0]![0]).toBe(LIGHT);
      expect(board.getCells()[1]![0]).toBe(DARK);
    });

    test("right-clicking a gap tool erases instead of colouring", () => {
      const board = makeBoard(2, 1, "unplayable");
      press(0, 0, LEFT);
      release();
      expect(board.getCells()[0]![0]).toBe(UNPLAYABLE);
      press(0, 0, RIGHT);
      release();
      expect(board.getCells()[0]![0]).toBe(UNKNOWN);
    });

    test("the middle button paints nothing", () => {
      const board = makeBoard(2, 1);
      cellAt(0, 0).dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: true, button: 1 }),
      );
      release();
      expect(board.getCells()[0]![0]).toBe(UNKNOWN);
    });
  });

  describe("Re-clicking erases", () => {
    test("pressing the same button on the same colour clears it", () => {
      const board = makeBoard(2, 1);
      press(0, 0, LEFT);
      release();
      press(0, 0, LEFT);
      release();
      expect(board.getCells()[0]![0]).toBe(UNKNOWN);
    });

    test("the other button still paints its own colour", () => {
      const board = makeBoard(2, 1);
      press(0, 0, LEFT);
      release();
      press(0, 0, RIGHT);
      release();
      expect(board.getCells()[0]![0]).toBe(LIGHT);
    });

    /**
     * The stroke commits at pointerdown. Deciding per cell would make this drag
     * erase the first cell and paint the rest, which is the bug the whole
     * mechanism exists to avoid.
     */
    test("a drag started on a painted cell erases the whole run", () => {
      const board = makeBoard(4, 1);
      press(0, 0, LEFT);
      release();

      press(0, 0, LEFT);
      drag(1, 0);
      drag(2, 0);
      release();

      expect(board.getCells().map(column => column[0])).toEqual([
        UNKNOWN,
        UNKNOWN,
        UNKNOWN,
        UNKNOWN,
      ]);
    });

    test("a drag started on a blank cell paints the whole run", () => {
      const board = makeBoard(4, 1);
      press(1, 0, LEFT);
      drag(2, 0);
      drag(3, 0);
      release();
      expect(board.getCells().map(column => column[0])).toEqual([
        UNKNOWN,
        DARK,
        DARK,
        DARK,
      ]);
    });

    test("a pointermove with the pointer up paints nothing", () => {
      const board = makeBoard(2, 1);
      drag(0, 0);
      expect(board.getCells()[0]![0]).toBe(UNKNOWN);
    });

    /**
     * A touch that becomes a system gesture ends as pointercancel rather than
     * pointerup. A board that kept the stroke would carry on painting.
     */
    test("pointercancel ends the stroke", () => {
      const board = makeBoard(4, 1);
      press(0, 0, LEFT);
      release("pointercancel");
      drag(2, 0);
      expect(board.getCells()[2]![0]).toBe(UNKNOWN);
    });
  });

  describe("Keyboard painting", () => {
    /** Colouring is the page's main task, so it cannot be pointer-only. */
    test.each(["Enter", " "])("%s applies the selected tool", key => {
      const board = makeBoard(2, 2);
      type(0, 0, key);
      expect(board.getCells()[0]![0]).toBe(DARK);
    });

    test("the light tool paints light from the keyboard too", () => {
      const board = makeBoard(2, 2, "light");
      type(1, 1, "Enter");
      expect(board.getCells()[1]![1]).toBe(LIGHT);
    });

    test("pressing it again on the same colour clears the cell", () => {
      const board = makeBoard(2, 2);
      type(0, 0, "Enter");
      type(0, 0, "Enter");
      expect(board.getCells()[0]![0]).toBe(UNKNOWN);
    });

    /** A keystroke has no drag to carry, so it must leave no stroke behind. */
    test("it leaves no stroke for a later pointermove to continue", () => {
      const board = makeBoard(4, 1);
      type(0, 0, "Enter");
      drag(2, 0);
      expect(board.getCells()[2]![0]).toBe(UNKNOWN);
    });

    test("the reset tool paints nothing", () => {
      const board = makeBoard(2, 2, "reset");
      type(0, 0, "Enter");
      expect(board.getCells()[0]![0]).toBe(UNKNOWN);
    });
  });

  describe("Clues", () => {
    test("the symbol tool stamps the selected kind and value", () => {
      const board = makeBoard(2, 2, "symbol", 0, 4);
      press(1, 1, LEFT);
      release();
      expect(board.getSymbols()).toEqual([{ x: 1, y: 1, type: 0, value: 4 }]);
      expect(cellAt(1, 1).dataset.symbol).toBe("area");
      expect(cellAt(1, 1).textContent).toBe("4");
      expect(cellAt(1, 1).getAttribute("aria-label")).toBe(
        "Column 2, Row 2, Unknown, Area number 4",
      );
    });

    /**
     * The stylesheet sizes a clue by how many characters it has, because CSS
     * cannot measure a string and an area number is only bounded by the board's
     * own area. Without this the one-digit case — which is all but four of the
     * 221 area clues in the captured corpus — has to be sized for a number that
     * hardly ever turns up.
     */
    test("a clue reports how long its label is", () => {
      const board = makeBoard(4, 4, "symbol", 0, 7);
      press(0, 0, LEFT);
      release();
      expect(cellAt(0, 0).dataset.labelLength).toBe("1");

      board.setSymbolValue(12);
      press(1, 0, LEFT);
      release();
      expect(cellAt(1, 0).dataset.labelLength).toBe("2");

      // Lifting the clue takes the attribute with it, or an empty cell would
      // keep sizing text it no longer has.
      press(1, 0, RIGHT);
      release();
      expect(cellAt(1, 0).dataset.labelLength).toBeUndefined();
    });

    test("a letter is always one character long", () => {
      makeBoard(2, 2, "symbol", 1, "C");
      press(0, 0, LEFT);
      release();
      expect(cellAt(0, 0).dataset.labelLength).toBe("1");
    });

    test("stamping the same clue again lifts it", () => {
      const board = makeBoard(2, 2, "symbol", 0, 4);
      press(1, 1, LEFT);
      release();
      press(1, 1, LEFT);
      release();
      expect(board.getSymbols()).toEqual([]);
    });

    test("right-clicking lifts a clue and leaves the colour", () => {
      const board = makeBoard(2, 2, "symbol", 1, "C");
      press(0, 0, LEFT);
      release();
      board.setSelectedTool("dark");
      press(0, 0, LEFT);
      release();
      board.setSelectedTool("symbol");
      press(0, 0, RIGHT);
      release();
      expect(board.getSymbols()).toEqual([]);
      expect(board.getCells()[0]![0]).toBe(DARK);
    });

    /** A half-typed value field must stamp nothing rather than a guess. */
    test("an unusable value stamps nothing", () => {
      const board = makeBoard(2, 2, "symbol", 0, null);
      press(0, 0, LEFT);
      release();
      expect(board.getSymbols()).toEqual([]);
    });

    test("colouring over a clue keeps it", () => {
      const board = makeBoard(2, 2, "symbol", 0, 2);
      press(0, 0, LEFT);
      release();
      board.setSelectedTool("light");
      press(0, 0, LEFT);
      release();
      expect(board.getCells()[0]![0]).toBe(LIGHT);
      expect(board.getSymbols()).toEqual([{ x: 0, y: 0, type: 0, value: 2 }]);
    });

    test("painting a gap drops the clue that was there", () => {
      const board = makeBoard(2, 2, "symbol", 0, 2);
      press(0, 0, LEFT);
      release();
      board.setSelectedTool("unplayable");
      press(0, 0, LEFT);
      release();
      expect(board.getCells()[0]![0]).toBe(UNPLAYABLE);
      expect(board.getSymbols()).toEqual([]);
    });

    test("a clue cannot be placed on a gap", () => {
      const board = makeBoard(2, 2, "unplayable");
      press(0, 0, LEFT);
      release();
      board.setSelectedTool("symbol");
      press(0, 0, LEFT);
      release();
      expect(board.getSymbols()).toEqual([]);
    });

    test("the eraser clears both layers", () => {
      const board = makeBoard(2, 2, "symbol", 0, 2);
      press(0, 0, LEFT);
      release();
      board.setSelectedTool("dark");
      press(0, 0, LEFT);
      release();
      board.setSelectedTool("erase");
      press(0, 0, LEFT);
      release();
      expect(board.getCells()[0]![0]).toBe(UNKNOWN);
      expect(board.getSymbols()).toEqual([]);
    });

    test("clues come back in reading order", () => {
      const board = makeBoard(3, 2, "symbol", 0, 1);
      press(2, 1, LEFT);
      release();
      press(0, 0, LEFT);
      release();
      press(1, 1, LEFT);
      release();
      expect(board.getSymbols().map(s => [s.x, s.y])).toEqual([
        [0, 0],
        [1, 1],
        [2, 1],
      ]);
    });
  });

  describe("Typing on a cell", () => {
    test("a digit stamps an area number", () => {
      const board = makeBoard(2, 2, "dark", 0, 1);
      type(0, 0, "7");
      expect(board.getSymbols()).toEqual([{ x: 0, y: 0, type: 0, value: 7 }]);
    });

    /** Areas run past nine, so consecutive digits on one cell accumulate. */
    test("consecutive digits build a multi-digit area", () => {
      const board = makeBoard(4, 4, "dark", 0, 1);
      type(0, 0, "1");
      type(0, 0, "2");
      expect(board.getSymbols()[0]!.value).toBe(12);
    });

    test("a number that would outgrow the board is refused", () => {
      const board = makeBoard(2, 2, "dark", 0, 1);
      type(0, 0, "3");
      type(0, 0, "9");
      expect(board.getSymbols()[0]!.value).toBe(3);
    });

    test("moving to another cell starts a fresh number", () => {
      const board = makeBoard(4, 4, "dark", 0, 1);
      type(0, 0, "1");
      type(1, 0, "2");
      type(0, 0, "3");
      expect(board.getSymbols()).toEqual([
        { x: 0, y: 0, type: 0, value: 3 },
        { x: 1, y: 0, type: 0, value: 2 },
      ]);
    });

    test("painting ends the run", () => {
      const board = makeBoard(4, 4, "dark", 0, 1);
      type(0, 0, "1");
      press(0, 0, LEFT);
      release();
      type(0, 0, "2");
      expect(board.getSymbols()[0]!.value).toBe(2);
    });

    test("a leading zero is ignored rather than clamped", () => {
      const board = makeBoard(2, 2, "dark", 0, 1);
      type(0, 0, "0");
      expect(board.getSymbols()).toEqual([]);
    });

    test("a letter key edits a letter clue in place", () => {
      const board = makeBoard(2, 2, "symbol", 1, "A");
      press(0, 0, LEFT);
      release();
      type(0, 0, "c");
      expect(board.getSymbols()).toEqual([{ x: 0, y: 0, type: 1, value: "C" }]);
    });

    /** The key edits the clue that is there, so a digit cannot rewrite a letter. */
    test("a digit is ignored on a letter clue", () => {
      const board = makeBoard(2, 2, "symbol", 1, "A");
      press(0, 0, LEFT);
      release();
      type(0, 0, "5");
      expect(board.getSymbols()[0]!.value).toBe("A");
    });

    test("a letter is ignored when the area kind is selected", () => {
      const board = makeBoard(2, 2, "dark", 0, 1);
      type(0, 0, "q");
      expect(board.getSymbols()).toEqual([]);
    });

    test("Backspace removes the clue and keeps the colour", () => {
      const board = makeBoard(2, 2, "dark", 0, 1);
      press(0, 0, LEFT);
      release();
      type(0, 0, "5");
      type(0, 0, "Backspace");
      expect(board.getSymbols()).toEqual([]);
      expect(board.getCells()[0]![0]).toBe(DARK);
    });

    test("typing on a gap does nothing", () => {
      const board = makeBoard(2, 2, "unplayable");
      press(0, 0, LEFT);
      release();
      type(0, 0, "5");
      expect(board.getSymbols()).toEqual([]);
    });
  });

  describe("loadConfig", () => {
    test("fills both layers", () => {
      const board = makeBoard(2, 2);
      board.loadConfig({
        gridWidth: 2,
        gridHeight: 2,
        rules: [],
        cells: [
          [DARK, LIGHT],
          [UNKNOWN, UNPLAYABLE],
        ],
        symbols: [{ x: 0, y: 1, type: 1, value: "D" }],
      });
      board.renderGrid();
      expect(board.getCells()).toEqual([
        [DARK, LIGHT],
        [UNKNOWN, UNPLAYABLE],
      ]);
      expect(board.getSymbols()).toEqual([{ x: 0, y: 1, type: 1, value: "D" }]);
      expect(cellAt(1, 1).dataset.color).toBe("unplayable");
      expect(cellAt(0, 1).textContent).toBe("D");
    });
  });

  describe("dispose", () => {
    /**
     * `#grid` outlives the board, so a replaced board that kept listening would
     * keep painting into its own dead cells.
     */
    test("a disposed board stops painting", () => {
      const board = makeBoard(2, 2);
      board.dispose();
      press(0, 0, LEFT);
      release();
      expect(board.getCells()[0]![0]).toBe(UNKNOWN);
    });
  });
});
