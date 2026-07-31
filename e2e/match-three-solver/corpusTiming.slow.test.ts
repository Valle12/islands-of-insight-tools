// A measurement rather than an assertion: how long the REAL page takes over the
// whole captured corpus.
//
// OPT-IN, because it reloads the page 52 times and lets three boards search for
// 90 s each — five minutes that `bun run e2e` may not spend. Run it with
// MT_SLOW_E2E=1, the same shape as the shifting-mosaic heap-limit suite. It is a
// `test.skip`, so it reports as skipped rather than vanishing. Drives the actual UI in Chromium, cross-origin
// isolated, so the wasm portfolio races on real threads inside one module
// alongside the TypeScript worker — exactly what a user gets.
//
// Records two different things, because they are different questions:
//   answerMs  — when a playable solution first exists to show
//   settleMs  — when the search stops on its own (a proof, or nothing left)
// A board with a proof settles. A board without one keeps searching to the
// budget unless the user presses Stop, so its settle time is the budget and the
// number that matters is answerMs.

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

/** The three with no proof would each run the page's full 300 s budget. */
const NO_PROOF = new Set([
  "matchThreeTest47.json",
  "matchThreeTest50.json",
  "matchThreeTest51.json",
]);

const FAST_CAP_MS = 40_000;
const HARD_CAP_MS = 90_000;

test.skip(process.env.MT_SLOW_E2E !== "1", "opt in with MT_SLOW_E2E=1");

test("corpus timing on the real page", async ({ page }) => {
  test.setTimeout(20 * 60_000);
  await gotoIsolated(page, MATCH_THREE_URL);

  const rows: string[] = [];
  let proven = 0;
  let answered = 0;
  const answerTimes: number[] = [];

  for (const name of FIXTURES) {
    // A FRESH PAGE per fixture. Reusing one leaves the previous board's
    // "Step 1 of 7" sitting in the solution counter, and the poll below reads it
    // as this board's answer within milliseconds — which is how the first run of
    // this produced a 46 ms median and move counts belonging to other boards.
    await gotoIsolated(page, MATCH_THREE_URL);
    await page.locator("#config-file-input").setInputFiles(`${FIXTURE_DIR}/${name}`);
    await page.waitForTimeout(60);

    const cap = NO_PROOF.has(name) ? HARD_CAP_MS : FAST_CAP_MS;
    const began = Date.now();
    await page.locator("#solve-puzzle").click();

    // Poll the page's own elements: the progress line carries the streamed best,
    // and the spinner going away is the search settling.
    let answerMs = -1;
    let settleMs = -1;
    let best = "";
    for (;;) {
      const state = await page.evaluate(() => {
        const text = (id: string) =>
          (document.getElementById(id)?.textContent || "").trim();
        const hidden = (id: string) =>
          document.getElementById(id)?.classList.contains("hidden") ?? true;
        return {
          progress: text("solution-progress-text"),
          status: text("solution-status"),
          counter: text("solution-step-counter"),
          spinnerGone: hidden("solution-spinner"),
          viewShown: !hidden("solution-view"),
        };
      });
      const elapsed = Date.now() - began;
      // ONLY the streamed best. Matching any "N moves" also hits the progress
      // line's "ruling out N moves", which is present from the first tick and
      // would time the search starting rather than the answer arriving.
      const found =
        /Best so far: (\d+) moves?/.exec(state.progress) ??
        /Step \d+ of (\d+)/.exec(state.counter);
      if (answerMs < 0 && found) {
        answerMs = elapsed;
        best = found[1]!;
      }
      if (state.spinnerGone && (state.viewShown || state.status)) {
        settleMs = elapsed;
        best ||= /Step \d+ of (\d+)/.exec(state.counter)?.[1] ?? "";
        break;
      }
      if (elapsed > cap) break;
      await page.waitForTimeout(50);
    }

    if (answerMs >= 0 || settleMs >= 0) {
      answered++;
      answerTimes.push(answerMs >= 0 ? answerMs : settleMs);
    }
    if (settleMs >= 0 && !NO_PROOF.has(name)) proven++;
    rows.push(
      `${name}\tanswer=${answerMs >= 0 ? answerMs : settleMs}ms` +
        `\tsettle=${settleMs >= 0 ? settleMs + "ms" : "still searching at cap"}` +
        `\tmoves=${best || "?"}`,
    );

  }

  const total = answerTimes.reduce((a, b) => a + b, 0);
  const sorted = [...answerTimes].sort((a, b) => a - b);
  console.log("\n===== CORPUS TIMING =====");
  for (const row of rows) console.log(row);
  console.log(
    `\n${answered}/${FIXTURES.length} answered; ${proven} settled with a proof\n` +
      `answer time: total ${(total / 1000).toFixed(1)}s, ` +
      `median ${sorted[Math.floor(sorted.length / 2)]}ms, ` +
      `max ${sorted.at(-1)}ms`,
  );
  expect(answered).toBe(FIXTURES.length);
});
