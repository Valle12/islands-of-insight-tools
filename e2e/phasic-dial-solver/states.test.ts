import { expect, test, type Page } from "@playwright/test";

/** Aims one dial's pointer at the given position. */
async function aim(page: Page, color: string, value: number) {
  const face = page.locator(`.dial-card[data-color="${color}"]`).getByRole(
    "slider",
  );
  await face.press("Home");
  for (let i = 0; i < value; i++) await face.press("ArrowRight");
}

function setTurns(page: Page, button: number, color: string, turns: number) {
  return page
    .getByRole("spinbutton", { name: `Button ${button} ${color} turns` })
    .fill(String(turns));
}

test.describe("Phasic Dial Solver", () => {
  test("test solver with solved state", async ({ page }) => {
    await page.goto("/phasic-dial-solver");

    // Two square dials, both already aimed at the hub.
    await expect(page.locator("#dials-list")).toMatchAriaSnapshot(`
      - text: Blue
      - slider "Blue dial position"
      - button "Fewer positions on the blue dial"
      - text: 4 positions
      - button "More positions on the blue dial"
      - text: Aimed at the hub Red
      - slider "Red dial position"
      - button "Fewer positions on the red dial"
      - text: 4 positions
      - button "More positions on the red dial"
      - text: Aimed at the hub
    `);

    await page.getByRole("button", { name: "Calculate Turns" }).click();
    await expect(page.locator("#result")).toHaveText(
      "Already solved! No button presses needed.",
    );

    // Adding a dial invalidates the answer without being asked twice.
    await page.getByRole("button", { name: "Add a dial" }).click();
    await expect(page.locator("#result")).toBeHidden();
    await expect(page.locator(".dial-card")).toHaveCount(3);
    await expect(page.locator(".button-card .turn-slot")).toHaveCount(3);

    await page.getByRole("button", { name: "Calculate Turns" }).click();
    await expect(page.locator("#result")).toHaveText(
      "Already solved! No button presses needed.",
    );

    // …and so does adding a button.
    await page.getByRole("button", { name: "Add a button" }).click();
    await expect(page.locator("#result")).toBeHidden();
    await expect(page.locator("#buttons-list")).toMatchAriaSnapshot(`
      - text: Button 1
      - button "Delete button 1"
      - button "One fewer blue turn on button 1"
      - spinbutton "Button 1 blue turns"
      - button "One more blue turn on button 1"
      - text: Blue
      - button "One fewer red turn on button 1"
      - spinbutton "Button 1 red turns"
      - button "One more red turn on button 1"
      - text: Red
      - button "One fewer green turn on button 1"
      - spinbutton "Button 1 green turns"
      - button "One more green turn on button 1"
      - text: Green Button 2
      - button "Delete button 2"
      - button "One fewer blue turn on button 2"
      - spinbutton "Button 2 blue turns"
      - button "One more blue turn on button 2"
      - text: Blue
      - button "One fewer red turn on button 2"
      - spinbutton "Button 2 red turns"
      - button "One more red turn on button 2"
      - text: Red
      - button "One fewer green turn on button 2"
      - spinbutton "Button 2 green turns"
      - button "One more green turn on button 2"
      - text: Green
    `);
  });

  test("test solver with unsolvable state", async ({ page }) => {
    await page.goto("/phasic-dial-solver");

    // One dial off the hub and no button that turns anything.
    await aim(page, "blue", 1);
    await page.getByRole("button", { name: "Calculate Turns" }).click();
    await expect(page.locator("#result")).toHaveText("No solution found.");

    // Four dials, four buttons, each turning a dial the puzzle cannot use to
    // reach zero on every dial at once.
    await page.getByRole("button", { name: "Add a dial" }).click();
    await page.getByRole("button", { name: "Add a dial" }).click();
    for (let i = 0; i < 3; i++) {
      await page.getByRole("button", { name: "Add a button" }).click();
    }
    await setTurns(page, 1, "blue", 1);
    await setTurns(page, 2, "red", 1);
    await setTurns(page, 3, "green", 1);
    for (const color of ["blue", "red", "green", "yellow"]) {
      await aim(page, color, 1);
    }

    await page.getByRole("button", { name: "Calculate Turns" }).click();
    await expect(page.locator("#result")).toHaveText("No solution found.");
    await expect(page.locator(".button-presses").first()).toBeHidden();
  });

  test("a dial reports its shape and position as it is turned", async ({
    page,
  }) => {
    await page.goto("/phasic-dial-solver");

    const blue = page.locator('.dial-card[data-color="blue"]');
    const face = blue.getByRole("slider");
    await expect(blue).toHaveAttribute("data-solved", "true");

    await blue
      .getByRole("button", { name: "More positions on the blue dial" })
      .click();
    await blue
      .getByRole("button", { name: "More positions on the blue dial" })
      .click();
    await expect(blue.locator(".dial-sides-count")).toHaveText("6 positions");
    await expect(face).toHaveAttribute("aria-valuemax", "5");

    await face.press("ArrowRight");
    await expect(face).toHaveAttribute("aria-valuenow", "1");
    await expect(blue).toHaveAttribute("data-solved", "false");
    await expect(blue.locator(".dial-state")).toHaveText("Position 1");

    // Six steps clockwise on a six-position dial is a full turn.
    for (let i = 0; i < 5; i++) await face.press("ArrowRight");
    await expect(face).toHaveAttribute("aria-valuenow", "0");
    await expect(blue).toHaveAttribute("data-solved", "true");
  });
});
