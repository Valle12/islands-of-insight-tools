import { expect, test, type Locator, type Page } from "@playwright/test";
import { readFileSync } from "fs";

// A three-dial puzzle in the page's download format. Solvable: pressing
// button 1 three times and button 2 twice zeroes every dial.
const SAMPLE_CONFIG = {
  maxValues: [3, 4, 5],
  initialValues: [1, 2, 0],
  buttons: [{ turns: [1, 0, 2] }, { turns: [0, 3, 1] }],
};

function upload(page: Page, config: unknown, name = "phasicDialTest.json") {
  return page.locator("#config-file-input").setInputFiles({
    name,
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(config)),
  });
}

/** The Max (or Value) field of every dial row, in order. */
function dialFields(page: Page, field: "dial-max" | "dial-value") {
  return page.locator(`.dial-row .${field} input`);
}

/**
 * `toHaveValues` only covers multi-selects, so assert element by element.
 * The count check first keeps a short list from passing by accident.
 */
async function expectValues(fields: Locator, expected: string[]) {
  await expect(fields).toHaveCount(expected.length);
  for (let i = 0; i < expected.length; i++) {
    await expect(fields.nth(i)).toHaveValue(expected[i]!);
  }
}

test.describe("Phasic Dial Solver", () => {
  test("uploads a config file and populates the dials and buttons", async ({
    page,
  }) => {
    await page.goto("/phasic-dial-solver");

    await upload(page, SAMPLE_CONFIG);

    await expect(page.locator(".dial-row")).toHaveCount(3);
    await expectValues(dialFields(page, "dial-max"), ["3", "4", "5"]);
    await expectValues(dialFields(page, "dial-value"), ["1", "2", "0"]);

    const buttonRows = page.locator("#table-body tr");
    await expect(buttonRows).toHaveCount(2);
    await expectValues(
      buttonRows.nth(0).locator("md-outlined-text-field input"),
      ["1", "0", "2"],
    );
    await expectValues(
      buttonRows.nth(1).locator("md-outlined-text-field input"),
      ["0", "3", "1"],
    );

    await expect(page.locator("#warning-banner")).toBeHidden();
    await expect(page.locator("#result")).toBeHidden();
  });

  test("loads a config dropped onto the page", async ({ page }) => {
    await page.goto("/phasic-dial-solver");

    const dataTransfer = await page.evaluateHandle(json => {
      const dt = new DataTransfer();
      dt.items.add(
        new File([json], "puzzle.json", { type: "application/json" }),
      );
      return dt;
    }, JSON.stringify(SAMPLE_CONFIG));

    await page.dispatchEvent("body", "drop", { dataTransfer });

    await expect(page.locator(".dial-row")).toHaveCount(3);
    await expect(page.locator("#drop-overlay")).toBeHidden();
  });

  test("warns about an invalid config and leaves the page untouched", async ({
    page,
  }) => {
    await page.goto("/phasic-dial-solver");

    await upload(page, { maxValues: [3], initialValues: [0], buttons: [] });

    await expect(page.locator("#warning-banner")).toContainText(
      "Invalid config: maxValues must hold between 2 and 6 dials.",
    );
    await expect(page.locator(".dial-row")).toHaveCount(2);
  });

  test("downloads the entered puzzle, carrying the solution once solved", async ({
    page,
  }) => {
    await page.goto("/phasic-dial-solver");

    await page.getByRole("spinbutton", { name: "Value" }).first().fill("1");
    await page.getByRole("spinbutton", { name: "Value" }).nth(1).fill("2");
    await page
      .locator(
        "td:nth-child(2) > md-outlined-text-field > .text-field > .field > .input-wrapper > .input",
      )
      .fill("1");
    await page
      .locator(
        "td:nth-child(3) > md-outlined-text-field > .text-field > .field > .input-wrapper > .input",
      )
      .fill("2");

    // Before solving, the file holds the inputs only.
    let downloadPromise = page.waitForEvent("download");
    await page.locator("#download-config").click();
    let download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("phasicDialTest.json");
    const beforeSolve = JSON.parse(
      readFileSync(await download.path(), "utf8"),
    );
    expect(beforeSolve).toEqual({
      maxValues: [3, 3],
      initialValues: [1, 2],
      buttons: [{ turns: [1, 2] }],
    });

    await page.getByRole("button", { name: "Calculate Turns" }).click();
    await expect(page.locator("#result")).toContainText("Button 1: 3 presses");

    downloadPromise = page.waitForEvent("download");
    await page.locator("#download-config").click();
    download = await downloadPromise;
    const afterSolve = JSON.parse(readFileSync(await download.path(), "utf8"));
    expect(afterSolve.result).toEqual([3]);
  });

  test("shows a spinner while solving a six-dial puzzle", async ({ page }) => {
    await page.goto("/phasic-dial-solver");

    // Six six-sided dials and eight buttons: 6^8 combinations, which is
    // roughly a second of searching — long enough that the spinner is what
    // the user actually looks at, and long enough to assert on reliably.
    await upload(page, {
      maxValues: [5, 5, 5, 5, 5, 5],
      initialValues: [1, 1, 1, 1, 1, 1],
      buttons: Array.from({ length: 8 }, (_, b) => ({
        turns: Array.from({ length: 6 }, (_, dial) => (dial === b % 6 ? 1 : 0)),
      })),
    });
    await expect(page.locator(".dial-row")).toHaveCount(6);
    await expect(page.locator("#solve-spinner")).toBeHidden();

    await page.getByRole("button", { name: "Calculate Turns" }).click();
    await expect(page.locator("#solve-spinner")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Calculate Turns" }),
    ).toBeDisabled();

    await expect(page.locator("#result")).toContainText("Button 3: 5 presses", {
      timeout: 60000,
    });
    await expect(page.locator("#solve-spinner")).toBeHidden();
    await expect(
      page.getByRole("button", { name: "Calculate Turns" }),
    ).toBeEnabled();
  });

  test("round-trips a downloaded config back through upload", async ({
    page,
  }) => {
    await page.goto("/phasic-dial-solver");

    await upload(page, SAMPLE_CONFIG);
    await page.getByRole("button", { name: "Calculate Turns" }).click();
    const solved = await page.locator("#result").textContent();

    const downloadPromise = page.waitForEvent("download");
    await page.locator("#download-config").click();
    const json = readFileSync(await (await downloadPromise).path(), "utf8");
    expect(JSON.parse(json).result).toBeDefined();

    await page.locator("#reset #button").click();
    await expect(page.locator(".dial-row")).toHaveCount(2);

    await page.locator("#config-file-input").setInputFiles({
      name: "roundtrip.json",
      mimeType: "application/json",
      buffer: Buffer.from(json),
    });

    await expect(page.locator(".dial-row")).toHaveCount(3);
    await expectValues(dialFields(page, "dial-max"), ["3", "4", "5"]);
    await expect(page.locator("#warning-banner")).toBeHidden();

    await page.getByRole("button", { name: "Calculate Turns" }).click();
    await expect(page.locator("#result")).toHaveText(solved!);
  });
});
