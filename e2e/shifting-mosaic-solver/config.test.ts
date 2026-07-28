import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "fs";
import { gotoIsolated } from "../coi";

// A small, structurally valid config in the editor's download format.
const SAMPLE_CONFIG = {
  gridWidth: 4,
  gridHeight: 3,
  shapes: [
    [{ x: 0, y: 0 }],
    [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
    ],
  ],
  initialAnchors: [
    { x: 0, y: 0 },
    { x: 1, y: 1 },
  ],
  goalIndex: 0,
  goalAnchor: { x: 3, y: 0 },
};

type Cell = { x: number; y: number };

function cellAt(page: Page, x: number, y: number) {
  return page.locator(`.grid-cell[data-x="${x}"][data-y="${y}"]`);
}

async function cellCenter(
  page: Page,
  x: number,
  y: number,
): Promise<{ cx: number; cy: number }> {
  const box = await cellAt(page, x, y).boundingBox();
  if (!box) throw new Error(`Cell at (${x}, ${y}) is not visible`);
  return { cx: box.x + box.width / 2, cy: box.y + box.height / 2 };
}

async function paintShape(page: Page, cells: Cell[]) {
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i]!;
    const { cx, cy } = await cellCenter(page, c.x, c.y);
    await page.mouse.move(cx, cy);
    if (i === 0) await page.mouse.down();
  }
  await page.mouse.up();
}

async function paintWithGap(page: Page, start: Cell, end: Cell) {
  const startCenter = await cellCenter(page, start.x, start.y);
  await page.mouse.move(startCenter.cx, startCenter.cy);
  await page.mouse.down();
  const endCenter = await cellCenter(page, end.x, end.y);
  await page.mouse.move(endCenter.cx, endCenter.cy);
  await page.mouse.up();
}

test.describe("Shifting Mosaic Solver", () => {
  test("uploads a config file and populates the editor", async ({ page }) => {
    await gotoIsolated(page);

    await page.locator("#config-file-input").setInputFiles({
      name: "puzzle.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(SAMPLE_CONFIG)),
    });

    await expect(page.locator(".grid-cell")).toHaveCount(12);
    await expect(page.locator(".block-row")).toHaveCount(2);
    await expect(page.locator(".grid-cell.goal-zone")).toHaveCount(1);
    await expect(
      page.getByRole("spinbutton", { name: "Grid Width" }),
    ).toHaveValue("4");
    await expect(
      page.getByRole("spinbutton", { name: "Grid Height" }),
    ).toHaveValue("3");
    await expect(cellAt(page, 0, 0)).toHaveAttribute(
      "data-block-type",
      "goal",
    );
    await expect(cellAt(page, 1, 1)).toHaveAttribute(
      "data-block-type",
      "obstruction",
    );
    await expect(cellAt(page, 3, 0)).toHaveClass(/goal-zone/);
    await expect(page.locator("#warning-banner")).toBeHidden();
  });

  test("loads a config dropped onto the page", async ({ page }) => {
    await gotoIsolated(page);

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
    await expect(page.locator(".grid-cell.goal-zone")).toHaveCount(1);
    await expect(page.locator("#drop-overlay")).toBeHidden();
  });

  test("solves a real fixture through the portfolio bridge", async ({
    page,
  }) => {
    await gotoIsolated(page);

    // A real (small) fixture exercises the multi-worker portfolio end to
    // end: several racing solver arms, first-win termination, progress
    // aggregation, and the step-through view on a multi-block solution.
    const json = readFileSync(
      "test/resources/shifting-mosaic-solver/shiftingMosaicTest2.json",
      "utf8",
    );
    await page.locator("#config-file-input").setInputFiles({
      name: "shiftingMosaicTest2.json",
      mimeType: "application/json",
      buffer: Buffer.from(json),
    });
    await expect(page.locator(".block-row")).toHaveCount(3);

    await page.getByRole("button", { name: "Calculate Solution" }).click();
    await expect(page.locator("#solution-view")).toBeVisible({
      timeout: 60000,
    });
    await expect(page.locator("#solution-step-counter")).toContainText(
      "Step 1",
    );
  });

  test("rejects an invalid dropped file", async ({ page }) => {
    await gotoIsolated(page);

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

  test("downloads the current configuration as JSON", async ({ page }) => {
    await gotoIsolated(page);

    // A single goal block plus its goal zone — the minimum for a download.
    await page.getByRole("button", { name: "Goal Block", exact: true }).click();
    await cellAt(page, 0, 0).click();
    await cellAt(page, 2, 0).click();
    await expect(cellAt(page, 2, 0)).toHaveClass(/goal-zone/);

    const downloadPromise = page.waitForEvent("download");
    await page.locator("#download-config").click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("shiftingMosaicTest.json");

    const path = await download.path();
    const config = JSON.parse(readFileSync(path, "utf8"));
    expect(config.gridWidth).toBe(6);
    expect(config.gridHeight).toBe(6);
    expect(config.goalIndex).toBe(0);
    expect(config.goalAnchor).toEqual({ x: 2, y: 0 });
    expect(config.shapes).toEqual([[{ x: 0, y: 0 }]]);
  });

  test("round-trips a downloaded config back through upload", async ({
    page,
  }) => {
    await gotoIsolated(page);

    await page.getByRole("button", { name: "Goal Block", exact: true }).click();
    await cellAt(page, 0, 0).click();
    await cellAt(page, 2, 0).click();

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
    await expect(cellAt(page, 0, 0)).toHaveAttribute(
      "data-block-type",
      "goal",
    );
    await expect(cellAt(page, 2, 0)).toHaveClass(/goal-zone/);
    await expect(page.locator("#warning-banner")).toBeHidden();
  });
});