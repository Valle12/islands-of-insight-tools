import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Block } from "../../src/pages/shifting-mosaic-solver/block";
import { Board } from "../../src/pages/shifting-mosaic-solver/board";
import type { ShiftingMosaicSolverEditor } from "../../src/pages/shifting-mosaic-solver/shiftingMosaicSolver";

describe("Board (shifting-mosaic)", () => {
  let editorMock: {
    render: ReturnType<typeof mock>;
    hideSolution: ReturnType<typeof mock>;
    notifyGoalZonePlacementChanged: ReturnType<typeof mock>;
    showWarning: ReturnType<typeof mock>;
  };
  let board: Board;
  let internal: any;

  beforeEach(() => {
    document.body.innerHTML = '<div id="grid"></div>';
    editorMock = {
      render: mock(() => {}),
      hideSolution: mock(() => {}),
      notifyGoalZonePlacementChanged: mock(() => {}),
      showWarning: mock(() => {}),
    };
    board = new Board(
      editorMock as unknown as ShiftingMosaicSolverEditor,
      5,
      5,
      "obstruction",
    );
    internal = board as any;
  });

  describe("Pointerdown handler", () => {
    function dispatch(el: EventTarget, type: string) {
      el.dispatchEvent(new Event(type, { bubbles: true }));
    }

    test("ignores when target is the grid background (no cell)", () => {
      const grid = document.getElementById("grid")!;
      dispatch(grid, "pointerdown");
      expect(internal.isPainting).toBe(false);
      expect(editorMock.render).not.toHaveBeenCalled();
    });

    test("starts painting and adds cell when clicking an empty cell", () => {
      board.renderGrid();
      const cell = document.querySelector(
        '.grid-cell[data-x="0"][data-y="0"]',
      ) as HTMLElement;
      dispatch(cell, "pointerdown");
      expect(internal.isPainting).toBe(true);
      expect(internal.inProgressCells.has("0,0")).toBe(true);
      expect(editorMock.hideSolution).toHaveBeenCalled();
      expect(editorMock.render).toHaveBeenCalled();
    });

    test("clicking on an occupied cell flags overlap and does not paint", () => {
      internal.blockAssignments[0][0] = 1;
      board.renderGrid();
      const cell = document.querySelector(
        '.grid-cell[data-x="0"][data-y="0"]',
      ) as HTMLElement;
      dispatch(cell, "pointerdown");
      expect(internal.isPainting).toBe(true);
      expect(internal.attemptedOverlap).toBe(true);
      expect(internal.inProgressCells.size).toBe(0);
    });

    test("returns early when goal tool active and a goal block already exists", () => {
      internal.selectedTool = "goal";
      internal.blocks.set(1, new Block(1, "goal", [{ x: 4, y: 4 }]));
      board.renderGrid();
      const cell = document.querySelector(
        '.grid-cell[data-x="0"][data-y="0"]',
      ) as HTMLElement;
      dispatch(cell, "pointerdown");
      expect(internal.isPainting).toBe(false);
      expect(internal.inProgressCells.size).toBe(0);
    });

    test("during placement mode, places goal zone on valid click", () => {
      internal.blocks.set(1, new Block(1, "goal", [{ x: 0, y: 0 }]));
      internal.isPlacingGoalZone = true;
      board.renderGrid();
      const cell = document.querySelector(
        '.grid-cell[data-x="3"][data-y="3"]',
      ) as HTMLElement;
      dispatch(cell, "pointerdown");
      expect(board.getGoalZoneCells()).toEqual([{ x: 3, y: 3 }]);
      expect(board.isInGoalZonePlacementMode()).toBe(false);
      expect(internal.isPainting).toBe(false);
    });

    test("during placement mode, rejects click when hologram would be out of bounds", () => {
      internal.blocks.set(
        1,
        new Block(1, "goal", [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
        ]),
      );
      internal.isPlacingGoalZone = true;
      board.renderGrid();
      // x=4 + shape width 2 → x=5 is out of bounds for gridWidth=5
      const cell = document.querySelector(
        '.grid-cell[data-x="4"][data-y="0"]',
      ) as HTMLElement;
      dispatch(cell, "pointerdown");
      expect(board.isInGoalZonePlacementMode()).toBe(true);
      expect(board.getGoalZoneCells()).toEqual([]);
    });
  });

  describe("Pointermove handler", () => {
    function dispatch(el: EventTarget, type: string) {
      el.dispatchEvent(new Event(type, { bubbles: true }));
    }

    test("does nothing when not painting and not placing", () => {
      board.renderGrid();
      const cell = document.querySelector(
        '.grid-cell[data-x="0"][data-y="0"]',
      ) as HTMLElement;
      editorMock.render.mockClear();
      dispatch(cell, "pointermove");
      expect(editorMock.render).not.toHaveBeenCalled();
    });

    test("adds new cell to in-progress when painting", () => {
      board.renderGrid();
      internal.isPainting = true;
      const cell = document.querySelector(
        '.grid-cell[data-x="2"][data-y="0"]',
      ) as HTMLElement;
      dispatch(cell, "pointermove");
      expect(internal.inProgressCells.has("2,0")).toBe(true);
      expect(editorMock.render).toHaveBeenCalled();
    });

    test("ignores already-added cell during painting", () => {
      board.renderGrid();
      internal.isPainting = true;
      internal.inProgressCells.add("2,0");
      editorMock.render.mockClear();
      const cell = document.querySelector(
        '.grid-cell[data-x="2"][data-y="0"]',
      ) as HTMLElement;
      dispatch(cell, "pointermove");
      expect(editorMock.render).not.toHaveBeenCalled();
    });

    test("updates placement cursor and re-renders during placement mode", () => {
      internal.blocks.set(1, new Block(1, "goal", [{ x: 0, y: 0 }]));
      internal.isPlacingGoalZone = true;
      board.renderGrid();
      editorMock.render.mockClear();
      const cell = document.querySelector(
        '.grid-cell[data-x="3"][data-y="3"]',
      ) as HTMLElement;
      dispatch(cell, "pointermove");
      expect(internal.placementCursor).toEqual({ x: 3, y: 3 });
      expect(editorMock.render).toHaveBeenCalled();
    });

    test("ignores no-cell move (gap between cells) during placement mode", () => {
      internal.blocks.set(1, new Block(1, "goal", [{ x: 0, y: 0 }]));
      internal.isPlacingGoalZone = true;
      internal.placementCursor = { x: 2, y: 2 };
      const grid = document.getElementById("grid")!;
      editorMock.render.mockClear();
      dispatch(grid, "pointermove");
      // cursor unchanged
      expect(internal.placementCursor).toEqual({ x: 2, y: 2 });
      expect(editorMock.render).not.toHaveBeenCalled();
    });

    test("ignores duplicate cursor during placement mode", () => {
      internal.blocks.set(1, new Block(1, "goal", [{ x: 0, y: 0 }]));
      internal.isPlacingGoalZone = true;
      internal.placementCursor = { x: 3, y: 3 };
      board.renderGrid();
      editorMock.render.mockClear();
      const cell = document.querySelector(
        '.grid-cell[data-x="3"][data-y="3"]',
      ) as HTMLElement;
      dispatch(cell, "pointermove");
      expect(editorMock.render).not.toHaveBeenCalled();
    });
  });

  describe("Pointerleave handler", () => {
    function dispatch(el: EventTarget, type: string) {
      el.dispatchEvent(new Event(type, { bubbles: true }));
    }

    test("clears placement cursor when in placement mode", () => {
      internal.isPlacingGoalZone = true;
      internal.placementCursor = { x: 1, y: 1 };
      const grid = document.getElementById("grid")!;
      dispatch(grid, "pointerleave");
      expect(internal.placementCursor).toBeNull();
      expect(editorMock.render).toHaveBeenCalled();
    });

    test("does nothing when not in placement mode", () => {
      const grid = document.getElementById("grid")!;
      editorMock.render.mockClear();
      dispatch(grid, "pointerleave");
      expect(editorMock.render).not.toHaveBeenCalled();
    });
  });

  describe("CommitInProgressBlock (private)", () => {
    test("creates an obstruction block from contiguous in-progress cells", () => {
      internal.selectedTool = "obstruction";
      internal.inProgressCells.add("0,0");
      internal.inProgressCells.add("1,0");

      internal.commitInProgressBlock();

      expect(board.getBlocks().size).toBe(1);
      const block = board.getBlocks().get(1)!;
      expect(block.type).toBe("obstruction");
      expect(block.cells).toHaveLength(2);
      expect(internal.blockAssignments[0][0]).toBe(1);
      expect(internal.blockAssignments[1][0]).toBe(1);
      expect(internal.nextBlockId).toBe(2);
    });

    test("creates a goal block and enters placement mode", () => {
      internal.selectedTool = "goal";
      internal.inProgressCells.add("0,0");

      internal.commitInProgressBlock();

      expect(board.hasGoalBlock()).toBe(true);
      expect(board.isInGoalZonePlacementMode()).toBe(true);
      expect(editorMock.notifyGoalZonePlacementChanged).toHaveBeenCalled();
    });

    test("commits valid cells even when overlap was attempted during the drag (no false-positive warning)", () => {
      internal.selectedTool = "obstruction";
      internal.inProgressCells.add("0,0");
      internal.attemptedOverlap = true;

      internal.commitInProgressBlock();

      expect(board.getBlocks().size).toBe(1);
      expect(board.getBlocks().get(1)?.cells).toEqual([{ x: 0, y: 0 }]);
      expect(internal.blockAssignments[0][0]).toBe(1);
      expect(editorMock.showWarning).not.toHaveBeenCalled();
    });

    test("commits a multi-cell block even when the drag ended on an existing block", () => {
      internal.selectedTool = "obstruction";
      internal.blocks.set(
        1,
        new Block(1, "obstruction", [{ x: 2, y: 0 }]),
      );
      internal.blockAssignments[2][0] = 1;
      internal.nextBlockId = 2;

      // Simulate a drag (0,0) → (1,0) → (2,0, occupied)
      internal.tryAddInProgressCell({ x: 0, y: 0 });
      internal.tryAddInProgressCell({ x: 1, y: 0 });
      internal.tryAddInProgressCell({ x: 2, y: 0 });

      expect(internal.attemptedOverlap).toBe(true);
      expect(internal.inProgressCells.size).toBe(2);

      internal.commitInProgressBlock();

      expect(board.getBlocks().size).toBe(2);
      expect(internal.blockAssignments[0][0]).toBe(2);
      expect(internal.blockAssignments[1][0]).toBe(2);
      expect(internal.blockAssignments[2][0]).toBe(1);
      expect(editorMock.showWarning).not.toHaveBeenCalled();
    });

    test("warns about overlap when no cells were drawn (e.g., direct click on existing block)", () => {
      internal.selectedTool = "obstruction";
      internal.attemptedOverlap = true;

      internal.commitInProgressBlock();

      expect(board.getBlocks().size).toBe(0);
      expect(editorMock.showWarning).toHaveBeenCalledTimes(1);
      expect(editorMock.showWarning.mock.calls[0]![0]).toContain("overlaps");
    });

    test("rejects non-contiguous in-progress cells (fast drag) with a 'connected area' warning", () => {
      internal.selectedTool = "obstruction";
      internal.inProgressCells.add("0,0");
      internal.inProgressCells.add("3,0");

      internal.commitInProgressBlock();

      expect(board.getBlocks().size).toBe(0);
      expect(editorMock.showWarning).toHaveBeenCalledTimes(1);
      expect(editorMock.showWarning.mock.calls[0]![0]).toContain(
        "connected area",
      );
    });

    test("rejects non-contiguous in-progress cells (gap caused by overlap) with an 'overlaps' warning", () => {
      internal.selectedTool = "obstruction";
      internal.inProgressCells.add("0,0");
      internal.inProgressCells.add("3,0");
      internal.attemptedOverlap = true;

      internal.commitInProgressBlock();

      expect(board.getBlocks().size).toBe(0);
      expect(editorMock.showWarning).toHaveBeenCalledTimes(1);
      expect(editorMock.showWarning.mock.calls[0]![0]).toContain("overlaps");
    });

    test("returns silently when in-progress cells are empty", () => {
      internal.selectedTool = "obstruction";

      internal.commitInProgressBlock();

      expect(board.getBlocks().size).toBe(0);
      expect(editorMock.showWarning).not.toHaveBeenCalled();
    });

    test("returns when goal tool is active and a goal block already exists", () => {
      internal.selectedTool = "goal";
      internal.blocks.set(1, new Block(1, "goal", [{ x: 4, y: 4 }]));
      internal.inProgressCells.add("0,0");

      internal.commitInProgressBlock();

      expect(board.getBlocks().size).toBe(1);
      expect(board.getBlocks().get(2)).toBeUndefined();
      expect(editorMock.showWarning).not.toHaveBeenCalled();
    });

    test("returns when selected tool is not obstruction or goal", () => {
      internal.selectedTool = "reset";
      internal.inProgressCells.add("0,0");

      internal.commitInProgressBlock();

      expect(board.getBlocks().size).toBe(0);
    });
  });

  describe("TryPlaceGoalZone (private)", () => {
    test("places goal zone and exits placement mode when valid", () => {
      internal.blocks.set(1, new Block(1, "goal", [{ x: 0, y: 0 }]));
      internal.isPlacingGoalZone = true;

      internal.tryPlaceGoalZone({ x: 2, y: 2 });

      expect(board.getGoalZoneCells()).toEqual([{ x: 2, y: 2 }]);
      expect(board.isInGoalZonePlacementMode()).toBe(false);
      expect(internal.placementCursor).toBeNull();
      expect(editorMock.notifyGoalZonePlacementChanged).toHaveBeenCalled();
      expect(editorMock.hideSolution).toHaveBeenCalled();
      expect(editorMock.render).toHaveBeenCalled();
    });

    test("does nothing when hologram would be invalid (out of bounds)", () => {
      internal.blocks.set(
        1,
        new Block(1, "goal", [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
        ]),
      );
      internal.isPlacingGoalZone = true;

      internal.tryPlaceGoalZone({ x: 4, y: 0 });

      expect(board.getGoalZoneCells()).toEqual([]);
      expect(board.isInGoalZonePlacementMode()).toBe(true);
    });
  });

  describe("Pointerup handler", () => {
    test("does nothing for the current board when not painting", () => {
      // Capture mocks before dispatch — older boards from prior tests may also
      // fire on this document-level event, but they hold their own editor refs
      // and cannot touch the current editorMock.
      editorMock.hideSolution.mockClear();
      editorMock.render.mockClear();

      document.dispatchEvent(new Event("pointerup"));

      expect(internal.isPainting).toBe(false);
      expect(board.getBlocks().size).toBe(0);
      expect(editorMock.hideSolution).not.toHaveBeenCalled();
      expect(editorMock.render).not.toHaveBeenCalled();
    });

    test("commits in-progress block, resets state, hides solution, and re-renders when painting", () => {
      internal.selectedTool = "obstruction";
      internal.isPainting = true;
      internal.inProgressCells.add("0,0");
      internal.inProgressCells.add("1,0");
      editorMock.hideSolution.mockClear();
      editorMock.render.mockClear();

      document.dispatchEvent(new Event("pointerup"));

      expect(internal.isPainting).toBe(false);
      expect(internal.inProgressCells.size).toBe(0);
      expect(internal.attemptedOverlap).toBe(false);
      expect(board.getBlocks().size).toBe(1);
      expect(internal.blockAssignments[0][0]).toBe(1);
      expect(internal.blockAssignments[1][0]).toBe(1);
      expect(editorMock.hideSolution).toHaveBeenCalled();
      expect(editorMock.render).toHaveBeenCalled();
    });
  });
});