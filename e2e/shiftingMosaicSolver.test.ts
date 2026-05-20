import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "fs";

const SHIFTING_MOSAIC_URL = "/shifting-mosaic-solver";

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
    await page.goto(SHIFTING_MOSAIC_URL);

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

  test("switches between Obstruction and Goal Block tools", async ({
    page,
  }) => {
    await page.goto(SHIFTING_MOSAIC_URL);
    await expect(page.locator("#tool-status")).toContainText("Obstruction");
    await page.getByRole("button", { name: "Goal Block", exact: true }).click();
    await expect(page.locator("#tool-status")).toContainText("Goal Block");
    await page.getByRole("button", { name: "Obstruction", exact: true }).click();
    await expect(page.locator("#tool-status")).toContainText("Obstruction");
  });

  test("creates a single-cell obstruction block via click", async ({
    page,
  }) => {
    await page.goto(SHIFTING_MOSAIC_URL);
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
    await page.goto(SHIFTING_MOSAIC_URL);
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
    await page.goto(SHIFTING_MOSAIC_URL);
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

  test("hologram shows invalid styling when out of bounds and refuses to place", async ({
    page,
  }) => {
    await page.goto(SHIFTING_MOSAIC_URL);
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
    await page.goto(SHIFTING_MOSAIC_URL);
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
    await page.goto(SHIFTING_MOSAIC_URL);
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
    await page.goto(SHIFTING_MOSAIC_URL);
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
    await page.goto(SHIFTING_MOSAIC_URL);
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
    await page.goto(SHIFTING_MOSAIC_URL);
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
    await page.goto(SHIFTING_MOSAIC_URL);
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

  test("Calculate Solution warns when no goal block is defined", async ({
    page,
  }) => {
    await page.goto(SHIFTING_MOSAIC_URL);
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
    await page.goto(SHIFTING_MOSAIC_URL);

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

  test("rejects a block that overlaps an existing block", async ({ page }) => {
    await page.goto(SHIFTING_MOSAIC_URL);
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
    await page.goto(SHIFTING_MOSAIC_URL);
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
    await page.goto(SHIFTING_MOSAIC_URL);

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
    await page.goto(SHIFTING_MOSAIC_URL);
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
    await page.goto(SHIFTING_MOSAIC_URL);
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

  test("uploads a config file and populates the editor", async ({ page }) => {
    await page.goto(SHIFTING_MOSAIC_URL);

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
    await page.goto(SHIFTING_MOSAIC_URL);

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

  test("rejects an invalid dropped file", async ({ page }) => {
    await page.goto(SHIFTING_MOSAIC_URL);

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
    await page.goto(SHIFTING_MOSAIC_URL);

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
    await page.goto(SHIFTING_MOSAIC_URL);

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
