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

import { readFileSync, readdirSync } from "node:fs";
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

/** How often the wait below re-reads the page, in ms. */
const POLL_MS = 50;

/** The fixture's own shape, which is what "this board has loaded" means. */
function shapeOf(name: string) {
  const config = JSON.parse(
    readFileSync(`${FIXTURE_DIR}/${name}`, "utf8"),
  ) as { gridWidth: number; gridHeight: number; cells: number[][] };
  return {
    width: config.gridWidth,
    height: config.gridHeight,
    // FIRST_SYMBOL is 2; anything at or above it is a block.
    blocks: config.cells.flat().filter(cell => cell >= 2).length,
  };
}

test.skip(process.env.MT_SLOW_E2E !== "1", "opt in with MT_SLOW_E2E=1");

test("corpus timing on the real page", async ({ page }) => {
  test.setTimeout(20 * 60_000);

  const rows: string[] = [];
  const times: number[] = [];
  let answered = 0;

  for (const name of FIXTURES) {
    // A FRESH PAGE per fixture. Reusing one leaves the previous board's
    // "Step 1 of 7" sitting in the solution counter, and the wait below reads
    // it as this board's answer within milliseconds — which is how the first
    // version of this reported a 46 ms median and move counts belonging to
    // other boards.
    await gotoIsolated(page, MATCH_THREE_URL);
    await page
      .locator("#config-file-input")
      .setInputFiles(`${FIXTURE_DIR}/${name}`);
    // Wait on THIS board being on screen, not on a fixed delay. The banner is
    // no use as a signal — it starts hidden and a valid fixture leaves it
    // hidden — so the check is the fixture's own shape: the two size fields the
    // load rewrites, plus its block count, which no other board in the corpus
    // shares at the same dimensions.
    const shape = shapeOf(name);
    await expect(page.locator("#grid .grid-cell")).toHaveCount(
      shape.width * shape.height,
    );
    await expect(
      page.getByRole("spinbutton", { name: "Grid Width" }),
    ).toHaveValue(String(shape.width));
    await expect(
      page.getByRole("spinbutton", { name: "Grid Height" }),
    ).toHaveValue(String(shape.height));
    await expect(page.locator('#grid [data-kind="symbol"]')).toHaveCount(
      shape.blocks,
    );

    const began = Date.now();
    await page.locator("#solve-puzzle").click();

    // One synchronisation on the page's own end-of-solve state rather than a
    // hand-rolled poll: the viewer appearing, or the spinner going away with a
    // status in its place ("Already solved", "No solution", "Gave up").
    const settled = await page
      .waitForFunction(
        () => {
          const text = (id: string) =>
            (document.getElementById(id)?.textContent || "").trim();
          const hidden = (id: string) =>
            document.getElementById(id)?.classList.contains("hidden") ?? true;
          if (!hidden("solution-view"))
            return { counter: text("solution-step-counter"), status: "" };
          const status = text("solution-status");
          if (hidden("solution-spinner") && status)
            return { counter: "", status };
          return null;
        },
        undefined,
        { polling: POLL_MS, timeout: CAP_MS },
      )
      .then(handle => handle.jsonValue())
      .catch(() => null);
    const ms = settled ? Date.now() - began : -1;
    const outcome = settled
      ? settled.status ||
        `${/Step \d+ of (\d+)/.exec(settled.counter)?.[1] ?? "?"} moves`
      : "";

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
