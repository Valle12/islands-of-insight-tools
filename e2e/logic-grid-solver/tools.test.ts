import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
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

/** One of a directed kind's four arrows, by the direction it aims at. */
function directionToggle(page: Page, id: string, direction: string) {
  return page.locator(
    `#symbol-row .symbol-tool[data-symbol="${id}"] ` +
      `.direction-toggle[data-direction="${direction}"]`,
  );
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

  /** A row per kind of tool: what clears the board, what colors it, what clues it. */
  test("groups the tools into rows by what they do", async ({ page }) => {
    await expect(page.locator("#command-row .tool-button")).toHaveCount(2);
    // Four: the three colors plus merge, which also changes what the board is
    // rather than doing something to it once.
    await expect(page.locator("#color-row .tool-button")).toHaveCount(4);
    // `.symbol-chip` means "the clue KINDS". The dart's arrows and the
    // symmetry symbol's axes sit inside their controls as `.direction-toggle`
    // and deliberately do not answer to that class — four toggles each. The
    // viewpoint and the galaxy point nowhere, so the toggle count stays at
    // eight while the chips reach six.
    await expect(page.locator("#symbol-row .symbol-chip")).toHaveCount(6);
    await expect(page.locator("#symbol-row .direction-toggle")).toHaveCount(8);
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

  test("a drag paints one color across the whole run", async ({ page }) => {
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

  test("clues sit on the color rather than replacing it", async ({ page }) => {
    await clueChip(page, "area").click();
    await page.getByRole("spinbutton", { name: "Area number value" }).fill("4");
    await cellAt(page, 2, 2).click();
    await expect(cellAt(page, 2, 2)).toHaveText("4");
    await expect(cellAt(page, 2, 2)).toHaveAttribute("data-symbol", "area");

    // Colorless until the cell is colored — which is the whole point.
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

  test("right-clicking a clue lifts it and keeps the color", async ({
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

  /** The rule row is a column of headed bands, not one long list. The drawn
   * shapes are not one of them — they close Arrangement, which is the band
   * whose sentence they say. */
  test("groups the rules into headed bands", async ({ page }) => {
    await expect(page.locator("#rule-row .rule-band")).toHaveCount(4);
    await expect(page.locator("#rule-row .rule-band-heading")).toHaveText([
      "Arrangement",
      "Region",
      "Symbol",
      "Answer",
    ]);
  });

  /** The five controls retired in format version 3 are gone from the row for
   * good: their shapes are drawn now, and a drawing keeps no name. */
  test("the retired controls have no chips any more", async ({ page }) => {
    for (const id of [
      "no-dark-diagonal",
      "no-dark-l",
      "no-light-crossed-dark-t",
      "no-dark-knight",
      "no-dark-light-dark-elbow",
    ])
      await expect(ruleChip(page, id)).toHaveCount(0);
  });

  /**
   * Drawing a forbidden shape end to end, through a real browser — the flow
   * that replaced a per-rule append cycle, and the reason the five controls
   * above could go.
   *
   * The 3x3 is the shape this whole feature exists for: nine squares, which is
   * more than a compiled clause could hold before its literals went variable
   * length.
   */
  test("a drawn pattern becomes a chip and comes back on a download", async ({
    page,
  }) => {
    await page.locator("#rule-row .rule-pattern-add").click();
    await page.locator("#pattern-width").getByRole("spinbutton").fill("3");
    await page.locator("#pattern-height").getByRole("spinbutton").fill("3");
    await expect(page.locator("#pattern-grid .pattern-cell")).toHaveCount(9);

    // Arm light, then one left click a square: the board's own gesture.
    await page
      .locator('#pattern-colors .pattern-color[data-pattern-color="light"]')
      .click();
    for (let at = 0; at < 9; at++)
      await page.locator(`#pattern-grid .pattern-cell[data-at="${at}"]`).click();
    await page
      .locator("#pattern-save")
      .getByRole("button", { name: "Save" })
      .click();

    const chip = page.locator("#rule-row .pattern-toggle");
    await expect(chip).toHaveCount(1);
    await expect(chip).toHaveAttribute("aria-pressed", "true");
    // The chip IS the drawing: nine light squares, and no borrowed name.
    await expect(
      chip.locator('.pattern-square[data-square="light"]'),
    ).toHaveCount(9);

    const downloadPromise = page.waitForEvent("download");
    await page.locator("#download-config").click();
    const download = await downloadPromise;
    const config: { patterns?: unknown } = JSON.parse(
      readFileSync(await download.path(), "utf8"),
    );
    expect(config.patterns).toEqual([
      { width: 3, height: 3, cells: Array.from({ length: 9 }, () => 2) },
    ]);
  });

  /**
   * The right button is the eraser, which is the half of the gesture a unit
   * test in a stub DOM cannot show is wired to a real press.
   */
  /**
   * The two color chips are a `fieldset`, not a div carrying `role="group"`:
   * the grouping semantics come with the element. What has to survive that is
   * the accessible NAME, which a fieldset takes from `aria-label` when it has
   * no `legend` — and this dialog has no room to show one.
   */
  test("the pattern colors are a named group", async ({ page }) => {
    await page.locator("#rule-row .rule-pattern-add").click();
    await expect(
      page.getByRole("group", { name: "Pattern color" }),
    ).toHaveCount(1);
  });

  test("the right button paints the other color", async ({ page }) => {
    await page.locator("#rule-row .rule-pattern-add").click();
    const square = page.locator('#pattern-grid .pattern-cell[data-at="0"]');
    await square.click();
    await expect(square).toHaveAttribute("data-square", "dark");
    await square.click({ button: "right" });
    await expect(square).toHaveAttribute("data-square", "light");
    // ...and the button that writes what is already there clears it, which is
    // the board's own rule and the only eraser either button needs.
    await square.click({ button: "right" });
    await expect(square).toHaveAttribute("data-square", "unknown");
  });

  /** The drawn chips close the ARRANGEMENT band — a drawn shape says exactly
   * what every chip beside it says, so it is not a band of its own. */
  test("the pattern chips live in the arrangement band", async ({ page }) => {
    await expect(
      page.locator('#rule-row .rule-band[data-band="patterns"]'),
    ).toHaveCount(0);
    await expect(
      page.locator(
        '#rule-row .rule-band[data-band="arrangement"] #pattern-chips',
      ),
    ).toHaveCount(1);
    await expect(
      page.locator(
        '#rule-row .rule-band[data-band="arrangement"] .rule-pattern-add',
      ),
    ).toHaveCount(1);
  });

  /** Switching one off leaves it drawn but off this board, so the key goes
   * away entirely rather than being written empty. Deleting takes it for
   * good. */
  test("a drawn pattern toggles off and deletes", async ({ page }) => {
    await page.locator("#rule-row .rule-pattern-add").click();
    await page.locator('#pattern-grid .pattern-cell[data-at="0"]').click();
    await page
      .locator("#pattern-save")
      .getByRole("button", { name: "Save" })
      .click();

    const chip = page.locator("#rule-row .pattern-toggle");
    await chip.click();
    await expect(chip).toHaveAttribute("aria-pressed", "false");
    await chip.click();
    await expect(chip).toHaveAttribute("aria-pressed", "true");

    await page.locator("#rule-row .pattern-delete").click();
    await expect(page.locator("#rule-row .pattern-toggle")).toHaveCount(0);
  });

  /** A reset is about this BOARD — the shape stays drawn, one click away for
   * the next puzzle in a group. */
  test("a reset switches a drawn pattern off but keeps it", async ({ page }) => {
    await page.locator("#rule-row .rule-pattern-add").click();
    await page.locator('#pattern-grid .pattern-cell[data-at="0"]').click();
    await page
      .locator("#pattern-save")
      .getByRole("button", { name: "Save" })
      .click();

    await tool(page, "reset").click();
    await page
      .locator("#reset-confirm")
      .getByRole("button", { name: "Reset" })
      .click();

    const chip = page.locator("#rule-row .pattern-toggle");
    await expect(chip).toHaveCount(1);
    await expect(chip).toHaveAttribute("aria-pressed", "false");
  });

  /** A folded pair is layout, not linkage: its Dark and Light segments are two
   * independent switches, and both can be on at once. */
  test("a pair's segments toggle independently", async ({ page }) => {
    await ruleChip(page, "no-dark-2x2").click();
    await expect(ruleChip(page, "no-light-2x2")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await ruleChip(page, "no-light-2x2").click();
    await expect(ruleChip(page, "no-dark-2x2")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(ruleChip(page, "no-light-2x2")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  /**
   * The sized families: a value field per instance, appended by the control's
   * own "+" — the flow that replaced the per-size chips, driven through a real
   * browser so focus hand-off and the number field's behavior are the real
   * things.
   */
  test("a sized rule takes its number in the row", async ({ page }) => {
    // Driven through a RUN control, the family that still takes several values
    // per color — the area cap has its own test below.
    const control = page.locator(
      '#rule-row .rule-sized[data-sized-control="run-dark"]',
    );
    await expect(control.locator(".rule-size")).toHaveCount(0);

    await control.locator(".rule-size-add").click();
    const field = page.getByRole("spinbutton", { name: "No dark 1x value 1" });
    // The new slot takes focus, so the number can be typed straight away.
    await expect(field).toBeFocused();
    await field.fill("3");
    await expect(control).toHaveClass(/selected/);

    // A second instance of the same family and color is one more "+".
    await control.locator(".rule-size-add").click();
    await page
      .getByRole("spinbutton", { name: "No dark 1x value 2" })
      .fill("5");
    await expect(control.locator(".rule-size")).toHaveCount(2);

    // An emptied slot disappears when it is left.
    await field.fill("");
    await field.blur();
    await expect(control.locator(".rule-size")).toHaveCount(1);
    await expect(control.locator(".rule-size")).toHaveValue("5");
    await expect(control).toHaveClass(/selected/);
  });

  /**
   * "Every dark region has area 2" and "…area 3" hold together only where dark
   * is absent from the board, so an area control takes ONE value and its "+"
   * leaves as soon as there is a slot to put a number in. The run family keeps
   * its button: two bans on one color are merely redundant.
   */
  test("an area control takes one value and its + goes away", async ({
    page,
  }) => {
    const control = page.locator(
      '#rule-row .rule-sized[data-sized-control="area-dark"]',
    );
    const add = control.locator(".rule-size-add");
    await expect(add).toBeVisible();

    await add.click();
    const field = page.getByRole("spinbutton", {
      name: "Dark regions have area value 1",
    });
    await expect(field).toBeFocused();
    await field.fill("3");
    await expect(control).toHaveClass(/selected/);
    await expect(add).toBeHidden();
    await expect(control.locator(".rule-size")).toHaveCount(1);

    // The run control beside it is unaffected.
    await expect(
      page.locator('#rule-row .rule-size-add[data-sized-control="run-dark"]'),
    ).toBeVisible();

    // Emptying the slot and leaving it hands the button back.
    await field.fill("");
    await field.blur();
    await expect(control.locator(".rule-size")).toHaveCount(0);
    await expect(add).toBeVisible();
  });

  /** An out-of-range value marks its own field and arms nothing. */
  test("a sized value outside its bounds reads as invalid", async ({
    page,
  }) => {
    const control = page.locator(
      '#rule-row .rule-sized[data-sized-control="run-dark"]',
    );
    await control.locator(".rule-size-add").click();
    const field = page.getByRole("spinbutton", { name: "No dark 1x value 1" });
    await field.fill("9");
    await expect(field).toHaveAttribute("aria-invalid", "true");
    await expect(control).not.toHaveClass(/selected/);
    await field.fill("8");
    await expect(field).not.toHaveAttribute("aria-invalid");
    await expect(control).toHaveClass(/selected/);
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

  /**
   * Merged cells, through a real drag — the one thing the unit tests cannot
   * check, since happy-dom has no layout and the gesture is hit-tested by
   * coordinate.
   */
  test("dragging the merge tool fuses squares into one cell", async ({
    page,
  }) => {
    await tool(page, "merge").click();
    await expect(page.locator("#tool-status")).toHaveText(
      "Selected tool: Merge cells · Right-click: Split cells",
    );

    await dragRow(page, 0, 0, 2);
    // The seams between the three squares are gone and the outer sides stay.
    await expect(cellAt(page, 0, 0)).toHaveClass(/cell-join-right/);
    await expect(cellAt(page, 1, 0)).toHaveClass(/cell-join-left/);
    await expect(cellAt(page, 1, 0)).toHaveClass(/cell-join-right/);
    await expect(cellAt(page, 2, 0)).not.toHaveClass(/cell-join-right/);

    // One click anywhere in it colors the whole cell.
    await tool(page, "dark").click();
    await cellAt(page, 2, 0).click();
    for (const x of [0, 1, 2]) {
      await expect(cellAt(page, x, 0)).toHaveAttribute("data-color", "dark");
    }
    await expect(cellAt(page, 3, 0)).toHaveAttribute("data-color", "unknown");

    // The seam between two squares of one cell is part of that cell, so
    // clicking it paints — it is bridged by a pseudo-element that hit-tests as
    // its own square rather than being a dead strip the pointer falls through.
    await tool(page, "erase").click();
    await cellAt(page, 0, 0).click();
    await expect(cellAt(page, 0, 0)).toHaveAttribute("data-color", "unknown");
    await tool(page, "dark").click();
    const left = (await cellAt(page, 0, 0).boundingBox())!;
    const right = (await cellAt(page, 1, 0).boundingBox())!;
    await page.mouse.click(
      (left.x + left.width + right.x) / 2,
      left.y + left.height / 2,
    );
    for (const x of [0, 1, 2]) {
      await expect(cellAt(page, x, 0)).toHaveAttribute("data-color", "dark");
    }

    // Right-dragging takes squares back out, and restructuring clears them.
    await tool(page, "merge").click();
    await dragRow(page, 0, 1, 1, "right");
    await expect(cellAt(page, 0, 0)).not.toHaveClass(/cell-join-right/);
    await expect(cellAt(page, 0, 0)).toHaveAttribute("data-color", "unknown");
  });

  /**
   * Every square of a merged cell carries its own clue slot. That matters
   * most for a dart, whose line starts on its own square — on a three-square
   * bar the same dart on each square is three different puzzles, and the
   * game's harder boards really do put several darts on one cell. Real
   * pointer presses rather than the unit tests' synthetic ones, since the
   * seam bridges and the arrow glyph are both in the way.
   */
  test("each square of a merged cell carries its own clue", async ({
    page,
  }) => {
    await tool(page, "merge").click();
    await dragRow(page, 0, 0, 2);

    await clueChip(page, "dart").click();
    await clueValue(page, "dart").fill("2");
    await cellAt(page, 2, 0).click();
    await expect(cellAt(page, 2, 0)).toHaveText(/2/);
    await expect(cellAt(page, 0, 0)).toHaveText("");
    await expect(cellAt(page, 1, 0)).toHaveText("");

    // Another square of the same cell ADDS a second clue — the multi-dart
    // boards — leaving the first where it was.
    await cellAt(page, 0, 0).click();
    await expect(cellAt(page, 0, 0)).toHaveText(/2/);
    await expect(cellAt(page, 2, 0)).toHaveText(/2/);

    // The same square again turns its OWN dart, the directed kinds' re-click
    // rule, and leaves the neighbor's alone. Presence is asserted BEFORE the
    // values are captured: with the attribute missing, both reads would be
    // null and the not-that-value assertion below would pass vacuously.
    await expect(cellAt(page, 0, 0)).toHaveAttribute("data-direction", /./);
    await expect(cellAt(page, 2, 0)).toHaveAttribute("data-direction", /./);
    const aimed = await cellAt(page, 0, 0).getAttribute("data-direction");
    const other = await cellAt(page, 2, 0).getAttribute("data-direction");
    await cellAt(page, 0, 0).click();
    await expect(cellAt(page, 0, 0)).not.toHaveAttribute(
      "data-direction",
      aimed!,
    );
    await expect(cellAt(page, 2, 0)).toHaveAttribute("data-direction", other!);
    await expect(cellAt(page, 0, 0)).toHaveText(/2/);
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

  /**
   * The dart is placed with its aim already set, and re-aimed afterwards by
   * dragging the arrow drawn on it. The drag is the half no unit test can
   * reach: happy-dom has no layout, and the gesture is hit-tested by where the
   * cursor sits relative to the middle of the tile.
   */
  test.describe("darts", () => {
    /** Arms the dart tool with a value and an aim, then stamps it on a cell. */
    async function placeDart(
      page: Page,
      x: number,
      y: number,
      value: string,
      direction: string,
    ) {
      await clueValue(page, "dart").fill(value);
      await directionToggle(page, "dart", direction).click();
      await cellAt(page, x, y).click();
    }

    test("stamps a number and an arrow together", async ({ page }) => {
      await placeDart(page, 1, 1, "2", "down");
      await expect(cellAt(page, 1, 1)).toHaveAttribute("data-symbol", "dart");
      await expect(cellAt(page, 1, 1)).toHaveAttribute("data-direction", "down");
      await expect(cellAt(page, 1, 1).locator(".cell-value")).toHaveText("2");
      await expect(cellAt(page, 1, 1)).toHaveAccessibleName(
        "Column 2, Row 2, Unknown, Dart 2 pointing down",
      );
    });

    test("exactly one arrow reads as chosen", async ({ page }) => {
      await directionToggle(page, "dart", "left").click();
      await expect(directionToggle(page, "dart", "left")).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await expect(directionToggle(page, "dart", "right")).toHaveAttribute(
        "aria-pressed",
        "false",
      );
    });

    /**
     * The re-click rule for a directed clue TURNS it rather than lifting, so
     * placing a row of darts and then aiming them is all plain clicks. Lifting
     * is the right button's job alone.
     */
    test("clicking a placed dart turns it clockwise", async ({ page }) => {
      await placeDart(page, 2, 2, "1", "right");
      const cell = cellAt(page, 2, 2);

      await cell.click();
      await expect(cell).toHaveAttribute("data-direction", "down");
      await cell.click();
      await expect(cell).toHaveAttribute("data-direction", "left");

      await cell.click({ button: "right" });
      await expect(cell).not.toHaveAttribute("data-direction", /.*/);
      await expect(cell).toHaveAccessibleName("Column 3, Row 3, Unknown");
    });

    test("an arrow key aims a focused dart", async ({ page }) => {
      await placeDart(page, 1, 0, "1", "right");
      await cellAt(page, 1, 0).press("ArrowUp");
      await expect(cellAt(page, 1, 0)).toHaveAttribute("data-direction", "up");
    });

    /**
     * The arrow SITS a quarter turn clockwise of the way it points, which is
     * how the game draws it. Only the stylesheet says so — `cellView.ts` just
     * writes the number, the arrow and `data-direction` — and only a real
     * browser has the layout to check it, so it is pinned here.
     */
    test("seats the arrow a quarter turn clockwise of its aim", async ({
      page,
    }) => {
      const seatOf = async (at: number, direction: string) => {
        await placeDart(page, at, 4, "1", direction);
        return cellAt(page, at, 4).evaluate(cell => {
          const n = cell.querySelector(".cell-value")!.getBoundingClientRect();
          const a = cell.querySelector(".cell-arrow")!.getBoundingClientRect();
          const dx = a.x - n.x;
          const dy = a.y - n.y;
          if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? "right" : "left";
          return dy > 0 ? "below" : "above";
        });
      };

      expect(await seatOf(0, "up")).toBe("right");
      expect(await seatOf(1, "right")).toBe("below");
      expect(await seatOf(2, "down")).toBe("left");
      expect(await seatOf(3, "left")).toBe("above");
    });

  });

  /**
   * The viewpoint is the dart without the pointing: a number-carrying kind
   * whose four chevrons are decoration for its four rays, so its control is
   * chip + field with no toggles, and re-clicking lifts rather than turns.
   */
  test.describe("viewpoints", () => {
    /** Arms the viewpoint tool with a value, then stamps it on a cell. */
    async function placeViewpoint(
      page: Page,
      x: number,
      y: number,
      value: string,
    ) {
      await clueValue(page, "viewpoint").fill(value);
      await cellAt(page, x, y).click();
    }

    test("stamps a number ringed by four chevrons", async ({ page }) => {
      await placeViewpoint(page, 1, 1, "3");
      const cell = cellAt(page, 1, 1);
      await expect(cell).toHaveAttribute("data-symbol", "viewpoint");
      await expect(cell).toHaveAttribute("data-viewpoint", "");
      await expect(cell.locator(".cell-value")).toHaveText("3");
      await expect(cell.locator(".cell-chevron")).toHaveCount(4);
      await expect(cell).toHaveAccessibleName(
        "Column 2, Row 2, Unknown, Viewpoint 3",
      );
    });

    test("has no direction toggles beside its chip", async ({ page }) => {
      await expect(
        page.locator(
          '#symbol-row .symbol-tool[data-symbol="viewpoint"] .direction-toggle',
        ),
      ).toHaveCount(0);
      // But it does have its own value field, unlike the symmetry symbol.
      await expect(clueValue(page, "viewpoint")).toHaveAttribute("min", "1");
      await expect(clueValue(page, "viewpoint")).toHaveAttribute("max", "11");
    });

    /** Nothing to turn, so the directed kinds' re-click rule never fires. */
    test("re-clicking a placed viewpoint lifts it", async ({ page }) => {
      await placeViewpoint(page, 2, 2, "2");
      const cell = cellAt(page, 2, 2);
      await cell.click();
      await expect(cell).not.toHaveAttribute("data-viewpoint", /.*/);
      await expect(cell).toHaveAccessibleName("Column 3, Row 3, Unknown");
    });

    /**
     * The chevrons hug the tile's edges with the number centered between them
     * — only the stylesheet says so, and only a real browser has the layout
     * to check it.
     */
    test("seats the four chevrons at the tile's edges", async ({ page }) => {
      await placeViewpoint(page, 1, 1, "2");
      const sides = await cellAt(page, 1, 1).evaluate(cell => {
        const box = cell.getBoundingClientRect();
        const middle = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        return [...cell.querySelectorAll(".cell-chevron")].map(chevron => {
          const ink = chevron.getBoundingClientRect();
          const dx = ink.x + ink.width / 2 - middle.x;
          const dy = ink.y + ink.height / 2 - middle.y;
          if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? "right" : "left";
          return dy > 0 ? "below" : "above";
        });
      });
      expect([...sides].sort()).toEqual(["above", "below", "left", "right"]);
    });
  });

  /**
   * The symmetry symbol is the dart's counterpart with an AXIS instead of a
   * number: a control with no value field, one glyph turned four ways — and,
   * on a merged cell, a SEAT on the grid lines that only a real pointer
   * position can choose, which is the half no unit test reaches.
   */
  test.describe("symmetry", () => {
    function axisToggle(page: Page, axis: string) {
      return page.locator(
        `#symbol-row .symbol-tool[data-symbol="lotus"] ` +
          `.direction-toggle[data-axis="${axis}"]`,
      );
    }

    async function placeLotus(page: Page, x: number, y: number, axis: string) {
      await axisToggle(page, axis).click();
      await cellAt(page, x, y).click();
    }

    test("has no value field and stamps the rotated glyph", async ({
      page,
    }) => {
      await expect(
        page.locator(
          '#symbol-row .symbol-tool[data-symbol="lotus"] .symbol-value',
        ),
      ).toHaveCount(0);
      await placeLotus(page, 1, 1, "vertical");
      const cell = cellAt(page, 1, 1);
      await expect(cell).toHaveAttribute("data-symbol", "lotus");
      await expect(cell).toHaveAttribute("data-axis", "vertical");
      await expect(cell).toHaveAccessibleName(
        "Column 2, Row 2, Unknown, Symmetry along the vertical axis",
      );
    });

    test("exactly one axis reads as chosen", async ({ page }) => {
      await axisToggle(page, "diagonal-up").click();
      await expect(axisToggle(page, "diagonal-up")).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await expect(axisToggle(page, "horizontal")).toHaveAttribute(
        "aria-pressed",
        "false",
      );
    });

    test("clicking a placed symbol turns it 45 degrees", async ({ page }) => {
      await placeLotus(page, 2, 2, "horizontal");
      const cell = cellAt(page, 2, 2);

      await cell.click();
      await expect(cell).toHaveAttribute("data-axis", "diagonal-down");
      await cell.click();
      await expect(cell).toHaveAttribute("data-axis", "vertical");

      await cell.click({ button: "right" });
      await expect(cell).not.toHaveAttribute("data-axis", /.*/);
      await expect(cell).toHaveAccessibleName("Column 3, Row 3, Unknown");
    });

    /** Compass keys do not name axes, so the horizontal pair steps instead. */
    test("the horizontal arrows rotate a focused symbol", async ({ page }) => {
      await placeLotus(page, 1, 0, "horizontal");
      const cell = cellAt(page, 1, 0);
      await cell.press("ArrowRight");
      await expect(cell).toHaveAttribute("data-axis", "diagonal-down");
      await cell.press("ArrowLeft");
      await expect(cell).toHaveAttribute("data-axis", "horizontal");
    });

    /**
     * The seat. Pressed near the seam inside a merged cell, the symbol sits ON
     * the grid line between the two squares — `data-seat` slides the glyph
     * half a square over — and turning there skips the diagonals, which have
     * no reflection on a grid-line seat to offer.
     */
    test("a press near a merged cell's seam seats the symbol on it", async ({
      page,
    }) => {
      await tool(page, "merge").click();
      await dragRow(page, 0, 0, 1);

      await axisToggle(page, "vertical").click();
      const cell = cellAt(page, 0, 0);
      const box = (await cell.boundingBox())!;
      const seam = { x: box.width - 2, y: box.height / 2 };
      await cell.click({ position: seam });
      await expect(cell).toHaveAttribute("data-seat", "1");
      await expect(cell).toHaveAttribute("data-axis", "vertical");

      await cell.click({ position: seam });
      await expect(cell).toHaveAttribute("data-axis", "horizontal");
      await expect(cell).toHaveAttribute("data-seat", "1");
    });
  });

  test.describe("galaxies", () => {
    /** The first chip-only kind: no field, no toggles — the chip is the whole
     * control, and the tile is one glyph. */
    test("has a bare chip and stamps the icon", async ({ page }) => {
      const control = page.locator(
        '#symbol-row .symbol-tool[data-symbol="galaxy"]',
      );
      await expect(control.locator(".symbol-value")).toHaveCount(0);
      await expect(control.locator(".direction-toggle")).toHaveCount(0);

      await clueChip(page, "galaxy").click();
      const cell = cellAt(page, 1, 1);
      await cell.click();
      await expect(cell).toHaveAttribute("data-symbol", "galaxy");
      await expect(cell).toHaveAccessibleName(
        "Column 2, Row 2, Unknown, Galaxy",
      );
      await expect(cell.locator("md-icon")).toHaveText("cyclone");
    });

    /** Nothing to turn, so the second press is a plain lift — the dart's
     * turns-instead rule never fires for a kind with no direction. */
    test("re-clicking lifts it", async ({ page }) => {
      await clueChip(page, "galaxy").click();
      const cell = cellAt(page, 2, 2);
      await cell.click();
      await expect(cell).toHaveAttribute("data-symbol", "galaxy");
      await cell.click();
      await expect(cell).not.toHaveAttribute("data-symbol", /.*/);
      await expect(cell).toHaveAccessibleName("Column 3, Row 3, Unknown");
    });

    /**
     * A galaxy's center may sit on a grid line — and unlike the lotus's it
     * needs NO merged cell under it, which is the whole point: a half turn
     * about a point needs nothing to hold the point up.
     */
    test("a press near a plain square's seam seats it on the line", async ({
      page,
    }) => {
      await clueChip(page, "galaxy").click();
      const cell = cellAt(page, 1, 1);
      const box = (await cell.boundingBox())!;
      await cell.click({ position: { x: box.width - 2, y: box.height / 2 } });
      await expect(cell).toHaveAttribute("data-seat", "1");
      await expect(cell).toHaveAttribute("data-symbol", "galaxy");
      // The glyph overhangs its neighbor but the CLUE does not move there.
      await expect(cellAt(page, 2, 1)).not.toHaveAttribute("data-symbol", /.*/);
    });

    /**
     * A seated galaxy lies across two squares, and its whole point is that
     * they may be different colors — where one glyph of one color is
     * invisible over half of itself. Each half is therefore its own copy,
     * clipped to the part of the glyph over one square and inked against THAT
     * square, so the pair comes out dark beside light.
     *
     * Only a browser can settle this: the halves are cut by `clip-path` and
     * their ink comes from the stylesheet, neither of which a stub DOM has.
     * What is asserted is that the two halves differ and each contrasts with
     * what it lies on — never the tokens themselves, which are the theme's to
     * change.
     */
    test("a seated galaxy is inked against each square", async ({ page }) => {
      await tool(page, "dark").click();
      await cellAt(page, 1, 1).click();
      await tool(page, "light").click();
      await cellAt(page, 2, 1).click();

      await clueChip(page, "galaxy").click();
      const cell = cellAt(page, 1, 1);
      const box = (await cell.boundingBox())!;
      await page.mouse.click(box.x + box.width + 3, box.y + box.height / 2);
      await expect(cell).toHaveAttribute("data-seat", "1");

      const halves = cell.locator("md-icon.cell-galaxy");
      await expect(halves).toHaveCount(2);
      await expect(halves.nth(0)).toHaveAttribute("data-under", "dark");
      await expect(halves.nth(1)).toHaveAttribute("data-under", "light");

      const inks = await halves.evaluateAll(nodes =>
        nodes.map(node => getComputedStyle(node).color),
      );
      expect(inks[0]).not.toBe(inks[1]);
      // Each half's ink is the color the square UNDER it is not: the left
      // half lies on dark, so it takes the ink a light square is drawn in,
      // and the right half the other way about.
      const fills = await page.evaluate(() => {
        const at = (x: number, y: number) =>
          getComputedStyle(
            document.querySelector(
              `#grid .grid-cell[data-x="${x}"][data-y="${y}"]`,
            )!,
          ).backgroundColor;
        return { dark: at(1, 1), light: at(2, 1) };
      });
      expect(inks[0]).not.toBe(fills.dark);
      expect(inks[1]).not.toBe(fills.light);
    });

    /**
     * The squares a seated galaxy lies across are drawn as ONE tile, so the
     * color changes at the edge where they meet rather than across the seam —
     * which is what the game shows and what two rimmed boxes with a gap
     * between them cannot say. The squares paint nothing; the outline layer
     * paints one path per color the tile holds.
     */
    test("a seated galaxy joins its squares into one tile", async ({ page }) => {
      await tool(page, "dark").click();
      await cellAt(page, 1, 1).click();
      await tool(page, "light").click();
      await cellAt(page, 2, 1).click();

      await clueChip(page, "galaxy").click();
      const cell = cellAt(page, 1, 1);
      const box = (await cell.boundingBox())!;
      await page.mouse.click(box.x + box.width + 3, box.y + box.height / 2);
      await expect(cell).toHaveAttribute("data-seat", "1");

      await expect(cell).toHaveClass(/cell-pair-right/);
      await expect(cellAt(page, 2, 1)).toHaveClass(/cell-pair-left/);
      // Both squares stop painting themselves, exactly as a merged cell's do.
      // `toHaveCSS` rather than one read of the computed style: the squares
      // carry a background transition, so a single sample catches it partway.
      await expect(cell).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect(cellAt(page, 2, 1)).toHaveCSS(
        "background-color",
        "rgba(0, 0, 0, 0)",
      );
      // One outline path per color of the tile, and they really differ.
      const fills = await page.locator("#grid .shape-outline path").evaluateAll(
        nodes => nodes.map(node => getComputedStyle(node).fill),
      );
      expect(fills).toHaveLength(2);
      expect(fills[0]).not.toBe(fills[1]);
    });

    /**
     * The pill's own state machine, and the reason this block is as long as it
     * is: every one of these was found by hand on the real page, and none of
     * them failed a test at the time.
     */

    /** The point in the seam to the RIGHT of a square, where a seat 1 lives. */
    const seatRight = async (page: Page, x: number, y: number) => {
      await clueChip(page, "galaxy").click();
      const box = (await cellAt(page, x, y).boundingBox())!;
      await page.mouse.click(box.x + box.width + 3, box.y + box.height / 2);
    };
    /** Every tile the editor's outline layer is drawing, by color. */
    const tileFills = (page: Page) =>
      page
        .locator("#grid .shape-outline path")
        .evaluateAll(nodes =>
          nodes.map(node => (node as SVGElement).dataset.color),
        );
    /** The `data-under` of each half of a seated glyph. */
    const glyphInks = (page: Page, x: number, y: number) =>
      cellAt(page, x, y)
        .locator("md-icon.cell-galaxy")
        .evaluateAll(nodes =>
          nodes.map(node => (node as HTMLElement).dataset.under),
        );

    /**
     * One square painted is enough to JOIN the pair, and the square that is
     * not painted stays plainly unpainted — drawn as a neutral part of the
     * tile, never borrowed from its partner. Borrowing was tried and turned
     * three untouched squares of a corner seat solid black, so the board
     * stopped saying which squares were really colored.
     */
    test("a pill with one square painted leaves the other neutral", async ({
      page,
    }) => {
      await tool(page, "dark").click();
      await cellAt(page, 1, 1).click();
      await seatRight(page, 1, 1);

      expect((await tileFills(page)).sort()).toEqual(["blank", "dark"]);
      await expect(cellAt(page, 2, 1)).toHaveClass(/cell-pair-left/);
      await expect(cellAt(page, 2, 1)).toHaveAttribute("data-color", "unknown");
      await expect(cellAt(page, 2, 1)).toHaveAccessibleName(
        "Column 3, Row 2, Unknown",
      );
      // The glyph inks each half against what is under it, and the half over
      // the neutral part falls back to the surface ink rather than to whatever
      // the clue's own square happened to hold.
      expect(await glyphInks(page, 1, 1)).toEqual(["dark", "unknown"]);
    });

    /**
     * A press changes the square it lands on and nothing else. With the pill
     * borrowing a color this was not true: painting the square that HELD the
     * color repainted the whole pill, so you could not put black on one half
     * of a white pill.
     */
    test("each press colors only the square it lands on", async ({ page }) => {
      await tool(page, "light").click();
      await cellAt(page, 1, 1).click();
      await seatRight(page, 1, 1);
      expect((await tileFills(page)).sort()).toEqual(["blank", "light"]);

      // The painted half, repainted: the other half stays neutral.
      await tool(page, "dark").click();
      await cellAt(page, 1, 1).click();
      expect((await tileFills(page)).sort()).toEqual(["blank", "dark"]);
      await expect(cellAt(page, 2, 1)).toHaveAttribute("data-color", "unknown");

      // ...and the neutral half takes a color of its own. One path per COLOR
      // the tile holds, so two dark squares are one path, not two.
      await cellAt(page, 2, 1).click();
      expect(await tileFills(page)).toEqual(["dark"]);
      await expect(cellAt(page, 1, 1)).toHaveAttribute("data-color", "dark");
    });

    /** Nothing painted, nothing joined: the pre-pill look, one plain glyph. */
    test("an unpainted pair is not drawn as a pill", async ({ page }) => {
      await seatRight(page, 1, 1);
      expect(await tileFills(page)).toEqual([]);
      await expect(cellAt(page, 1, 1)).not.toHaveClass(/cell-pair/);
      await expect(cellAt(page, 2, 1)).not.toHaveClass(/cell-pair/);
      await expect(cellAt(page, 1, 1).locator("md-icon.cell-galaxy")).toHaveCount(
        1,
      );
      await expect(cellAt(page, 1, 1)).toHaveCSS("border-style", "dashed");
    });

    /** The whole round trip, which is what catches a stale tile cache. */
    test("the pill appears with the first color and goes with the last", async ({
      page,
    }) => {
      await seatRight(page, 1, 1);
      expect(await tileFills(page)).toEqual([]);

      await tool(page, "light").click();
      await cellAt(page, 2, 1).click();
      expect((await tileFills(page)).sort()).toEqual(["blank", "light"]);

      await cellAt(page, 2, 1).click(); // re-click erases
      expect(await tileFills(page)).toEqual([]);
      await expect(cellAt(page, 1, 1)).not.toHaveClass(/cell-pair/);
      await expect(cellAt(page, 2, 1)).toHaveCSS("border-style", "dashed");
    });

    /**
     * The glyph sits on the clue's square, so painting its PARTNER has to
     * repaint a square nothing else would think to touch. Getting that wrong
     * is why one paint order worked and the other did not.
     */
    test("painting either square first ends at the same picture", async ({
      page,
    }) => {
      const build = async (first: "dark" | "light") => {
        await seatRight(page, 1, 1);
        await tool(page, first === "dark" ? "dark" : "light").click();
        await cellAt(page, first === "dark" ? 1 : 2, 1).click();
        await tool(page, first === "dark" ? "light" : "dark").click();
        await cellAt(page, first === "dark" ? 2 : 1, 1).click();
        return {
          fills: (await tileFills(page)).sort(),
          inks: await glyphInks(page, 1, 1),
        };
      };
      const darkFirst = await build("dark");
      await page.reload();
      await page.locator("#grid .grid-cell").first().waitFor();
      const lightFirst = await build("light");

      expect(darkFirst.inks).toEqual(["dark", "light"]);
      expect(darkFirst).toEqual(lightFirst);
    });

    /**
     * A galaxy occupies the squares its seat sits between, and no two of them
     * may share one. All three of these were reachable by hand, and the last
     * by a single drag.
     */
    test("a galaxy cannot be placed inside another galaxy's squares", async ({
      page,
    }) => {
      await seatRight(page, 1, 1);
      await expect(cellAt(page, 1, 1)).toHaveAttribute("data-seat", "1");

      // The center of the square the pill runs into.
      await cellAt(page, 2, 1).click();
      await expect(cellAt(page, 2, 1)).not.toHaveAttribute("data-symbol", /.*/);
      // ...and the next seam along, which would share that square too.
      await seatRight(page, 2, 1);
      await expect(cellAt(page, 2, 1)).not.toHaveAttribute("data-symbol", /.*/);
      await expect(cellAt(page, 1, 1)).toHaveAttribute("data-seat", "1");
    });

    test("a centered galaxy blocks a pill that would run through it", async ({
      page,
    }) => {
      await clueChip(page, "galaxy").click();
      await cellAt(page, 2, 1).click();
      await expect(cellAt(page, 2, 1)).toHaveAttribute("data-symbol", "galaxy");

      await seatRight(page, 1, 1);
      await expect(cellAt(page, 1, 1)).not.toHaveAttribute("data-symbol", /.*/);
    });

    /**
     * Two galaxies on different squares of one MERGED cell are two centers of
     * rotational symmetry for one region, which no coloring can satisfy — so
     * the cell, not the square, is the unit two galaxies may not share.
     */
    test("a merged cell may not carry two galaxies", async ({ page }) => {
      await tool(page, "merge").click();
      const from = (await cellAt(page, 1, 1).boundingBox())!;
      const to = (await cellAt(page, 2, 1).boundingBox())!;
      await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
      await page.mouse.down();
      await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2);
      await page.mouse.up();
      await expect(cellAt(page, 1, 1)).toHaveClass(/cell-join-right/);

      await clueChip(page, "galaxy").click();
      await cellAt(page, 1, 1).click();
      await expect(cellAt(page, 1, 1)).toHaveAttribute("data-symbol", "galaxy");
      await cellAt(page, 2, 1).click();
      await expect(cellAt(page, 2, 1)).not.toHaveAttribute("data-symbol", /.*/);
    });

    /** The guard's own regression test: this is a MOVE, not a clash. */
    test("re-seating a galaxy is not an overlap", async ({ page }) => {
      await seatRight(page, 1, 1);
      await expect(cellAt(page, 1, 1)).toHaveAttribute("data-seat", "1");
      await cellAt(page, 1, 1).click();
      await expect(cellAt(page, 1, 1)).toHaveAttribute("data-symbol", "galaxy");
      await expect(cellAt(page, 1, 1)).not.toHaveAttribute("data-seat", /.*/);
    });

    /**
     * A gap cannot be half of a pill: an SVG fill cannot be the hatch a gap is
     * drawn with, and a square the puzzle does not color is not part of a
     * cell anyway. This also pins the write that moves BOTH layers at once —
     * painting a square unplayable drops the clue with it.
     */
    test("painting a pill's square unplayable drops the pill", async ({
      page,
    }) => {
      await tool(page, "dark").click();
      await cellAt(page, 1, 1).click();
      await tool(page, "light").click();
      await cellAt(page, 2, 1).click();
      await seatRight(page, 1, 1);
      expect(await tileFills(page)).toHaveLength(2);

      await tool(page, "unplayable").click();
      await cellAt(page, 2, 1).click();
      expect(await tileFills(page)).toEqual([]);
      await expect(cellAt(page, 1, 1)).not.toHaveClass(/cell-pair/);
    });

    /** The eraser writes a color AND drops the clue in one go. */
    test("erasing the galaxy's own square drops the pill", async ({ page }) => {
      await tool(page, "dark").click();
      await cellAt(page, 1, 1).click();
      await tool(page, "light").click();
      await cellAt(page, 2, 1).click();
      await seatRight(page, 1, 1);
      expect(await tileFills(page)).toHaveLength(2);

      await tool(page, "erase").click();
      await cellAt(page, 1, 1).click();
      await expect(cellAt(page, 1, 1)).not.toHaveAttribute("data-symbol", /.*/);
      expect(await tileFills(page)).toEqual([]);
      await expect(cellAt(page, 2, 1)).not.toHaveClass(/cell-pair/);
    });

    /** Two pills that only touch are two pills, and nothing bridges them. */
    test("two pills side by side stay two tiles", async ({ page }) => {
      await tool(page, "dark").click();
      for (const x of [0, 1, 2, 3]) await cellAt(page, x, 1).click();
      await seatRight(page, 0, 1);
      await seatRight(page, 2, 1);

      expect(await tileFills(page)).toEqual(["dark", "dark"]);
      await expect(cellAt(page, 1, 1)).toHaveClass(/cell-pair-left/);
      await expect(cellAt(page, 1, 1)).not.toHaveClass(/cell-pair-right/);
      await expect(cellAt(page, 2, 1)).toHaveClass(/cell-pair-right/);
      await expect(cellAt(page, 2, 1)).not.toHaveClass(/cell-pair-left/);
    });

    test("a press near a corner seats it on the corner", async ({ page }) => {
      await clueChip(page, "galaxy").click();
      const cell = cellAt(page, 1, 1);
      const box = (await cell.boundingBox())!;
      // Inside the square's 8px border-radius: the extreme corner is outside
      // the rounded shape, so a hit test there lands on the grid behind it.
      await cell.click({ position: { x: box.width - 6, y: box.height - 6 } });
      await expect(cell).toHaveAttribute("data-seat", "3");
    });

    /**
     * The seams between the squares are clickable while a seated clue is
     * armed, which is what makes a galaxy on a grid line reachable: its point
     * IS the gap, so asking the player to hit the square and lean is
     * backwards. The crossing of four squares is the case that matters most —
     * it is where a corner-seated galaxy obviously belongs.
     */
    test("a press in the seam itself seats it on the line", async ({
      page,
    }) => {
      await clueChip(page, "galaxy").click();
      const cell = cellAt(page, 1, 1);
      const box = (await cell.boundingBox())!;
      // Halfway into the 6px seam to the right of (1,1).
      await page.mouse.click(box.x + box.width + 3, box.y + box.height / 2);
      await expect(cell).toHaveAttribute("data-symbol", "galaxy");
      await expect(cell).toHaveAttribute("data-seat", "1");
    });

    test("a press on the crossing of four squares seats it on the corner", async ({
      page,
    }) => {
      await clueChip(page, "galaxy").click();
      const cell = cellAt(page, 1, 1);
      const box = (await cell.boundingBox())!;
      await page.mouse.click(box.x + box.width + 3, box.y + box.height + 3);
      await expect(cell).toHaveAttribute("data-seat", "3");
      // The crossing belongs to the top-left of the four and to nothing else.
      await expect(cellAt(page, 2, 2)).not.toHaveAttribute("data-symbol", /.*/);
    });

    /** The seams are open for a SEATED clue and shut for everything else: a
     * color has no meaning in a gap, and widening those targets would change
     * what a drag across the board paints. */
    test("the seams are shut again for a paint tool", async ({ page }) => {
      await clueChip(page, "galaxy").click();
      await expect(page.locator("#grid")).toHaveAttribute("data-seams", "");
      await tool(page, "dark").click();
      await expect(page.locator("#grid")).not.toHaveAttribute(
        "data-seams",
        /.*/,
      );

      // ...and a press in the seam paints nothing.
      const box = (await cellAt(page, 1, 1).boundingBox())!;
      await page.mouse.click(box.x + box.width + 3, box.y + box.height / 2);
      await expect(cellAt(page, 1, 1)).toHaveAttribute("data-color", "unknown");
      await expect(cellAt(page, 2, 1)).toHaveAttribute("data-color", "unknown");
    });

    /** A seat at the board's edge has no square to sit against, so the press
     * falls back to the square's own center rather than being refused. */
    test("a seat that would leave the board falls back to the center", async ({
      page,
    }) => {
      await clueChip(page, "galaxy").click();
      const cell = cellAt(page, 5, 5);
      const box = (await cell.boundingBox())!;
      await cell.click({ position: { x: box.width - 2, y: box.height / 2 } });
      await expect(cell).toHaveAttribute("data-symbol", "galaxy");
      await expect(cell).not.toHaveAttribute("data-seat", /.*/);
    });
  });
});
