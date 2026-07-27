import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Block } from "../../src/pages/shifting-mosaic-solver/block";
import { Board } from "../../src/pages/shifting-mosaic-solver/board";
import {
  extractCellPosition,
  isContiguous,
  positionsEqual,
} from "../../src/pages/shifting-mosaic-solver/boardGeometry";
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

  describe("IsContiguous (private)", () => {
    test("empty array is trivially contiguous", () => {
      expect(isContiguous([])).toBe(true);
    });

    test("single cell is trivially contiguous", () => {
      expect(isContiguous([{ x: 0, y: 0 }])).toBe(true);
    });

    test("4-connected horizontal line", () => {
      expect(
        isContiguous([
          { x: 0, y: 0 },
          { x: 1, y: 0 },
          { x: 2, y: 0 },
        ]),
      ).toBe(true);
    });

    test("4-connected vertical line", () => {
      expect(
        isContiguous([
          { x: 0, y: 0 },
          { x: 0, y: 1 },
          { x: 0, y: 2 },
        ]),
      ).toBe(true);
    });

    test("L-shape is contiguous", () => {
      expect(
        isContiguous([
          { x: 0, y: 0 },
          { x: 1, y: 0 },
          { x: 1, y: 1 },
          { x: 1, y: 2 },
        ]),
      ).toBe(true);
    });

    test("plus shape is contiguous", () => {
      expect(
        isContiguous([
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
        isContiguous([
          { x: 0, y: 0 },
          { x: 5, y: 0 },
        ]),
      ).toBe(false);
    });

    test("diagonal-only adjacency is not 4-connected", () => {
      expect(
        isContiguous([
          { x: 0, y: 0 },
          { x: 1, y: 1 },
        ]),
      ).toBe(false);
    });

    test("two separate clusters are not contiguous", () => {
      expect(
        isContiguous([
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
      expect(positionsEqual(null, null)).toBe(true);
    });

    test("first null is not equal", () => {
      expect(positionsEqual(null, { x: 0, y: 0 })).toBe(false);
    });

    test("second null is not equal", () => {
      expect(positionsEqual({ x: 0, y: 0 }, null)).toBe(false);
    });

    test("same coordinates are equal", () => {
      expect(
        positionsEqual({ x: 3, y: 7 }, { x: 3, y: 7 }),
      ).toBe(true);
    });

    test("different coordinates are not equal", () => {
      expect(
        positionsEqual({ x: 3, y: 7 }, { x: 4, y: 7 }),
      ).toBe(false);
      expect(
        positionsEqual({ x: 3, y: 7 }, { x: 3, y: 8 }),
      ).toBe(false);
    });
  });

  describe("ExtractCellPosition (private)", () => {
    test("null target returns null", () => {
      expect(extractCellPosition(null)).toBeNull();
    });

    test("non-HTMLElement target returns null", () => {
      expect(extractCellPosition({} as EventTarget)).toBeNull();
      expect(extractCellPosition(document)).toBeNull();
    });

    test("element outside any grid-cell returns null", () => {
      const div = document.createElement("div");
      document.body.appendChild(div);
      expect(extractCellPosition(div)).toBeNull();
    });

    test("grid-cell with non-integer dataset returns null", () => {
      const cell = document.createElement("button");
      cell.className = "grid-cell";
      cell.dataset.x = "abc";
      cell.dataset.y = "0";
      document.body.appendChild(cell);
      expect(extractCellPosition(cell)).toBeNull();
    });

    test("valid grid-cell returns parsed position", () => {
      const cell = document.createElement("button");
      cell.className = "grid-cell";
      cell.dataset.x = "3";
      cell.dataset.y = "4";
      document.body.appendChild(cell);
      expect(extractCellPosition(cell)).toEqual({ x: 3, y: 4 });
    });

    test("nested element inside grid-cell resolves to the cell's position", () => {
      const cell = document.createElement("button");
      cell.className = "grid-cell";
      cell.dataset.x = "1";
      cell.dataset.y = "2";
      const child = document.createElement("span");
      cell.appendChild(child);
      document.body.appendChild(cell);
      expect(extractCellPosition(child)).toEqual({ x: 1, y: 2 });
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

});