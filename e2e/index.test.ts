import { expect, test } from "@playwright/test";
import { waitForCoiSettled } from "./coi";

test.describe("Index", () => {
  test("test navigating to subpages", async ({ page }) => {
    // Three of the five subpages register the COOP/COEP shim, which reloads
    // once when its service worker activates. The wait goes immediately after
    // each of those clicks and BEFORE the first assertion, because the pending
    // reload breaks both ends: an interaction issued into it dies with
    // "Execution context was destroyed", and a Home click into it lets the
    // reload win and cancel the navigation, leaving the next assertion looking
    // at the solver page it just tried to leave.
    await page.goto("/");
    // Logic grid has no wasm, so no shim and no wait.
    await page.getByRole("link", { name: "Logic Grid Solver" }).click();
    await expect(page.getByRole("button", { name: "Solve Grid" })).toBeVisible();
    await page.getByRole("link", { name: "Home" }).locator("#button").click();
    await page.getByRole("link", { name: "Match Three Solver" }).click();
    await waitForCoiSettled(page);
    await expect(
      page.getByRole("button", { name: "Solve Puzzle" }),
    ).toBeVisible();
    await page.getByRole("link", { name: "Home" }).locator("#button").click();
    // Phasic dial is the one page that registers no shim, hence no wait here.
    await page.getByRole("link", { name: "Phasic Dial Solver" }).click();
    await expect(
      page.getByRole("button", { name: "Calculate Turns" }),
    ).toBeVisible();
    await page.getByRole("link", { name: "Home" }).locator("#button").click();
    await page.getByRole("link", { name: "Rolling Blocks Solver" }).click();
    await waitForCoiSettled(page);
    await expect(
      page.getByRole("button", { name: "Calculate Moves" }),
    ).toBeVisible();
    await page.getByRole("link", { name: "Home" }).locator("#button").click();
    await page
      .getByRole("link", { name: "Shifting Mosaic Solver" })
      .click();
    await waitForCoiSettled(page);
    await expect(
      page.getByRole("button", { name: "Calculate Solution" }),
    ).toBeVisible();
    await page.getByRole("link", { name: "Home" }).locator("#button").click();
    // Scoped to level 1: the home page carries prose now, and an unscoped
    // heading locator is strict-mode — it would break on the first <h2>.
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      "Islands of Insight Tools",
    );
  });
});
