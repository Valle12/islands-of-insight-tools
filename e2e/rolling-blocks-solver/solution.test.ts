import { expect, test, type Page } from "@playwright/test";
import { gotoIsolated } from "../coi";

/** Builds a 9x9 board with one goal and one 2-high block. */
async function buildPuzzle(page: Page) {
  await gotoIsolated(page, "/rolling-blocks-solver");

  await page.getByRole("spinbutton", { name: "Grid Width" }).click();
  await page.getByRole("spinbutton", { name: "Grid Width" }).fill("9");
  await page.getByRole("spinbutton", { name: "Grid Width" }).press("Tab");
  await page.getByRole("spinbutton", { name: "Grid Height" }).fill("9");

  await page.getByRole("button", { name: "Goal" }).click();
  await page.getByRole("button", { name: "Column 5, Row 5, Regular" }).click();

  await page.getByRole("button", { name: "Block Footprint" }).click();
  await page.getByRole("button", { name: "Column 3, Row 7, Regular" }).click();

  const heightInput = page.locator(
    "md-outlined-text-field[data-block-id] input",
  );
  await heightInput.first().click();
  await heightInput.first().press("Control+A");
  await page.keyboard.type("2");
  await page.keyboard.press("Tab");
}

/**
 * Solves the puzzle and comes straight back to the editor, which is where
 * every "an edit clears the solution" test starts: solving now opens the
 * step-by-step view over the editor.
 */
async function setupSolvedPuzzle(page: Page) {
  await buildPuzzle(page);
  await page.getByRole("button", { name: "Calculate Moves" }).click();
  await expect(page.locator("#solution-moves")).toBeVisible({ timeout: 30000 });
  await page.getByRole("button", { name: "Back to editor" }).click();
  await expect(page.locator("#editor-section")).toBeVisible();
  await expect(page.locator("#solution-panel")).toBeVisible();
}

