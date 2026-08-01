import { expect, test, type Page } from "@playwright/test";

/**
 * Gives one dial its shape and starting position through the controls a player
 * uses: the −/+ under the dial, then the pointer itself.
 */
async function setDial(
  page: Page,
  color: string,
  positions: number,
  value: number,
) {
  const card = page.locator(`.dial-card[data-color="${color}"]`);
  const face = card.getByRole("slider");
  const max = Number(await face.getAttribute("aria-valuemax"));

  const more = card.getByRole("button", {
    name: `More positions on the ${color} dial`,
  });
  const fewer = card.getByRole("button", {
    name: `Fewer positions on the ${color} dial`,
  });
  for (let i = max + 1; i < positions; i++) await more.click();
  for (let i = max + 1; i > positions; i--) await fewer.click();

  await face.press("Home");
  for (let i = 0; i < value; i++) await face.press("ArrowRight");
}

function setTurns(page: Page, button: number, color: string, turns: number) {
  return page
    .getByRole("spinbutton", { name: `Button ${button} ${color} turns` })
    .fill(String(turns));
}

/** The `Button N — M presses` rows, flattened for a single assertion. */
function resultRows(page: Page) {
  return page.locator("#result .result-row");
}

test.describe("Phasic Dial Solver", () => {
  test("test solver with basic solvable state", async ({ page }) => {
    await page.goto("/phasic-dial-solver");

    await setDial(page, "blue", 4, 3);
    await setDial(page, "red", 6, 0);
    await page.getByRole("button", { name: "Add a button" }).click();
    await page.getByRole("button", { name: "Add a button" }).click();

    await setTurns(page, 1, "blue", 2);
    await setTurns(page, 2, "blue", 1);
    await setTurns(page, 2, "red", 2);
    await setTurns(page, 3, "blue", 1);
    await setTurns(page, 3, "red", 3);

    await page.getByRole("button", { name: "Calculate Turns" }).click();

    await expect(resultRows(page)).toHaveCount(2);
    await expect(resultRows(page).nth(0)).toContainText("Button 1");
    await expect(resultRows(page).nth(0)).toContainText("1 press");
    await expect(resultRows(page).nth(1)).toContainText("Button 2");
    await expect(resultRows(page).nth(1)).toContainText("3 presses");
    await expect(page.locator(".result-summary")).toHaveText(
      "4 presses in total",
    );
  });

  test("test solver with complex solvable state", async ({ page }) => {
    await page.goto("/phasic-dial-solver");

    for (let i = 0; i < 3; i++) {
      await page.getByRole("button", { name: "Add a dial" }).click();
    }
    await setDial(page, "blue", 6, 4);
    await setDial(page, "red", 5, 1);
    await setDial(page, "green", 6, 2);
    await setDial(page, "yellow", 5, 1);
    await setDial(page, "cyan", 5, 4);

    for (let i = 0; i < 4; i++) {
      await page.getByRole("button", { name: "Add a button" }).click();
    }
    await setTurns(page, 1, "blue", 1);
    await setTurns(page, 1, "red", 2);
    await setTurns(page, 1, "green", 3);
    await setTurns(page, 1, "yellow", 1);
    await setTurns(page, 1, "cyan", 2);
    await setTurns(page, 2, "blue", 1);
    await setTurns(page, 3, "red", 3);
    await setTurns(page, 4, "green", 1);
    await setTurns(page, 5, "cyan", 1);

    await page.getByRole("button", { name: "Calculate Turns" }).click();

    await expect(resultRows(page)).toHaveCount(5);
    const counts = page.locator("#result .result-count");
    await expect(counts.nth(0)).toHaveText("4 presses");
    await expect(counts.nth(1)).toHaveText("4 presses");
    await expect(counts.nth(2)).toHaveText("2 presses");
    await expect(counts.nth(3)).toHaveText("4 presses");
    await expect(counts.nth(4)).toHaveText("3 presses");
  });

  test("aiming every dial at the hub needs no presses at all", async ({
    page,
  }) => {
    await page.goto("/phasic-dial-solver");

    await expect(page.locator('.dial-card[data-solved="true"]')).toHaveCount(2);

    await page.getByRole("button", { name: "Calculate Turns" }).click();

    await expect(page.locator("#result")).toHaveText(
      "Already solved! No button presses needed.",
    );
  });
});
