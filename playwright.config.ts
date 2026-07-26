import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  // Playwright WIPES outputDir at the start of every run, and its default is
  // bare "test-results" — the same directory the fuzz harness and bench
  // campaigns write to (src/util/fuzzShiftingMosaic.ts defaults to
  // test-results/sm-fuzz). A single `bun run e2e` therefore deleted a finished
  // 10,000-board campaign and its fixtures. Confine Playwright to its own
  // subdirectory so long-running solver artifacts survive an e2e run.
  outputDir: "test-results/playwright",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "html",
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "bun src/util/serve.ts",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
  },
});
