import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "fs";
import { gotoIsolated, MATCH_THREE_URL } from "../coi";
import { pageSymbols } from "./symbols";

/** Loads a fixture through the page's own file input. */
async function loadFixture(page: Page, name: string) {
  await gotoIsolated(page, MATCH_THREE_URL);
  const json = readFileSync(
    `test/resources/match-three-solver/${name}`,
    "utf8",
  );
  await page.locator("#config-file-input").setInputFiles({
    name,
    mimeType: "application/json",
    buffer: Buffer.from(json),
  });
  await expect(page.locator("#warning-banner")).toBeHidden();
}

function solutionCell(page: Page, x: number, y: number) {
  return page.locator(
    `#solution-grid .grid-cell[data-x="${x}"][data-y="${y}"]`,
  );
}

// Both grids carry `.grid-cell`s with the same coordinates, so every editor
// selector here has to say which grid it means.
function editorCell(page: Page, x: number, y: number) {
  return page.locator(`#grid .grid-cell[data-x="${x}"][data-y="${y}"]`);
}

/** The blockade *tile* — it leads the chip row rather than the tool row. */
function blockedTool(page: Page) {
  return page.locator('#symbol-row .symbol-chip[data-tool="blocked"]');
}

/**
 * Every captured fixture is solvable — that is the point of the corpus — so an
 * unsolvable board has to be built here. Two symbols with two cells each can
 * never line up three.
 */
const UNSOLVABLE = {
  gridWidth: 2,
  gridHeight: 2,
  cells: [
    [2, 3],
    [3, 2],
  ],
};

