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

  /** A row per kind of tool: what clears the board, what colours it, what clues it. */
  test("groups the tools into rows by what they do", async ({ page }) => {
    await expect(page.locator("#command-row .tool-button")).toHaveCount(2);
    // Four: the three colours plus merge, which also changes what the board is
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

  /** The rule row is a column of headed bands, not one long list. */
  test("groups the rules into headed bands", async ({ page }) => {
    await expect(page.locator("#rule-row .rule-band")).toHaveCount(4);
    await expect(page.locator("#rule-row .rule-band-heading")).toHaveText([
      "Arrangement",
      "Region",
      "Symbol",
      "Answer",
    ]);
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
   * browser so focus hand-off and the number field's behaviour are the real
   * things.
   */
  test("a sized rule takes its number in the row", async ({ page }) => {
    const control = page.locator(
      '#rule-row .rule-sized[data-sized-control="area-dark"]',
    );
    await expect(control.locator(".rule-size")).toHaveCount(0);

    await control.locator(".rule-size-add").click();
    const field = page.getByRole("spinbutton", {
      name: "Dark regions have area value 1",
    });
    // The new slot takes focus, so the number can be typed straight away.
    await expect(field).toBeFocused();
    await field.fill("3");
    await expect(control).toHaveClass(/selected/);

    // A second instance of the same family and colour is one more "+".
    await control.locator(".rule-size-add").click();
    await page
      .getByRole("spinbutton", { name: "Dark regions have area value 2" })
      .fill("5");
    await expect(control.locator(".rule-size")).toHaveCount(2);

    // An emptied slot disappears when it is left.
    await field.fill("");
    await field.blur();
    await expect(control.locator(".rule-size")).toHaveCount(1);
    await expect(control.locator(".rule-size")).toHaveValue("5");
    await expect(control).toHaveClass(/selected/);
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

    // One click anywhere in it colours the whole cell.
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
    // rule, and leaves the neighbour's alone. Presence is asserted BEFORE the
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
     * The chevrons hug the tile's edges with the number centred between them
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
  });
});
