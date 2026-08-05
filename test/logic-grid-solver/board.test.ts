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
      const board = makeBoard(4, 4, "dark", 0, 1);
      type(0, 0, "7");
      expect(board.getSymbols()).toEqual([{ x: 0, y: 0, type: 0, value: 7 }]);
    });

    /**
     * The ceiling applies to the FIRST digit too, not only to a grown one: a
     * 2x2 board's area tops out at 4, so a single keystroke can already
     * overshoot and there is no earlier value to fall back to.
     */
    test("a first digit above the board's area is refused", () => {
      const board = makeBoard(2, 2, "dark", 0, 1);
      type(0, 0, "7");
      expect(board.getSymbols()).toEqual([]);
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

  /**
   * The dart is the first clue that carries more than a value, and the first
   * whose square matters: it counts along a line from where it sits. So it is
   * placed with both halves at once, and the arrow drawn on it is a handle the
   * pointer can swing round afterwards.
   */
  describe("Darts", () => {
    const DART = 2;
    const UP = 0;
    const RIGHT_WAY = 1;
    const DOWN = 2;
    const LEFT_WAY = 3;

    /** A board with one dart already on `(1, 1)`, aimed right. */
    function withDart(value = 2, direction = RIGHT_WAY) {
      const board = makeBoard(4, 3, "symbol", DART, value);
      board.setSymbolDirection(direction);
      press(1, 1, LEFT);
      release();
      return board;
    }

    test("stamps the value and the direction together", () => {
      const board = withDart(2, DOWN);
      expect(board.getSymbols()).toEqual([
        { x: 1, y: 1, type: DART, value: 2, direction: DOWN },
      ]);
      expect(cellAt(1, 1).getAttribute("aria-label")).toBe(
        "Column 2, Row 2, Unknown, Dart 2 pointing down",
      );
    });

    /**
     * Two children rather than one text node, and the arrow's SEAT is a quarter
     * turn clockwise of the way it points — which the stylesheet does off
     * `data-direction`, so what is pinned here is that the attribute and the
     * two elements are there for it to work with.
     */
    test("draws the number and a real arrow element", () => {
      withDart(3, LEFT_WAY);
      const cell = cellAt(1, 1);
      expect(cell.dataset.direction).toBe("left");
      expect(cell.querySelector(".cell-value")?.textContent).toBe("3");
      expect(cell.querySelector(".cell-arrow")?.textContent).toBe(
        "arrow_right_alt",
      );
      // The number is written first, so one flex direction says all four seats.
      expect(cell.firstElementChild?.className).toBe("cell-value");
    });

    test("lifting a dart takes its arrow with it", () => {
      const board = withDart();
      board.setSelectedTool("symbol");
      press(1, 1, RIGHT);
      release();
      expect(board.getSymbols()).toEqual([]);
      expect(cellAt(1, 1).dataset.direction).toBeUndefined();
      expect(cellAt(1, 1).querySelector(".cell-arrow")).toBeNull();
    });

    /**
     * The re-click rule compares the WHOLE clue. Stamping a dart that differs
     * only in where it points has to re-aim the one already there rather than
     * read as "the same clue again" and lift it.
     */
    /**
     * The re-click rule for a DIRECTED clue turns instead of lifting: the same
     * clue apart from where it points is a request to point it somewhere else.
     * Four clicks take it all the way round, so placing a row of darts and then
     * aiming them is a sequence of plain clicks.
     */
    test("clicking a placed dart turns it clockwise", () => {
      const board = withDart(2, RIGHT_WAY);
      const aim = () => board.getSymbols()[0]!.direction;

      press(1, 1, LEFT);
      release();
      expect(aim()).toBe(DOWN);

      press(1, 1, LEFT);
      release();
      expect(aim()).toBe(LEFT_WAY);

      press(1, 1, LEFT);
      release();
      expect(aim()).toBe(UP);

      press(1, 1, LEFT);
      release();
      // All the way round and back to where it started, rather than stopping
      // at the last direction or lifting the clue.
      expect(aim()).toBe(RIGHT_WAY);
    });

    /** Turning is only for the clue that is already there; a different value
     *  is a different clue and overwrites, aimed the way the tool is. */
    test("a different value overwrites rather than turning", () => {
      const board = withDart(2, RIGHT_WAY);
      board.setSymbolValue(5);
      press(1, 1, LEFT);
      release();
      expect(board.getSymbols()).toEqual([
        { x: 1, y: 1, type: DART, value: 5, direction: RIGHT_WAY },
      ]);
    });

    /** Lifting is the right button's job alone, since the left one now turns. */
    test("only the right button lifts a dart", () => {
      const board = withDart(1, UP);
      press(1, 1, RIGHT);
      release();
      expect(board.getSymbols()).toEqual([]);
    });

    test("an arrow key aims a focused dart", () => {
      const board = withDart(1, RIGHT_WAY);
      type(1, 1, "ArrowDown");
      expect(board.getSymbols()[0]!.direction).toBe(DOWN);
      type(1, 1, "ArrowLeft");
      expect(board.getSymbols()[0]!.direction).toBe(LEFT_WAY);
    });

    /** Everywhere else the arrows go on scrolling, as they always did. */
    test("an arrow key on a cell with no dart does nothing", () => {
      const board = makeBoard(4, 3, "symbol", 0, 4);
      press(0, 0, LEFT);
      release();
      type(0, 0, "ArrowUp");
      expect(board.getSymbols()).toEqual([{ x: 0, y: 0, type: 0, value: 4 }]);
    });

    /** Zero is a real dart, unlike an area of zero — see `nextNumberValue`. */
    test("typing keeps the dart's own bounds and its aim", () => {
      const board = withDart(2, DOWN);
      type(1, 1, "0");
      expect(board.getSymbols()).toEqual([
        { x: 1, y: 1, type: DART, value: 0, direction: DOWN },
      ]);
    });

    test("round-trips the direction through a config", () => {
      const board = makeBoard(3, 3);
      board.loadConfig({
        version: 1,
        gridWidth: 3,
        gridHeight: 3,
        rules: [],
        cells: [
          [UNKNOWN, UNKNOWN, UNKNOWN],
          [UNKNOWN, UNKNOWN, UNKNOWN],
          [UNKNOWN, UNKNOWN, UNKNOWN],
        ],
        symbols: [{ x: 2, y: 0, type: DART, value: 1, direction: UP }],
      });
      board.renderGrid();
      expect(board.getSymbols()).toEqual([
        { x: 2, y: 0, type: DART, value: 1, direction: UP },
      ]);
      expect(cellAt(2, 0).dataset.direction).toBe("up");
    });
  });

  /**
   * The symmetry symbol (the game's lotus): the first VALUELESS kind, whose
   * `direction` is an axis and whose place inside a merged cell — the SEAT —
   * is chosen by where the pointer goes down, half-grid points included.
   */
  describe("Symmetry symbols", () => {
    const LOTUS = 3;

    function makeLotusBoard(axis = 0) {
      const board = makeBoard(4, 3, "symbol", LOTUS, null);
      board.setSymbolDirection(axis);
      return board;
    }

    /**
     * A press that says WHERE in the square it landed. happy-dom has no
     * layout, so the square's box is stubbed and the coordinates do the rest —
     * which is exactly the half of seat-snapping a unit test can reach.
     */
    function pressAt(x: number, y: number, clientX: number, clientY: number) {
      const cell = cellAt(x, y);
      spyOn(cell, "getBoundingClientRect").mockReturnValue({
        left: 0,
        top: 0,
        width: 40,
        height: 40,
      } as DOMRect);
      cell.dispatchEvent(
        new MouseEvent("pointerdown", {
          bubbles: true,
          button: LEFT,
          clientX,
          clientY,
        }),
      );
    }

    /** A vertical 1x2 merged cell in the top-left corner. */
    function withMergedColumn(board: Board) {
      board.setSelectedTool("merge");
      press(0, 0);
      drag(0, 1);
      release();
      board.setSelectedTool("symbol");
    }

    test("stamps with an axis and no value key", () => {
      const board = makeLotusBoard(0);
      press(1, 1);
      expect(board.getSymbols()).toEqual([
        { x: 1, y: 1, type: LOTUS, direction: 0 },
      ]);
      expect(cellAt(1, 1).dataset.symbol).toBe("lotus");
      expect(cellAt(1, 1).dataset.axis).toBe("horizontal");
      expect(cellAt(1, 1).getAttribute("aria-label")).toBe(
        "Column 2, Row 2, Unknown, Symmetry along the horizontal axis",
      );
    });

    test("re-clicking turns it 45 degrees clockwise, four times round", () => {
      const board = makeLotusBoard(0);
      press(1, 1);
      press(1, 1);
      expect(cellAt(1, 1).dataset.axis).toBe("diagonal-down");
      press(1, 1);
      expect(cellAt(1, 1).dataset.axis).toBe("vertical");
      press(1, 1);
      expect(cellAt(1, 1).dataset.axis).toBe("diagonal-up");
      press(1, 1);
      expect(board.getSymbols()).toEqual([
        { x: 1, y: 1, type: LOTUS, direction: 0 },
      ]);
    });

    test("the right button lifts it", () => {
      const board = makeLotusBoard(2);
      press(1, 1);
      press(1, 1, RIGHT);
      expect(board.getSymbols()).toEqual([]);
      expect(cellAt(1, 1).dataset.symbol).toBeUndefined();
    });

    /** A valueless kind has nothing for a keystroke to edit — and it must not
     * lose its clue to one either. */
    test("digits neither edit nor replace it", () => {
      const board = makeLotusBoard(0);
      press(1, 1);
      type(1, 1, "3");
      expect(board.getSymbols()).toEqual([
        { x: 1, y: 1, type: LOTUS, direction: 0 },
      ]);
    });

    /** Compass keys do not name axes, so the horizontal pair STEPS the axis
     * instead, and the vertical pair keeps scrolling. */
    test("the horizontal arrows step the axis either way round", () => {
      const board = makeLotusBoard(0);
      press(1, 1);
      type(1, 1, "ArrowRight");
      expect(cellAt(1, 1).dataset.axis).toBe("diagonal-down");
      type(1, 1, "ArrowLeft");
      expect(cellAt(1, 1).dataset.axis).toBe("horizontal");
      type(1, 1, "ArrowUp");
      expect(cellAt(1, 1).dataset.axis).toBe("horizontal");
      expect(board.getSymbols()).toHaveLength(1);
    });

    test("another kind stamped over it clears it first", () => {
      const board = makeLotusBoard(0);
      press(1, 1);
      board.setSelectedSymbol(0);
      board.setSymbolValue(2);
      press(1, 1);
      expect(board.getSymbols()).toEqual([{ x: 1, y: 1, type: 0, value: 2 }]);
    });

    test("a press near the seam seats it on the grid line", () => {
      const board = makeLotusBoard(0);
      withMergedColumn(board);
      pressAt(0, 0, 20, 38);
      expect(board.getSymbols()).toEqual([
        { x: 0, y: 0, type: LOTUS, direction: 0, seat: 2 },
      ]);
      expect(cellAt(0, 0).dataset.seat).toBe("2");
    });

    /** Leaning towards a square that is not a shape-mate has no seam to sit
     * on, so the press falls back to the square's own centre. */
    test("a seat the shape cannot carry falls back to the centre", () => {
      const board = makeLotusBoard(0);
      withMergedColumn(board);
      pressAt(0, 0, 38, 20);
      expect(board.getSymbols()).toEqual([
        { x: 0, y: 0, type: LOTUS, direction: 0 },
      ]);
    });

    /** A diagonal axis has no reflection on a grid-line seat, so the seam is
     * skipped rather than defined. */
    test("a diagonal axis refuses the seam and sits at the centre", () => {
      const board = makeLotusBoard(1);
      withMergedColumn(board);
      pressAt(0, 0, 20, 38);
      expect(board.getSymbols()).toEqual([
        { x: 0, y: 0, type: LOTUS, direction: 1 },
      ]);
    });

    test("turning on a grid-line seat skips the diagonals", () => {
      const board = makeLotusBoard(0);
      withMergedColumn(board);
      pressAt(0, 0, 20, 38);
      pressAt(0, 0, 20, 38);
      expect(board.getSymbols()).toEqual([
        { x: 0, y: 0, type: LOTUS, direction: 2, seat: 2 },
      ]);
      pressAt(0, 0, 20, 38);
      expect(board.getSymbols()).toEqual([
        { x: 0, y: 0, type: LOTUS, direction: 0, seat: 2 },
      ]);
    });

    test("restructuring its cell drops it", () => {
      const board = makeLotusBoard(0);
      withMergedColumn(board);
      pressAt(0, 0, 20, 38);
      board.setSelectedTool("merge");
      press(0, 1, RIGHT);
      release();
      expect(board.getSymbols()).toEqual([]);
    });

    /** Every kind keeps the square its file names, and for a lotus that square
     * is half of its seat: `(0,0)` seat 2 is the seam BELOW the top square, a
     * different point from the same seat under either of the others. */
    test("loadConfig keeps it on its own square", () => {
      const board = makeBoard(4, 3);
      board.loadConfig({
        version: 1,
        gridWidth: 4,
        gridHeight: 3,
        rules: [],
        cells: [
          [UNKNOWN, UNKNOWN, UNKNOWN],
          [UNKNOWN, UNKNOWN, UNKNOWN],
          [UNKNOWN, UNKNOWN, UNKNOWN],
          [UNKNOWN, UNKNOWN, UNKNOWN],
        ],
        symbols: [{ x: 0, y: 0, type: LOTUS, direction: 0, seat: 2 }],
        shapes: [[0, 4, 8]],
      });
      board.renderGrid();
      expect(board.getSymbols()).toEqual([
        { x: 0, y: 0, type: LOTUS, direction: 0, seat: 2 },
      ]);
      expect(cellAt(0, 0).dataset.seat).toBe("2");
    });
  });

  describe("loadConfig", () => {
    test("fills both layers", () => {
      const board = makeBoard(2, 2);
      board.loadConfig({
        version: 1,
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

  /**
   * Merged cells: several grid squares acting as ONE cell. The gestures are
   * per-square — a left-drag pulls squares into the cell the stroke started in,
   * a right-drag pushes them back out — so what is asserted here is where each
   * square ends up and that whatever is left behind is still one connected
   * shape.
   */
  describe("Merged cells", () => {
    /** Fuses a run of squares by dragging across them with the merge tool. */
    function mergeAcross(squares: [number, number][], button = LEFT) {
      const [first, ...rest] = squares;
      press(first![0], first![1], button);
      for (const [x, y] of rest) drag(x, y);
      release();
    }

    test("a drag fuses the squares it crosses into one cell", () => {
      const board = makeBoard(4, 3, "merge");
      mergeAcross([
        [0, 0],
        [1, 0],
        [2, 0],
      ]);
      expect(board.getShapes()).toEqual([[0, 1, 2]]);
    });

    test("a board with no merged cells reports none at all", () => {
      // Not an empty array: the key is omitted from the download entirely.
      expect(makeBoard(2, 2, "merge").getShapes()).toBeUndefined();
    });

    /**
     * The user's own example: start inside one cell, drag into another, and the
     * squares crossed move between them. Starting inside a cell EXTENDS it
     * rather than beginning a third.
     */
    test("a drag moves squares out of the cell they were in", () => {
      const board = makeBoard(4, 3, "merge");
      mergeAcross([
        [0, 0],
        [1, 0],
      ]);
      mergeAcross([
        [2, 0],
        [3, 0],
      ]);
      expect(board.getShapes()).toEqual([
        [0, 1],
        [2, 3],
      ]);

      // Start in the second cell and drag back over one square of the first.
      mergeAcross([
        [2, 0],
        [1, 0],
      ]);
      expect(board.getShapes()).toEqual([[1, 2, 3]]);
    });

    test("right-dragging takes squares back out one at a time", () => {
      const board = makeBoard(4, 3, "merge");
      mergeAcross([
        [0, 0],
        [1, 0],
        [2, 0],
      ]);
      mergeAcross([[1, 0]], RIGHT);
      // The middle square left, and what remains is two loose squares rather
      // than one cell in two pieces.
      expect(board.getShapes()).toBeUndefined();
    });

    /**
     * Pulling a square out can leave the rest in several pieces, and a cell is
     * always ONE connected shape. Taking the middle out of a plus leaves four
     * separated arms, and each is a plain square again.
     */
    test("what a split leaves behind is broken into connected pieces", () => {
      const board = makeBoard(3, 3, "merge");
      // A T: the top row plus the square below its middle.
      mergeAcross([
        [0, 0],
        [1, 0],
        [2, 0],
      ]);
      mergeAcross([
        [1, 0],
        [1, 1],
      ]);
      expect(board.getShapes()).toEqual([[0, 1, 2, 4]]);

      mergeAcross([[1, 0]], RIGHT);
      // (0,0) is alone, so it dissolves; (2,0) and (1,1) are alone too. The
      // whole cell falls apart rather than staying one disconnected cell.
      expect(board.getShapes()).toBeUndefined();
    });

    test("a merged cell takes one colour for all of its squares", () => {
      const board = makeBoard(4, 3, "merge");
      mergeAcross([
        [0, 0],
        [1, 0],
        [2, 0],
      ]);

      board.setSelectedTool("dark");
      press(1, 0, LEFT);
      release();
      expect(board.getCells()[0]![0]).toBe(DARK);
      expect(board.getCells()[1]![0]).toBe(DARK);
      expect(board.getCells()[2]![0]).toBe(DARK);
      // ...and nothing outside it.
      expect(board.getCells()[3]![0]).toBe(UNKNOWN);
    });

    /**
     * A merged cell holds ONE clue, on whichever of its squares the player put
     * it — the game draws a dart's line from its own square, and even an area
     * number reads as a different board when it moves, so nothing is re-homed
     * to a canonical middle square any more.
     */
    test("a merged cell carries its clue once, where it was pressed", () => {
      const board = makeBoard(4, 3, "merge");
      mergeAcross([
        [0, 0],
        [1, 0],
        [2, 0],
      ]);

      board.setSelectedTool("symbol");
      board.setSymbolValue(3);
      press(2, 0, LEFT);
      release();
      expect(board.getSymbols()).toEqual([{ x: 2, y: 0, type: 0, value: 3 }]);
      expect(cellAt(2, 0).textContent).toBe("3");
      expect(cellAt(1, 0).textContent).toBe("");
    });

    /** Pressing another square MOVES the cell's one clue rather than lifting
     * it: two clues on one cell is what the model does not allow, and a press
     * that reads as "the same clue again" would have erased this one. */
    test("pressing another square of a clued cell moves the clue there", () => {
      const board = makeBoard(4, 3, "merge");
      mergeAcross([
        [0, 0],
        [1, 0],
        [2, 0],
      ]);

      board.setSelectedTool("symbol");
      board.setSymbolValue(3);
      press(2, 0, LEFT);
      release();
      press(0, 0, LEFT);
      release();
      expect(board.getSymbols()).toEqual([{ x: 0, y: 0, type: 0, value: 3 }]);
      expect(cellAt(0, 0).textContent).toBe("3");
      expect(cellAt(2, 0).textContent).toBe("");

      // ...and the SAME square still erases, which is the only way a press
      // lifts one.
      press(0, 0, LEFT);
      release();
      expect(board.getSymbols()).toEqual([]);
    });

    /**
     * The keyboard has to agree with the pointer above: a first clue lands on
     * the square being typed on, and the second digit then has to find the
     * first's number rather than start again beside it.
     */
    test("typing on a square of a merged cell clues that square", () => {
      const board = makeBoard(4, 3, "merge");
      mergeAcross([
        [0, 0],
        [1, 0],
        [2, 0],
      ]);

      board.setSelectedTool("symbol");
      type(2, 0, "1");
      type(2, 0, "2");
      expect(board.getSymbols()).toEqual([{ x: 2, y: 0, type: 0, value: 12 }]);
      expect(cellAt(2, 0).textContent).toBe("12");
    });

    /**
     * The cell carries one clue however many squares it spans, so typing on a
     * DIFFERENT square edits the one already there rather than stamping a
     * second beside it. It stays where it is: typing is an edit, and only a
     * press moves a clue.
     */
    test("typing on another square edits the clue the cell already has", () => {
      const board = makeBoard(4, 3, "merge");
      mergeAcross([
        [0, 0],
        [1, 0],
        [2, 0],
      ]);

      board.setSelectedTool("symbol");
      type(2, 0, "1");
      type(0, 0, "2");
      expect(board.getSymbols()).toEqual([{ x: 2, y: 0, type: 0, value: 12 }]);
      expect(cellAt(0, 0).textContent).toBe("");
    });

    test("Backspace on any square of a merged cell lifts its clue", () => {
      const board = makeBoard(4, 3, "merge");
      mergeAcross([
        [0, 0],
        [1, 0],
        [2, 0],
      ]);

      board.setSelectedTool("symbol");
      board.setSymbolValue(3);
      press(0, 0, LEFT);
      release();
      expect(board.getSymbols()).toHaveLength(1);

      // From the far end, which is not where the clue is stored.
      type(2, 0, "Backspace");
      expect(board.getSymbols()).toEqual([]);
    });

    /**
     * A merged cell holds one colour and at most one clue, and the squares
     * coming together may disagree about both — so restructuring clears rather
     * than picking a winner nobody could predict.
     */
    test("merging clears the colour and clue of everything it touches", () => {
      const board = makeBoard(4, 3, "dark");
      press(0, 0, LEFT);
      release();
      press(1, 0, RIGHT);
      release();
      expect(board.getCells()[0]![0]).toBe(DARK);
      expect(board.getCells()[1]![0]).toBe(LIGHT);

      board.setSelectedTool("merge");
      mergeAcross([
        [0, 0],
        [1, 0],
      ]);
      expect(board.getCells()[0]![0]).toBe(UNKNOWN);
      expect(board.getCells()[1]![0]).toBe(UNKNOWN);
    });

    test("a gap cannot be part of a merged cell", () => {
      const board = makeBoard(4, 3, "unplayable");
      press(1, 0, LEFT);
      release();

      board.setSelectedTool("merge");
      mergeAcross([
        [0, 0],
        [1, 0],
        [2, 0],
      ]);
      // (1,0) is a gap, so it is skipped; the two ends are then a cell in two
      // pieces, which splits back into loose squares.
      expect(board.getShapes()).toBeUndefined();
    });

    test("painting a merged cell unplayable dissolves it", () => {
      const board = makeBoard(4, 3, "merge");
      mergeAcross([
        [0, 0],
        [1, 0],
      ]);
      board.setSelectedTool("unplayable");
      press(0, 0, LEFT);
      release();
      expect(board.getShapes()).toBeUndefined();
      expect(board.getCells()[0]![0]).toBe(UNPLAYABLE);
      expect(board.getCells()[1]![0]).toBe(UNPLAYABLE);
    });

    test("the seams inside a merged cell are marked for the stylesheet", () => {
      makeBoard(4, 3, "merge");
      mergeAcross([
        [0, 0],
        [1, 0],
      ]);
      expect(cellAt(0, 0).classList.contains("cell-join-right")).toBeTrue();
      expect(cellAt(1, 0).classList.contains("cell-join-left")).toBeTrue();
      // The outer sides keep their border.
      expect(cellAt(0, 0).classList.contains("cell-join-left")).toBeFalse();
      expect(cellAt(1, 0).classList.contains("cell-join-right")).toBeFalse();
      // And a square that leaves the cell loses its seam again.
      mergeAcross([[1, 0]], RIGHT);
      expect(cellAt(0, 0).classList.contains("cell-join-right")).toBeFalse();
    });

    /**
     * Colouring cannot be pointer-only on this page, and nor should merging be.
     * A keystroke has no drag, so it joins the focused square to a fixed
     * neighbour: the one to its LEFT, or the one ABOVE when it is in column 0.
     * Walk the shape and press Enter on each square.
     */
    test("Enter joins a square to the cell before it", () => {
      const board = makeBoard(4, 3, "merge");
      type(1, 0, "Enter");
      expect(board.getShapes()).toEqual([[0, 1]]);

      // Walking on extends the same cell rather than starting another.
      type(2, 0, "Enter");
      expect(board.getShapes()).toEqual([[0, 1, 2]]);

      // Nothing to the left, so it takes the square above.
      type(0, 1, "Enter");
      expect(board.getShapes()).toEqual([[0, 1, 2, 4]]);
    });

    test("Enter on the first square has nothing to join and does nothing", () => {
      const board = makeBoard(4, 3, "merge");
      type(0, 0, "Enter");
      expect(board.getShapes()).toBeUndefined();
    });

    /**
     * A click that merges nothing must cost nothing. The stroke claims the
     * square into a cell of one, and the pointerup dissolves it again — so if
     * the clear ran on the way in, a stray click would quietly wipe a painted,
     * clued square and leave no merged cell behind to show for it.
     */
    test("a click that merges nothing leaves the square alone", () => {
      const board = makeBoard(4, 3, "dark");
      press(0, 0, LEFT);
      release();
      board.setSelectedTool("symbol");
      board.setSymbolValue(4);
      press(0, 0, LEFT);
      release();
      expect(board.getSymbols()).toEqual([{ x: 0, y: 0, type: 0, value: 4 }]);

      board.setSelectedTool("merge");
      press(0, 0, LEFT);
      release();
      expect(board.getShapes()).toBeUndefined();
      expect(board.getCells()[0]![0]).toBe(DARK);
      expect(board.getSymbols()).toEqual([{ x: 0, y: 0, type: 0, value: 4 }]);
    });

    /**
     * The merge tool's secondary action, which the pointer gets on the right
     * button. Without it a keyboard user could build a merged cell and never
     * take a square back out of one.
     */
    test("Backspace takes a square back out of its cell", () => {
      const board = makeBoard(4, 3, "merge");
      type(1, 0, "Enter");
      type(2, 0, "Enter");
      expect(board.getShapes()).toEqual([[0, 1, 2]]);

      type(2, 0, "Backspace");
      expect(board.getShapes()).toEqual([[0, 1]]);
    });

    test("Backspace still lifts a clue when merging is not selected", () => {
      const board = makeBoard(4, 3, "symbol");
      board.setSymbolValue(2);
      press(1, 1, LEFT);
      release();
      expect(board.getSymbols()).toHaveLength(1);
      type(1, 1, "Backspace");
      expect(board.getSymbols()).toEqual([]);
    });

    test("loading a config restores its merged cells", () => {
      const board = makeBoard(4, 3, "merge");
      board.loadConfig({
        version: 1,
        gridWidth: 4,
        gridHeight: 3,
        rules: [],
        cells: [
          [DARK, UNKNOWN, UNKNOWN],
          [DARK, UNKNOWN, UNKNOWN],
          [UNKNOWN, UNKNOWN, UNKNOWN],
          [UNKNOWN, UNKNOWN, UNKNOWN],
        ],
        // On the far square of the merged cell, and it stays there: which
        // square holds a clue is the file's to say, so a load moves nothing.
        symbols: [{ x: 1, y: 0, type: 0, value: 2 }],
        shapes: [[0, 1]],
      });
      board.renderGrid();
      expect(board.getShapes()).toEqual([[0, 1]]);
      expect(board.getSymbols()).toEqual([{ x: 1, y: 0, type: 0, value: 2 }]);
      expect(cellAt(1, 0).textContent).toBe("2");
      expect(cellAt(0, 0).classList.contains("cell-join-right")).toBeTrue();
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
