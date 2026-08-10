import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "fs";
import { gotoIsolated, LOGIC_GRID_URL } from "../coi";
import { formatSample } from "../../test/logic-grid-solver/boards";
import {
  CONFIG_VERSION,
  migrationNotice,
} from "../../src/pages/logic-grid-solver/config";
// Read rather than restated: the catalogue's upper bound moves every time a
// rule lands, and its INDICES moved once when the list was regrouped. A literal
// here survives neither.
import { RULE_COUNT, RULES } from "../../src/pages/logic-grid-solver/rules";

const ruleIndex = (id: string) => RULES.findIndex(rule => rule.id === id);

// Every visit goes through gotoIsolated: this page registers the COOP/COEP
// shim and reloads once when its service worker activates, and anything issued
// into that window dies with "Execution context was destroyed".
const URL = LOGIC_GRID_URL;

// A small, structurally valid config in the editor's download format. `cells`
// carries the colour layer only — 0 unknown, 1 dark, 2 light, 3 unplayable —
// and the clues are a sparse list beside it. Current version, so no migration
// banner joins the assertions below.
const SAMPLE_CONFIG = {
  version: CONFIG_VERSION,
  gridWidth: 3,
  gridHeight: 2,
  rules: [ruleIndex("no-dark-2x2"), ruleIndex("underclued")].sort(
    (a, b) => a - b,
  ),
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
    await gotoIsolated(page, URL);
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

  test("loads a board using every part of the format", async ({ page }) => {
    await gotoIsolated(page, URL);
    await page.locator("#config-file-input").setInputFiles({
      name: "logicGridTest.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(formatSample())),
    });

    await expect(page.locator("#grid .grid-cell")).toHaveCount(25);
    await expect(cellAt(page, 4, 4)).toHaveAttribute("data-color", "unplayable");
    await expect(cellAt(page, 2, 2)).toHaveText("A");
    await expect(page.locator("#warning-banner")).toBeHidden();
  });

  test("loads a config dropped onto the page", async ({ page }) => {
    await gotoIsolated(page, URL);

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
    await gotoIsolated(page, URL);
    await upload(page, { ...SAMPLE_CONFIG, rules: [999] }, "bad.json");

    await expect(page.locator("#warning-banner")).toHaveText(
      `Invalid config: Rules must be integers between 0 and ${RULE_COUNT - 1}.`,
    );
    await expect(page.locator("#grid .grid-cell")).toHaveCount(36);
  });

  /** The valueless kind's own refusal, through the real banner: a symmetry
   * symbol never carries a value, and a file that says otherwise is naming a
   * puzzle this page cannot mean. */
  test("refuses a symmetry symbol carrying a value", async ({ page }) => {
    await gotoIsolated(page, URL);
    await upload(
      page,
      {
        ...SAMPLE_CONFIG,
        symbols: [{ x: 0, y: 0, type: 3, value: 1, direction: 0 }],
      },
      "bad.json",
    );

    await expect(page.locator("#warning-banner")).toHaveText(
      "Invalid config: Symmetry symbols carry no value.",
    );
  });

  /** A gap is not a cell the puzzle clues, and the editor cannot produce one. */
  test("refuses a clue sitting on a gap", async ({ page }) => {
    await gotoIsolated(page, URL);
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
    await gotoIsolated(page, URL);

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
    await gotoIsolated(page, URL);

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

    const raw = readFileSync(await download.path(), "utf8");
    const config = JSON.parse(raw);
    // The tag leads the file, so a reader knows which shape it is in before it
    // has parsed anything that shape could have changed. Checked on the TEXT,
    // since key order is the one thing a parsed object cannot show.
    expect(raw).toMatch(/^\{\n {2}"version": 2,/);
    expect(config.gridWidth).toBe(6);
    expect(config.gridHeight).toBe(6);
    expect(config.cells[0][0]).toBe(1);
    expect(config.cells[1][0]).toBe(2);
    expect(config.cells[5][5]).toBe(0);
    expect(config.rules).toEqual([ruleIndex("underclued")]);
    expect(config.symbols).toEqual([{ x: 2, y: 2, type: 0, value: 5 }]);
  });

  test("round-trips a downloaded config back through upload", async ({
    page,
  }) => {
    await gotoIsolated(page, URL);

    await cellAt(page, 2, 3).click();
    await page
      .locator('#symbol-row .symbol-chip[data-symbol="letter"]')
      .click();
    await page.getByRole("textbox", { name: "Letter value" }).fill("Q");
    await cellAt(page, 4, 1).click();
    // A sized rule rides along: "no light 1x3" is a value in the run control
    // now, stored under `runs` rather than as an index.
    await page
      .locator('#rule-row .rule-size-add[data-sized-control="run-light"]')
      .click();
    await page
      .getByRole("spinbutton", { name: "No light 1x value 1" })
      .fill("3");

    const downloadPromise = page.waitForEvent("download");
    await page.locator("#download-config").click();
    const json = readFileSync(await (await downloadPromise).path(), "utf8");
    expect(JSON.parse(json).runs).toEqual([{ color: "light", length: 3 }]);

    await page.locator('#paint-tools [data-tool="reset"]').click();
    await page
      .locator("#reset-confirm")
      .getByRole("button", { name: "Reset" })
      .click();
    await expect(cellAt(page, 2, 3)).toHaveAttribute("data-color", "unknown");
    await expect(
      page.locator('#rule-row .rule-size[data-sized-control="run-light"]'),
    ).toHaveCount(0);

    await page.locator("#config-file-input").setInputFiles({
      name: "roundtrip.json",
      mimeType: "application/json",
      buffer: Buffer.from(json),
    });

    await expect(cellAt(page, 2, 3)).toHaveAttribute("data-color", "dark");
    await expect(cellAt(page, 4, 1)).toHaveText("Q");
    await expect(
      page.locator('#rule-row .rule-size[data-sized-control="run-light"]'),
    ).toHaveValue("3");
    await expect(
      page.locator('#rule-row .rule-sized[data-sized-control="run-light"]'),
    ).toHaveClass(/selected/);
    await expect(page.locator("#warning-banner")).toBeHidden();
  });

  /**
   * An older file loads in full and then warns about the copy on disk — its
   * sized index landing as a value in the run control, not as a flag. The
   * banner auto-hides after a few seconds, so it is asserted first.
   */
  test("migrates a version 1 file and says so", async ({ page }) => {
    await gotoIsolated(page, URL);
    const v1 = { ...SAMPLE_CONFIG, rules: [ruleIndex("no-dark-1x2")] } as {
      version?: number;
    };
    delete v1.version;
    await upload(page, v1, "old.json");

    await expect(page.locator("#warning-banner")).toHaveText(
      migrationNotice(1),
    );
    await expect(page.locator("#grid .grid-cell")).toHaveCount(6);
    await expect(
      page.locator('#rule-row .rule-size[data-sized-control="run-dark"]'),
    ).toHaveValue("2");
    await expect(
      page.locator('#rule-row .rule-sized[data-sized-control="run-dark"]'),
    ).toHaveClass(/selected/);
  });

  test("ignores grid sizes beyond the 32 cap", async ({ page }) => {
    await gotoIsolated(page, URL);

    await page.getByRole("spinbutton", { name: "Grid Width" }).fill("33");
    await expect(page.locator("#grid .grid-cell")).toHaveCount(36);

    await page.getByRole("spinbutton", { name: "Grid Width" }).fill("32");
    await expect(page.locator("#grid .grid-cell")).toHaveCount(32 * 6);
  });
});