test.describe("Rolling Blocks Solver", () => {
  test("should show spinner on calculate click and display solution", async ({
    page,
  }) => {
    await buildPuzzle(page);

    // Solution panel should not be visible yet
    await expect(page.locator("#solution-panel")).toBeHidden();

    await page.getByRole("button", { name: "Calculate Moves" }).click();

    // Spinner should appear
    await expect(page.locator("#solution-panel")).toBeVisible();
    await expect(page.locator("#solution-spinner")).toBeVisible();

    // Wait for solution to appear (the WASM solver should complete)
    await expect(page.locator("#solution-moves")).toBeVisible({
      timeout: 30000,
    });
    await expect(page.locator("#solution-spinner")).toBeHidden();

    // The step view takes over from the editor, and the panel goes with it.
    await expect(page.locator("#editor-section")).toBeHidden();
    await expect(page.locator("#solution-view")).toBeVisible();
    await expect(page.locator("#solution-status")).toContainText(/\d+ moves?/);

    // Should display the actual moves as list items
    const moveItems = page.locator("#solution-moves li");
    await expect(moveItems.first()).toBeVisible();
    const moveCount = await moveItems.count();
    expect(moveCount).toBeGreaterThan(0);

    // Each move should contain a block reference and a direction
    for (let i = 0; i < moveCount; i++) {
      await expect(moveItems.nth(i)).toContainText("Block");
    }
  });

  test("should step through the solution one roll at a time", async ({
    page,
  }) => {
    await buildPuzzle(page);
    await page.getByRole("button", { name: "Calculate Moves" }).click();
    await expect(page.locator("#solution-moves")).toBeVisible({
      timeout: 30000,
    });

    const counter = page.locator("#solution-step-counter");
    const total = await page.locator("#solution-moves li").count();
    await expect(counter).toHaveText(`Step 1 of ${total}`);
    await expect(
      page.getByRole("button", { name: "Previous" }),
    ).toBeDisabled();

    // The board says which block to roll, and where it lands.
    await expect(page.locator("#solution-grid .rb-moving").first()).toBeVisible();
    await expect(page.locator("#solution-grid .rb-dest").first()).toBeVisible();
    await expect(page.locator("#solution-step-text")).toContainText("Roll Block");

    await page.getByRole("button", { name: "Next" }).click();
    await expect(counter).toHaveText(`Step 2 of ${total}`);
    await expect(page.locator("#solution-moves li").nth(1)).toHaveAttribute(
      "aria-current",
      "step",
    );

    await page.getByRole("button", { name: "Previous" }).click();
    await expect(counter).toHaveText(`Step 1 of ${total}`);

    // Clicking a row in the list jumps the board to that roll.
    await page.locator("#solution-moves li").last().click();
    await expect(counter).toHaveText(`Step ${total} of ${total}`);

    await page.getByRole("button", { name: "Next" }).click();
    await expect(counter).toHaveText(`Solved in ${total} moves`);
    await expect(page.getByRole("button", { name: "Next" })).toBeDisabled();
    await expect(page.locator("#solution-grid .rb-moving")).toHaveCount(0);
  });

  test("should return to the step view without solving again", async ({
    page,
  }) => {
    await setupSolvedPuzzle(page);

    await page.getByRole("button", { name: "Step through solution" }).click();

    await expect(page.locator("#solution-view")).toBeVisible();
    await expect(page.locator("#solution-step-counter")).toContainText(
      "Step 1 of",
    );
  });

  test("should hide solution when grid size changes", async ({ page }) => {
    await setupSolvedPuzzle(page);
    await page.getByRole("spinbutton", { name: "Grid Width" }).click();
    await page.getByRole("spinbutton", { name: "Grid Width" }).fill("7");
    await expect(page.locator("#solution-panel")).toBeHidden();
  });

  test("should hide solution after painting a cell", async ({ page }) => {
    await setupSolvedPuzzle(page);
    await page.getByRole("button", { name: "Must-Touch", exact: true }).click();
    await page
      .getByRole("button", { name: "Column 1, Row 1, Regular" })
      .click();
    await expect(page.locator("#solution-panel")).toBeHidden();
  });

  test("should hide solution after filling all cells", async ({ page }) => {
    await setupSolvedPuzzle(page);
    await page.getByRole("button", { name: "Fill Must-Touch" }).click();
    await expect(page.locator("#solution-panel")).toBeHidden();
  });

  test("should hide solution after creating a new block", async ({ page }) => {
    await setupSolvedPuzzle(page);
    await page.getByRole("button", { name: "Block Footprint" }).click();
    await page
      .getByRole("button", { name: "Column 1, Row 1, Regular" })
      .click();
    await expect(page.locator("#solution-panel")).toBeHidden();
  });

  test("should hide solution after deleting a block", async ({ page }) => {
    await setupSolvedPuzzle(page);
    await page.locator("md-icon-button[data-block-delete-id]").first().click();
    await expect(page.locator("#solution-panel")).toBeHidden();
  });

  test("should hide solution after changing block height", async ({ page }) => {
    await setupSolvedPuzzle(page);
    const heightInput = page.locator(
      "md-outlined-text-field[data-block-id] input",
    );
    await heightInput.first().click();
    await heightInput.first().press("Control+A");
    await page.keyboard.type("3");
    await page.keyboard.press("Tab");
    await expect(page.locator("#solution-panel")).toBeHidden();
  });

  test("should hide solution after reset", async ({ page }) => {
    await setupSolvedPuzzle(page);
    await page.getByRole("button", { name: "Reset" }).click();
    await page
      .locator("#reset-confirm")
      .getByRole("button", { name: "Reset" })
      .click();
    await expect(page.locator("#solution-panel")).toBeHidden();
  });

  test("should restart calculation when clicking calculate again", async ({
    page,
  }) => {
    await buildPuzzle(page);

    // Click Calculate Moves twice quickly (second click should restart)
    await page.getByRole("button", { name: "Calculate Moves" }).click();
    await expect(page.locator("#solution-spinner")).toBeVisible();

    // Click again — should restart and show spinner again
    await page.getByRole("button", { name: "Calculate Moves" }).click();
    await expect(page.locator("#solution-spinner")).toBeVisible();

    // Wait for the final solution to complete
    await expect(page.locator("#solution-moves")).toBeVisible({
      timeout: 30000,
    });
    await expect(page.locator("#solution-spinner")).toBeHidden();
    await expect(page.locator("#solution-status")).toContainText(/\d+ moves?/);
  });
});
