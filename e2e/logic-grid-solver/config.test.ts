import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "fs";

const URL = "/logic-grid-solver";

// A small, structurally valid config in the editor's download format. `cells`
// carries the colour layer only — 0 unknown, 1 dark, 2 light, 3 unplayable —
// and the clues are a sparse list beside it.
const SAMPLE_CONFIG = {
  gridWidth: 3,
  gridHeight: 2,
  rules: [0, 10],
  cells: [
    [1, 0],
    [2, 0],
    [0, 3],
  ],
  symbols: [
    { x: 0, y: 0, type: 0, value: 2 },
    { x: 1, y: 1, type: 1, value: "B" },
  ],
};

function cellAt(page: Page, x: number, y: number) {
  return page.locator(`#grid .grid-cell[data-x="${x}"][data-y="${y}"]`);
}

function ruleChip(page: Page, id: string) {
  return page.locator(`#rule-row .tool-button[data-rule="${id}"]`);
}

async function upload(page: Page, config: unknown, name = "puzzle.json") {
  await page.locator("#config-file-input").setInputFiles({
    name,
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(config)),
  });
}

test.describe("Logic Grid Solver config", () => {
  test("uploads a config file and populates the editor", async ({ page }) => {
    await page.goto(URL);
    await upload(page, SAMPLE_CONFIG);

    await expect(page.locator("#grid .grid-cell")).toHaveCount(6);
    await expect(
      page.getByRole("spinbutton", { name: "Grid Width" }),
    ).toHaveValue("3");
    await expect(cellAt(page, 0, 0)).toHaveAttribute("data-color", "dark");
    await expect(cellAt(page, 1, 0)).toHaveAttribute("data-color", "light");
    await expect(cellAt(page, 2, 1)).toHaveAttribute("data-color", "unplayable");
    await expect(cellAt(page, 0, 0)).toHaveText("2");
    await expect(cellAt(page, 1, 1)).toHaveText("B");
    await expect(ruleChip(page, "no-dark-2x2")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(ruleChip(page, "underclued")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(ruleChip(page, "connect-dark")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await expect(page.locator("#warning-banner")).toBeHidden();
  });

  test("loads the captured fixture", async ({ page }) => {
    await page.goto(URL);
    const json = readFileSync(
      "test/resources/logic-grid-solver/logicGridTest.json",
      "utf8",
    );
    await page.locator("#config-file-input").setInputFiles({
      name: "logicGridTest.json",
      mimeType: "application/json",
      buffer: Buffer.from(json),
    });

    await expect(page.locator("#grid .grid-cell")).toHaveCount(25);
    await expect(cellAt(page, 4, 4)).toHaveAttribute("data-color", "unplayable");
    await expect(cellAt(page, 2, 2)).toHaveText("A");
    await expect(page.locator("#warning-banner")).toBeHidden();
  });

  test("loads a config dropped onto the page", async ({ page }) => {
    await page.goto(URL);

    const dataTransfer = await page.evaluateHandle(json => {
      const dt = new DataTransfer();
      dt.items.add(
        new File([json], "puzzle.json", { type: "application/json" }),
      );
      return dt;
    }, JSON.stringify(SAMPLE_CONFIG));

    await page.dispatchEvent("body", "drop", { dataTransfer });

    await expect(page.locator("#grid .grid-cell")).toHaveCount(6);
    await expect(page.locator("#drop-overlay")).toBeHidden();
  });

  test("reports why a config was rejected", async ({ page }) => {
    await page.goto(URL);
    await upload(page, { ...SAMPLE_CONFIG, rules: [999] }, "bad.json");

    await expect(page.locator("#warning-banner")).toHaveText(
      "Invalid config: Rules must be integers between 0 and 11.",
    );
    await expect(page.locator("#grid .grid-cell")).toHaveCount(36);
  });

  /** A gap is not a cell the puzzle clues, and the editor cannot produce one. */
  test("refuses a clue sitting on a gap", async ({ page }) => {
    await page.goto(URL);
    await upload(
      page,
      {
        ...SAMPLE_CONFIG,
        symbols: [{ x: 2, y: 1, type: 0, value: 1 }],
      },
      "bad.json",
    );

    await expect(page.locator("#warning-banner")).toHaveText(
      "Invalid config: Column 3, row 2 is unplayable and cannot carry a symbol.",
    );
  });

  test("rejects a file that is not JSON", async ({ page }) => {
    await page.goto(URL);

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
    await expect(page.locator("#grid .grid-cell")).toHaveCount(36);
  });

  test("downloads the current puzzle as JSON", async ({ page }) => {
    await page.goto(URL);

    await cellAt(page, 0, 0).click();
    await cellAt(page, 1, 0).click({ button: "right" });
    await page.locator('#rule-row .tool-button[data-rule="underclued"]').click();
    await page.locator('#symbol-row .symbol-chip[data-symbol="area"]').click();
    await page.getByRole("spinbutton", { name: "Area number value" }).fill("5");
    await cellAt(page, 2, 2).click();

    const downloadPromise = page.waitForEvent("download");
    await page.locator("#download-config").click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("logicGridTest.json");

    const config = JSON.parse(readFileSync(await download.path(), "utf8"));
    expect(config.gridWidth).toBe(6);
    expect(config.gridHeight).toBe(6);
    expect(config.cells[0][0]).toBe(1);
    expect(config.cells[1][0]).toBe(2);
    expect(config.cells[5][5]).toBe(0);
    expect(config.rules).toEqual([10]);
    expect(config.symbols).toEqual([{ x: 2, y: 2, type: 0, value: 5 }]);
  });

  test("round-trips a downloaded config back through upload", async ({
    page,
  }) => {
    await page.goto(URL);

    await cellAt(page, 2, 3).click();
    await page
      .locator('#symbol-row .symbol-chip[data-symbol="letter"]')
      .click();
    await page.getByRole("textbox", { name: "Letter value" }).fill("Q");
    await cellAt(page, 4, 1).click();
    await page.locator('#rule-row .tool-button[data-rule="no-light-1x3"]').click();

    const downloadPromise = page.waitForEvent("download");
    await page.locator("#download-config").click();
    const json = readFileSync(await (await downloadPromise).path(), "utf8");

    await page.locator('#paint-tools [data-tool="reset"]').click();
    await page
      .locator("#reset-confirm")
      .getByRole("button", { name: "Reset" })
      .click();
    await expect(cellAt(page, 2, 3)).toHaveAttribute("data-color", "unknown");

    await page.locator("#config-file-input").setInputFiles({
      name: "roundtrip.json",
      mimeType: "application/json",
      buffer: Buffer.from(json),
    });

    await expect(cellAt(page, 2, 3)).toHaveAttribute("data-color", "dark");
    await expect(cellAt(page, 4, 1)).toHaveText("Q");
    await expect(ruleChip(page, "no-light-1x3")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.locator("#warning-banner")).toBeHidden();
  });

  test("ignores grid sizes beyond the 32 cap", async ({ page }) => {
    await page.goto(URL);

    await page.getByRole("spinbutton", { name: "Grid Width" }).fill("33");
    await expect(page.locator("#grid .grid-cell")).toHaveCount(36);

    await page.getByRole("spinbutton", { name: "Grid Width" }).fill("32");
    await expect(page.locator("#grid .grid-cell")).toHaveCount(32 * 6);
  });
});
