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
  test("test if all tools work as expected", async ({ page }) => {
    await page.goto("/rolling-blocks-solver");
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
    - button "Column 4, Row 2, Regular"
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
    - button "Column 1, Row 5, Regular"
    - button "Column 2, Row 5, Regular"
    - button "Column 3, Row 5, Regular"
    - button "Column 4, Row 5, Regular"
    - button "Column 5, Row 5, Regular"
    - text: "Selected tool: Regular"
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
    await page.getByRole("spinbutton", { name: "Grid Width" }).click();
    await page.getByRole("spinbutton", { name: "Grid Width" }).fill("6");
    await page.getByRole("spinbutton", { name: "Grid Width" }).press("Tab");
    await page.getByRole("spinbutton", { name: "Grid Height" }).fill("7");
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
    - button "Column 6, Row 1, Regular"
    - button "Column 1, Row 2, Regular"
    - button "Column 2, Row 2, Regular"
    - button "Column 3, Row 2, Regular"
    - button "Column 4, Row 2, Regular"
    - button "Column 5, Row 2, Regular"
    - button "Column 6, Row 2, Regular"
    - button "Column 1, Row 3, Regular"
    - button "Column 2, Row 3, Regular"
    - button "Column 3, Row 3, Regular"
    - button "Column 4, Row 3, Regular"
    - button "Column 5, Row 3, Regular"
    - button "Column 6, Row 3, Regular"
    - button "Column 1, Row 4, Regular"
    - button "Column 2, Row 4, Regular"
    - button "Column 3, Row 4, Regular"
    - button "Column 4, Row 4, Regular"
    - button "Column 5, Row 4, Regular"
    - button "Column 6, Row 4, Regular"
    - button "Column 1, Row 5, Regular"
    - button "Column 2, Row 5, Regular"
    - button "Column 3, Row 5, Regular"
    - button "Column 4, Row 5, Regular"
    - button "Column 5, Row 5, Regular"
    - button "Column 6, Row 5, Regular"
    - button "Column 1, Row 6, Regular"
    - button "Column 2, Row 6, Regular"
    - button "Column 3, Row 6, Regular"
    - button "Column 4, Row 6, Regular"
    - button "Column 5, Row 6, Regular"
    - button "Column 6, Row 6, Regular"
    - button "Column 1, Row 7, Regular"
    - button "Column 2, Row 7, Regular"
    - button "Column 3, Row 7, Regular"
    - button "Column 4, Row 7, Regular"
    - button "Column 5, Row 7, Regular"
    - button "Column 6, Row 7, Regular"
    - text: "Selected tool: Regular"
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
    await page.getByRole("button", { name: "Must-Touch", exact: true }).click();
    await page
      .getByRole("button", { name: "Column 2, Row 3, Regular" })
      .click();
    await page
      .getByRole("button", { name: "Column 3, Row 2, Regular" })
      .click();
    await page
      .getByRole("button", { name: "Column 4, Row 1, Regular" })
      .click();
    await page
      .getByRole("button", { name: "Column 4, Row 2, Regular" })
      .click();
    await page
      .getByRole("button", { name: "Column 4, Row 3, Regular" })
      .click();
    await page
      .getByRole("button", { name: "Column 4, Row 4, Regular" })
      .click();
    await page
      .getByRole("button", { name: "Column 4, Row 5, Regular" })
      .click();
    await page
      .getByRole("button", { name: "Column 4, Row 6, Regular" })
      .click();
    await page
      .getByRole("button", { name: "Column 4, Row 7, Regular" })
      .click();
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
    - button "Column 4, Row 1, Must-touch"
    - button "Column 5, Row 1, Regular"
    - button "Column 6, Row 1, Regular"
    - button "Column 1, Row 2, Regular"
    - button "Column 2, Row 2, Regular"
    - button "Column 3, Row 2, Must-touch"
    - button "Column 4, Row 2, Must-touch"
    - button "Column 5, Row 2, Regular"
    - button "Column 6, Row 2, Regular"
    - button "Column 1, Row 3, Regular"
    - button "Column 2, Row 3, Must-touch"
    - button "Column 3, Row 3, Regular"
    - button "Column 4, Row 3, Must-touch"
    - button "Column 5, Row 3, Regular"
    - button "Column 6, Row 3, Regular"
    - button "Column 1, Row 4, Regular"
    - button "Column 2, Row 4, Regular"
    - button "Column 3, Row 4, Regular"
    - button "Column 4, Row 4, Must-touch"
    - button "Column 5, Row 4, Regular"
    - button "Column 6, Row 4, Regular"
    - button "Column 1, Row 5, Regular"
    - button "Column 2, Row 5, Regular"
    - button "Column 3, Row 5, Regular"
    - button "Column 4, Row 5, Must-touch"
    - button "Column 5, Row 5, Regular"
    - button "Column 6, Row 5, Regular"
    - button "Column 1, Row 6, Regular"
    - button "Column 2, Row 6, Regular"
    - button "Column 3, Row 6, Regular"
    - button "Column 4, Row 6, Must-touch"
    - button "Column 5, Row 6, Regular"
    - button "Column 6, Row 6, Regular"
    - button "Column 1, Row 7, Regular"
    - button "Column 2, Row 7, Regular"
    - button "Column 3, Row 7, Regular"
    - button "Column 4, Row 7, Must-touch"
    - button "Column 5, Row 7, Regular"
    - button "Column 6, Row 7, Regular"
    - text: "Selected tool: Must-Touch"
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
    await page.getByRole("button", { name: "Fill Must-Touch" }).click();
    await expect(page.locator("#editor-card")).toMatchAriaSnapshot(`
    - heading "Rolling Blocks Setup" [level=1]
    - paragraph: Build the board layout and block definitions. Solver logic comes later.
    - text: Grid Width
    - spinbutton "Grid Width"
    - text: Grid Height
    - spinbutton "Grid Height"
    - button "Column 1, Row 1, Must-touch"
    - button "Column 2, Row 1, Must-touch"
    - button "Column 3, Row 1, Must-touch"
    - button "Column 4, Row 1, Must-touch"
    - button "Column 5, Row 1, Must-touch"
    - button "Column 6, Row 1, Must-touch"
    - button "Column 1, Row 2, Must-touch"
    - button "Column 2, Row 2, Must-touch"
    - button "Column 3, Row 2, Must-touch"
    - button "Column 4, Row 2, Must-touch"
    - button "Column 5, Row 2, Must-touch"
    - button "Column 6, Row 2, Must-touch"
    - button "Column 1, Row 3, Must-touch"
    - button "Column 2, Row 3, Must-touch"
    - button "Column 3, Row 3, Must-touch"
    - button "Column 4, Row 3, Must-touch"
    - button "Column 5, Row 3, Must-touch"
    - button "Column 6, Row 3, Must-touch"
    - button "Column 1, Row 4, Must-touch"
    - button "Column 2, Row 4, Must-touch"
    - button "Column 3, Row 4, Must-touch"
    - button "Column 4, Row 4, Must-touch"
    - button "Column 5, Row 4, Must-touch"
    - button "Column 6, Row 4, Must-touch"
    - button "Column 1, Row 5, Must-touch"
    - button "Column 2, Row 5, Must-touch"
    - button "Column 3, Row 5, Must-touch"
    - button "Column 4, Row 5, Must-touch"
    - button "Column 5, Row 5, Must-touch"
    - button "Column 6, Row 5, Must-touch"
    - button "Column 1, Row 6, Must-touch"
    - button "Column 2, Row 6, Must-touch"
    - button "Column 3, Row 6, Must-touch"
    - button "Column 4, Row 6, Must-touch"
    - button "Column 5, Row 6, Must-touch"
    - button "Column 6, Row 6, Must-touch"
    - button "Column 1, Row 7, Must-touch"
    - button "Column 2, Row 7, Must-touch"
    - button "Column 3, Row 7, Must-touch"
    - button "Column 4, Row 7, Must-touch"
    - button "Column 5, Row 7, Must-touch"
    - button "Column 6, Row 7, Must-touch"
    - text: "Selected tool: Must-Touch"
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
    await page.getByRole("button", { name: "Regular", exact: true }).click();
    await page
      .getByRole("button", { name: "Column 3, Row 1, Must-touch" })
      .click();
    await page
      .getByRole("button", { name: "Column 4, Row 1, Must-touch" })
      .click();
    await page
      .getByRole("button", { name: "Column 5, Row 1, Must-touch" })
      .click();
    await page
      .getByRole("button", { name: "Column 5, Row 2, Must-touch" })
      .click();
    await page
      .getByRole("button", { name: "Column 5, Row 3, Must-touch" })
      .click();
    await page
      .getByRole("button", { name: "Column 5, Row 4, Must-touch" })
      .click();
    await page
      .getByRole("button", { name: "Column 4, Row 4, Must-touch" })
      .click();
    await page
      .getByRole("button", { name: "Column 3, Row 4, Must-touch" })
      .click();
    await page
      .getByRole("button", { name: "Column 3, Row 5, Must-touch" })
      .click();
    await page
      .getByRole("button", { name: "Column 3, Row 6, Must-touch" })
      .click();
    await page
      .getByRole("button", { name: "Column 3, Row 7, Must-touch" })
      .click();
    await page
      .getByRole("button", { name: "Column 4, Row 7, Must-touch" })
      .click();
    await page
      .getByRole("button", { name: "Column 5, Row 7, Must-touch" })
      .click();
    await expect(page.locator("#editor-card")).toMatchAriaSnapshot(`
    - heading "Rolling Blocks Setup" [level=1]
    - paragraph: Build the board layout and block definitions. Solver logic comes later.
    - text: Grid Width
    - spinbutton "Grid Width"
    - text: Grid Height
    - spinbutton "Grid Height"
    - button "Column 1, Row 1, Must-touch"
    - button "Column 2, Row 1, Must-touch"
    - button "Column 3, Row 1, Regular"
    - button "Column 4, Row 1, Regular"
    - button "Column 5, Row 1, Regular"
    - button "Column 6, Row 1, Must-touch"
    - button "Column 1, Row 2, Must-touch"
    - button "Column 2, Row 2, Must-touch"
    - button "Column 3, Row 2, Must-touch"
    - button "Column 4, Row 2, Must-touch"
    - button "Column 5, Row 2, Regular"
    - button "Column 6, Row 2, Must-touch"
    - button "Column 1, Row 3, Must-touch"
    - button "Column 2, Row 3, Must-touch"
    - button "Column 3, Row 3, Must-touch"
    - button "Column 4, Row 3, Must-touch"
    - button "Column 5, Row 3, Regular"
    - button "Column 6, Row 3, Must-touch"
    - button "Column 1, Row 4, Must-touch"
    - button "Column 2, Row 4, Must-touch"
    - button "Column 3, Row 4, Regular"
    - button "Column 4, Row 4, Regular"
    - button "Column 5, Row 4, Regular"
    - button "Column 6, Row 4, Must-touch"
    - button "Column 1, Row 5, Must-touch"
    - button "Column 2, Row 5, Must-touch"
    - button "Column 3, Row 5, Regular"
    - button "Column 4, Row 5, Must-touch"
    - button "Column 5, Row 5, Must-touch"
    - button "Column 6, Row 5, Must-touch"
    - button "Column 1, Row 6, Must-touch"
    - button "Column 2, Row 6, Must-touch"
    - button "Column 3, Row 6, Regular"
    - button "Column 4, Row 6, Must-touch"
    - button "Column 5, Row 6, Must-touch"
    - button "Column 6, Row 6, Must-touch"
    - button "Column 1, Row 7, Must-touch"
    - button "Column 2, Row 7, Must-touch"
    - button "Column 3, Row 7, Regular"
    - button "Column 4, Row 7, Regular"
    - button "Column 5, Row 7, Regular"
    - button "Column 6, Row 7, Must-touch"
    - text: "Selected tool: Regular"
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
    await page.getByRole("button", { name: "Fill Regular" }).click();
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
    - button "Column 6, Row 1, Regular"
    - button "Column 1, Row 2, Regular"
    - button "Column 2, Row 2, Regular"
    - button "Column 3, Row 2, Regular"
    - button "Column 4, Row 2, Regular"
    - button "Column 5, Row 2, Regular"
    - button "Column 6, Row 2, Regular"
    - button "Column 1, Row 3, Regular"
    - button "Column 2, Row 3, Regular"
    - button "Column 3, Row 3, Regular"
    - button "Column 4, Row 3, Regular"
    - button "Column 5, Row 3, Regular"
    - button "Column 6, Row 3, Regular"
    - button "Column 1, Row 4, Regular"
    - button "Column 2, Row 4, Regular"
    - button "Column 3, Row 4, Regular"
    - button "Column 4, Row 4, Regular"
    - button "Column 5, Row 4, Regular"
    - button "Column 6, Row 4, Regular"
    - button "Column 1, Row 5, Regular"
    - button "Column 2, Row 5, Regular"
    - button "Column 3, Row 5, Regular"
    - button "Column 4, Row 5, Regular"
    - button "Column 5, Row 5, Regular"
    - button "Column 6, Row 5, Regular"
    - button "Column 1, Row 6, Regular"
    - button "Column 2, Row 6, Regular"
    - button "Column 3, Row 6, Regular"
    - button "Column 4, Row 6, Regular"
    - button "Column 5, Row 6, Regular"
    - button "Column 6, Row 6, Regular"
    - button "Column 1, Row 7, Regular"
    - button "Column 2, Row 7, Regular"
    - button "Column 3, Row 7, Regular"
    - button "Column 4, Row 7, Regular"
    - button "Column 5, Row 7, Regular"
    - button "Column 6, Row 7, Regular"
    - text: "Selected tool: Regular"
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
    await page.getByRole("button", { name: "Goal" }).click();
    const goal1Source = page.getByRole("button", {
      name: "Column 1, Row 1, Regular",
    });
    const goal1Target = page.getByRole("button", {
      name: "Column 3, Row 3, Regular",
    });
    await goal1Source.dragTo(goal1Target);
    await expect(page.locator("#editor-card")).toMatchAriaSnapshot(`
    - heading "Rolling Blocks Setup" [level=1]
    - paragraph: Build the board layout and block definitions. Solver logic comes later.
    - text: Grid Width
    - spinbutton "Grid Width"
    - text: Grid Height
    - spinbutton "Grid Height"
    - button "Column 1, Row 1, Goal"
    - button "Column 2, Row 1, Goal"
    - button "Column 3, Row 1, Goal"
    - button "Column 4, Row 1, Regular"
    - button "Column 5, Row 1, Regular"
    - button "Column 6, Row 1, Regular"
    - button "Column 1, Row 2, Goal"
    - button "Column 2, Row 2, Goal"
    - button "Column 3, Row 2, Goal"
    - button "Column 4, Row 2, Regular"
    - button "Column 5, Row 2, Regular"
    - button "Column 6, Row 2, Regular"
    - button "Column 1, Row 3, Goal"
    - button "Column 2, Row 3, Goal"
    - button "Column 3, Row 3, Goal"
    - button "Column 4, Row 3, Regular"
    - button "Column 5, Row 3, Regular"
    - button "Column 6, Row 3, Regular"
    - button "Column 1, Row 4, Regular"
    - button "Column 2, Row 4, Regular"
    - button "Column 3, Row 4, Regular"
    - button "Column 4, Row 4, Regular"
    - button "Column 5, Row 4, Regular"
    - button "Column 6, Row 4, Regular"
    - button "Column 1, Row 5, Regular"
    - button "Column 2, Row 5, Regular"
    - button "Column 3, Row 5, Regular"
    - button "Column 4, Row 5, Regular"
    - button "Column 5, Row 5, Regular"
    - button "Column 6, Row 5, Regular"
    - button "Column 1, Row 6, Regular"
    - button "Column 2, Row 6, Regular"
    - button "Column 3, Row 6, Regular"
    - button "Column 4, Row 6, Regular"
    - button "Column 5, Row 6, Regular"
    - button "Column 6, Row 6, Regular"
    - button "Column 1, Row 7, Regular"
    - button "Column 2, Row 7, Regular"
    - button "Column 3, Row 7, Regular"
    - button "Column 4, Row 7, Regular"
    - button "Column 5, Row 7, Regular"
    - button "Column 6, Row 7, Regular"
    - text: "Selected tool: Goal"
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
    await page.getByRole("button", { name: "Unplayable" }).click();
    await page
      .getByRole("button", { name: "Column 1, Row 7, Regular" })
      .click();
    await page
      .getByRole("button", { name: "Column 4, Row 7, Regular" })
      .click();
    await page
      .getByRole("button", { name: "Column 6, Row 7, Regular" })
      .click();
    await expect(page.locator("#editor-card")).toMatchAriaSnapshot(`
    - heading "Rolling Blocks Setup" [level=1]
    - paragraph: Build the board layout and block definitions. Solver logic comes later.
    - text: Grid Width
    - spinbutton "Grid Width"
    - text: Grid Height
    - spinbutton "Grid Height"
    - button "Column 1, Row 1, Goal"
    - button "Column 2, Row 1, Goal"
    - button "Column 3, Row 1, Goal"
    - button "Column 4, Row 1, Regular"
    - button "Column 5, Row 1, Regular"
    - button "Column 6, Row 1, Regular"
    - button "Column 1, Row 2, Goal"
    - button "Column 2, Row 2, Goal"
    - button "Column 3, Row 2, Goal"
    - button "Column 4, Row 2, Regular"
    - button "Column 5, Row 2, Regular"
    - button "Column 6, Row 2, Regular"
    - button "Column 1, Row 3, Goal"
    - button "Column 2, Row 3, Goal"
    - button "Column 3, Row 3, Goal"
    - button "Column 4, Row 3, Regular"
    - button "Column 5, Row 3, Regular"
    - button "Column 6, Row 3, Regular"
    - button "Column 1, Row 4, Regular"
    - button "Column 2, Row 4, Regular"
    - button "Column 3, Row 4, Regular"
    - button "Column 4, Row 4, Regular"
    - button "Column 5, Row 4, Regular"
    - button "Column 6, Row 4, Regular"
    - button "Column 1, Row 5, Regular"
    - button "Column 2, Row 5, Regular"
    - button "Column 3, Row 5, Regular"
    - button "Column 4, Row 5, Regular"
    - button "Column 5, Row 5, Regular"
    - button "Column 6, Row 5, Regular"
    - button "Column 1, Row 6, Regular"
    - button "Column 2, Row 6, Regular"
    - button "Column 3, Row 6, Regular"
    - button "Column 4, Row 6, Regular"
    - button "Column 5, Row 6, Regular"
    - button "Column 6, Row 6, Regular"
    - button "Column 1, Row 7, Unplayable"
    - button "Column 2, Row 7, Regular"
    - button "Column 3, Row 7, Regular"
    - button "Column 4, Row 7, Unplayable"
    - button "Column 5, Row 7, Regular"
    - button "Column 6, Row 7, Unplayable"
    - text: "Selected tool: Unplayable"
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
    await page.getByRole("button", { name: "Block Footprint" }).click();
    await page
      .getByRole("button", { name: "Column 6, Row 6, Regular" })
      .click();
    const block1Source = page.getByRole("button", {
      name: "Column 4, Row 6, Regular",
    });
    const block1Target = page.getByRole("button", {
      name: "Column 3, Row 6, Regular",
    });
    await block1Source.dragTo(block1Target);
    const block2Source = page.getByRole("button", {
      name: "Column 6, Row 4, Regular",
    });
    const block2Target = page.getByRole("button", {
      name: "Column 4, Row 1, Regular",
    });
    await block2Source.dragTo(block2Target);
    await expect(page.locator("#editor-card")).toMatchAriaSnapshot(`
    - heading "Rolling Blocks Setup" [level=1]
    - paragraph: Build the board layout and block definitions. Solver logic comes later.
    - text: Grid Width
    - spinbutton "Grid Width"
    - text: Grid Height
    - spinbutton "Grid Height"
    - button "Column 1, Row 1, Goal"
    - button "Column 2, Row 1, Goal"
    - button "Column 3, Row 1, Goal"
    - button "Column 4, Row 1, Block 3"
    - button "Column 5, Row 1, Block 3"
    - button "Column 6, Row 1, Block 3"
    - button "Column 1, Row 2, Goal"
    - button "Column 2, Row 2, Goal"
    - button "Column 3, Row 2, Goal"
    - button "Column 4, Row 2, Block 3"
    - button "Column 5, Row 2, Block 3"
    - button "Column 6, Row 2, Block 3"
    - button "Column 1, Row 3, Goal"
    - button "Column 2, Row 3, Goal"
    - button "Column 3, Row 3, Goal"
    - button "Column 4, Row 3, Block 3"
    - button "Column 5, Row 3, Block 3"
    - button "Column 6, Row 3, Block 3"
    - button "Column 1, Row 4, Regular"
    - button "Column 2, Row 4, Regular"
    - button "Column 3, Row 4, Regular"
    - button "Column 4, Row 4, Block 3"
    - button "Column 5, Row 4, Block 3"
    - button "Column 6, Row 4, Block 3"
    - button "Column 1, Row 5, Regular"
    - button "Column 2, Row 5, Regular"
    - button "Column 3, Row 5, Regular"
    - button "Column 4, Row 5, Regular"
    - button "Column 5, Row 5, Regular"
    - button "Column 6, Row 5, Regular"
    - button "Column 1, Row 6, Regular"
    - button "Column 2, Row 6, Regular"
    - button "Column 3, Row 6, Block 2"
    - button "Column 4, Row 6, Block 2"
    - button "Column 5, Row 6, Regular"
    - button "Column 6, Row 6, Block 1"
    - button "Column 1, Row 7, Unplayable"
    - button "Column 2, Row 7, Regular"
    - button "Column 3, Row 7, Regular"
    - button "Column 4, Row 7, Unplayable"
    - button "Column 5, Row 7, Regular"
    - button "Column 6, Row 7, Unplayable"
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
    - text: Block 1 Footprint 1x1 Height
    - spinbutton "Height"
    - button
    - text: Block 2 Footprint 2x1 Height
    - spinbutton "Height"
    - button
    - text: Block 3 Footprint 3x4 Height
    - spinbutton "Height"
    - button
    `);
    const heightInputs = page.locator(
      "md-outlined-text-field[data-block-id] input",
    );
    await heightInputs.nth(0).click();
    await heightInputs.nth(0).press("Control+A");
    await page.keyboard.type("2");
    await page.keyboard.press("Tab");
    await heightInputs.nth(1).click();
    await heightInputs.nth(1).press("Control+A");
    await page.keyboard.type("3");
    await page.keyboard.press("Tab");
    await heightInputs.nth(2).click();
    await heightInputs.nth(2).press("Control+A");
    await page.keyboard.type("4");
    await page.keyboard.press("Tab");
    await expect(page.locator("#editor-card")).toMatchAriaSnapshot(`
    - heading "Rolling Blocks Setup" [level=1]
    - paragraph: Build the board layout and block definitions. Solver logic comes later.
    - text: Grid Width
    - spinbutton "Grid Width"
    - text: Grid Height
    - spinbutton "Grid Height"
    - button "Column 1, Row 1, Goal"
    - button "Column 2, Row 1, Goal"
    - button "Column 3, Row 1, Goal"
    - button "Column 4, Row 1, Block 3"
    - button "Column 5, Row 1, Block 3"
    - button "Column 6, Row 1, Block 3"
    - button "Column 1, Row 2, Goal"
    - button "Column 2, Row 2, Goal"
    - button "Column 3, Row 2, Goal"
    - button "Column 4, Row 2, Block 3"
    - button "Column 5, Row 2, Block 3"
    - button "Column 6, Row 2, Block 3"
    - button "Column 1, Row 3, Goal"
    - button "Column 2, Row 3, Goal"
    - button "Column 3, Row 3, Goal"
    - button "Column 4, Row 3, Block 3"
    - button "Column 5, Row 3, Block 3"
    - button "Column 6, Row 3, Block 3"
    - button "Column 1, Row 4, Regular"
    - button "Column 2, Row 4, Regular"
    - button "Column 3, Row 4, Regular"
    - button "Column 4, Row 4, Block 3"
    - button "Column 5, Row 4, Block 3"
    - button "Column 6, Row 4, Block 3"
    - button "Column 1, Row 5, Regular"
    - button "Column 2, Row 5, Regular"
    - button "Column 3, Row 5, Regular"
    - button "Column 4, Row 5, Regular"
    - button "Column 5, Row 5, Regular"
    - button "Column 6, Row 5, Regular"
    - button "Column 1, Row 6, Regular"
    - button "Column 2, Row 6, Regular"
    - button "Column 3, Row 6, Block 2"
    - button "Column 4, Row 6, Block 2"
    - button "Column 5, Row 6, Regular"
    - button "Column 6, Row 6, Block 1"
    - button "Column 1, Row 7, Unplayable"
    - button "Column 2, Row 7, Regular"
    - button "Column 3, Row 7, Regular"
    - button "Column 4, Row 7, Unplayable"
    - button "Column 5, Row 7, Regular"
    - button "Column 6, Row 7, Unplayable"
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
    - text: Block 1 Footprint 1x1 Height
    - spinbutton "Height"
    - button
    - text: Block 2 Footprint 2x1 Height
    - spinbutton "Height"
    - button
    - text: Block 3 Footprint 3x4 Height
    - spinbutton "Height"
    - button
    `);
    await page.getByRole("button", { name: "Must-Touch", exact: true }).click();
    await page.getByRole("button", { name: "Column 6, Row 6, Block" }).click();
    await page.getByText("Block 3 Footprint 3x4 Height").hover();
    const hoveredCell = page.getByRole("button", {
      name: "Column 5, Row 3, Block",
    });
    await expect(hoveredCell).toHaveClass(/block-hovered/);
    await expect(hoveredCell).toHaveCSS("filter", /brightness/);
    await page.locator("#grid").hover();
    await expect(hoveredCell).not.toHaveClass(/block-hovered/);
    await page.locator("#button").nth(4).click();
    await expect(page.locator("#editor-card")).toMatchAriaSnapshot(`
    - heading "Rolling Blocks Setup" [level=1]
    - paragraph: Build the board layout and block definitions. Solver logic comes later.
    - text: Grid Width
    - spinbutton "Grid Width"
    - text: Grid Height
    - spinbutton "Grid Height"
    - button "Column 1, Row 1, Goal"
    - button "Column 2, Row 1, Goal"
    - button "Column 3, Row 1, Goal"
    - button "Column 4, Row 1, Block 1"
    - button "Column 5, Row 1, Block 1"
    - button "Column 6, Row 1, Block 1"
    - button "Column 1, Row 2, Goal"
    - button "Column 2, Row 2, Goal"
    - button "Column 3, Row 2, Goal"
    - button "Column 4, Row 2, Block 1"
    - button "Column 5, Row 2, Block 1"
    - button "Column 6, Row 2, Block 1"
    - button "Column 1, Row 3, Goal"
    - button "Column 2, Row 3, Goal"
    - button "Column 3, Row 3, Goal"
    - button "Column 4, Row 3, Block 1"
    - button "Column 5, Row 3, Block 1"
    - button "Column 6, Row 3, Block 1"
    - button "Column 1, Row 4, Regular"
    - button "Column 2, Row 4, Regular"
    - button "Column 3, Row 4, Regular"
    - button "Column 4, Row 4, Block 1"
    - button "Column 5, Row 4, Block 1"
    - button "Column 6, Row 4, Block 1"
    - button "Column 1, Row 5, Regular"
    - button "Column 2, Row 5, Regular"
    - button "Column 3, Row 5, Regular"
    - button "Column 4, Row 5, Regular"
    - button "Column 5, Row 5, Regular"
    - button "Column 6, Row 5, Regular"
    - button "Column 1, Row 6, Regular"
    - button "Column 2, Row 6, Regular"
    - button "Column 3, Row 6, Block 2"
    - button "Column 4, Row 6, Block 2"
    - button "Column 5, Row 6, Regular"
    - button "Column 6, Row 6, Must-touch"
    - button "Column 1, Row 7, Unplayable"
    - button "Column 2, Row 7, Regular"
    - button "Column 3, Row 7, Regular"
    - button "Column 4, Row 7, Unplayable"
    - button "Column 5, Row 7, Regular"
    - button "Column 6, Row 7, Unplayable"
    - text: "Selected tool: Must-Touch"
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
    - text: Block 1 Footprint 3x4 Height
    - spinbutton "Height"
    - button
    - text: Block 2 Footprint 2x1 Height
    - spinbutton "Height"
    - button
    `);
    await page.getByRole("button", { name: "Reset" }).click();
    await page
      .locator("#reset-confirm")
      .getByRole("button", { name: "Reset" })
      .click();
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
    - button "Column 4, Row 2, Regular"
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
    - button "Column 1, Row 5, Regular"
    - button "Column 2, Row 5, Regular"
    - button "Column 3, Row 5, Regular"
    - button "Column 4, Row 5, Regular"
    - button "Column 5, Row 5, Regular"
    - text: "Selected tool: Regular"
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

  test("should show spinner on calculate click and display solution", async ({
    page,
  }) => {
    await page.goto("/rolling-blocks-solver");

    // Set grid to 9x9
    await page.getByRole("spinbutton", { name: "Grid Width" }).click();
    await page.getByRole("spinbutton", { name: "Grid Width" }).fill("9");
    await page.getByRole("spinbutton", { name: "Grid Width" }).press("Tab");
    await page.getByRole("spinbutton", { name: "Grid Height" }).fill("9");

    // Set goal cell at Column 5, Row 5 (x=4, y=4)
    await page.getByRole("button", { name: "Goal" }).click();
    await page
      .getByRole("button", { name: "Column 5, Row 5, Regular" })
      .click();

    // Place a block at Column 3, Row 7 (x=2, y=6)
    await page.getByRole("button", { name: "Block Footprint" }).click();
    await page
      .getByRole("button", { name: "Column 3, Row 7, Regular" })
      .click();

    // Set block height to 2
    const heightInput = page.locator(
      "md-outlined-text-field[data-block-id] input",
    );
    await heightInput.first().click();
    await heightInput.first().press("Control+A");
    await page.keyboard.type("2");
    await page.keyboard.press("Tab");

    // Solution panel should not be visible yet
    await expect(page.locator("#solution-panel")).toBeHidden();

    // Click Calculate Moves
    await page.getByRole("button", { name: "Calculate Moves" }).click();

    // Spinner should appear
    await expect(page.locator("#solution-panel")).toBeVisible();
    await expect(page.locator("#solution-spinner")).toBeVisible();

    // Wait for solution to appear (the WASM solver should complete)
    await expect(page.locator("#solution-moves")).toBeVisible({ timeout: 30000 });
    await expect(page.locator("#solution-spinner")).toBeHidden();

    // Should show move count in status
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
    await page.goto("/rolling-blocks-solver");

    // Set up the same simple puzzle
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

    // Click Calculate Moves twice quickly (second click should restart)
    await page.getByRole("button", { name: "Calculate Moves" }).click();
    await expect(page.locator("#solution-spinner")).toBeVisible();

    // Click again — should restart and show spinner again
    await page.getByRole("button", { name: "Calculate Moves" }).click();
    await expect(page.locator("#solution-spinner")).toBeVisible();

    // Wait for the final solution to complete
    await expect(page.locator("#solution-moves")).toBeVisible({ timeout: 30000 });
    await expect(page.locator("#solution-spinner")).toBeHidden();
    await expect(page.locator("#solution-status")).toContainText(/\d+ moves?/);
  });
});
