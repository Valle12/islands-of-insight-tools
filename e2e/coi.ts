import type { Page } from "@playwright/test";

export const SHIFTING_MOSAIC_URL = "/shifting-mosaic-solver";
export const MATCH_THREE_URL = "/match-three-solver";

/**
 * Navigates to a page that registers the COOP/COEP service-worker shim and
 * waits until the document left behind is the FINAL one.
 *
 * `coiRegister.ts` registers a service worker and then reloads once so the page
 * comes back cross-origin isolated. `page.goto()` resolves on the pre-reload
 * document, so anything issued in that window — evaluate, click, even a locator
 * assertion — can be torn down mid-flight with "Execution context was
 * destroyed, most likely because of a navigation". It is a race against the
 * service worker activating, so it fails whichever test happens to lose it that
 * run, not the same one twice: exactly the shape of the intermittent failures
 * this suite had.
 *
 * Isolation is the settle signal, because it is only ever true on the RELOADED
 * document. A test that has no use for SharedArrayBuffer still has to wait —
 * the reload happens regardless of what the test wants from the page.
 */
export async function gotoIsolated(page: Page, url = SHIFTING_MOSAIC_URL) {
  await page.goto(url);
  await waitForCoiSettled(page);
}

/**
 * The wait on its own, for pages reached by CLICKING rather than by goto.
 *
 * The pending reload does not only break interactions with the shim page — it
 * can also cancel a navigation AWAY from it, landing the test back on the page
 * it just tried to leave.
 */
export async function waitForCoiSettled(page: Page) {
  const isolated = () =>
    typeof crossOriginIsolated !== "undefined" && crossOriginIsolated;
  try {
    await page.waitForFunction(isolated, null, { timeout: 30_000 });
    return;
  } catch {
    // Registration can miss its self-reload when the dev server is saturated by
    // the rest of the suite running in parallel. One explicit reload picks up
    // the now-registered worker; only a genuine failure survives both attempts.
    await page.reload();
    await page.waitForFunction(isolated, null, { timeout: 30_000 });
  }
}
