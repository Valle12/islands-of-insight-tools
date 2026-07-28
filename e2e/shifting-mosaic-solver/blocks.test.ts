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
  test("hologram shows invalid styling when out of bounds and refuses to place", async ({
    page,
  }) => {
    await gotoIsolated(page);
    await page.getByRole("button", { name: "Goal Block", exact: true }).click();
    await paintShape(page, [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
    ]);

    // Cursor at column 6 (x=5) on a 6-wide grid → second hologram cell would be at x=6 (out of bounds)
    await cellAt(page, 5, 0).hover();
    await expect(cellAt(page, 5, 0)).toHaveClass(/hologram-invalid/);

    await cellAt(page, 5, 0).click();
    // Still in placement mode — no goal zone placed
    await expect(page.locator("#placement-banner")).toBeVisible();
    await expect(page.locator(".grid-cell.goal-zone")).toHaveCount(0);
  });

  test("re-places goal zone via the list button", async ({ page }) => {
    await gotoIsolated(page);
    await page.getByRole("button", { name: "Goal Block", exact: true }).click();
    await cellAt(page, 0, 0).click();
    await cellAt(page, 3, 3).click();
    await expect(cellAt(page, 3, 3)).toHaveClass(/goal-zone/);

    await page.locator("md-icon-button[data-block-place-id]").click();
    await expect(page.locator("#placement-banner")).toBeVisible();
    await expect(page.locator(".grid-cell.goal-zone")).toHaveCount(0);

    await cellAt(page, 4, 4).click();
    await expect(page.locator("#placement-banner")).toBeHidden();
    await expect(cellAt(page, 4, 4)).toHaveClass(/goal-zone/);
    await expect(cellAt(page, 3, 3)).not.toHaveClass(/goal-zone/);
  });

  test("deletes an obstruction block and clears its cells", async ({
    page,
  }) => {
    await gotoIsolated(page);
    await paintShape(page, [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
    ]);
    await expect(page.locator(".block-row")).toHaveCount(1);

    await page.locator("md-icon-button[data-block-delete-id]").click();
    await expect(page.locator(".block-row")).toHaveCount(0);
    await expect(cellAt(page, 0, 0)).not.toHaveAttribute(
      "data-block-id",
      /.*/,
    );
    await expect(cellAt(page, 1, 0)).not.toHaveAttribute(
      "data-block-id",
      /.*/,
    );
  });

  test("deletes the goal block and clears the goal zone", async ({ page }) => {
    await gotoIsolated(page);
    await page.getByRole("button", { name: "Goal Block", exact: true }).click();
    await cellAt(page, 0, 0).click();
    await cellAt(page, 3, 3).click();
    await expect(page.locator(".grid-cell.goal-zone")).toHaveCount(1);

    await page.locator("md-icon-button[data-block-delete-id]").click();
    await expect(page.locator(".block-row")).toHaveCount(0);
    await expect(page.locator(".grid-cell.goal-zone")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Goal Block", exact: true }),
    ).not.toBeDisabled();
  });

  test("renumbers blocks after a non-trailing delete", async ({ page }) => {
    await gotoIsolated(page);
    await paintShape(page, [{ x: 0, y: 0 }]);
    await paintShape(page, [{ x: 2, y: 0 }]);
    await paintShape(page, [{ x: 4, y: 0 }]);

    await expect(page.locator(".block-row")).toHaveCount(3);

    await page.locator('md-icon-button[data-block-delete-id="2"]').click();

    await expect(page.locator(".block-row")).toHaveCount(2);
    // The cell that was Block 3 is now Block 2 (block 3 renumbered to 2)
    await expect(cellAt(page, 0, 0)).toHaveAttribute("data-block-id", "1");
    await expect(cellAt(page, 4, 0)).toHaveAttribute("data-block-id", "2");
    await expect(cellAt(page, 2, 0)).not.toHaveAttribute(
      "data-block-id",
      /.*/,
    );
    await expect(
      page.locator('.block-row[data-block-id="3"]'),
    ).toHaveCount(0);
  });

  test("hovering a block row highlights its cells in the grid", async ({
    page,
  }) => {
    await gotoIsolated(page);
    await paintShape(page, [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
    ]);
    await paintShape(page, [{ x: 3, y: 3 }]);

    await page.locator('.block-row[data-block-id="1"]').hover();
    await expect(cellAt(page, 0, 0)).toHaveClass(/block-hovered/);
    await expect(cellAt(page, 1, 0)).toHaveClass(/block-hovered/);
    await expect(cellAt(page, 3, 3)).not.toHaveClass(/block-hovered/);

    await page.locator('.block-row[data-block-id="2"]').hover();
    await expect(cellAt(page, 3, 3)).toHaveClass(/block-hovered/);
    await expect(cellAt(page, 0, 0)).not.toHaveClass(/block-hovered/);

    await page.locator("#tool-status").hover();
    await expect(cellAt(page, 3, 3)).not.toHaveClass(/block-hovered/);
    await expect(cellAt(page, 0, 0)).not.toHaveClass(/block-hovered/);
  });

  test("reset clears blocks and restores default grid size", async ({
    page,
  }) => {
    await gotoIsolated(page);
    await page.getByRole("spinbutton", { name: "Grid Width" }).click();
    await page.getByRole("spinbutton", { name: "Grid Width" }).fill("8");
    await page.getByRole("spinbutton", { name: "Grid Width" }).press("Tab");
    await paintShape(page, [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
    ]);
    await expect(page.locator(".block-row")).toHaveCount(1);

    await page.getByRole("button", { name: "Reset" }).click();
    await page
      .locator("#reset-confirm")
      .getByRole("button", { name: "Reset" })
      .click();

    await expect(page.locator(".block-row")).toHaveCount(0);
    await expect(page.locator(".grid-cell")).toHaveCount(36);
    await expect(
      page.getByRole("spinbutton", { name: "Grid Width" }),
    ).toHaveValue("6");
    await expect(
      page.getByRole("spinbutton", { name: "Grid Height" }),
    ).toHaveValue("6");
  });

});