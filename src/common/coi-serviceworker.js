// Cross-origin-isolation shim for hosts that cannot set response headers
// (GitHub Pages). Served from the site root and registered by pages that
// want SharedArrayBuffer/wasm-threads: as a service worker it re-serves
// same-scope responses with COOP/COEP headers attached.
//
// COEP uses `credentialless` (not `require-corp`) so third-party no-cors
// subresources like the Google Analytics gtag.js keep loading without CORP
// headers. Browsers without credentialless simply never become isolated and
// the app stays on its non-threaded fallback path.
//
// This file doubles as its own registration script: import it from a page
// (see coiRegister.ts) and it registers itself; the service-worker context
// runs the header-injection half.

if (typeof window === "undefined" && typeof self !== "undefined") {
  // ---- Service-worker half ----
  self.addEventListener("install", () => self.skipWaiting());
  self.addEventListener("activate", event =>
    event.waitUntil(self.clients.claim()),
  );
  self.addEventListener("fetch", event => {
    const request = event.request;
    // Never interfere with only-if-cached requests from non-same-origin
    // modes — they would fail with the headers rewritten.
    if (request.cache === "only-if-cached" && request.mode !== "same-origin")
      return;
    event.respondWith(
      fetch(request)
        .then(response => {
          if (response.status === 0) return response;
          const headers = new Headers(response.headers);
          headers.set("Cross-Origin-Embedder-Policy", "credentialless");
          headers.set("Cross-Origin-Opener-Policy", "same-origin");
          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers,
          });
        })
        // This worker's scope is the whole site, so EVERY request flows through
        // here. Without a catch, one rejected fetch (offline, a blocked
        // third-party script, an extension) becomes a hard network error plus
        // an unhandled rejection. Re-throwing lets the browser apply its own
        // failure handling instead.
        .catch(err => {
          console.warn("coi-serviceworker passthrough failed:", err);
          throw err;
        }),
    );
  });
}
