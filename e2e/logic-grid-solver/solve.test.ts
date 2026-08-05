import { expect, test, type Page } from "@playwright/test";
import { gotoIsolated, LOGIC_GRID_URL } from "../coi";
import {
  dartBoard,
  impossibleBoard,
  lotusOverMergedBoard,
  mergedCellBoard,
  solvableBoard,
  undercluedBoard,
} from "../../test/logic-grid-solver/boards";

// Every visit goes through gotoIsolated: this page registers the COOP/COEP
// shim and reloads once when its service worker activates, and anything issued
// into that window dies with "Execution context was destroyed".
const URL = LOGIC_GRID_URL;

function editorCell(page: Page, x: number, y: number) {
  return page.locator(`#grid .grid-cell[data-x="${x}"][data-y="${y}"]`);
}

function solutionCell(page: Page, x: number, y: number) {
  return page.locator(
    `#solution-grid .grid-cell[data-x="${x}"][data-y="${y}"]`,
  );
}

/** Loads a config through the page's own upload button. */
async function upload(page: Page, config: unknown) {
  await page.locator("#config-file-input").setInputFiles({
    name: "logicGridTest.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(config)),
  });
}

test.describe("Logic Grid Solver solving", () => {
  test.beforeEach(async ({ page }) => {
    await gotoIsolated(page, URL);
  });

  test("solves a board and shows it in place of the editor", async ({
    page,
  }) => {
    await upload(page, solvableBoard());
    await expect(page.locator("#solution-panel")).toBeHidden();

    await page.getByRole("button", { name: "Solve Grid" }).click();

    await expect(page.locator("#solution-view")).toBeVisible();
    await expect(page.locator("#editor-section")).toBeHidden();
    // Every playable cell is coloured: this board is not underclued.
    await expect(page.locator("#solution-count")).toHaveText("25 cells");
    await expect(page.locator("#solution-grid .grid-cell")).toHaveCount(25);
    await expect(
      page.locator('#solution-grid .grid-cell[data-color="unknown"]'),
    ).toHaveCount(0);
    // The clue is still drawn on the answer, on whichever colour it landed.
    await expect(solutionCell(page, 2, 2)).toHaveText("9");
  });

  test("Back to editor restores what was typed", async ({ page }) => {
    await editorCell(page, 0, 0).click();
    await page.getByRole("button", { name: "Solve Grid" }).click();
    await expect(page.locator("#solution-view")).toBeVisible();

    await page.getByRole("button", { name: "Back to editor" }).click();

    await expect(page.locator("#solution-view")).toBeHidden();
    await expect(page.locator("#editor-section")).toBeVisible();
    await expect(editorCell(page, 0, 0)).toHaveAttribute("data-color", "dark");
  });

  test("an underclued board paints only what is forced", async ({ page }) => {
    await upload(page, undercluedBoard());

    await page.getByRole("button", { name: "Solve Grid" }).click();

    await expect(page.locator("#solution-view")).toBeVisible();
    await expect(page.locator("#solution-count")).toContainText("deduced");
    // The area-one clue sits on a cell that was already dark, so its two
    // neighbours are forced light — and most of the board is not forced at all.
    await expect(solutionCell(page, 1, 0)).toHaveAttribute(
      "data-color",
      "light",
    );
    await expect(solutionCell(page, 0, 1)).toHaveAttribute(
      "data-color",
      "light",
    );
    await expect(solutionCell(page, 2, 1)).toHaveAttribute(
      "data-color",
      "unknown",
    );
    await expect(page.locator("#solution-note")).toContainText("not forced");
  });

  test("reports a board that cannot be completed", async ({ page }) => {
    // Two dark cells that have to be one region, each claiming a different size.
    await upload(page, impossibleBoard());

    await page.getByRole("button", { name: "Solve Grid" }).click();

    await expect(page.locator("#solution-panel")).toBeVisible();
    await expect(page.locator("#solution-status")).toHaveText("No solution");
    await expect(page.locator("#solution-view")).toBeHidden();
    await expect(page.locator("#editor-section")).toBeVisible();
  });

  test("painting a cell drops the answer", async ({ page }) => {
    await page.getByRole("button", { name: "Solve Grid" }).click();
    await expect(page.locator("#solution-view")).toBeVisible();

    await page.getByRole("button", { name: "Back to editor" }).click();
    await editorCell(page, 0, 0).click();

    await expect(page.locator("#solution-panel")).toBeHidden();
    await expect(page.locator("#solution-view")).toBeHidden();
  });

  test("toggling a rule drops it too", async ({ page }) => {
    await page.getByRole("button", { name: "Solve Grid" }).click();
    await expect(page.locator("#solution-view")).toBeVisible();

    // The rule row lives in the editor, so it can only be reached after going
    // back — which is also the moment the old answer must not quietly return.
    await page.getByRole("button", { name: "Back to editor" }).click();
    await page
      .locator('#rule-row .tool-button[data-rule="no-dark-2x2"]')
      .click();

    await expect(page.locator("#solution-panel")).toBeHidden();
    await expect(page.locator("#solution-view")).toBeHidden();
    await expect(page.locator("#editor-section")).toBeVisible();
  });

  /**
   * The answer's grid draws merged cells the same way the editor does: one SVG
   * path per cell, behind squares that paint nothing themselves. Two separate
   * things had to be true for that and neither was.
   *
   * The layer is absolutely positioned, so it needs a positioned ancestor —
   * without one it anchored to the page and every merged cell was drawn in the
   * top-left corner while its squares left holes in the answer. And the path is
   * traced from `--logic-cell` plus `--logic-seam`, so a square has to be
   * exactly that tall: the answer's squares are `<div>`s rather than the
   * editor's `<button>`s, and the pixel of border a content-box div adds put
   * every row 1.14px below where the outline expected it, until a merged cell
   * sat visibly higher than the plain squares beside it.
   *
   * So this measures both: inside the grid at all, and on the same line as the
   * row it belongs to.
   */
  test("draws merged cells inside the answer, aligned to its rows", async ({
    page,
  }) => {
    await upload(page, mergedCellBoard());
    await page.getByRole("button", { name: "Solve Grid" }).click();
    await expect(page.locator("#solution-view")).toBeVisible();

    const paths = page.locator("#solution-grid .shape-outline path");
    await expect(paths).toHaveCount(2);

    const grid = (await page.locator("#solution-grid").boundingBox())!;
    const boxes = await Promise.all(
      [0, 1].map(async i => (await paths.nth(i).boundingBox())!),
    );
    for (const box of boxes) {
      expect(box.x).toBeGreaterThanOrEqual(grid.x - 2);
      expect(box.y).toBeGreaterThanOrEqual(grid.y - 2);
      expect(box.x + box.width).toBeLessThanOrEqual(grid.x + grid.width + 2);
      expect(box.y + box.height).toBeLessThanOrEqual(grid.y + grid.height + 2);
    }

    // The 1x3 bar across the top row: its outline has to sit on the same line
    // as that row's plain squares, give or take the half stroke it is inset by.
    // Taken as the higher of the two rather than as the first, because the
    // order `outlineLayer` emits its paths in is not a contract.
    const bar = boxes[0]!.y <= boxes[1]!.y ? boxes[0]! : boxes[1]!;
    const square = (await solutionCell(page, 0, 0).boundingBox())!;
    expect(Math.abs(bar.y - square.y)).toBeLessThanOrEqual(1);
  });

  /**
   * The same layer, on a board with NO merged cells: an `<svg>` carrying no
   * width, height or viewBox falls back to the replaced element's default
   * 300x150, and since it is absolutely positioned inside the grid that
   * phantom box lands in the scrollable overflow of the shell around it. A
   * small answer then came with a horizontal scrollbar over empty background
   * and the height it reserves, while the editor's own shell — stretched wide
   * by the tool rows above it — hid the same bug completely.
   *
   * Only a real browser lays this out, which is why the assertion is here and
   * not in a unit test.
   */
  test("draws a small answer without a scrollbar over nothing", async ({
    page,
  }) => {
    await upload(page, solvableBoard());
    await page.getByRole("button", { name: "Solve Grid" }).click();
    await expect(page.locator("#solution-view")).toBeVisible();

    const shell = await page.locator("#solution-grid-shell").evaluate(el => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      offsetHeight: (el as HTMLElement).offsetHeight,
      clientHeight: el.clientHeight,
    }));
    expect(shell.scrollWidth).toBe(shell.clientWidth);
    // The scrollbar's own height, had one been reserved: the shell's border is
    // 1px a side, so anything past 2px is a gutter.
    expect(shell.offsetHeight - shell.clientHeight).toBeLessThanOrEqual(2);
  });

  /**
   * Both darts on this board fill in immediately — one holds 0 and one holds a
   * whole line — so between them they settle every cell, and the top one looks
   * straight through the gap in its row.
   *
   * What it really checks is the whole `direction` path end to end: a dart that
   * lost its aim between the page and the module would settle a different line,
   * and one that lost it between the module and the answer would come back
   * drawn as a bare number.
   */
  test("solves a board its darts settle, and keeps their arrows", async ({
    page,
  }) => {
    await upload(page, dartBoard());
    await page.getByRole("button", { name: "Solve Grid" }).click();

    await expect(page.locator("#solution-view")).toBeVisible();
    await expect(
      page.locator('#solution-grid .grid-cell[data-color="unknown"]'),
    ).toHaveCount(0);

    // Nothing light past the gap, so the rest of the top row is dark...
    for (const x of [1, 3, 4]) {
      await expect(solutionCell(page, x, 0)).toHaveAttribute(
        "data-color",
        "dark",
      );
    }
    // ...and the whole of the bottom dart's line is light.
    for (const x of [1, 2, 3, 4]) {
      await expect(solutionCell(page, x, 1)).toHaveAttribute(
        "data-color",
        "light",
      );
    }

    // The answer is drawn with the same clues the editor showed, arrows and all.
    await expect(solutionCell(page, 0, 0)).toHaveAttribute(
      "data-direction",
      "right",
    );
    await expect(solutionCell(page, 0, 0).locator(".cell-value")).toHaveText(
      "0",
    );
  });

  /**
   * The symmetry symbol end to end: seated on the seam of its own 1x2 merged
   * cell, its region must mirror across that grid line, which forces the whole
   * board — the square beside its lower half dark, the bottom row light. An
   * axis or seat lost at either boundary would settle a different board, and
   * one lost on the way back would draw the glyph in the wrong place.
   */
  test("solves a board its symmetry symbol settles, and keeps its seat", async ({
    page,
  }) => {
    await upload(page, lotusOverMergedBoard());
    await page.getByRole("button", { name: "Solve Grid" }).click();

    await expect(page.locator("#solution-view")).toBeVisible();
    await expect(
      page.locator('#solution-grid .grid-cell[data-color="unknown"]'),
    ).toHaveCount(0);

    // Mirroring across the seam forces (1,1) dark; the bottom row reflects
    // off the board, so it can only be light.
    await expect(solutionCell(page, 1, 1)).toHaveAttribute(
      "data-color",
      "dark",
    );
    for (const x of [0, 1]) {
      await expect(solutionCell(page, x, 2)).toHaveAttribute(
        "data-color",
        "light",
      );
    }

    // The answer keeps the glyph on its seam, turned the way it was placed.
    await expect(solutionCell(page, 0, 0)).toHaveAttribute(
      "data-axis",
      "horizontal",
    );
    await expect(solutionCell(page, 0, 0)).toHaveAttribute("data-seat", "2");
  });
});
