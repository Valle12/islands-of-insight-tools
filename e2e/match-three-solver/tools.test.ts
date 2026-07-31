import { expect, test, type Page } from "@playwright/test";
import { pageSymbols } from "./symbols";

// Scoped to #grid: the solution view has a second grid of `.grid-cell`s with
// the same coordinates on it, so an unscoped selector is ambiguous.
function cellAt(page: Page, x: number, y: number) {
  return page.locator(`#grid .grid-cell[data-x="${x}"][data-y="${y}"]`);
}

function chips(page: Page) {
  return page.locator("#symbol-row .symbol-chip[data-symbol-index]");
}

/** The blockade *tile* — it leads the chip row rather than the tool row. */
function blockedTool(page: Page) {
  return page.locator('#symbol-row .symbol-chip[data-tool="blocked"]');
}

/**
 * The Reset *tool*. Once the confirmation dialog has been opened, its own
 * "Reset" button is matchable too, so this must stay scoped to the tool row.
 */
function resetTool(page: Page) {
  return page.locator('#tool-row .tool-button[data-tool="reset"]');
}

// Symbols are a fixed, append-only list. Assertions key off `data-symbol` and
// the chip row's own contents, so appending a symbol needs no edit here.
test.describe("Match Three Solver tools", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/match-three-solver");
  });

  test("opens on an empty board offering every symbol", async ({ page }) => {
    const symbols = await pageSymbols(page);

    // #grid-scoped: #solution-grid reuses .grid-cell with the same attributes.
    await expect(page.locator("#grid .grid-cell")).toHaveCount(36);
    await expect(
      page.locator('#grid .grid-cell[data-kind="empty"]'),
    ).toHaveCount(36);
    expect(symbols.length).toBeGreaterThan(1);
    // The status names the kind of tool; the selected chip shows which tile.
    await expect(page.locator("#tool-status")).toHaveText(
      "Selected tool: Color",
    );
    await expect(chips(page).first()).toHaveClass(/selected/);
    await expect(page.locator("#solution-panel")).toBeHidden();
  });

  test("paints with the selected symbol", async ({ page }) => {
    const first = (await pageSymbols(page))[0]!;

    await cellAt(page, 1, 1).click();
    await expect(cellAt(page, 1, 1)).toHaveAttribute("data-kind", "symbol");
    await expect(cellAt(page, 1, 1)).toHaveAttribute("data-symbol", first.id);
    await expect(cellAt(page, 1, 1)).toHaveAccessibleName(
      `Column 2, Row 2, ${first.label}`,
    );
  });

  test("paints obstacles and erases them again", async ({ page }) => {
    await blockedTool(page).click();
    await expect(page.locator("#tool-status")).toHaveText(
      "Selected tool: Blocked",
    );
    await cellAt(page, 0, 0).click();
    await expect(cellAt(page, 0, 0)).toHaveAttribute("data-kind", "blocked");

    await page.locator('#tool-row [data-tool="empty"]').click();
    await expect(page.locator("#tool-status")).toHaveText(
      "Selected tool: Eraser",
    );
    await cellAt(page, 0, 0).click();
    await expect(cellAt(page, 0, 0)).toHaveAttribute("data-kind", "empty");
  });

  test("drags paint across a row", async ({ page }) => {
    await blockedTool(page).click();
    const from = await cellAt(page, 0, 5).boundingBox();
    const to = await cellAt(page, 3, 5).boundingBox();
    if (!from || !to) throw new Error("grid cells not visible");

    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, {
      steps: 12,
    });
    await page.mouse.up();

    await expect(
      page.locator('#grid .grid-cell[data-kind="blocked"]'),
    ).toHaveCount(4);
  });

  test("switches between symbols from the chip row", async ({ page }) => {
    const [first, second] = await pageSymbols(page);

    await cellAt(page, 0, 0).click();

    await chips(page).nth(1).click();
    await expect(chips(page).nth(1)).toHaveClass(/selected/);
    await expect(chips(page).first()).not.toHaveClass(/selected/);
    await cellAt(page, 1, 0).click();
    await expect(cellAt(page, 1, 0)).toHaveAttribute("data-symbol", second!.id);

    // Going back to the first symbol is the whole point of the chip row.
    await chips(page).first().click();
    await expect(chips(page).first()).toHaveClass(/selected/);
    await cellAt(page, 2, 0).click();
    await expect(cellAt(page, 2, 0)).toHaveAttribute("data-symbol", first!.id);
    await expect(cellAt(page, 0, 0)).toHaveAttribute("data-symbol", first!.id);
  });

  // That two symbols render as two *different* images is checked in
  // test/match-three-solver/board.test.ts. It cannot be checked here without
  // reading artwork back off the page, which this suite does not do.

  // A resize means a different puzzle, so the cells go with it. The symbols
  // are the game's own fixed set and stay put.
  test("resizing clears the board but keeps the symbols", async ({ page }) => {
    const before = await pageSymbols(page);
    await cellAt(page, 0, 0).click();

    await page.getByRole("spinbutton", { name: "Grid Width" }).fill("4");
    await page.getByRole("spinbutton", { name: "Grid Height" }).fill("3");

    await expect(page.locator("#grid .grid-cell")).toHaveCount(12);
    await expect(chips(page)).toHaveCount(before.length);
    await expect(cellAt(page, 0, 0)).toHaveAttribute("data-kind", "empty");
  });

  test("reset clears the board and the size", async ({ page }) => {
    await page.getByRole("spinbutton", { name: "Grid Width" }).fill("4");
    await chips(page).nth(1).click();
    await cellAt(page, 0, 0).click();

    await resetTool(page).click();
    await page
      .locator("#reset-cancel")
      .getByRole("button", { name: "Cancel" })
      .click();
    await expect(cellAt(page, 0, 0)).toHaveAttribute("data-kind", "symbol");

    await resetTool(page).click();
    await page
      .locator("#reset-confirm")
      .getByRole("button", { name: "Reset" })
      .click();

    await expect(page.locator("#grid .grid-cell")).toHaveCount(36);
    await expect(
      page.locator('#grid .grid-cell[data-kind="empty"]'),
    ).toHaveCount(36);
    await expect(page.getByRole("spinbutton", { name: "Grid Width" })).toHaveValue(
      "6",
    );
  });

  test("the blockade leads the chip row without taking a symbol index", async ({
    page,
  }) => {
    const blockade = blockedTool(page);
    await expect(blockade).toHaveCount(1);
    await expect(blockade).not.toHaveAttribute("data-symbol-index", /.*/);
    // First in the row, ahead of every symbol.
    await expect(
      page.locator("#symbol-row .symbol-chip").first(),
    ).toHaveAttribute("data-tool", "blocked");

    await blockade.click();
    await cellAt(page, 0, 0).click();
    await expect(cellAt(page, 0, 0)).toHaveAttribute("data-kind", "blocked");
    await expect(cellAt(page, 0, 0)).toHaveAccessibleName(
      "Column 1, Row 1, Blocked",
    );
  });

  test("matches the editor layout", async ({ page }) => {
    await page.getByRole("spinbutton", { name: "Grid Width" }).fill("2");
    await page.getByRole("spinbutton", { name: "Grid Height" }).fill("2");
    await blockedTool(page).click();
    await cellAt(page, 0, 0).click();

    await expect(page.locator("#editor-card")).toMatchAriaSnapshot(`
      - heading "Match Three Setup" [level=1]
      - paragraph: Paint the board with obstacles and blocks, then solve it.
      - text: Grid Width
      - spinbutton "Grid Width"
      - text: Grid Height
      - spinbutton "Grid Height"
      - button "Column 1, Row 1, Blocked"
      - button "Column 2, Row 1, Empty"
      - button "Column 1, Row 2, Empty"
      - button "Column 2, Row 2, Empty"
      - text: "Selected tool: Blocked"
      - button "Eraser"
      - button "Reset"
      - button "Blocked"
      - button "Blue"
      - button "Cyan"
      - button "Purple"
      - button "Nude"
      - button "Ocher"
      - button "Pink"
      - button "Purple 2"
      - button "Teal"
      - button "Solve Puzzle"
      - button "Load config from disk"
      - button "Download config"
    `);
  });
});