// Symbols are a fixed, append-only list, so assertions key off `data-symbol`
// and the chip row's own labels rather than anything rendered.
test.describe("Match Three Solver solving", () => {
  test("walks a solved fixture step by step", async ({ page }) => {
    await loadFixture(page, "matchThreeTest28.json");

    await page.getByRole("button", { name: "Solve Puzzle" }).click();

    const view = page.locator("#solution-view");
    await expect(view).toBeVisible({ timeout: 60_000 });
    await expect(page.locator("#editor-section")).toBeHidden();
    // A proven answer carries no budget note.
    await expect(page.locator("#solution-proven-note")).toBeHidden();
    await expect(page.locator("#solution-step-counter")).toHaveText(
      "Step 1 of 5",
    );

    // The pair to exchange, and nothing else marked.
    await expect(page.locator("#solution-grid [data-swap]")).toHaveCount(2);
    await expect(page.locator("#solution-grid [data-swap='a']")).toHaveCount(1);
    await expect(page.locator("#solution-grid [data-swap='b']")).toHaveCount(1);

    await expect(page.locator("#solution-step-text")).toContainText("Swap");

    await page.getByRole("button", { name: "Next" }).click();
    await expect(page.locator("#solution-step-counter")).toHaveText(
      "Step 2 of 5",
    );

    await page.getByRole("button", { name: "Previous" }).click();
    await expect(page.locator("#solution-step-counter")).toHaveText(
      "Step 1 of 5",
    );

    for (let i = 0; i < 5; i++) {
      await page.getByRole("button", { name: "Next" }).click();
    }

    await expect(page.locator("#solution-step-counter")).toHaveText(
      "Solved in 5 moves",
    );
    await expect(page.locator("#solution-step-text")).toContainText(
      "board is clear",
    );
    // No blocks are left once every move has been played.
    await expect(
      page.locator("#solution-grid .grid-cell[data-kind='symbol']"),
    ).toHaveCount(0);
  });

  test("the last step leaves Next dead and Previous live", async ({ page }) => {
    await loadFixture(page, "matchThreeTest28.json");
    await page.getByRole("button", { name: "Solve Puzzle" }).click();
    await expect(page.locator("#solution-view")).toBeVisible({
      timeout: 60_000,
    });

    await expect(page.getByRole("button", { name: "Previous" })).toBeDisabled();
    for (let i = 0; i < 5; i++) {
      await page.getByRole("button", { name: "Next" }).click();
    }
    await expect(page.getByRole("button", { name: "Next" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Previous" })).toBeEnabled();
  });

  test("Back to editor returns the board unchanged", async ({ page }) => {
    await loadFixture(page, "matchThreeTest28.json");
    await page.getByRole("button", { name: "Solve Puzzle" }).click();
    await expect(page.locator("#solution-view")).toBeVisible({
      timeout: 60_000,
    });

    await page.getByRole("button", { name: "Back to editor" }).click();

    await expect(page.locator("#solution-view")).toBeHidden();
    await expect(page.locator("#editor-section")).toBeVisible();
    await expect(editorCell(page, 0, 4)).toHaveAttribute(
      "data-kind",
      "blocked",
    );
  });

  test("says so when a board cannot be cleared", async ({ page }) => {
    await gotoIsolated(page, MATCH_THREE_URL);
    await page.locator("#config-file-input").setInputFiles({
      name: "unsolvable.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(UNSOLVABLE)),
    });

    await page.getByRole("button", { name: "Solve Puzzle" }).click();

    await expect(page.locator("#solution-status")).toHaveText("No solution", {
      timeout: 60_000,
    });
    await expect(page.locator("#solution-message")).toContainText(
      "cannot be cleared",
    );
    await expect(page.locator("#solution-view")).toBeHidden();
  });

  test("refuses a board that has not settled", async ({ page }) => {
    await gotoIsolated(page, MATCH_THREE_URL);

    // A block painted anywhere but the bottom row is left hanging in mid-air.
    await editorCell(page, 0, 0).click();
    await page.getByRole("button", { name: "Solve Puzzle" }).click();

    await expect(page.locator("#warning-banner")).toContainText(
      "Column 1, Row 1 floats above an empty cell",
    );
    await expect(page.locator("#solution-view")).toBeHidden();
    await expect(page.locator("#solution-panel")).toBeHidden();
  });

  test("refuses a board that still has a line of three", async ({ page }) => {
    await gotoIsolated(page, MATCH_THREE_URL);

    for (const x of [0, 1, 2]) {
      await editorCell(page, x, 5).click();
    }
    await page.getByRole("button", { name: "Solve Puzzle" }).click();

    await expect(page.locator("#warning-banner")).toContainText(
      "is already part of a line of three",
    );
    await expect(page.locator("#solution-view")).toBeHidden();
  });

  test("an empty board needs no moves", async ({ page }) => {
    await gotoIsolated(page, MATCH_THREE_URL);

    await page.getByRole("button", { name: "Solve Puzzle" }).click();

    await expect(page.locator("#solution-status")).toHaveText(
      "Already solved",
      { timeout: 60_000 },
    );
    await expect(page.locator("#solution-view")).toBeHidden();
  });

  test("the solution grid labels cells by symbol name", async ({ page }) => {
    await loadFixture(page, "matchThreeTest28.json");
    const labels = (await pageSymbols(page)).map(symbol => symbol.label);
    await page.getByRole("button", { name: "Solve Puzzle" }).click();
    await expect(page.locator("#solution-view")).toBeVisible({
      timeout: 60_000,
    });

    await expect(solutionCell(page, 0, 4)).toHaveAttribute(
      "aria-label",
      "Column 1, Row 5, Blocked",
    );
    await expect(solutionCell(page, 2, 0)).toHaveAttribute(
      "aria-label",
      new RegExp(`^Column 3, Row 1, (${labels.join("|")})$`),
    );
  });

  test("editing the board drops the solution", async ({ page }) => {
    await gotoIsolated(page, MATCH_THREE_URL);
    await page.locator("#config-file-input").setInputFiles({
      name: "unsolvable.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(UNSOLVABLE)),
    });
    await page.getByRole("button", { name: "Solve Puzzle" }).click();
    await expect(page.locator("#solution-status")).toHaveText("No solution", {
      timeout: 60_000,
    });

    await blockedTool(page).click();
    await editorCell(page, 0, 0).click();

    await expect(page.locator("#solution-panel")).toBeHidden();
  });
});
