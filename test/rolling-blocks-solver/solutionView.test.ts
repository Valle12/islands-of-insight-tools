import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Block } from "../../src/pages/rolling-blocks-solver/block";
import { Direction } from "../../src/pages/rolling-blocks-solver/directions";
import type { Puzzle } from "../../src/pages/rolling-blocks-solver/replay";
import { SolutionView } from "../../src/pages/rolling-blocks-solver/solutionView";
import type { Turn } from "../../src/pages/rolling-blocks-solver/turn";
import type { Tile } from "../../src/util/types";

const MARKUP = `
  <span id="solution-step-counter"></span>
  <div id="solution-grid"></div>
  <div id="solution-step-text"></div>
  <button id="solution-prev"></button>
  <button id="solution-next"></button>
  <ol id="solution-moves"></ol>
`;

/** Column-major grid of `regular`, with `paint` applied on top. */
function grid(
  width: number,
  height: number,
  paint: Record<string, Tile> = {},
): Tile[][] {
  const cells: Tile[][] = Array.from({ length: width }, () =>
    Array.from({ length: height }, () => "regular" as Tile),
  );
  for (const [key, tile] of Object.entries(paint)) {
    const [x, y] = key.split(",").map(Number);
    cells[x!]![y!] = tile;
  }
  return cells;
}

/** A 1x1 footprint standing two high, so a roll changes its shape. */
const TALL: Puzzle = {
  gridWidth: 5,
  gridHeight: 2,
  cells: grid(5, 2),
  blocks: [new Block(1, 0, 0, 1, 1, 2)],
};

const ROLL_RIGHT: Turn = { blockId: 1, direction: Direction.RIGHT };

