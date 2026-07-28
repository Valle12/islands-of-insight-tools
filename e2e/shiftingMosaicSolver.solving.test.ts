import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "fs";
import { gotoIsolated } from "./coi";

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
  test("Calculate Solution warns when no goal block is defined", async ({
    page,
  }) => {
    await gotoIsolated(page);
    await page.getByRole("button", { name: "Calculate Solution" }).click();
    await expect(page.locator("#warning-banner")).toBeVisible();
    await expect(page.locator("#warning-banner")).toContainText(
      "No goal block",
    );
    await expect(page.locator("#solution-view")).toBeHidden();
  });

  test("solves a trivial puzzle and shows the step-by-step solution view", async ({
    page,
  }) => {
    await gotoIsolated(page);

    // A single 1x1 goal block at (0,0) with its goal zone two cells right.
    await page.getByRole("button", { name: "Goal Block", exact: true }).click();
    await cellAt(page, 0, 0).click();
    await cellAt(page, 2, 0).click();
    await expect(cellAt(page, 2, 0)).toHaveClass(/goal-zone/);

    await page.getByRole("button", { name: "Calculate Solution" }).click();

    // The WASM worker loads + searches; allow generous time.
    await expect(page.locator("#solution-view")).toBeVisible({
      timeout: 30000,
    });
    await expect(page.locator("#editor-section")).toBeHidden();
    await expect(page.locator("#solution-grid .grid-cell")).toHaveCount(36);
    await expect(page.locator("#solution-step-text")).toContainText("right");
    await expect(page.locator("#solution-step-counter")).toContainText(
      "Step 1",
    );

    // Step through to the end, then return to the editor.
    await page.getByRole("button", { name: "Next" }).click();
    await expect(page.locator("#solution-step-counter")).toContainText(
      "Solved",
    );
    await page.getByRole("button", { name: "Back to editor" }).click();
    await expect(page.locator("#editor-section")).toBeVisible();
    await expect(page.locator("#solution-view")).toBeHidden();
  });

  test("groups a multi-direction block move into one path step", async ({
    page,
  }) => {
    await gotoIsolated(page);

    // A single goal block at (0,2) whose goal zone sits up-and-right at (2,0).
    // The only solution slides it right then up — all consecutive moves of one
    // block, so the viewer must present it as a single path step.
    await page.getByRole("button", { name: "Goal Block", exact: true }).click();
    await cellAt(page, 0, 2).click();
    await cellAt(page, 2, 0).click();
    await expect(cellAt(page, 2, 0)).toHaveClass(/goal-zone/);

    await page.getByRole("button", { name: "Calculate Solution" }).click();
    await expect(page.locator("#solution-view")).toBeVisible({
      timeout: 30000,
    });

    await expect(page.locator("#solution-step-counter")).toHaveText(
      "Step 1 of 1",
    );
    // One step, but the path text names both legs of the route.
    await expect(page.locator("#solution-step-text")).toContainText("right");
    await expect(page.locator("#solution-step-text")).toContainText("up");

    // The drag path is drawn as an SVG overlay on the grid.
    await expect(page.locator(".sm-path-overlay")).toHaveCount(1);
    await expect(page.locator(".sm-path-line")).toHaveCount(1);

    // Reaching the end clears the path overlay.
    await page.getByRole("button", { name: "Next" }).click();
    await expect(page.locator("#solution-step-counter")).toContainText(
      "Solved",
    );
    await expect(page.locator(".sm-path-overlay")).toHaveCount(0);
  });

  test("rejects a block that overlaps an existing block", async ({ page }) => {
    await gotoIsolated(page);
    await paintShape(page, [
      { x: 1, y: 1 },
      { x: 2, y: 1 },
    ]);
    await expect(page.locator(".block-row")).toHaveCount(1);

    // Drag through cells (0,1) → (1,1, occupied) → (3,1). The skipped occupied
    // cell breaks contiguity, and the warning identifies the cause as overlap.
    await paintShape(page, [
      { x: 0, y: 1 },
      { x: 1, y: 1 },
      { x: 3, y: 1 },
    ]);

    await expect(page.locator(".block-row")).toHaveCount(1);
    await expect(page.locator("#warning-banner")).toBeVisible();
    await expect(page.locator("#warning-banner")).toContainText("overlaps");
    await expect(cellAt(page, 0, 1)).not.toHaveAttribute(
      "data-block-id",
      /.*/,
    );
    await expect(cellAt(page, 3, 1)).not.toHaveAttribute(
      "data-block-id",
      /.*/,
    );
  });

  test("commits a contiguous block even when the drag ended on an existing block", async ({
    page,
  }) => {
    await gotoIsolated(page);
    await paintShape(page, [{ x: 2, y: 1 }]);
    await expect(page.locator(".block-row")).toHaveCount(1);

    // Drag (0,1) → (1,1) → (2,1, occupied). The drawn cells (0,1)(1,1) are
    // contiguous and don't overlap, so the new block should be committed and
    // no warning should appear.
    await paintShape(page, [
      { x: 0, y: 1 },
      { x: 1, y: 1 },
      { x: 2, y: 1 },
    ]);

    await expect(page.locator(".block-row")).toHaveCount(2);
    await expect(page.locator("#warning-banner")).toBeHidden();
    await expect(cellAt(page, 0, 1)).toHaveAttribute("data-block-id", "2");
    await expect(cellAt(page, 1, 1)).toHaveAttribute("data-block-id", "2");
    await expect(cellAt(page, 2, 1)).toHaveAttribute("data-block-id", "1");
  });

  test("rejects a non-contiguous block from a fast drag", async ({ page }) => {
    await gotoIsolated(page);

    // Mouse moves with default steps fire only one pointermove at the destination,
    // so dragging from (0,0) directly to (5,0) skips the cells in between.
    await paintWithGap(page, { x: 0, y: 0 }, { x: 5, y: 0 });

    await expect(page.locator(".block-row")).toHaveCount(0);
    await expect(page.locator("#warning-banner")).toBeVisible();
    await expect(page.locator("#warning-banner")).toContainText(
      "connected area",
    );
    await expect(cellAt(page, 0, 0)).not.toHaveAttribute(
      "data-block-id",
      /.*/,
    );
    await expect(cellAt(page, 5, 0)).not.toHaveAttribute(
      "data-block-id",
      /.*/,
    );
  });

  test("clicking directly on an existing block triggers the overlap warning", async ({
    page,
  }) => {
    await gotoIsolated(page);
    await paintShape(page, [{ x: 2, y: 2 }]);
    await expect(page.locator(".block-row")).toHaveCount(1);

    await cellAt(page, 2, 2).click();
    await expect(page.locator(".block-row")).toHaveCount(1);
    await expect(page.locator("#warning-banner")).toBeVisible();
    await expect(page.locator("#warning-banner")).toContainText("overlaps");
  });

  test("does not falsely report overlap after a grid resize", async ({
    page,
  }) => {
    await gotoIsolated(page);
    await cellAt(page, 0, 0).click();
    await expect(page.locator(".block-row")).toHaveCount(1);

    // Resizing must reuse the board instance — a leaked listener from a stale
    // board would still see (0,0) as occupied and trip a false overlap.
    await page.getByRole("spinbutton", { name: "Grid Width" }).fill("4");
    await page.getByRole("spinbutton", { name: "Grid Width" }).press("Tab");
    await expect(page.locator(".block-row")).toHaveCount(0);

    await cellAt(page, 0, 0).click();
    await expect(page.locator(".block-row")).toHaveCount(1);
    await expect(page.locator("#warning-banner")).toBeHidden();

    // Resize once more, then paint several blocks — none should warn.
    await page.getByRole("spinbutton", { name: "Grid Height" }).fill("3");
    await page.getByRole("spinbutton", { name: "Grid Height" }).press("Tab");
    await cellAt(page, 0, 0).click();
    await cellAt(page, 1, 0).click();
    await cellAt(page, 2, 0).click();
    await expect(page.locator(".block-row")).toHaveCount(3);
    await expect(page.locator("#warning-banner")).toBeHidden();
  });

});