import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SolutionView } from "../../src/pages/match-three-solver/solutionView";
import type { Move } from "../../src/pages/match-three-solver/rules";
import { SYMBOLS } from "../../src/pages/match-three-solver/symbols";
import { board } from "./boards";

const MARKUP = `
  <span id="solution-step-counter"></span>
  <div id="solution-grid"></div>
  <div id="solution-step-text"></div>
  <button id="solution-prev"></button>
  <button id="solution-next"></button>
`;

/** `aab` over `bba`: swapping the right-hand column makes both rows a line. */
const ONE_MOVE = ["aab", "bba"];
const VERTICAL_SWAP: Move = { a: { x: 2, y: 0 }, b: { x: 2, y: 1 } };

/** One horizontal swap, two waves, empty board. */
const CASCADE = ["c..", "b..", "a..", "a..", "cac", "abb"];
const HORIZONTAL_SWAP: Move = { a: { x: 0, y: 4 }, b: { x: 1, y: 4 } };

describe("SolutionView", () => {
  let view: SolutionView;

  const byId = (id: string) => document.getElementById(id)!;
  const cells = () =>
    document.querySelectorAll<HTMLElement>("#solution-grid .grid-cell");
  const cellAt = (x: number, y: number) =>
    document.querySelector<HTMLElement>(
      `#solution-grid .grid-cell[data-x="${x}"][data-y="${y}"]`,
    )!;
  const swapped = () =>
    [...cells()]
      .filter(cell => cell.dataset.swap)
      .map(cell => `${cell.dataset.x},${cell.dataset.y}`);
  function open(rows: string[], moves: Move[]) {
    view = new SolutionView({ board: board(rows), moves });
  }

  beforeEach(() => {
    document.body.innerHTML = MARKUP;
  });

  afterEach(() => {
    view.dispose();
    document.body.innerHTML = "";
  });

  describe("The board it draws", () => {
    test("shows the position the move is played on", () => {
      open(ONE_MOVE, [VERTICAL_SWAP]);

      expect(cells()).toHaveLength(6);
      expect(cellAt(0, 0).dataset.symbol).toBe(SYMBOLS[0]!.id);
      expect(cellAt(2, 0).dataset.symbol).toBe(SYMBOLS[1]!.id);
      expect(cellAt(2, 0).getAttribute("aria-label")).toBe(
        `Column 3, Row 1, ${SYMBOLS[1]!.label}`,
      );
    });

    test("marks the two blocks to exchange", () => {
      open(ONE_MOVE, [VERTICAL_SWAP]);

      expect(swapped()).toEqual(["2,0", "2,1"]);
      expect(cellAt(2, 0).dataset.swap).toBe("a");
      expect(cellAt(2, 1).dataset.swap).toBe("b");
    });

    /**
     * Only the pair to exchange is marked. Outlining what the move clears as
     * well was tried and dropped: on a move that takes a dozen blocks it left
     * the board unreadable, and the count in the step text says it anyway.
     */
    test("marks nothing but the pair to exchange", () => {
      open(ONE_MOVE, [VERTICAL_SWAP]);

      expect(swapped()).toHaveLength(2);
      expect(
        [...cells()].filter(cell => cell.className !== "grid-cell"),
      ).toBeEmpty();
    });

    test("records which way the pair is exchanged", () => {
      open(ONE_MOVE, [VERTICAL_SWAP]);
      expect(cellAt(2, 0).dataset.swapAxis).toBe("vertical");

      view.dispose();
      open(CASCADE, [HORIZONTAL_SWAP]);
      expect(cellAt(0, 4).dataset.swapAxis).toBe("horizontal");
    });

    test("empty and blocked cells keep the editor's labels", () => {
      open(CASCADE, [HORIZONTAL_SWAP]);

      expect(cellAt(1, 0).dataset.kind).toBe("empty");
      expect(cellAt(1, 0).getAttribute("aria-label")).toBe(
        "Column 2, Row 1, Empty",
      );
    });
  });

  describe("What it says", () => {
    /**
     * Positions, never tile names. Several tiles cannot be named usefully
     * ("Purple 2", "Nude"), and the ringed cells already say which two.
     */
    test("names both cells by position and counts the clear", () => {
      open(ONE_MOVE, [VERTICAL_SWAP]);

      const text = byId("solution-step-text").textContent!;
      expect(text).toContain("Column 3, Row 1");
      expect(text).toContain("Column 3, Row 2");
      expect(text).toContain("6 blocks");
      for (const symbol of SYMBOLS) expect(text).not.toContain(symbol.label);
    });

    test("calls out a swap whose fallout keeps matching", () => {
      open(CASCADE, [HORIZONTAL_SWAP]);

      const text = byId("solution-step-text").textContent!;
      expect(text).toContain("keeps matching");
      expect(text).toContain("10 blocks");
      expect(text).not.toContain("outlined");
    });

    test("counts the steps", () => {
      open(ONE_MOVE, [VERTICAL_SWAP]);
      expect(byId("solution-step-counter").textContent).toBe("Step 1 of 1");
    });
  });

  describe("Stepping", () => {
    test("Next moves on to the cleared board", () => {
      open(ONE_MOVE, [VERTICAL_SWAP]);
      byId("solution-next").click();

      expect(cellAt(0, 0).dataset.kind).toBe("empty");
      expect(swapped()).toBeEmpty();
      expect(byId("solution-step-counter").textContent).toBe("Solved in 1 move");
      expect(byId("solution-step-text").textContent).toContain("board is clear");
    });

    test("Previous goes back to the move", () => {
      open(ONE_MOVE, [VERTICAL_SWAP]);
      byId("solution-next").click();
      byId("solution-prev").click();

      expect(swapped()).toEqual(["2,0", "2,1"]);
      expect(byId("solution-step-counter").textContent).toBe("Step 1 of 1");
    });

    test("Previous is dead on the first step and Next on the last", () => {
      open(ONE_MOVE, [VERTICAL_SWAP]);
      expect(byId("solution-prev").hasAttribute("disabled")).toBeTrue();
      expect(byId("solution-next").hasAttribute("disabled")).toBeFalse();

      byId("solution-next").click();
      expect(byId("solution-prev").hasAttribute("disabled")).toBeFalse();
      expect(byId("solution-next").hasAttribute("disabled")).toBeTrue();
    });

    test("stepping past either end does nothing", () => {
      open(ONE_MOVE, [VERTICAL_SWAP]);
      byId("solution-prev").click();
      expect(byId("solution-step-counter").textContent).toBe("Step 1 of 1");

      byId("solution-next").click();
      byId("solution-next").click();
      expect(byId("solution-step-counter").textContent).toBe("Solved in 1 move");
    });

    test("dispose leaves the buttons inert", () => {
      open(ONE_MOVE, [VERTICAL_SWAP]);
      view.dispose();
      byId("solution-next").click();

      expect(byId("solution-step-counter").textContent).toBe("Step 1 of 1");
    });
  });

  test("a move that is not legal ends the walk there", () => {
    open(ONE_MOVE, [
      VERTICAL_SWAP,
      { a: { x: 0, y: 0 }, b: { x: 1, y: 0 } },
    ]);

    expect(byId("solution-step-counter").textContent).toBe("Step 1 of 1");
  });
});
