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
      expect(document.querySelectorAll(".grid-cell")).toHaveLength(25);
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
      expect(document.querySelectorAll(".grid-cell")).toHaveLength(25);
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

});