describe("SolutionView", () => {
  let view: SolutionView | undefined;

  const byId = (id: string) => document.getElementById(id)!;
  const cellAt = (x: number, y: number) =>
    document.querySelector<HTMLElement>(
      `#solution-grid .grid-cell[data-x="${x}"][data-y="${y}"]`,
    )!;
  const classed = (name: string) =>
    [...document.querySelectorAll<HTMLElement>(`#solution-grid .${name}`)].map(
      cell => `${cell.dataset.x},${cell.dataset.y}`,
    );
  const open = (puzzle: Puzzle, turns: Turn[]) => {
    view = new SolutionView(puzzle, turns);
  };
  const next = () => byId("solution-next").click();
  const prev = () => byId("solution-prev").click();

  beforeEach(() => {
    document.body.innerHTML = MARKUP;
  });

  afterEach(() => {
    // Guarded and cleared: `view` is assigned per test, so a constructor that
    // throws would otherwise make this dispose() the PREVIOUS test's instance
    // (or undefined) and report that instead of the real failure.
    view?.dispose();
    view = undefined;
    document.body.innerHTML = "";
  });

  describe("The board it draws", () => {
    test("shows the position the roll is played from", () => {
      open(TALL, [ROLL_RIGHT, ROLL_RIGHT]);

      expect(
        document.querySelectorAll("#solution-grid .grid-cell"),
      ).toHaveLength(10);
      expect(cellAt(0, 0).dataset.blockId).toBe("1");
      expect(cellAt(1, 0).dataset.kind).toBe("regular");
    });

    test("marks the block that rolls and where it lands", () => {
      open(TALL, [ROLL_RIGHT]);

      // Standing on one cell; it tips onto the two cells to its right.
      expect(classed("rb-moving")).toEqual(["0,0"]);
      expect(classed("rb-dest")).toEqual(["1,0", "2,0"]);
    });

    test("outlines the destination on its outer edges only", () => {
      open(TALL, [ROLL_RIGHT]);

      expect(cellAt(1, 0).classList.contains("rb-dest-edge-left")).toBeTrue();
      expect(cellAt(1, 0).classList.contains("rb-dest-edge-right")).toBeFalse();
      expect(cellAt(2, 0).classList.contains("rb-dest-edge-right")).toBeTrue();
    });

    test("follows the block through the roll", () => {
      open(TALL, [ROLL_RIGHT, ROLL_RIGHT]);

      next();

      // Lying down across two cells, about to stand back up on the third.
      expect(classed("rb-moving")).toEqual(["1,0", "2,0"]);
      expect(classed("rb-dest")).toEqual(["3,0"]);
    });

    test("dims a must-touch cell once it has been stepped on", () => {
      const puzzle: Puzzle = {
        gridWidth: 3,
        gridHeight: 1,
        cells: grid(3, 1, { "1,0": "mustTouch" }),
        blocks: [new Block(1, 0, 0, 1, 1, 1)],
      };
      open(puzzle, [
        { blockId: 1, direction: Direction.RIGHT },
        { blockId: 1, direction: Direction.RIGHT },
      ]);

      expect(cellAt(1, 0).dataset.touched).toBeUndefined();

      next();
      next();

      expect(cellAt(1, 0).dataset.touched).toBe("true");
    });
  });

  describe("Stepping", () => {
    test("counts the steps and describes the current one", () => {
      open(TALL, [ROLL_RIGHT, ROLL_RIGHT]);

      expect(byId("solution-step-counter").textContent).toBe("Step 1 of 2");
      expect(byId("solution-step-text").textContent).toContain(
        "Roll Block 1 right",
      );
    });

    test("cannot go back from the first step", () => {
      open(TALL, [ROLL_RIGHT, ROLL_RIGHT]);

      expect(byId("solution-prev").hasAttribute("disabled")).toBeTrue();

      next();

      expect(byId("solution-prev").hasAttribute("disabled")).toBeFalse();
      prev();
      expect(byId("solution-step-counter").textContent).toBe("Step 1 of 2");
    });

    test("ends on a card that says the board is solved", () => {
      const puzzle: Puzzle = {
        gridWidth: 3,
        gridHeight: 1,
        cells: grid(3, 1, { "2,0": "goal" }),
        blocks: [new Block(1, 0, 0, 1, 1, 1)],
      };
      open(puzzle, [
        { blockId: 1, direction: Direction.RIGHT },
        { blockId: 1, direction: Direction.RIGHT },
      ]);

      next();
      next();

      expect(byId("solution-step-counter").textContent).toBe(
        "Solved in 2 moves",
      );
      expect(byId("solution-next").hasAttribute("disabled")).toBeTrue();
      // Nothing is highlighted once every roll is behind you.
      expect(classed("rb-moving")).toEqual([]);
    });

    test("says so when the witness does not actually solve the board", () => {
      const puzzle: Puzzle = {
        gridWidth: 3,
        gridHeight: 1,
        cells: grid(3, 1, { "0,0": "goal" }),
        blocks: [new Block(1, 0, 0, 1, 1, 1)],
      };
      open(puzzle, [{ blockId: 1, direction: Direction.RIGHT }]);

      next();

      expect(byId("solution-step-counter").textContent).toBe(
        "Stopped after 1 move",
      );
    });
  });

  describe("The move list", () => {
    test("lists every roll with its block and direction", () => {
      open(TALL, [ROLL_RIGHT, { blockId: 1, direction: Direction.LEFT }]);

      const items = document.querySelectorAll("#solution-moves li");
      expect(items).toHaveLength(2);
      expect(items[0]!.textContent).toContain("Block 1");
      expect(items[0]!.textContent).toContain("right");
      expect(items[1]!.textContent).toContain("left");
    });

    test("marks the current row and the ones already done", () => {
      open(TALL, [ROLL_RIGHT, ROLL_RIGHT]);

      let items = document.querySelectorAll("#solution-moves li");
      expect(items[0]!.getAttribute("aria-current")).toBe("step");
      expect(items[1]!.getAttribute("aria-current")).toBeNull();

      next();

      items = document.querySelectorAll("#solution-moves li");
      expect(items[0]!.classList.contains("done")).toBeTrue();
      expect(items[1]!.getAttribute("aria-current")).toBe("step");
    });

    test("jumps the board to a row that is clicked", () => {
      open(TALL, [ROLL_RIGHT, ROLL_RIGHT]);

      document
        .querySelectorAll<HTMLElement>("#solution-moves li")[1]!
        .click();

      expect(byId("solution-step-counter").textContent).toBe("Step 2 of 2");
    });

    test("greys out the rolls a broken witness never reaches", () => {
      // Two rolls right from x=0 on a 2-wide board: the second falls off.
      const puzzle: Puzzle = {
        gridWidth: 2,
        gridHeight: 1,
        cells: grid(2, 1),
        blocks: [new Block(1, 0, 0, 1, 1, 1)],
      };
      open(puzzle, [
        { blockId: 1, direction: Direction.RIGHT },
        { blockId: 1, direction: Direction.RIGHT },
      ]);

      const items =
        document.querySelectorAll<HTMLElement>("#solution-moves li");
      expect(items).toHaveLength(2);
      expect(items[0]!.dataset.unplayable).toBeUndefined();
      expect(items[1]!.dataset.unplayable).toBe("true");
      expect(byId("solution-step-counter").textContent).toBe("Step 1 of 1");
    });
  });

  test("stops listening once disposed", () => {
    open(TALL, [ROLL_RIGHT, ROLL_RIGHT]);
    view!.dispose();
    view = undefined;

    next();

    expect(byId("solution-step-counter").textContent).toBe("Step 1 of 2");
  });
});
