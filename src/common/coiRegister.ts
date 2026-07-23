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

  navigator.serviceWorker
    .register("/coi-serviceworker.js")
    .then(registration => {
      // First visit: the worker only controls the page after a reload.
      // Guard against loops (e.g. a browser that never becomes isolated).
      if (
        !navigator.serviceWorker.controller &&
        sessionStorage.getItem(RELOAD_GUARD) !== "1"
      ) {
        sessionStorage.setItem(RELOAD_GUARD, "1");
        registration.addEventListener("updatefound", () => {});
        window.location.reload();
      }
    })
    .catch(err => {
      console.warn("coi-serviceworker registration failed:", err);
    });
}
