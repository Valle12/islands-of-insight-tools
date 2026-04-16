import { expect, test } from "@playwright/test";

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
    await expect(page.getByRole("heading")).toContainText(
      "Islands of Insight Tools",
    );
  });
});
