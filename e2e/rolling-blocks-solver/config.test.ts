import { expect, test, type Page } from "@playwright/test";
import { gotoIsolated } from "../coi";
import { readFileSync } from "fs";

// A small, structurally valid config in the editor's download format.
const SAMPLE_CONFIG = {
  gridWidth: 4,
  gridHeight: 3,
  cells: [
    ["regular", "regular", "regular"],
    ["mustTouch", "regular", "goal"],
    ["regular", "unplayable", "goal"],
    ["regular", "regular", "regular"],
  ],
  blocks: [
    { id: 1, x: 0, y: 0, width: 1, depth: 1, height: 2 },
    { id: 2, x: 3, y: 1, width: 1, depth: 2, height: 1 },
  ],
};

function cellAt(page: Page, x: number, y: number) {
  return page.locator(`.grid-cell[data-x="${x}"][data-y="${y}"]`);
}

test.describe("Rolling Blocks Solver config", () => {
  test("uploads a config file and populates the editor", async ({ page }) => {
    await gotoIsolated(page, "/rolling-blocks-solver");

    await page.locator("#config-file-input").setInputFiles({
      name: "puzzle.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(SAMPLE_CONFIG)),
    });

    await expect(page.locator(".grid-cell")).toHaveCount(12);
    await expect(page.locator(".block-row")).toHaveCount(2);
    await expect(
      page.getByRole("spinbutton", { name: "Grid Width" }),
    ).toHaveValue("4");
    await expect(
      page.getByRole("spinbutton", { name: "Grid Height" }),
    ).toHaveValue("3");
    await expect(cellAt(page, 1, 0)).toHaveAttribute("data-kind", "mustTouch");
    await expect(cellAt(page, 2, 1)).toHaveAttribute("data-kind", "unplayable");
    await expect(cellAt(page, 1, 2)).toHaveAttribute("data-kind", "goal");
    await expect(cellAt(page, 0, 0)).toHaveAttribute("data-kind", "block");
    await expect(cellAt(page, 3, 1)).toHaveAttribute("data-kind", "block");
    await expect(page.locator("#warning-banner")).toBeHidden();
  });

  test("loads a config dropped onto the page", async ({ page }) => {
    await gotoIsolated(page, "/rolling-blocks-solver");

    const dataTransfer = await page.evaluateHandle(json => {
      const dt = new DataTransfer();
      dt.items.add(
        new File([json], "puzzle.json", { type: "application/json" }),
      );
      return dt;
    }, JSON.stringify(SAMPLE_CONFIG));

    await page.dispatchEvent("body", "drop", { dataTransfer });

    await expect(page.locator(".grid-cell")).toHaveCount(12);
    await expect(page.locator(".block-row")).toHaveCount(2);
    await expect(page.locator("#drop-overlay")).toBeHidden();
  });

  test("rejects an invalid dropped file", async ({ page }) => {
    await gotoIsolated(page, "/rolling-blocks-solver");

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
    await expect(page.locator(".block-row")).toHaveCount(0);
  });

  test("solves a real fixture loaded through upload", async ({ page }) => {
    await gotoIsolated(page, "/rolling-blocks-solver");

    const json = readFileSync(
      "test/resources/rolling-blocks-solver/rollingBlocksTest9.json",
      "utf8",
    );
    await page.locator("#config-file-input").setInputFiles({
      name: "rollingBlocksTest9.json",
      mimeType: "application/json",
      buffer: Buffer.from(json),
    });
    await expect(page.locator(".block-row")).toHaveCount(2);

    await page.getByRole("button", { name: "Calculate Moves" }).click();
    await expect(page.locator("#solution-moves")).toBeVisible({
      timeout: 30000,
    });
    await expect(page.locator("#solution-status")).toHaveText(/\d+ moves?/);
  });

  test("downloads the current configuration as JSON", async ({ page }) => {
    await gotoIsolated(page, "/rolling-blocks-solver");

    // Paint one must-touch cell and place one 2x1 block.
    await page.getByRole("button", { name: "Must-Touch", exact: true }).click();
    await cellAt(page, 0, 0).click();
    await page.getByRole("button", { name: "Block Footprint" }).click();
    const from = await cellAt(page, 2, 2).boundingBox();
    const to = await cellAt(page, 3, 2).boundingBox();
    if (!from || !to) throw new Error("grid cells not visible");
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2);
    await page.mouse.up();
    await expect(page.locator(".block-row")).toHaveCount(1);

    const downloadPromise = page.waitForEvent("download");
    await page.locator("#download-config").click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("rollingBlocksTest.json");

    const path = await download.path();
    const config = JSON.parse(readFileSync(path, "utf8"));
    expect(config.gridWidth).toBe(5);
    expect(config.gridHeight).toBe(5);
    expect(config.cells[0][0]).toBe("mustTouch");
    expect(config.blocks).toEqual([
      { id: 1, x: 2, y: 2, width: 2, depth: 1, height: 1 },
    ]);
  });

  test("round-trips a downloaded config back through upload", async ({
    page,
  }) => {
    await gotoIsolated(page, "/rolling-blocks-solver");

    await page.getByRole("button", { name: "Must-Touch", exact: true }).click();
    await cellAt(page, 0, 0).click();
    await page.getByRole("button", { name: "Block Footprint" }).click();
    await cellAt(page, 2, 2).click();
    await expect(page.locator(".block-row")).toHaveCount(1);

    const downloadPromise = page.waitForEvent("download");
    await page.locator("#download-config").click();
    const download = await downloadPromise;
    const path = await download.path();
    const json = readFileSync(path, "utf8");

    // Reset, then re-upload the downloaded file.
    await page.getByRole("button", { name: "Reset" }).click();
    await page
      .locator("#reset-confirm")
      .getByRole("button", { name: "Reset" })
      .click();
    await expect(page.locator(".block-row")).toHaveCount(0);

    await page.locator("#config-file-input").setInputFiles({
      name: "roundtrip.json",
      mimeType: "application/json",
      buffer: Buffer.from(json),
    });

    await expect(page.locator(".block-row")).toHaveCount(1);
    await expect(cellAt(page, 0, 0)).toHaveAttribute("data-kind", "mustTouch");
    await expect(cellAt(page, 2, 2)).toHaveAttribute("data-kind", "block");
    await expect(page.locator("#warning-banner")).toBeHidden();
  });

  test("ignores grid sizes beyond the 64 cap", async ({ page }) => {
    await gotoIsolated(page, "/rolling-blocks-solver");

    await page.getByRole("spinbutton", { name: "Grid Width" }).fill("65");
    // The board keeps its previous size: 5x5 = 25 cells.
    await expect(page.locator(".grid-cell")).toHaveCount(25);

    await page.getByRole("spinbutton", { name: "Grid Width" }).fill("64");
    await expect(page.locator(".grid-cell")).toHaveCount(64 * 5);
  });
});
