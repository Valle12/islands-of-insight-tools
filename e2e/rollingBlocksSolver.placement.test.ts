import { expect, test, type Page } from "@playwright/test";

async function setupSolvedPuzzle(page: Page) {
  await page.goto("/rolling-blocks-solver");

  await page.getByRole("spinbutton", { name: "Grid Width" }).click();
  await page.getByRole("spinbutton", { name: "Grid Width" }).fill("9");
  await page.getByRole("spinbutton", { name: "Grid Width" }).press("Tab");
  await page.getByRole("spinbutton", { name: "Grid Height" }).fill("9");

  await page.getByRole("button", { name: "Goal" }).click();
  await page
    .getByRole("button", { name: "Column 5, Row 5, Regular" })
    .click();

  await page.getByRole("button", { name: "Block Footprint" }).click();
  await page
    .getByRole("button", { name: "Column 3, Row 7, Regular" })
    .click();

  const heightInput = page.locator(
    "md-outlined-text-field[data-block-id] input",
  );
  await heightInput.first().click();
  await heightInput.first().press("Control+A");
  await page.keyboard.type("2");
  await page.keyboard.press("Tab");

  await page.getByRole("button", { name: "Calculate Moves" }).click();
  await expect(page.locator("#solution-moves")).toBeVisible({ timeout: 30000 });
}

