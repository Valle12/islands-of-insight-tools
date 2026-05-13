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
      expect(internal.blockAssignments.length).toBe(5);
      for (let x = 0; x < 5; x++) {
        expect(internal.blockAssignments[x].length).toBe(5);
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

  describe("IsContiguous (private)", () => {
    test("empty array is trivially contiguous", () => {
      expect(internal.isContiguous([])).toBe(true);
    });

    test("single cell is trivially contiguous", () => {
      expect(internal.isContiguous([{ x: 0, y: 0 }])).toBe(true);
    });

    test("4-connected horizontal line", () => {
      expect(
        internal.isContiguous([
          { x: 0, y: 0 },
          { x: 1, y: 0 },
          { x: 2, y: 0 },
        ]),
      ).toBe(true);
    });

    test("4-connected vertical line", () => {
      expect(
        internal.isContiguous([
          { x: 0, y: 0 },
          { x: 0, y: 1 },
          { x: 0, y: 2 },
        ]),
      ).toBe(true);
    });

    test("L-shape is contiguous", () => {
      expect(
        internal.isContiguous([
          { x: 0, y: 0 },
          { x: 1, y: 0 },
          { x: 1, y: 1 },
          { x: 1, y: 2 },
        ]),
      ).toBe(true);
    });

    test("plus shape is contiguous", () => {
      expect(
        internal.isContiguous([
          { x: 1, y: 0 },
          { x: 0, y: 1 },
          { x: 1, y: 1 },
          { x: 2, y: 1 },
          { x: 1, y: 2 },
        ]),
      ).toBe(true);
    });

    test("cells with a gap on the same row are not contiguous", () => {
      expect(
        internal.isContiguous([
          { x: 0, y: 0 },
          { x: 5, y: 0 },
        ]),
      ).toBe(false);
    });

    test("diagonal-only adjacency is not 4-connected", () => {
      expect(
        internal.isContiguous([
          { x: 0, y: 0 },
          { x: 1, y: 1 },
        ]),
      ).toBe(false);
    });

    test("two separate clusters are not contiguous", () => {
      expect(
        internal.isContiguous([
          { x: 0, y: 0 },
          { x: 1, y: 0 },
          { x: 3, y: 0 },
          { x: 4, y: 0 },
        ]),
      ).toBe(false);
    });
  });

  describe("ComputeHologramCellsAt (private)", () => {
    test("returns empty array when no goal block exists", () => {
      const cells = internal.computeHologramCellsAt({ x: 2, y: 2 });
      expect(cells).toEqual([]);
    });

    test("offsets the goal block's relative shape by the cursor position", () => {
      internal.blocks.set(
        1,
        new Block(1, "goal", [
          { x: 5, y: 5 },
          { x: 6, y: 5 },
          { x: 5, y: 6 },
        ]),
      );

      const cells = internal.computeHologramCellsAt({ x: 2, y: 3 });

      expect(cells).toEqual([
        { x: 2, y: 3 },
        { x: 3, y: 3 },
        { x: 2, y: 4 },
      ]);
    });
  });

  describe("IsHologramValid (private)", () => {
    test("empty cells are invalid", () => {
      expect(internal.isHologramValid([])).toBe(false);
    });

    test("all cells in bounds are valid", () => {
      expect(
        internal.isHologramValid([
          { x: 0, y: 0 },
          { x: 4, y: 4 },
        ]),
      ).toBe(true);
    });

    test("any cell out of bounds is invalid", () => {
      expect(
        internal.isHologramValid([
          { x: 0, y: 0 },
          { x: 5, y: 0 },
        ]),
      ).toBe(false);
      expect(internal.isHologramValid([{ x: -1, y: 0 }])).toBe(false);
      expect(internal.isHologramValid([{ x: 0, y: 5 }])).toBe(false);
    });
  });

  describe("ComputeHologramCells (private)", () => {
    test("returns empty when not in placement mode", () => {
      internal.placementCursor = { x: 2, y: 2 };
      expect(internal.computeHologramCells()).toEqual([]);
    });

    test("returns empty when in placement mode but cursor is null", () => {
      internal.isPlacingGoalZone = true;
      internal.placementCursor = null;
      expect(internal.computeHologramCells()).toEqual([]);
    });

    test("returns offset shape when placing with cursor and goal block", () => {
      internal.blocks.set(
        1,
        new Block(1, "goal", [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
        ]),
      );
      internal.isPlacingGoalZone = true;
      internal.placementCursor = { x: 2, y: 3 };
      expect(internal.computeHologramCells()).toEqual([
        { x: 2, y: 3 },
        { x: 3, y: 3 },
      ]);
    });
  });

  describe("PositionsEqual (private)", () => {
    test("both null is equal", () => {
      expect(internal.positionsEqual(null, null)).toBe(true);
    });

    test("first null is not equal", () => {
      expect(internal.positionsEqual(null, { x: 0, y: 0 })).toBe(false);
    });

    test("second null is not equal", () => {
      expect(internal.positionsEqual({ x: 0, y: 0 }, null)).toBe(false);
    });

    test("same coordinates are equal", () => {
      expect(
        internal.positionsEqual({ x: 3, y: 7 }, { x: 3, y: 7 }),
      ).toBe(true);
    });

    test("different coordinates are not equal", () => {
      expect(
        internal.positionsEqual({ x: 3, y: 7 }, { x: 4, y: 7 }),
      ).toBe(false);
      expect(
        internal.positionsEqual({ x: 3, y: 7 }, { x: 3, y: 8 }),
      ).toBe(false);
    });
  });

  describe("ExtractCellPosition (private)", () => {
    test("null target returns null", () => {
      expect(internal.extractCellPosition(null)).toBeNull();
    });

    test("non-HTMLElement target returns null", () => {
      expect(internal.extractCellPosition({} as EventTarget)).toBeNull();
      expect(internal.extractCellPosition(document)).toBeNull();
    });

    test("element outside any grid-cell returns null", () => {
      const div = document.createElement("div");
      document.body.appendChild(div);
      expect(internal.extractCellPosition(div)).toBeNull();
    });

    test("grid-cell with non-integer dataset returns null", () => {
      const cell = document.createElement("button");
      cell.className = "grid-cell";
      cell.dataset.x = "abc";
      cell.dataset.y = "0";
      document.body.appendChild(cell);
      expect(internal.extractCellPosition(cell)).toBeNull();
    });

    test("valid grid-cell returns parsed position", () => {
      const cell = document.createElement("button");
      cell.className = "grid-cell";
      cell.dataset.x = "3";
      cell.dataset.y = "4";
      document.body.appendChild(cell);
      expect(internal.extractCellPosition(cell)).toEqual({ x: 3, y: 4 });
    });

    test("nested element inside grid-cell resolves to the cell's position", () => {
      const cell = document.createElement("button");
      cell.className = "grid-cell";
      cell.dataset.x = "1";
      cell.dataset.y = "2";
      const child = document.createElement("span");
      cell.appendChild(child);
      document.body.appendChild(cell);
      expect(internal.extractCellPosition(child)).toEqual({ x: 1, y: 2 });
    });
  });

  describe("HasBlockAt (private)", () => {
    test("returns true when cell belongs to that block id", () => {
      internal.blockAssignments[2][3] = 7;
      expect(internal.hasBlockAt(2, 3, 7)).toBe(true);
    });

    test("returns false for a different block id", () => {
      internal.blockAssignments[2][3] = 7;
      expect(internal.hasBlockAt(2, 3, 8)).toBe(false);
    });

    test("returns false for out-of-bounds coordinates", () => {
      expect(internal.hasBlockAt(-1, 0, 1)).toBe(false);
      expect(internal.hasBlockAt(5, 0, 1)).toBe(false);
      expect(internal.hasBlockAt(0, -1, 1)).toBe(false);
      expect(internal.hasBlockAt(0, 5, 1)).toBe(false);
    });
  });

  describe("RenderGrid", () => {
    function getCell(x: number, y: number): HTMLElement {
      const cell = document.querySelector(
        `.grid-cell[data-x="${x}"][data-y="${y}"]`,
      ) as HTMLElement | null;
      if (!cell) throw new Error(`Cell at (${x}, ${y}) not found`);
      return cell;
    }

    test("renders gridWidth × gridHeight cells", () => {
      board.renderGrid();
      expect(document.querySelectorAll(".grid-cell").length).toBe(25);
    });

    test("sets grid template columns from gridWidth", () => {
      board.renderGrid();
      const grid = document.getElementById("grid")!;
      expect(grid.style.gridTemplateColumns).toBe(
        "repeat(5, minmax(0, 1fr))",
      );
    });

    test("clears existing children before rendering", () => {
      board.renderGrid();
      board.renderGrid();
      expect(document.querySelectorAll(".grid-cell").length).toBe(25);
    });

    test("empty cells have 'Empty' aria-label and no block dataset", () => {
      board.renderGrid();
      const cell = getCell(0, 0);
      expect(cell.getAttribute("aria-label")).toBe("Column 1, Row 1, Empty");
      expect(cell.dataset.blockId).toBeUndefined();
      expect(cell.dataset.blockType).toBeUndefined();
    });

    test("obstruction block cells get id, type, and edge classes on outer sides", () => {
      internal.blocks.set(
        1,
        new Block(1, "obstruction", [
          { x: 1, y: 1 },
          { x: 2, y: 1 },
          { x: 1, y: 2 },
          { x: 2, y: 2 },
        ]),
      );
      internal.blockAssignments[1][1] = 1;
      internal.blockAssignments[2][1] = 1;
      internal.blockAssignments[1][2] = 1;
      internal.blockAssignments[2][2] = 1;

      board.renderGrid();

      const tl = getCell(1, 1);
      expect(tl.dataset.blockId).toBe("1");
      expect(tl.dataset.blockType).toBe("obstruction");
      expect(tl.classList.contains("block-edge-top")).toBe(true);
      expect(tl.classList.contains("block-edge-left")).toBe(true);
      expect(tl.classList.contains("block-edge-right")).toBe(false);
      expect(tl.classList.contains("block-edge-bottom")).toBe(false);

      const br = getCell(2, 2);
      expect(br.classList.contains("block-edge-bottom")).toBe(true);
      expect(br.classList.contains("block-edge-right")).toBe(true);
      expect(br.classList.contains("block-edge-top")).toBe(false);
      expect(br.classList.contains("block-edge-left")).toBe(false);
    });

    test("goal block cells get data-block-type='goal' and aria-label uses 'Goal block'", () => {
      internal.blocks.set(1, new Block(1, "goal", [{ x: 0, y: 0 }]));
      internal.blockAssignments[0][0] = 1;
      board.renderGrid();
      const cell = getCell(0, 0);
      expect(cell.dataset.blockType).toBe("goal");
      expect(cell.getAttribute("aria-label")).toBe(
        "Column 1, Row 1, Goal block 1",
      );
    });

    test("obstruction aria-label uses 'Obstruction N'", () => {
      internal.blocks.set(
        2,
        new Block(2, "obstruction", [{ x: 1, y: 1 }]),
      );
      internal.blockAssignments[1][1] = 2;
      board.renderGrid();
      expect(getCell(1, 1).getAttribute("aria-label")).toBe(
        "Column 2, Row 2, Obstruction 2",
      );
    });

    test("hovered block id adds block-hovered class to its cells", () => {
      internal.blocks.set(
        1,
        new Block(1, "obstruction", [{ x: 0, y: 0 }]),
      );
      internal.blockAssignments[0][0] = 1;
      internal.hoveredBlockId = 1;
      board.renderGrid();
      expect(getCell(0, 0).classList.contains("block-hovered")).toBe(true);
    });

    test("non-hovered block does not get block-hovered class", () => {
      internal.blocks.set(
        1,
        new Block(1, "obstruction", [{ x: 0, y: 0 }]),
      );
      internal.blockAssignments[0][0] = 1;
      internal.hoveredBlockId = 2;
      board.renderGrid();
      expect(getCell(0, 0).classList.contains("block-hovered")).toBe(false);
    });

    test("in-progress cells use 'in-progress' class for obstruction tool", () => {
      internal.selectedTool = "obstruction";
      internal.inProgressCells.add("0,0");
      internal.inProgressCells.add("1,0");
      board.renderGrid();
      expect(getCell(0, 0).classList.contains("in-progress")).toBe(true);
      expect(getCell(1, 0).classList.contains("in-progress")).toBe(true);
      expect(getCell(0, 0).classList.contains("in-progress-goal")).toBe(false);
    });

    test("in-progress cells use 'in-progress-goal' class for goal tool", () => {
      internal.selectedTool = "goal";
      internal.inProgressCells.add("3,3");
      board.renderGrid();
      expect(getCell(3, 3).classList.contains("in-progress-goal")).toBe(true);
      expect(getCell(3, 3).classList.contains("in-progress")).toBe(false);
    });

    test("goal-zone cells get goal-zone class with correct edge classes", () => {
      internal.goalZoneCells = [
        { x: 1, y: 1 },
        { x: 2, y: 1 },
      ];
      board.renderGrid();
      const tl = getCell(1, 1);
      expect(tl.classList.contains("goal-zone")).toBe(true);
      expect(tl.classList.contains("goal-zone-edge-top")).toBe(true);
      expect(tl.classList.contains("goal-zone-edge-bottom")).toBe(true);
      expect(tl.classList.contains("goal-zone-edge-left")).toBe(true);
      expect(tl.classList.contains("goal-zone-edge-right")).toBe(false);

      const tr = getCell(2, 1);
      expect(tr.classList.contains("goal-zone-edge-right")).toBe(true);
      expect(tr.classList.contains("goal-zone-edge-left")).toBe(false);
    });

    test("hologram cells get 'hologram' class when valid", () => {
      internal.blocks.set(1, new Block(1, "goal", [{ x: 0, y: 0 }]));
      internal.isPlacingGoalZone = true;
      internal.placementCursor = { x: 2, y: 2 };
      board.renderGrid();
      expect(getCell(2, 2).classList.contains("hologram")).toBe(true);
      expect(getCell(2, 2).classList.contains("hologram-invalid")).toBe(false);
    });

    test("hologram cells get 'hologram-invalid' class when out of bounds", () => {
      internal.blocks.set(
        1,
        new Block(1, "goal", [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
        ]),
      );
      internal.isPlacingGoalZone = true;
      internal.placementCursor = { x: 4, y: 0 };
      board.renderGrid();
      // Cursor at x=4 with shape spanning x=4..5; x=5 is out of bounds (gridWidth=5)
      expect(getCell(4, 0).classList.contains("hologram-invalid")).toBe(true);
      expect(getCell(4, 0).classList.contains("hologram")).toBe(false);
    });
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
      expect(block.cells.length).toBe(2);
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
