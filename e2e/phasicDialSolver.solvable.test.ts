import { expect, test } from "@playwright/test";

test.describe("Phasic Dial Solver", () => {
  test("test solver with basic solvable state", async ({ page }) => {
    await page.goto("/phasic-dial-solver");
    await page.getByRole("spinbutton", { name: "Max" }).nth(1).fill("5");
    await page.getByRole("spinbutton", { name: "Value" }).first().fill("3");
    await page.locator("#add-button #button").click();
    await page.locator("#add-button #button").click();
    await page.getByRole("spinbutton").nth(4).fill("2");
    await page
      .locator(
        "tr:nth-child(2) > td:nth-child(2) > md-outlined-text-field > .text-field > .field > .input-wrapper > .input",
      )
      .fill("1");
    await page
      .locator(
        "tr:nth-child(2) > td:nth-child(3) > md-outlined-text-field > .text-field > .field > .input-wrapper > .input",
      )
      .fill("2");
    await page
      .locator(
        "tr:nth-child(3) > td:nth-child(2) > md-outlined-text-field > .text-field > .field > .input-wrapper > .input",
      )
      .fill("1");
    await page
      .locator(
        "tr:nth-child(3) > td:nth-child(3) > md-outlined-text-field > .text-field > .field > .input-wrapper > .input",
      )
      .fill("3");
    await page.getByRole("button", { name: "Calculate Turns" }).click();
    await expect(page.locator("#result")).toContainText(
      "Button 1: 1 pressButton 2: 3 presses",
    );
  });

  test("test solver with complex solvable state", async ({ page }) => {
    await page.goto("/phasic-dial-solver");
    await page.locator("#add-dial #button").click();
    await page.locator("#add-dial #button").click();
    await page.locator("#add-dial #button").click();
    await page.getByRole("spinbutton", { name: "Max" }).first().fill("5");
    await page.getByRole("spinbutton", { name: "Max" }).first().press("Tab");
    await page.getByRole("spinbutton", { name: "Value" }).first().fill("4");
    await page.getByRole("spinbutton", { name: "Value" }).first().press("Tab");
    await page.getByRole("spinbutton", { name: "Max" }).nth(1).fill("4");
    await page.getByRole("spinbutton", { name: "Max" }).nth(1).press("Tab");
    await page.getByRole("spinbutton", { name: "Value" }).nth(1).fill("1");
    await page.getByRole("spinbutton", { name: "Value" }).nth(1).press("Tab");
    await page.getByRole("spinbutton", { name: "Max" }).nth(2).fill("5");
    await page.getByRole("spinbutton", { name: "Max" }).nth(2).press("Tab");
    await page.getByRole("spinbutton", { name: "Value" }).nth(2).fill("2");
    await page.locator("#add-button #button").click();
    await page.locator("#add-button #button").click();
    await page.getByRole("spinbutton", { name: "Max" }).nth(3).fill("4");
    await page.getByRole("spinbutton", { name: "Max" }).nth(3).press("Tab");
    await page.getByRole("spinbutton", { name: "Value" }).nth(3).fill("1");
    await page.getByRole("spinbutton", { name: "Value" }).nth(3).press("Tab");
    await page.getByRole("spinbutton", { name: "Max" }).nth(4).fill("4");
    await page.getByRole("spinbutton", { name: "Max" }).nth(4).press("Tab");
    await page.getByRole("spinbutton", { name: "Value" }).nth(4).fill("4");
    await page.locator("#add-button #button").click();
    await page.locator("#add-button #button").click();
    await page
      .locator(
        "td:nth-child(2) > md-outlined-text-field > .text-field > .field > .input-wrapper > .input",
      )
      .first()
      .fill("1");
    await page
      .locator(
        "td:nth-child(2) > md-outlined-text-field > .text-field > .field > .input-wrapper > .input",
      )
      .first()
      .press("Tab");
    await page
      .locator(
        "td:nth-child(3) > md-outlined-text-field > .text-field > .field > .input-wrapper > .input",
      )
      .first()
      .fill("2");
    await page
      .locator(
        "td:nth-child(3) > md-outlined-text-field > .text-field > .field > .input-wrapper > .input",
      )
      .first()
      .press("Tab");
    await page
      .locator(
        "td:nth-child(4) > md-outlined-text-field > .text-field > .field > .input-wrapper > .input",
      )
      .first()
      .fill("3");
    await page
      .locator(
        "td:nth-child(4) > md-outlined-text-field > .text-field > .field > .input-wrapper > .input",
      )
      .first()
      .press("Tab");
    await page
      .locator(
        "td:nth-child(5) > md-outlined-text-field > .text-field > .field > .input-wrapper > .input",
      )
      .first()
      .fill("1");
    await page
      .locator(
        "td:nth-child(5) > md-outlined-text-field > .text-field > .field > .input-wrapper > .input",
      )
      .first()
      .press("Tab");
    await page
      .locator(
        "td:nth-child(6) > md-outlined-text-field > .text-field > .field > .input-wrapper > .input",
      )
      .first()
      .fill("2");
    await page
      .locator(
        "td:nth-child(6) > md-outlined-text-field > .text-field > .field > .input-wrapper > .input",
      )
      .first()
      .press("Tab");
    await page
      .locator(
        "tr:nth-child(2) > td:nth-child(2) > md-outlined-text-field > .text-field > .field > .input-wrapper > .input",
      )
      .fill("1");
    await page
      .locator(
        "tr:nth-child(3) > td:nth-child(3) > md-outlined-text-field > .text-field > .field > .input-wrapper > .input",
      )
      .fill("3");
    await page
      .locator(
        "tr:nth-child(4) > td:nth-child(4) > md-outlined-text-field > .text-field > .field > .input-wrapper > .input",
      )
      .fill("1");
    await page
      .locator(
        "tr:nth-child(5) > td:nth-child(6) > md-outlined-text-field > .text-field > .field > .input-wrapper > .input",
      )
      .fill("1");
    await page.getByRole("button", { name: "Calculate Turns" }).click();
    await expect(page.locator("#result")).toContainText(
      "Button 1: 4 pressesButton 2: 4 pressesButton 3: 2 pressesButton 4: 4 pressesButton 5: 3 presses",
    );
  });
});