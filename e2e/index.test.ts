import { expect, test } from "@playwright/test";
import { waitForCoiSettled } from "./coi";

test.describe("Index", () => {
  test("test navigating to subpages", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Phasic Dial Solver" }).click();
    await expect(
      page.getByRole("button", { name: "Calculate Turns" }),
    ).toBeVisible();
    await page.getByRole("link", { name: "Home" }).locator("#button").click();
    await page.getByRole("button", { name: "Rolling Blocks Solver" }).click();
    await expect(
      page.getByRole("button", { name: "Calculate Moves" }),
    ).toBeVisible();
    await page.getByRole("link", { name: "Home" }).locator("#button").click();
    await page
      .getByRole("button", { name: "Shifting Mosaic Solver" })
      .click();
    await expect(
      page.getByRole("button", { name: "Calculate Solution" }),
    ).toBeVisible();
    // Only this subpage registers the COOP/COEP shim, which reloads once when
    // its service worker activates. Clicking Home into that pending reload lets
    // the reload win and cancel the navigation, leaving the heading assertion
    // below looking at the solver page.
    await waitForCoiSettled(page);
    await page.getByRole("link", { name: "Home" }).locator("#button").click();
    await expect(page.getByRole("heading")).toContainText(
      "Islands of Insight Tools",
    );
  });
});
