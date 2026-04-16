import { expect, test } from "@playwright/test";

test.describe("Phasic Dial Solver", () => {
  test("test solver with solved state", async ({ page }) => {
    await page.goto("/phasic-dial-solver");
    await expect(page.locator("#container")).toMatchAriaSnapshot(`
    - button
    - heading "Dials" [level=2]
    - button
    - img
    - text: Max
    - spinbutton "Max"
    - text: Value
    - spinbutton "Value"
    - img
    - text: Max
    - spinbutton "Max"
    - text: Value
    - spinbutton "Value"
    - button
    - table:
      - rowgroup:
        - row:
          - columnheader
          - columnheader:
            - img
          - columnheader:
            - img
      - rowgroup:
        - row "Button 1":
          - cell "Button 1"
          - cell:
            - spinbutton: "0"
          - cell:
            - spinbutton: "0"
    - button
    - button "Calculate Turns"
    `);
    await page.getByRole("button", { name: "Calculate Turns" }).click();
    await expect(page.locator("#container")).toMatchAriaSnapshot(`
    - button
    - heading "Dials" [level=2]
    - button
    - img
    - text: Max
    - spinbutton "Max"
    - text: Value
    - spinbutton "Value"
    - img
    - text: Max
    - spinbutton "Max"
    - text: Value
    - spinbutton "Value"
    - button
    - table:
      - rowgroup:
        - row:
          - columnheader
          - columnheader:
            - img
          - columnheader:
            - img
      - rowgroup:
        - row "Button 1":
          - cell "Button 1"
          - cell:
            - spinbutton: "0"
          - cell:
            - spinbutton: "0"
    - button
    - button "Calculate Turns"
    - text: Already solved! No button presses needed.
    `);
    await page.locator("#add-dial #button").click();
    await page.getByRole("button", { name: "Calculate Turns" }).click();
    await expect(page.locator("#container")).toMatchAriaSnapshot(`
    - button
    - heading "Dials" [level=2]
    - button
    - img
    - text: Max
    - spinbutton "Max"
    - text: Value
    - spinbutton "Value"
    - img
    - text: Max
    - spinbutton "Max"
    - text: Value
    - spinbutton "Value"
    - img
    - text: Max
    - spinbutton "Max"
    - text: Value
    - spinbutton "Value"
    - button
    - table:
      - rowgroup:
        - row:
          - columnheader
          - columnheader:
            - img
          - columnheader:
            - img
          - columnheader:
            - img
      - rowgroup:
        - row "Button 1":
          - cell "Button 1"
          - cell:
            - spinbutton: "0"
          - cell:
            - spinbutton: "0"
          - cell:
            - spinbutton: "0"
    - button
    - button "Calculate Turns"
    - text: Already solved! No button presses needed.
    `);
    await page.locator("#add-dial #button").click();
    await expect(page.locator("#container")).toMatchAriaSnapshot(`
    - button
    - heading "Dials" [level=2]
    - button
    - img
    - text: Max
    - spinbutton "Max"
    - text: Value
    - spinbutton "Value"
    - img
    - text: Max
    - spinbutton "Max"
    - text: Value
    - spinbutton "Value"
    - img
    - text: Max
    - spinbutton "Max"
    - text: Value
    - spinbutton "Value"
    - img
    - text: Max
    - spinbutton "Max"
    - text: Value
    - spinbutton "Value"
    - button
    - table:
      - rowgroup:
        - row:
          - columnheader
          - columnheader:
            - img
          - columnheader:
            - img
          - columnheader:
            - img
          - columnheader:
            - img
      - rowgroup:
        - row "Button 1":
          - cell "Button 1"
          - cell:
            - spinbutton: "0"
          - cell:
            - spinbutton: "0"
          - cell:
            - spinbutton: "0"
          - cell:
            - spinbutton: "0"
    - button
    - button "Calculate Turns"
    - text: Already solved! No button presses needed.
    `);
    await page.locator("#add-button #button").click();
    await page
      .locator(
        "td:nth-child(2) > md-outlined-text-field > .text-field > .field > .input-wrapper > .input",
      )
      .first()
      .fill("1");
    await page
      .locator(
        "td:nth-child(3) > md-outlined-text-field > .text-field > .field > .input-wrapper > .input",
      )
      .first()
      .fill("1");
    await page
      .locator(
        "tr:nth-child(2) > td:nth-child(4) > md-outlined-text-field > .text-field > .field > .input-wrapper > .input",
      )
      .fill("2");
    await page
      .locator(
        "tr:nth-child(2) > td:nth-child(5) > md-outlined-text-field > .text-field > .field > .input-wrapper > .input",
      )
      .fill("2");
    await page.getByRole("button", { name: "Calculate Turns" }).click();
    await expect(page.locator("#container")).toMatchAriaSnapshot(`
    - button
    - heading "Dials" [level=2]
    - button
    - img
    - text: Max
    - spinbutton "Max"
    - text: Value
    - spinbutton "Value"
    - img
    - text: Max
    - spinbutton "Max"
    - text: Value
    - spinbutton "Value"
    - img
    - text: Max
    - spinbutton "Max"
    - text: Value
    - spinbutton "Value"
    - img
    - text: Max
    - spinbutton "Max"
    - text: Value
    - spinbutton "Value"
    - button
    - table:
      - rowgroup:
        - row:
          - columnheader
          - columnheader:
            - img
          - columnheader:
            - img
          - columnheader:
            - img
          - columnheader:
            - img
      - rowgroup:
        - row "Button 1":
          - cell "Button 1"
          - cell:
            - spinbutton: "1"
          - cell:
            - spinbutton: "1"
          - cell:
            - spinbutton: "0"
          - cell:
            - spinbutton: "0"
        - row "Button 2":
          - cell "Button 2"
          - cell:
            - spinbutton: "0"
          - cell:
            - spinbutton: "0"
          - cell:
            - spinbutton: "2"
          - cell:
            - spinbutton: "2"
    - button
    - button "Calculate Turns"
    - text: Already solved! No button presses needed.
    `);
    await page.locator("#add-dial #button").click();
    await page.locator("#add-button #button").click();
    await page.getByRole("button", { name: "Calculate Turns" }).click();
    await expect(page.locator("#container")).toMatchAriaSnapshot(`
    - button
    - heading "Dials" [level=2]
    - button
    - img
    - text: Max
    - spinbutton "Max"
    - text: Value
    - spinbutton "Value"
    - img
    - text: Max
    - spinbutton "Max"
    - text: Value
    - spinbutton "Value"
    - img
    - text: Max
    - spinbutton "Max"
    - text: Value
    - spinbutton "Value"
    - img
    - text: Max
    - spinbutton "Max"
    - text: Value
    - spinbutton "Value"
    - img
    - text: Max
    - spinbutton "Max"
    - text: Value
    - spinbutton "Value"
    - table:
      - rowgroup:
        - row:
          - columnheader
          - columnheader:
            - img
          - columnheader:
            - img
          - columnheader:
            - img
          - columnheader:
            - img
          - columnheader:
            - img
      - rowgroup:
        - row "Button 1":
          - cell "Button 1"
          - cell:
            - spinbutton: "0"
          - cell:
            - spinbutton: "0"
          - cell:
            - spinbutton: "0"
          - cell:
            - spinbutton: "0"
          - cell:
            - spinbutton: "0"
        - row "Button 2":
          - cell "Button 2"
          - cell:
            - spinbutton: "0"
          - cell:
            - spinbutton: "0"
          - cell:
            - spinbutton: "0"
          - cell:
            - spinbutton: "0"
          - cell:
            - spinbutton: "0"
        - row "Button 3":
          - cell "Button 3"
          - cell:
            - spinbutton: "0"
          - cell:
            - spinbutton: "0"
          - cell:
            - spinbutton: "0"
          - cell:
            - spinbutton: "0"
          - cell:
            - spinbutton: "0"
    - button
    - button "Calculate Turns"
    - text: Already solved! No button presses needed.
    `);
  });

  test("test solver with unsolvable state", async ({ page }) => {
    await page.goto("/phasic-dial-solver");
    await page.getByRole("spinbutton", { name: "Value" }).first().fill("1");
    await page.getByRole("button", { name: "Calculate Turns" }).click();
    await expect(page.locator("#result")).toContainText("No solution found.");
    await page.locator("#add-dial #button").click();
    await page.locator("#add-dial #button").click();
    await page.locator("#add-dial #button").click();
    await page.locator("#add-button #button").click();
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
        "tr:nth-child(2) > td:nth-child(3) > md-outlined-text-field > .text-field > .field > .input-wrapper > .input",
      )
      .fill("1");
    await page
      .locator(
        "tr:nth-child(3) > td:nth-child(4) > md-outlined-text-field > .text-field > .field > .input-wrapper > .input",
      )
      .fill("1");
    await page
      .locator(
        "tr:nth-child(4) > td:nth-child(5) > md-outlined-text-field > .text-field > .field > .input-wrapper > .input",
      )
      .fill("1");
    await page.getByRole("spinbutton", { name: "Value" }).first().fill("1");
    await page.getByRole("spinbutton", { name: "Value" }).nth(1).fill("1");
    await page.getByRole("spinbutton", { name: "Value" }).nth(2).fill("1");
    await page.getByRole("spinbutton", { name: "Value" }).nth(3).fill("1");
    await page.getByRole("spinbutton", { name: "Value" }).nth(4).fill("1");
    await page.getByRole("button", { name: "Calculate Turns" }).click();
    await expect(page.locator("#container")).toMatchAriaSnapshot(`
    - button
    - heading "Dials" [level=2]
    - button
    - img
    - text: Max
    - spinbutton "Max"
    - text: Value
    - spinbutton "Value"
    - img
    - text: Max
    - spinbutton "Max"
    - text: Value
    - spinbutton "Value"
    - img
    - text: Max
    - spinbutton "Max"
    - text: Value
    - spinbutton "Value"
    - img
    - text: Max
    - spinbutton "Max"
    - text: Value
    - spinbutton "Value"
    - img
    - text: Max
    - spinbutton "Max"
    - text: Value
    - spinbutton "Value"
    - table:
      - rowgroup:
        - row:
          - columnheader
          - columnheader:
            - img
          - columnheader:
            - img
          - columnheader:
            - img
          - columnheader:
            - img
          - columnheader:
            - img
      - rowgroup:
        - row "Button 1":
          - cell "Button 1"
          - cell:
            - spinbutton: "1"
          - cell:
            - spinbutton: "0"
          - cell:
            - spinbutton: "0"
          - cell:
            - spinbutton: "0"
          - cell:
            - spinbutton: "0"
        - row "Button 2":
          - cell "Button 2"
          - cell:
            - spinbutton: "0"
          - cell:
            - spinbutton: "1"
          - cell:
            - spinbutton: "0"
          - cell:
            - spinbutton: "0"
          - cell:
            - spinbutton: "0"
        - row "Button 3":
          - cell "Button 3"
          - cell:
            - spinbutton: "0"
          - cell:
            - spinbutton: "0"
          - cell:
            - spinbutton: "1"
          - cell:
            - spinbutton: "0"
          - cell:
            - spinbutton: "0"
        - row "Button 4":
          - cell "Button 4"
          - cell:
            - spinbutton: "0"
          - cell:
            - spinbutton: "0"
          - cell:
            - spinbutton: "0"
          - cell:
            - spinbutton: "1"
          - cell:
            - spinbutton: "0"
    - button
    - button "Calculate Turns"
    - text: No solution found.
    `);
  });

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
