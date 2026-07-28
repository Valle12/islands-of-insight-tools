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

  describe("Initial state", () => {
    test("has no blocks, no goal zone, idle mode", () => {
      expect(board.getBlocks().size).toBe(0);
      expect(board.getGoalZoneCells()).toEqual([]);
      expect(board.hasGoalBlock()).toBe(false);
      expect(board.isInGoalZonePlacementMode()).toBe(false);
      expect(board.getHoveredBlockId()).toBe(0);
    });

    test("blockAssignments grid is sized to gridWidth x gridHeight and zero-initialized", () => {
      expect(internal.blockAssignments).toHaveLength(5);
      for (let x = 0; x < 5; x++) {
        expect(internal.blockAssignments[x]).toHaveLength(5);
        for (let y = 0; y < 5; y++) {
          expect(internal.blockAssignments[x][y]).toBe(0);
        }
      }
    });
  });

  describe("SetSelectedTool", () => {
    test("updates the internal tool", () => {
      board.setSelectedTool("goal");
      expect(internal.selectedTool).toBe("goal");
      board.setSelectedTool("obstruction");
      expect(internal.selectedTool).toBe("obstruction");
    });
  });

  describe("HasGoalBlock", () => {
    test("true when at least one block is a goal", () => {
      internal.blocks.set(
        1,
        new Block(1, "obstruction", [{ x: 0, y: 0 }]),
      );
      internal.blocks.set(2, new Block(2, "goal", [{ x: 1, y: 1 }]));
      expect(board.hasGoalBlock()).toBe(true);
    });

    test("false when only obstruction blocks exist", () => {
      internal.blocks.set(
        1,
        new Block(1, "obstruction", [{ x: 0, y: 0 }]),
      );
      expect(board.hasGoalBlock()).toBe(false);
    });
  });

  describe("DeleteBlockById", () => {
    test("removes obstruction block and clears its cells", () => {
      const block = new Block(1, "obstruction", [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
      ]);
      internal.blocks.set(1, block);
      internal.blockAssignments[0][0] = 1;
      internal.blockAssignments[1][0] = 1;

      board.deleteBlockById(1);

      expect(board.getBlocks().has(1)).toBe(false);
      expect(internal.blockAssignments[0][0]).toBe(0);
      expect(internal.blockAssignments[1][0]).toBe(0);
    });

    test("deleting a goal block also clears the goal zone and exits placement mode", () => {
      const goal = new Block(1, "goal", [{ x: 0, y: 0 }]);
      internal.blocks.set(1, goal);
      internal.blockAssignments[0][0] = 1;
      internal.goalZoneCells = [{ x: 3, y: 3 }];
      internal.isPlacingGoalZone = true;
      internal.placementCursor = { x: 2, y: 2 };

      board.deleteBlockById(1);

      expect(board.getGoalZoneCells()).toEqual([]);
      expect(board.isInGoalZonePlacementMode()).toBe(false);
      expect(internal.placementCursor).toBeNull();
    });

    test("deleting a non-existent block is a no-op", () => {
      expect(() => board.deleteBlockById(99)).not.toThrow();
      expect(board.getBlocks().size).toBe(0);
    });

    test("only the deleted block's cells are cleared", () => {
      internal.blocks.set(
        1,
        new Block(1, "obstruction", [{ x: 0, y: 0 }]),
      );
      internal.blocks.set(
        2,
        new Block(2, "obstruction", [{ x: 4, y: 4 }]),
      );
      internal.blockAssignments[0][0] = 1;
      internal.blockAssignments[4][4] = 2;

      board.deleteBlockById(1);

      expect(internal.blockAssignments[0][0]).toBe(0);
      expect(internal.blockAssignments[4][4]).toBe(2);
    });
  });

  describe("RenumberBlocks", () => {
    test("when the trailing id was deleted, decrements nextBlockId", () => {
      internal.blocks.set(
        1,
        new Block(1, "obstruction", [{ x: 0, y: 0 }]),
      );
      internal.blockAssignments[0][0] = 1;
      internal.nextBlockId = 2;

      board.renumberBlocks(1);

      expect(internal.nextBlockId).toBe(1);
    });

    test("when a non-trailing id was deleted, the last block is renamed", () => {
      const b1 = new Block(1, "obstruction", [{ x: 0, y: 0 }]);
      const b3 = new Block(3, "obstruction", [{ x: 2, y: 0 }]);
      internal.blocks.set(1, b1);
      internal.blocks.set(3, b3);
      internal.blockAssignments[0][0] = 1;
      internal.blockAssignments[2][0] = 3;
      internal.nextBlockId = 4;

      board.renumberBlocks(2);

      expect(internal.nextBlockId).toBe(3);
      expect(board.getBlocks().has(3)).toBe(false);
      expect(board.getBlocks().has(2)).toBe(true);
      expect(board.getBlocks().get(2)?.id).toBe(2);
      expect(internal.blockAssignments[2][0]).toBe(2);
      expect(internal.blockAssignments[0][0]).toBe(1);
    });

    test("when the blocks map is empty, resets nextBlockId to 1", () => {
      internal.nextBlockId = 5;
      board.renumberBlocks(2);
      expect(internal.nextBlockId).toBe(1);
    });
  });

  describe("SetHoveredBlockId", () => {
    test("setting a new id triggers editor.render", () => {
      board.setHoveredBlockId(3);
      expect(editorMock.render).toHaveBeenCalledTimes(1);
      expect(board.getHoveredBlockId()).toBe(3);
    });

    test("setting the same id does not trigger a re-render", () => {
      board.setHoveredBlockId(2);
      editorMock.render.mockClear();
      board.setHoveredBlockId(2);
      expect(editorMock.render).not.toHaveBeenCalled();
      expect(board.getHoveredBlockId()).toBe(2);
    });

    test("clearing the hover (id 0) re-renders if previously hovered", () => {
      board.setHoveredBlockId(2);
      editorMock.render.mockClear();
      board.setHoveredBlockId(0);
      expect(editorMock.render).toHaveBeenCalledTimes(1);
      expect(board.getHoveredBlockId()).toBe(0);
    });
  });

  describe("StartGoalZonePlacement", () => {
    test("re-enters placement mode for an existing goal block and clears prior zone", () => {
      const goal = new Block(1, "goal", [{ x: 0, y: 0 }]);
      internal.blocks.set(1, goal);
      internal.goalZoneCells = [{ x: 3, y: 3 }];

      board.startGoalZonePlacement(1);

      expect(board.isInGoalZonePlacementMode()).toBe(true);
      expect(board.getGoalZoneCells()).toEqual([]);
      expect(editorMock.notifyGoalZonePlacementChanged).toHaveBeenCalled();
      expect(editorMock.render).toHaveBeenCalled();
    });

    test("ignores when given an obstruction block id", () => {
      internal.blocks.set(
        1,
        new Block(1, "obstruction", [{ x: 0, y: 0 }]),
      );

      board.startGoalZonePlacement(1);

      expect(board.isInGoalZonePlacementMode()).toBe(false);
    });

    test("ignores when block id does not exist", () => {
      board.startGoalZonePlacement(99);
      expect(board.isInGoalZonePlacementMode()).toBe(false);
    });
  });

  describe("ResetBoardData", () => {
    test("clears blocks, goal zone, ids, and placement state", () => {
      internal.blocks.set(
        1,
        new Block(1, "obstruction", [{ x: 0, y: 0 }]),
      );
      internal.blockAssignments[0][0] = 1;
      internal.goalZoneCells = [{ x: 3, y: 3 }];
      internal.nextBlockId = 5;
      internal.isPainting = true;
      internal.attemptedOverlap = true;
      internal.isPlacingGoalZone = true;
      internal.placementCursor = { x: 1, y: 1 };
      internal.inProgressCells.add("0,0");

      board.resetBoardData();

      expect(board.getBlocks().size).toBe(0);
      expect(board.getGoalZoneCells()).toEqual([]);
      expect(board.isInGoalZonePlacementMode()).toBe(false);
      expect(internal.nextBlockId).toBe(1);
      expect(internal.isPainting).toBe(false);
      expect(internal.attemptedOverlap).toBe(false);
      expect(internal.placementCursor).toBeNull();
      expect(internal.inProgressCells.size).toBe(0);
      for (let x = 0; x < 5; x++) {
        for (let y = 0; y < 5; y++) {
          expect(internal.blockAssignments[x][y]).toBe(0);
        }
      }
    });
  });

  describe("Reconfigure", () => {
    test("resizes the blockAssignments grid and clears all state", () => {
      internal.blocks.set(
        1,
        new Block(1, "obstruction", [{ x: 0, y: 0 }]),
      );
      internal.blockAssignments[0][0] = 1;
      internal.nextBlockId = 2;

      board.reconfigure(7, 3);

      expect(internal.gridWidth).toBe(7);
      expect(internal.gridHeight).toBe(3);
      expect(internal.blockAssignments).toHaveLength(7);
      expect(internal.blockAssignments[0]).toHaveLength(3);
      expect(board.getBlocks().size).toBe(0);
      expect(internal.nextBlockId).toBe(1);
    });
  });

  describe("LoadConfig", () => {
    const config = {
      gridWidth: 4,
      gridHeight: 3,
      shapes: [
        [{ x: 0, y: 0 }],
        [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
        ],
      ],
      initialAnchors: [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ],
      goalIndex: 0,
      goalAnchor: { x: 3, y: 0 },
    };

    test("rebuilds the grid, blocks, and goal zone from a config", () => {
      board.loadConfig(config);

      expect(internal.gridWidth).toBe(4);
      expect(internal.gridHeight).toBe(3);
      expect(board.getBlocks().size).toBe(2);
      expect(internal.nextBlockId).toBe(3);

      const goal = board.getBlocks().get(1)!;
      expect(goal.type).toBe("goal");
      expect(internal.blockAssignments[0][0]).toBe(1);

      const obstruction = board.getBlocks().get(2)!;
      expect(obstruction.type).toBe("obstruction");
      expect(internal.blockAssignments[1][1]).toBe(2);
      expect(internal.blockAssignments[2][1]).toBe(2);

      expect(board.getGoalZoneCells()).toEqual([{ x: 3, y: 0 }]);
      expect(board.hasGoalBlock()).toBe(true);
    });

    test("replaces any pre-existing blocks", () => {
      internal.blocks.set(
        1,
        new Block(1, "obstruction", [{ x: 4, y: 4 }]),
      );
      internal.blockAssignments[4][4] = 1;

      board.loadConfig(config);

      expect(board.getBlocks().size).toBe(2);
      // The old grid was discarded — block 2 sits where the config places it.
      expect(internal.blockAssignments[1][1]).toBe(2);
    });
  });

});