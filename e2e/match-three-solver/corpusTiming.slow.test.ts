// A measurement rather than an assertion: how long the REAL page takes over the
// whole captured corpus. Drives the actual UI in Chromium, cross-origin
// isolated, so the wasm portfolio races on real threads inside one module
// alongside the TypeScript worker — exactly what a user gets.
//
// OPT-IN, because it reloads the page once per fixture. Run it with
// MT_SLOW_E2E=1, the same shape as the shifting-mosaic heap-limit suite. It is a
// `test.skip`, so it reports as skipped rather than vanishing.
//
// It used to record two numbers per board — when an answer first existed, and
// when the search stopped — because those were different questions: a board with
// no proof kept searching to the budget with its answer already in hand. The
// search now ends at the first solution, so the two collapsed into one.

import { readdirSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { gotoIsolated, MATCH_THREE_URL } from "../coi";

const FIXTURE_DIR = "test/resources/match-three-solver";
const FIXTURES = readdirSync(FIXTURE_DIR)
  .filter(n => n.endsWith(".json"))
  .sort((a, b) => {
    const na = Number(/(\d+)/.exec(a)?.[1] ?? 0);
    const nb = Number(/(\d+)/.exec(b)?.[1] ?? 0);
    return na - nb;
  });

/** Generous: every captured board has measured well under this. */
const CAP_MS = 90_000;

test.skip(process.env.MT_SLOW_E2E !== "1", "opt in with MT_SLOW_E2E=1");

test("corpus timing on the real page", async ({ page }) => {
  test.setTimeout(20 * 60_000);

  const rows: string[] = [];
  const times: number[] = [];
  let answered = 0;

  for (const name of FIXTURES) {
    // A FRESH PAGE per fixture. Reusing one leaves the previous board's
    // "Step 1 of 7" sitting in the solution counter, and the poll below reads it
    // as this board's answer within milliseconds — which is how the first
    // version of this reported a 46 ms median and move counts belonging to
    // other boards.
    await gotoIsolated(page, MATCH_THREE_URL);
    await page
      .locator("#config-file-input")
      .setInputFiles(`${FIXTURE_DIR}/${name}`);
    await page.waitForTimeout(60);

    const began = Date.now();
    await page.locator("#solve-puzzle").click();

    let ms = -1;
    let outcome = "";
    for (;;) {
      const state = await page.evaluate(() => {
        const text = (id: string) =>
          (document.getElementById(id)?.textContent || "").trim();
        const hidden = (id: string) =>
          document.getElementById(id)?.classList.contains("hidden") ?? true;
        return {
          status: text("solution-status"),
          counter: text("solution-step-counter"),
          viewShown: !hidden("solution-view"),
          spinnerGone: hidden("solution-spinner"),
        };
      });
      const elapsed = Date.now() - began;
      if (state.viewShown) {
        ms = elapsed;
        outcome = `${/Step \d+ of (\d+)/.exec(state.counter)?.[1] ?? "?"} moves`;
        break;
      }
      // "Already solved", "No solution" and "Gave up" all end without a viewer.
      if (state.spinnerGone && state.status) {
        ms = elapsed;
        outcome = state.status;
        break;
      }
      if (elapsed > CAP_MS) break;
      await page.waitForTimeout(50);
    }

    if (ms >= 0) {
      answered++;
      times.push(ms);
    }
    rows.push(`${name}\t${ms >= 0 ? `${ms}ms` : "CAPPED"}\t${outcome}`);
  }

  const sorted = [...times].sort((a, b) => a - b);
  console.log("\n===== CORPUS TIMING =====");
  for (const row of rows) console.log(row);
  console.log(
    `\n${answered}/${FIXTURES.length} finished\n` +
      `total ${(times.reduce((a, b) => a + b, 0) / 1000).toFixed(1)}s, ` +
      `median ${sorted[Math.floor(sorted.length / 2)]}ms, ` +
      `max ${sorted.at(-1)}ms`,
  );
  expect(answered).toBe(FIXTURES.length);
});
