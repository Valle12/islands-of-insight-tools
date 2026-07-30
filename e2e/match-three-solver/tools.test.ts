import { expect, test, type Page } from "@playwright/test";

function cellAt(page: Page, x: number, y: number) {
  return page.locator(`.grid-cell[data-x="${x}"][data-y="${y}"]`);
}

function chips(page: Page) {
  return page.locator("#color-row .color-chip");
}

/**
 * The Reset *tool*. Once the confirmation dialog has been opened, its own
 * "Reset" button is matchable too, so this must stay scoped to the tool row.
 */
function resetTool(page: Page) {
  return page.locator('#tool-row .tool-button[data-tool="reset"]');
}

// The palette is handed out at random, so every assertion here keys off the
// slot (`data-color-index`, the "Color N" label) and never a color name.
test.describe("Match Three Solver tools", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/match-three-solver");
  });

  test("opens on an empty board with a single color", async ({ page }) => {
    await expect(page.locator(".grid-cell")).toHaveCount(36);
    await expect(page.locator('.grid-cell[data-kind="empty"]')).toHaveCount(36);
    await expect(chips(page)).toHaveCount(1);
    await expect(page.locator("#tool-status")).toHaveText(
      "Selected tool: Color 1",
    );
    await expect(page.locator("#solution-panel")).toBeHidden();
  });

  test("paints with the selected color", async ({ page }) => {
    await cellAt(page, 1, 1).click();
    await expect(cellAt(page, 1, 1)).toHaveAttribute("data-kind", "color");
    await expect(cellAt(page, 1, 1)).toHaveAttribute("data-color-index", "0");
    await expect(cellAt(page, 1, 1)).toHaveAccessibleName(
      "Column 2, Row 2, Color 1",
    );
  });

  test("paints obstacles and erases them again", async ({ page }) => {
    await page.getByRole("button", { name: "Blocked" }).click();
    await expect(page.locator("#tool-status")).toHaveText(
      "Selected tool: Blocked",
    );
    await cellAt(page, 0, 0).click();
    await expect(cellAt(page, 0, 0)).toHaveAttribute("data-kind", "blocked");

    await page.getByRole("button", { name: "Eraser" }).click();
    await expect(page.locator("#tool-status")).toHaveText(
      "Selected tool: Eraser",
    );
    await cellAt(page, 0, 0).click();
    await expect(cellAt(page, 0, 0)).toHaveAttribute("data-kind", "empty");
  });

  test("drags paint across a row", async ({ page }) => {
    await page.getByRole("button", { name: "Blocked" }).click();
    const from = await cellAt(page, 0, 5).boundingBox();
    const to = await cellAt(page, 3, 5).boundingBox();
    if (!from || !to) throw new Error("grid cells not visible");

    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, {
      steps: 12,
    });
    await page.mouse.up();

    await expect(page.locator('.grid-cell[data-kind="blocked"]')).toHaveCount(4);
  });

  test("adds a color, selects it, and can switch back", async ({ page }) => {
    await cellAt(page, 0, 0).click();

    await page.getByRole("button", { name: "Add Color" }).click();
    await expect(chips(page)).toHaveCount(2);
    await expect(page.locator("#tool-status")).toHaveText(
      "Selected tool: Color 2",
    );
    await cellAt(page, 1, 0).click();
    await expect(cellAt(page, 1, 0)).toHaveAttribute("data-color-index", "1");

    // Going back to the first color is the whole point of the chip row.
    await chips(page).first().click();
    await expect(page.locator("#tool-status")).toHaveText(
      "Selected tool: Color 1",
    );
    await cellAt(page, 2, 0).click();
    await expect(cellAt(page, 2, 0)).toHaveAttribute("data-color-index", "0");
    await expect(cellAt(page, 0, 0)).toHaveAttribute("data-color-index", "0");
  });

  test("each color chip paints a distinct fill", async ({ page }) => {
    await page.getByRole("button", { name: "Add Color" }).click();
    await cellAt(page, 0, 0).click();
    await chips(page).first().click();
    await cellAt(page, 1, 0).click();

    const fill = (x: number, y: number) =>
      cellAt(page, x, y).evaluate(
        el => getComputedStyle(el).backgroundColor,
      );
    expect(await fill(0, 0)).not.toBe(await fill(1, 0));
  });

  test("resizing keeps the colors but clears the board", async ({ page }) => {
    await page.getByRole("button", { name: "Add Color" }).click();
    await cellAt(page, 0, 0).click();

    await page.getByRole("spinbutton", { name: "Grid Width" }).fill("4");
    await page.getByRole("spinbutton", { name: "Grid Height" }).fill("3");

    await expect(page.locator(".grid-cell")).toHaveCount(12);
    await expect(chips(page)).toHaveCount(2);
    await expect(cellAt(page, 0, 0)).toHaveAttribute("data-kind", "empty");
  });

  test("the solve button explains that the solver is pending", async ({
    page,
  }) => {
    await page.getByRole("button", { name: "Solve Puzzle" }).click();
    await expect(page.locator("#solution-panel")).toBeVisible();
    await expect(page.locator("#solution-status")).toHaveText(
      "Not available yet",
    );
    await expect(page.locator("#solution-placeholder")).toContainText(
      "not implemented yet",
    );

    // Any edit invalidates it again.
    await cellAt(page, 0, 0).click();
    await expect(page.locator("#solution-panel")).toBeHidden();
  });

  test("reset clears the board and the extra colors", async ({ page }) => {
    await page.getByRole("button", { name: "Add Color" }).click();
    await cellAt(page, 0, 0).click();
    await page.getByRole("spinbutton", { name: "Grid Width" }).fill("4");

    await resetTool(page).click();
    await page
      .locator("#reset-cancel")
      .getByRole("button", { name: "Cancel" })
      .click();
    await expect(chips(page)).toHaveCount(2);

    await resetTool(page).click();
    await page
      .locator("#reset-confirm")
      .getByRole("button", { name: "Reset" })
      .click();

    await expect(page.locator(".grid-cell")).toHaveCount(36);
    await expect(chips(page)).toHaveCount(1);
    await expect(page.locator('.grid-cell[data-kind="empty"]')).toHaveCount(36);
  });

  test("matches the editor layout", async ({ page }) => {
    await page.getByRole("spinbutton", { name: "Grid Width" }).fill("2");
    await page.getByRole("spinbutton", { name: "Grid Height" }).fill("2");
    await page.getByRole("button", { name: "Blocked" }).click();
    await cellAt(page, 0, 0).click();

    await expect(page.locator("#editor-card")).toMatchAriaSnapshot(`
      - heading "Match Three Setup" [level=1]
      - paragraph: Paint the board with obstacles and colored blocks, then solve it.
      - text: Grid Width
      - spinbutton "Grid Width"
      - text: Grid Height
      - spinbutton "Grid Height"
      - button "Column 1, Row 1, Blocked"
      - button "Column 2, Row 1, Empty"
      - button "Column 1, Row 2, Empty"
      - button "Column 2, Row 2, Empty"
      - text: "Selected tool: Blocked"
      - button "Blocked"
      - button "Eraser"
      - button "Add Color"
      - button "Reset"
      - button "Color 1"
      - button "Solve Puzzle"
      - button "Load config from disk"
      - button "Download config"
    `);
  });
});
