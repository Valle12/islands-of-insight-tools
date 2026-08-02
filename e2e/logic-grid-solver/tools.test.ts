import { expect, test, type Page } from "@playwright/test";
import { gotoIsolated, LOGIC_GRID_URL } from "../coi";

// Every visit goes through gotoIsolated: this page registers the COOP/COEP
// shim and reloads once when its service worker activates, and anything issued
// into that window dies with "Execution context was destroyed".
const URL = LOGIC_GRID_URL;

// Scoped to #grid throughout: nothing else on this page renders `.grid-cell`
// today, and scoping keeps that true if a solution grid ever arrives.
function cellAt(page: Page, x: number, y: number) {
  return page.locator(`#grid .grid-cell[data-x="${x}"][data-y="${y}"]`);
}

/** Keyed on `data-tool`, not on which of the three rows holds it. */
function tool(page: Page, name: string) {
  return page.locator(`#paint-tools .tool-button[data-tool="${name}"]`);
}

function clueChip(page: Page, id: string) {
  return page.locator(`#symbol-row .symbol-chip[data-symbol="${id}"]`);
}

/** The split control's own field — one per clue kind, never shared. */
function clueValue(page: Page, id: string) {
  return page.locator(`#symbol-row .symbol-tool[data-symbol="${id}"] input`);
}

function ruleChip(page: Page, id: string) {
  return page.locator(`#rule-row .tool-button[data-rule="${id}"]`);
}

/** Drags the given button across one row of cells, in one stroke. */
async function dragRow(page: Page, y: number, from: number, to: number,
  button: "left" | "right" = "left") {
  const box = async (x: number) => (await cellAt(page, x, y).boundingBox())!;
  const start = await box(from);
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down({ button });
  for (let x = from + 1; x <= to; x++) {
    const step = await box(x);
    await page.mouse.move(step.x + step.width / 2, step.y + step.height / 2);
  }
  await page.mouse.up({ button });
}

