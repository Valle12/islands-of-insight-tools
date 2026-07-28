// Registers the COOP/COEP service-worker shim (coi-serviceworker.js) and
// reloads once so the page comes back cross-origin isolated. Pages that can
// use wasm threads import this for its side effect; everything degrades
// gracefully when service workers are unavailable (isolation simply stays
// off and the solver keeps using its multi-worker portfolio).

const RELOAD_GUARD = "coi-shim-reloaded";

export function registerCoiShim(): void {
  if (typeof window === "undefined") return;
  if (window.crossOriginIsolated) return;
  if (!("serviceWorker" in navigator)) return;
  // file:// or other non-secure contexts can't register service workers.
  if (!window.isSecureContext) return;

  // Page-relative, NOT root-absolute: the site is published to a GitHub Pages
  // project sub-path (https://<user>.github.io/<repo>/), so "/coi-serviceworker.js"
  // would resolve against the domain root and 404. Pages live one level below
  // the site root, so "../" lands on it — and the worker's default scope is its
  // own directory, i.e. the site root, covering every page.
  navigator.serviceWorker
    .register("../coi-serviceworker.js")
    .then(async () => {
      // register() resolves while the worker may still be INSTALLING; reloading
      // now would come back uncontrolled and the guard below would then block
      // the retry that would have worked. Wait for activation first.
      await navigator.serviceWorker.ready;
      // Test ISOLATION, not "is a worker controlling us". The shim calls
      // clients.claim(), so after awaiting ready a controller usually already
      // exists — but this document was fetched BEFORE the worker could add
      // COOP/COEP, so it is still not isolated. Keying the reload off the
      // controller therefore skipped it exactly when it was needed, and the
      // page silently fell back to the non-threaded portfolio. (Caught by
      // e2e/shifting-mosaic-solver/wasmVariants.test.ts, which asserts isolation on a
      // fresh browser context; a warm context hides it because the worker is
      // already installed and the very first load comes back isolated.)
      // Guard against loops on browsers that can never isolate.
      if (
        !window.crossOriginIsolated &&
        sessionStorage.getItem(RELOAD_GUARD) !== "1"
      ) {
        sessionStorage.setItem(RELOAD_GUARD, "1");
        window.location.reload();
      }
    })
    .catch(err => {
      console.warn("coi-serviceworker registration failed:", err);
    });
}
