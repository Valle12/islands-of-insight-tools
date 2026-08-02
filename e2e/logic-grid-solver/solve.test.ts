import { expect, test, type Page } from "@playwright/test";
import { gotoIsolated, LOGIC_GRID_URL } from "../coi";
import {
  impossibleBoard,
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
});