test.describe("Rolling Blocks Solver", () => {
  test("test if block will not be placed if it covers unplayable cell", async ({
    page,
  }) => {
    await page.goto("/rolling-blocks-solver");
    await page.getByRole("button", { name: "Unplayable" }).click();
    await page
      .getByRole("button", { name: "Column 1, Row 5, Regular" })
      .click();
    await page
      .getByRole("button", { name: "Column 4, Row 2, Regular" })
      .click();
    await page
      .getByRole("button", { name: "Column 4, Row 5, Regular" })
      .click();
    await page.getByRole("button", { name: "Block Footprint" }).click();
    const block1Source = page.getByRole("button", {
      name: "Column 3, Row 3, Regular",
    });
    const block1Target = page.getByRole("button", {
      name: "Column 1, Row 5, Unplayable",
    });
    await block1Source.dragTo(block1Target);
    await expect(page.locator("#editor-card")).toMatchAriaSnapshot(`
    - heading "Rolling Blocks Setup" [level=1]
    - paragraph: Build the board layout and block definitions. Solver logic comes later.
    - text: Grid Width
    - spinbutton "Grid Width"
    - text: Grid Height
    - spinbutton "Grid Height"
    - button "Column 1, Row 1, Regular"
    - button "Column 2, Row 1, Regular"
    - button "Column 3, Row 1, Regular"
    - button "Column 4, Row 1, Regular"
    - button "Column 5, Row 1, Regular"
    - button "Column 1, Row 2, Regular"
    - button "Column 2, Row 2, Regular"
    - button "Column 3, Row 2, Regular"
    - button "Column 4, Row 2, Unplayable"
    - button "Column 5, Row 2, Regular"
    - button "Column 1, Row 3, Regular"
    - button "Column 2, Row 3, Regular"
    - button "Column 3, Row 3, Regular"
    - button "Column 4, Row 3, Regular"
    - button "Column 5, Row 3, Regular"
    - button "Column 1, Row 4, Regular"
    - button "Column 2, Row 4, Regular"
    - button "Column 3, Row 4, Regular"
    - button "Column 4, Row 4, Regular"
    - button "Column 5, Row 4, Regular"
    - button "Column 1, Row 5, Unplayable"
    - button "Column 2, Row 5, Regular"
    - button "Column 3, Row 5, Regular"
    - button "Column 4, Row 5, Unplayable"
    - button "Column 5, Row 5, Regular"
    - text: "Selected tool: Block Footprint"
    - button "Regular"
    - button "Fill Regular"
    - button "Must-Touch"
    - button "Fill Must-Touch"
    - button "Goal"
    - button "Unplayable"
    - button "Block Footprint"
    - button "Reset"
    - button "Calculate Moves"
    - heading "Blocks" [level=2]
    - paragraph: Drag once on the grid with Block Footprint to create a cuboid.
    - paragraph: No blocks defined yet. Use Block Footprint and drag on the grid.
    `);
    const block2Source = page.getByRole("button", {
      name: "Column 3, Row 1, Regular",
    });
    const block2Target = page.getByRole("button", {
      name: "Column 5, Row 3, Regular",
    });
    await block2Source.dragTo(block2Target);
    await expect(page.locator("#editor-card")).toMatchAriaSnapshot(`
    - heading "Rolling Blocks Setup" [level=1]
    - paragraph: Build the board layout and block definitions. Solver logic comes later.
    - text: Grid Width
    - spinbutton "Grid Width"
    - text: Grid Height
    - spinbutton "Grid Height"
    - button "Column 1, Row 1, Regular"
    - button "Column 2, Row 1, Regular"
    - button "Column 3, Row 1, Regular"
    - button "Column 4, Row 1, Regular"
    - button "Column 5, Row 1, Regular"
    - button "Column 1, Row 2, Regular"
    - button "Column 2, Row 2, Regular"
    - button "Column 3, Row 2, Regular"
    - button "Column 4, Row 2, Unplayable"
    - button "Column 5, Row 2, Regular"
    - button "Column 1, Row 3, Regular"
    - button "Column 2, Row 3, Regular"
    - button "Column 3, Row 3, Regular"
    - button "Column 4, Row 3, Regular"
    - button "Column 5, Row 3, Regular"
    - button "Column 1, Row 4, Regular"
    - button "Column 2, Row 4, Regular"
    - button "Column 3, Row 4, Regular"
    - button "Column 4, Row 4, Regular"
    - button "Column 5, Row 4, Regular"
    - button "Column 1, Row 5, Unplayable"
    - button "Column 2, Row 5, Regular"
    - button "Column 3, Row 5, Regular"
    - button "Column 4, Row 5, Unplayable"
    - button "Column 5, Row 5, Regular"
    - text: "Selected tool: Block Footprint"
    - button "Regular"
    - button "Fill Regular"
    - button "Must-Touch"
    - button "Fill Must-Touch"
    - button "Goal"
    - button "Unplayable"
    - button "Block Footprint"
    - button "Reset"
    - button "Calculate Moves"
    - heading "Blocks" [level=2]
    - paragraph: Drag once on the grid with Block Footprint to create a cuboid.
    - paragraph: No blocks defined yet. Use Block Footprint and drag on the grid.
    `);
    const block3Source = page.getByRole("button", {
      name: "Column 3, Row 3, Regular",
    });
    const block3Target = page.getByRole("button", {
      name: "Column 5, Row 5, Regular",
    });
    await block3Source.dragTo(block3Target);
    await expect(page.locator("#editor-card")).toMatchAriaSnapshot(`
    - heading "Rolling Blocks Setup" [level=1]
    - paragraph: Build the board layout and block definitions. Solver logic comes later.
    - text: Grid Width
    - spinbutton "Grid Width"
    - text: Grid Height
    - spinbutton "Grid Height"
    - button "Column 1, Row 1, Regular"
    - button "Column 2, Row 1, Regular"
    - button "Column 3, Row 1, Regular"
    - button "Column 4, Row 1, Regular"
    - button "Column 5, Row 1, Regular"
    - button "Column 1, Row 2, Regular"
    - button "Column 2, Row 2, Regular"
    - button "Column 3, Row 2, Regular"
    - button "Column 4, Row 2, Unplayable"
    - button "Column 5, Row 2, Regular"
    - button "Column 1, Row 3, Regular"
    - button "Column 2, Row 3, Regular"
    - button "Column 3, Row 3, Regular"
    - button "Column 4, Row 3, Regular"
    - button "Column 5, Row 3, Regular"
    - button "Column 1, Row 4, Regular"
    - button "Column 2, Row 4, Regular"
    - button "Column 3, Row 4, Regular"
    - button "Column 4, Row 4, Regular"
    - button "Column 5, Row 4, Regular"
    - button "Column 1, Row 5, Unplayable"
    - button "Column 2, Row 5, Regular"
    - button "Column 3, Row 5, Regular"
    - button "Column 4, Row 5, Unplayable"
    - button "Column 5, Row 5, Regular"
    - text: "Selected tool: Block Footprint"
    - button "Regular"
    - button "Fill Regular"
    - button "Must-Touch"
    - button "Fill Must-Touch"
    - button "Goal"
    - button "Unplayable"
    - button "Block Footprint"
    - button "Reset"
    - button "Calculate Moves"
    - heading "Blocks" [level=2]
    - paragraph: Drag once on the grid with Block Footprint to create a cuboid.
    - paragraph: No blocks defined yet. Use Block Footprint and drag on the grid.
    `);
  });

});