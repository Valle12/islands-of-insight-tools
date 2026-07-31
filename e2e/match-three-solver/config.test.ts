import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "fs";
import { maxCellValue, pageSymbols } from "./symbols";

// A small, structurally valid config in the editor's download format. Cells
// are plain indices: 0 empty, 1 blocked, 2+ a symbol.
const SAMPLE_CONFIG = {
  gridWidth: 3,
  gridHeight: 2,
  cells: [
    [2, 1],
    [0, 3],
    [3, 2],
  ],
};

function cellAt(page: Page, x: number, y: number) {
  return page.locator(`.grid-cell[data-x="${x}"][data-y="${y}"]`);
}

/** The blockade *tile* — it leads the chip row rather than the tool row. */
function blockedTool(page: Page) {
  return page.locator('#symbol-row .symbol-chip[data-tool="blocked"]');
}

// Symbols are a fixed, append-only list, so assertions key off `data-symbol`.
test.describe("Match Three Solver config", () => {
  test("uploads a config file and populates the editor", async ({ page }) => {
    await page.goto("/match-three-solver");

    await page.locator("#config-file-input").setInputFiles({
      name: "puzzle.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(SAMPLE_CONFIG)),
    });

    await expect(page.locator(".grid-cell")).toHaveCount(6);
    await expect(
      page.getByRole("spinbutton", { name: "Grid Width" }),
    ).toHaveValue("3");
    await expect(
      page.getByRole("spinbutton", { name: "Grid Height" }),
    ).toHaveValue("2");
    await expect(cellAt(page, 0, 1)).toHaveAttribute("data-kind", "blocked");
    await expect(cellAt(page, 1, 0)).toHaveAttribute("data-kind", "empty");
    const symbols = await pageSymbols(page);
    await expect(cellAt(page, 0, 0)).toHaveAttribute(
      "data-symbol",
      symbols[0]!.id,
    );
    await expect(cellAt(page, 1, 1)).toHaveAttribute(
      "data-symbol",
      symbols[1]!.id,
    );
    await expect(page.locator("#warning-banner")).toBeHidden();
  });

  test("loads a config dropped onto the page", async ({ page }) => {
    await page.goto("/match-three-solver");

    const dataTransfer = await page.evaluateHandle(json => {
      const dt = new DataTransfer();
      dt.items.add(
        new File([json], "puzzle.json", { type: "application/json" }),
      );
      return dt;
    }, JSON.stringify(SAMPLE_CONFIG));

    await page.dispatchEvent("body", "drop", { dataTransfer });

    await expect(page.locator(".grid-cell")).toHaveCount(6);
    await expect(page.locator("#drop-overlay")).toBeHidden();
  });

  test("rejects an invalid dropped file", async ({ page }) => {
    await page.goto("/match-three-solver");

    const dataTransfer = await page.evaluateHandle(() => {
      const dt = new DataTransfer();
      dt.items.add(
        new File(["this is not json"], "bad.json", {
          type: "application/json",
        }),
      );
      return dt;
    });

    await page.dispatchEvent("body", "drop", { dataTransfer });

    await expect(page.locator("#warning-banner")).toBeVisible();
    await expect(page.locator(".grid-cell")).toHaveCount(36);
  });

  test("reports why a config was rejected", async ({ page }) => {
    await page.goto("/match-three-solver");
    const max = await maxCellValue(page);

    await page.locator("#config-file-input").setInputFiles({
      name: "bad.json",
      mimeType: "application/json",
      buffer: Buffer.from(
        JSON.stringify({
          ...SAMPLE_CONFIG,
          cells: [
            [2, 1],
            [0, 99],
            [3, 2],
          ],
        }),
      ),
    });

    await expect(page.locator("#warning-banner")).toHaveText(
      `Invalid config: Cells must be integers between 0 and ${max} ` +
        "(0 empty, 1 blocked, 2+ symbols).",
    );
  });

  test("loads a real downloaded fixture", async ({ page }) => {
    await page.goto("/match-three-solver");

    const json = readFileSync(
      "test/resources/match-three-solver/matchThreeTest28.json",
      "utf8",
    );
    await page.locator("#config-file-input").setInputFiles({
      name: "matchThreeTest28.json",
      mimeType: "application/json",
      buffer: Buffer.from(json),
    });

    await expect(cellAt(page, 0, 4)).toHaveAttribute("data-kind", "blocked");
    await expect(cellAt(page, 0, 0)).toHaveAttribute("data-kind", "empty");
    await expect(page.locator("#warning-banner")).toBeHidden();
  });

  test("downloads the current configuration as JSON", async ({ page }) => {
    await page.goto("/match-three-solver");

    await blockedTool(page).click();
    await cellAt(page, 0, 0).click();
    await page.locator("#symbol-row .symbol-chip[data-symbol-index]").nth(1).click();
    await cellAt(page, 1, 1).click();

    const downloadPromise = page.waitForEvent("download");
    await page.locator("#download-config").click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("matchThreeTest.json");

    const config = JSON.parse(readFileSync(await download.path(), "utf8"));
    expect(config.gridWidth).toBe(6);
    expect(config.gridHeight).toBe(6);
    // Every cell is one number: 0 empty, 1 blocked, 2+ a symbol.
    expect(config.cells.flat().every(Number.isInteger)).toBe(true);
    expect(config.cells[0][0]).toBe(1);
    expect(config.cells[1][1]).toBe(3);
    expect(config.cells[5][5]).toBe(0);
  });

  test("round-trips a downloaded config back through upload", async ({
    page,
  }) => {
    await page.goto("/match-three-solver");

    await page.locator("#symbol-row .symbol-chip[data-symbol-index]").nth(1).click();
    await cellAt(page, 2, 3).click();
    await blockedTool(page).click();
    await cellAt(page, 4, 1).click();

    const downloadPromise = page.waitForEvent("download");
    await page.locator("#download-config").click();
    const json = readFileSync(await (await downloadPromise).path(), "utf8");

    await page.locator('#tool-row [data-tool="reset"]').click();
    await page
      .locator("#reset-confirm")
      .getByRole("button", { name: "Reset" })
      .click();

    await page.locator("#config-file-input").setInputFiles({
      name: "roundtrip.json",
      mimeType: "application/json",
      buffer: Buffer.from(json),
    });

    await expect(cellAt(page, 2, 3)).toHaveAttribute(
      "data-symbol",
      (await pageSymbols(page))[1]!.id,
    );
    await expect(cellAt(page, 4, 1)).toHaveAttribute("data-kind", "blocked");
    await expect(page.locator("#warning-banner")).toBeHidden();
  });

  test("ignores grid sizes beyond the 32 cap", async ({ page }) => {
    await page.goto("/match-three-solver");

    await page.getByRole("spinbutton", { name: "Grid Width" }).fill("33");
    // The board keeps its previous size: 6x6 = 36 cells.
    await expect(page.locator(".grid-cell")).toHaveCount(36);

    await page.getByRole("spinbutton", { name: "Grid Width" }).fill("32");
    await expect(page.locator(".grid-cell")).toHaveCount(32 * 6);
  });
});
