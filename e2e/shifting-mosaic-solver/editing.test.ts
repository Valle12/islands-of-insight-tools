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
  test("renders default UI and allows grid resize", async ({ page }) => {
    await gotoIsolated(page);

    await expect(
      page.getByRole("heading", { name: "Shifting Mosaic Solver" }),
    ).toBeVisible();
    await expect(page.locator("#tool-status")).toHaveText(
      "Selected tool: Obstruction",
    );
    await expect(page.locator(".grid-cell")).toHaveCount(36);
    await expect(page.locator("#blocks-list")).toContainText(
      "No blocks defined yet",
    );
    await expect(
      page.getByRole("button", { name: "Obstruction", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Goal Block", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Reset" })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Calculate Solution" }),
    ).toBeVisible();
    await expect(page.locator("#upload-config")).toBeVisible();
    await expect(page.locator("#download-config")).toBeVisible();
    await expect(page.locator("#placement-banner")).toBeHidden();
    await expect(page.locator("#warning-banner")).toBeHidden();
    await expect(page.locator("#solution-panel")).toBeHidden();

    await page.getByRole("spinbutton", { name: "Grid Width" }).click();
    await page.getByRole("spinbutton", { name: "Grid Width" }).fill("8");
    await page.getByRole("spinbutton", { name: "Grid Width" }).press("Tab");
    await page.getByRole("spinbutton", { name: "Grid Height" }).fill("4");
    await expect(page.locator(".grid-cell")).toHaveCount(32);
  });

  test("renders a large grid without overlapping cells", async ({ page }) => {
    await gotoIsolated(page);

    await page.getByRole("spinbutton", { name: "Grid Width" }).fill("43");
    await page.getByRole("spinbutton", { name: "Grid Width" }).press("Tab");
    await page.getByRole("spinbutton", { name: "Grid Height" }).fill("16");
    await page.getByRole("spinbutton", { name: "Grid Height" }).press("Tab");
    await expect(page.locator(".grid-cell")).toHaveCount(43 * 16);

    const box = async (x: number, y: number) => {
      const b = await cellAt(page, x, y).boundingBox();
      if (!b) throw new Error(`cell (${x}, ${y}) is not visible`);
      return b;
    };
    const c00 = await box(0, 0);
    const c10 = await box(1, 0);
    const c01 = await box(0, 1);
    const cFar = await box(42, 15);

    // Neighboring cells never overlap — each starts at/after the previous
    // one ends (this is exactly what broke with fixed-width cells).
    expect(c10.x).toBeGreaterThanOrEqual(c00.x + c00.width - 0.5);
    expect(c01.y).toBeGreaterThanOrEqual(c00.y + c00.height - 0.5);

    // Cells stay square and large enough to interact with.
    expect(c00.width).toBeGreaterThan(8);
    expect(Math.abs(c00.width - c00.height)).toBeLessThan(2);

    // The whole grid is laid out — the far corner is past the start cell.
    expect(cFar.x).toBeGreaterThan(c00.x);
    expect(cFar.y).toBeGreaterThan(c00.y);

    // The card widened past the default 960px to use more screen space.
    const card = await page.locator("#editor-card").boundingBox();
    expect(card!.width).toBeGreaterThan(960);

    // The grid scales to fit — no horizontal page overflow.
    const noHorizontalScroll = await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth + 1,
    );
    expect(noHorizontalScroll).toBe(true);

    // Still interactive at this size.
    await cellAt(page, 5, 5).click();
    await expect(page.locator(".block-row")).toHaveCount(1);
  });

  test("switches between Obstruction and Goal Block tools", async ({
    page,
  }) => {
    await gotoIsolated(page);
    await expect(page.locator("#tool-status")).toContainText("Obstruction");
    await page.getByRole("button", { name: "Goal Block", exact: true }).click();
    await expect(page.locator("#tool-status")).toContainText("Goal Block");
    await page.getByRole("button", { name: "Obstruction", exact: true }).click();
    await expect(page.locator("#tool-status")).toContainText("Obstruction");
  });

  test("creates a single-cell obstruction block via click", async ({
    page,
  }) => {
    await gotoIsolated(page);
    await cellAt(page, 1, 1).click();
    await expect(page.locator(".block-row")).toHaveCount(1);
    await expect(page.locator(".block-chip-obstruction")).toContainText(
      "Obs 1",
    );
    await expect(cellAt(page, 1, 1)).toHaveAttribute(
      "data-block-type",
      "obstruction",
    );
    await expect(cellAt(page, 1, 1)).toHaveAttribute("data-block-id", "1");
  });

  test("creates a multi-cell obstruction block via freeform drag", async ({
    page,
  }) => {
    await gotoIsolated(page);
    await paintShape(page, [
      { x: 1, y: 1 },
      { x: 2, y: 1 },
      { x: 3, y: 1 },
      { x: 3, y: 2 },
    ]);
    await expect(page.locator(".block-row")).toHaveCount(1);
    for (const c of [
      { x: 1, y: 1 },
      { x: 2, y: 1 },
      { x: 3, y: 1 },
      { x: 3, y: 2 },
    ]) {
      await expect(cellAt(page, c.x, c.y)).toHaveAttribute(
        "data-block-type",
        "obstruction",
      );
      await expect(cellAt(page, c.x, c.y)).toHaveAttribute(
        "data-block-id",
        "1",
      );
    }
    await expect(cellAt(page, 0, 0)).not.toHaveAttribute(
      "data-block-id",
      /.*/,
    );
  });

  test("draws goal block, places goal zone, locks Goal tool", async ({
    page,
  }) => {
    await gotoIsolated(page);
    await page.getByRole("button", { name: "Goal Block", exact: true }).click();
    await paintShape(page, [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
    ]);

    await expect(page.locator(".block-chip-goal")).toContainText("Goal 1");
    await expect(page.locator("#placement-banner")).toBeVisible();
    await expect(page.locator("#tool-status")).toContainText(
      "Place the goal zone",
    );

    // All tool buttons disabled while placing
    await expect(
      page.getByRole("button", { name: "Obstruction", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Goal Block", exact: true }),
    ).toBeDisabled();
    await expect(page.getByRole("button", { name: "Reset" })).toBeDisabled();

    // Hovering shows the hologram
    await cellAt(page, 3, 3).hover();
    await expect(page.locator(".grid-cell.hologram")).toHaveCount(2);
    await expect(cellAt(page, 3, 3)).toHaveClass(/hologram/);
    await expect(cellAt(page, 4, 3)).toHaveClass(/hologram/);

    // Click commits the goal zone
    await cellAt(page, 3, 3).click();
    await expect(page.locator("#placement-banner")).toBeHidden();
    await expect(page.locator(".grid-cell.goal-zone")).toHaveCount(2);
    await expect(cellAt(page, 3, 3)).toHaveClass(/goal-zone/);
    await expect(cellAt(page, 4, 3)).toHaveClass(/goal-zone/);

    // Goal tool button stays disabled while a goal block exists
    await expect(
      page.getByRole("button", { name: "Goal Block", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Obstruction", exact: true }),
    ).not.toBeDisabled();
  });

});