test.describe("Logic Grid Solver tools", () => {
  test.beforeEach(async ({ page }) => {
    await gotoIsolated(page, URL);
  });

  test("opens on an empty board with dark selected", async ({ page }) => {
    await expect(page.locator("#grid .grid-cell")).toHaveCount(36);
    await expect(cellAt(page, 0, 0)).toHaveAttribute("data-color", "unknown");
    await expect(cellAt(page, 0, 0)).toHaveAccessibleName(
      "Column 1, Row 1, Unknown",
    );
    await expect(page.locator("#tool-status")).toHaveText(
      "Selected tool: Dark · Right-click: Light",
    );
    await expect(tool(page, "dark")).toHaveClass(/selected/);
  });

  /** A row per kind of tool: what clears the board, what colours it, what clues it. */
  test("groups the tools into rows by what they do", async ({ page }) => {
    await expect(page.locator("#command-row .tool-button")).toHaveCount(2);
    await expect(page.locator("#color-row .tool-button")).toHaveCount(3);
    await expect(page.locator("#symbol-row .symbol-chip")).toHaveCount(2);
  });

  test("left paints dark and right paints light", async ({ page }) => {
    await cellAt(page, 1, 1).click();
    await cellAt(page, 2, 1).click({ button: "right" });

    await expect(cellAt(page, 1, 1)).toHaveAttribute("data-color", "dark");
    await expect(cellAt(page, 2, 1)).toHaveAttribute("data-color", "light");
    await expect(cellAt(page, 2, 1)).toHaveAccessibleName(
      "Column 3, Row 2, Light",
    );
  });

  test("clicking the same button again clears the cell", async ({ page }) => {
    await cellAt(page, 0, 0).click();
    await expect(cellAt(page, 0, 0)).toHaveAttribute("data-color", "dark");
    await cellAt(page, 0, 0).click();
    await expect(cellAt(page, 0, 0)).toHaveAttribute("data-color", "unknown");
  });

  test("the other button repaints rather than clearing", async ({ page }) => {
    await cellAt(page, 0, 0).click();
    await cellAt(page, 0, 0).click({ button: "right" });
    await expect(cellAt(page, 0, 0)).toHaveAttribute("data-color", "light");
  });

  test("a drag paints one colour across the whole run", async ({ page }) => {
    await dragRow(page, 2, 1, 4);
    for (let x = 1; x <= 4; x++) {
      await expect(cellAt(page, x, 2)).toHaveAttribute("data-color", "dark");
    }
    await expect(cellAt(page, 0, 2)).toHaveAttribute("data-color", "unknown");
  });

  /**
   * The stroke commits at pointerdown, so a drag begun on a painted cell erases
   * every cell it crosses instead of flipping between paint and erase.
   */
  test("a drag begun on a painted cell erases the whole run", async ({
    page,
  }) => {
    await dragRow(page, 3, 0, 3);
    await dragRow(page, 3, 0, 3);
    for (let x = 0; x <= 3; x++) {
      await expect(cellAt(page, x, 3)).toHaveAttribute("data-color", "unknown");
    }
  });

  test("right-dragging paints light", async ({ page }) => {
    await dragRow(page, 4, 1, 3, "right");
    for (let x = 1; x <= 3; x++) {
      await expect(cellAt(page, x, 4)).toHaveAttribute("data-color", "light");
    }
  });

  test("the unplayable tool marks gaps in the board", async ({ page }) => {
    await tool(page, "unplayable").click();
    await expect(page.locator("#tool-status")).toHaveText(
      "Selected tool: Unplayable · Right-click: Erase",
    );
    await cellAt(page, 5, 5).click();
    await expect(cellAt(page, 5, 5)).toHaveAttribute("data-color", "unplayable");
  });

  test("clues sit on the colour rather than replacing it", async ({ page }) => {
    await clueChip(page, "area").click();
    await page.getByRole("spinbutton", { name: "Area number value" }).fill("4");
    await cellAt(page, 2, 2).click();
    await expect(cellAt(page, 2, 2)).toHaveText("4");
    await expect(cellAt(page, 2, 2)).toHaveAttribute("data-symbol", "area");

    // Colourless until the cell is coloured — which is the whole point.
    await expect(cellAt(page, 2, 2)).toHaveAttribute("data-color", "unknown");
    await tool(page, "dark").click();
    await cellAt(page, 2, 2).click();
    await expect(cellAt(page, 2, 2)).toHaveAttribute("data-color", "dark");
    await expect(cellAt(page, 2, 2)).toHaveText("4");
    await expect(cellAt(page, 2, 2)).toHaveAccessibleName(
      "Column 3, Row 3, Dark, Area number 4",
    );
  });

  test("a letter clue takes one letter", async ({ page }) => {
    await clueChip(page, "letter").click();
    await page.getByRole("textbox", { name: "Letter value" }).fill("c");
    // Corrected in the field, not just on the way to the board.
    await expect(clueValue(page, "letter")).toHaveValue("C");
    await cellAt(page, 1, 0).click();
    await expect(cellAt(page, 1, 0)).toHaveText("C");
    await expect(cellAt(page, 1, 0)).toHaveAttribute("data-symbol", "letter");
  });

  /**
   * Each kind keeps its own value beside its own chip, so typing into one is
   * both an edit and a selection, and never disturbs the other.
   */
  test("each clue kind carries its own value field", async ({ page }) => {
    await expect(clueValue(page, "area")).toHaveValue("1");
    await expect(clueValue(page, "letter")).toHaveValue("A");

    await clueValue(page, "letter").fill("M");
    await expect(clueValue(page, "area")).toHaveValue("1");
    await expect(
      page.locator('#symbol-row .symbol-tool[data-symbol="letter"]'),
    ).toHaveClass(/selected/);

    await cellAt(page, 0, 0).click();
    await expect(cellAt(page, 0, 0)).toHaveText("M");
  });

  test("a value the kind cannot use is marked and stamps nothing", async ({
    page,
  }) => {
    await clueValue(page, "area").fill("0");
    await expect(clueValue(page, "area")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    // The other field is judged on its own, not on the selected kind.
    await expect(clueValue(page, "letter")).not.toHaveAttribute("aria-invalid");

    await cellAt(page, 1, 1).click();
    await expect(cellAt(page, 1, 1)).toHaveText("");
  });

  /** Areas run past nine, so digits typed on one cell accumulate. */
  test("typing on a cell edits its clue", async ({ page }) => {
    await clueChip(page, "area").click();
    await cellAt(page, 3, 3).click();
    await page.keyboard.press("1");
    await page.keyboard.press("2");
    await expect(cellAt(page, 3, 3)).toHaveText("12");

    await page.keyboard.press("Backspace");
    await expect(cellAt(page, 3, 3)).toHaveText("");
    await expect(cellAt(page, 3, 3)).toHaveAttribute("data-color", "unknown");
  });

  test("right-clicking a clue lifts it and keeps the colour", async ({
    page,
  }) => {
    await clueChip(page, "area").click();
    await cellAt(page, 0, 1).click();
    await tool(page, "light").click();
    await cellAt(page, 0, 1).click();
    await clueChip(page, "area").click();
    await cellAt(page, 0, 1).click({ button: "right" });

    await expect(cellAt(page, 0, 1)).toHaveText("");
    await expect(cellAt(page, 0, 1)).toHaveAttribute("data-color", "light");
  });

  test("the eraser clears both layers", async ({ page }) => {
    await clueChip(page, "area").click();
    await cellAt(page, 4, 4).click();
    await tool(page, "dark").click();
    await cellAt(page, 4, 4).click();

    await tool(page, "erase").click();
    await cellAt(page, 4, 4).click();
    await expect(cellAt(page, 4, 4)).toHaveAttribute("data-color", "unknown");
    await expect(cellAt(page, 4, 4)).toHaveText("");
  });

  test("rules toggle on and off", async ({ page }) => {
    const underclued = ruleChip(page, "underclued");
    await expect(underclued).toHaveAttribute("aria-pressed", "false");
    await underclued.click();
    await expect(ruleChip(page, "underclued")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await ruleChip(page, "underclued").click();
    await expect(ruleChip(page, "underclued")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  /** A different size is a different puzzle, and it brings its own rules. */
  test("resizing redraws an empty board and drops the rules", async ({
    page,
  }) => {
    await cellAt(page, 0, 0).click();
    await ruleChip(page, "no-dark-2x2").click();

    await page.getByRole("spinbutton", { name: "Grid Width" }).fill("4");
    await page.getByRole("spinbutton", { name: "Grid Height" }).fill("3");

    await expect(page.locator("#grid .grid-cell")).toHaveCount(12);
    await expect(cellAt(page, 0, 0)).toHaveAttribute("data-color", "unknown");
    await expect(ruleChip(page, "no-dark-2x2")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  test("reset asks first, then clears the board and the rules", async ({
    page,
  }) => {
    await cellAt(page, 0, 0).click();
    await ruleChip(page, "no-dark-2x2").click();

    await tool(page, "reset").click();
    await page
      .locator("#reset-cancel")
      .getByRole("button", { name: "Cancel" })
      .click();
    await expect(cellAt(page, 0, 0)).toHaveAttribute("data-color", "dark");

    await tool(page, "reset").click();
    await page
      .locator("#reset-confirm")
      .getByRole("button", { name: "Reset" })
      .click();
    await expect(cellAt(page, 0, 0)).toHaveAttribute("data-color", "unknown");
    await expect(ruleChip(page, "no-dark-2x2")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });
});
