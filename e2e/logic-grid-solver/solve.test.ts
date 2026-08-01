import { expect, test, type Page } from "@playwright/test";

const URL = "/logic-grid-solver";

function cellAt(page: Page, x: number, y: number) {
  return page.locator(`#grid .grid-cell[data-x="${x}"][data-y="${y}"]`);
}

/**
 * The search is not written yet. What is being pinned here is the shell it will
 * hang off: the button reports honestly, and any edit drops what it said.
 */
test.describe("Logic Grid Solver solving", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(URL);
  });

  test("reports that the solver is not written yet", async ({ page }) => {
    await expect(page.locator("#solution-panel")).toBeHidden();

    await page.locator('#rule-row .tool-button[data-rule="underclued"]').click();
    await page.getByRole("button", { name: "Solve Grid" }).click();

    await expect(page.locator("#solution-panel")).toBeVisible();
    await expect(page.locator("#solution-status")).toHaveText(
      "Not implemented",
    );
    await expect(page.locator("#solution-message")).toContainText(
      "(6x6, 1 rule, 0 symbols)",
    );
    // No solution view: a solved logic grid is one finished board, not steps.
    await expect(page.locator("#solution-view")).toHaveCount(0);
    await expect(page.locator("#editor-section")).toBeVisible();
  });

  test("painting a cell drops the message", async ({ page }) => {
    await page.getByRole("button", { name: "Solve Grid" }).click();
    await expect(page.locator("#solution-panel")).toBeVisible();

    await cellAt(page, 0, 0).click();
    await expect(page.locator("#solution-panel")).toBeHidden();
  });

  test("toggling a rule drops the message", async ({ page }) => {
    await page.getByRole("button", { name: "Solve Grid" }).click();
    await expect(page.locator("#solution-panel")).toBeVisible();

    await page.locator('#rule-row .tool-button[data-rule="no-dark-2x2"]').click();
    await expect(page.locator("#solution-panel")).toBeHidden();
  });
});
