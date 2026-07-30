import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "fs";

// A small, structurally valid config in the editor's download format. Cells
// are plain indices: 0 empty, 1 blocked, 2+ a palette slot.
const SAMPLE_CONFIG = {
  gridWidth: 3,
  gridHeight: 2,
  colors: ["teal", "gold"],
  cells: [
    [2, 1],
    [0, 3],
    [3, 2],
  ],
};

function cellAt(page: Page, x: number, y: number) {
  return page.locator(`.grid-cell[data-x="${x}"][data-y="${y}"]`);
}

// The palette is handed out at random, so nothing here may assert a color
// name — only the slot index the editor paints with.
test.describe("Match Three Solver config", () => {
  test("uploads a config file and populates the editor", async ({ page }) => {
    await page.goto("/match-three-solver");

    await page.locator("#config-file-input").setInputFiles({
      name: "puzzle.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(SAMPLE_CONFIG)),
    });

    await expect(page.locator(".grid-cell")).toHaveCount(6);
    await expect(page.locator("#color-row .color-chip")).toHaveCount(2);
    await expect(
      page.getByRole("spinbutton", { name: "Grid Width" }),
    ).toHaveValue("3");
    await expect(
      page.getByRole("spinbutton", { name: "Grid Height" }),
    ).toHaveValue("2");
    await expect(cellAt(page, 0, 1)).toHaveAttribute("data-kind", "blocked");
    await expect(cellAt(page, 1, 0)).toHaveAttribute("data-kind", "empty");
    await expect(cellAt(page, 0, 0)).toHaveAttribute("data-color-index", "0");
    await expect(cellAt(page, 1, 1)).toHaveAttribute("data-color-index", "1");
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

    await page.locator("#config-file-input").setInputFiles({
      name: "bad.json",
      mimeType: "application/json",
      buffer: Buffer.from(
        JSON.stringify({ ...SAMPLE_CONFIG, colors: ["teal", "teal"] }),
      ),
    });

    await expect(page.locator("#warning-banner")).toHaveText(
      "Invalid config: colors must not repeat a color.",
    );
  });

  test("loads a real downloaded fixture", async ({ page }) => {
    await page.goto("/match-three-solver");

    const json = readFileSync(
      "test/resources/match-three-solver/matchThreeTest1.json",
      "utf8",
    );
    await page.locator("#config-file-input").setInputFiles({
      name: "matchThreeTest1.json",
      mimeType: "application/json",
      buffer: Buffer.from(json),
    });

    await expect(page.locator("#color-row .color-chip")).toHaveCount(3);
    await expect(cellAt(page, 2, 3)).toHaveAttribute("data-kind", "blocked");
    await expect(cellAt(page, 0, 0)).toHaveAttribute("data-kind", "empty");
    await expect(page.locator("#warning-banner")).toBeHidden();
  });

  test("downloads the current configuration as JSON", async ({ page }) => {
    await page.goto("/match-three-solver");

    await page.getByRole("button", { name: "Blocked" }).click();
    await cellAt(page, 0, 0).click();
    await page.getByRole("button", { name: "Add Color" }).click();
    await cellAt(page, 1, 1).click();

    const downloadPromise = page.waitForEvent("download");
    await page.locator("#download-config").click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("matchThreeTest.json");

    const config = JSON.parse(readFileSync(await download.path(), "utf8"));
    expect(config.gridWidth).toBe(6);
    expect(config.gridHeight).toBe(6);
    expect(config.colors).toHaveLength(2);
    // Every cell is one number: 0 empty, 1 blocked, 2+ a palette slot.
    expect(config.cells.flat().every(Number.isInteger)).toBe(true);
    expect(config.cells[0][0]).toBe(1);
    expect(config.cells[1][1]).toBe(3);
    expect(config.cells[5][5]).toBe(0);
  });

  test("round-trips a downloaded config back through upload", async ({
    page,
  }) => {
    await page.goto("/match-three-solver");

    await page.getByRole("button", { name: "Add Color" }).click();
    await cellAt(page, 2, 3).click();
    await page.getByRole("button", { name: "Blocked" }).click();
    await cellAt(page, 4, 1).click();

    const downloadPromise = page.waitForEvent("download");
    await page.locator("#download-config").click();
    const json = readFileSync(await (await downloadPromise).path(), "utf8");

    await page.locator('#tool-row .tool-button[data-tool="reset"]').click();
    await page
      .locator("#reset-confirm")
      .getByRole("button", { name: "Reset" })
      .click();
    await expect(page.locator("#color-row .color-chip")).toHaveCount(1);

    await page.locator("#config-file-input").setInputFiles({
      name: "roundtrip.json",
      mimeType: "application/json",
      buffer: Buffer.from(json),
    });

    await expect(page.locator("#color-row .color-chip")).toHaveCount(2);
    await expect(cellAt(page, 2, 3)).toHaveAttribute("data-color-index", "1");
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
