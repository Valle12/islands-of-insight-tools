/**
 * The files `src/util/buildWasm.ts` leaves in each solver's `wasm/` directory,
 * and where each solver's are published.
 *
 * One list, because there used to be one per solver plus a fourth as a `Set`
 * in `serve.ts`: four copies of the same nine names, which meant a fifth
 * solver was a fifth copy and a new variant was four edits. Missing the
 * `serve.ts` copy 404s in dev; missing a `build.ts` copy 404s only in
 * production, after CI has gone green.
 *
 * `astar.worker.js` is the odd one out — it is hand-written source that lives
 * in the generated directory rather than em++ output — but it is published the
 * same way, so it belongs on the same list.
 */
export const WASM_VARIANT_FILES = [
  "astar.mjs",
  "astar.wasm",
  "astar.worker.js",
  "astar.threads.mjs",
  "astar.threads.wasm",
  "astar.mem64.mjs",
  "astar.mem64.wasm",
  "astar.threads.mem64.mjs",
  "astar.threads.mem64.wasm",
] as const;

/**
 * Files served from every solver's wasm prefix that are NOT that solver's own
 * output: the name each worker imports, mapped to the one source it is copied
 * from.
 *
 * Published per solver rather than from a shared url of its own so a worker
 * reaches it as `./astar.workerCore.js` — page-relative, exactly like the
 * `astar.mjs` beside it, and with no second prefix for `serve.ts` and
 * `build.ts` to keep in step. Four copies of ~4 KB in `dist/` is the price,
 * and it buys one copy of the file that matters.
 */
export const WASM_SHARED_FILES: Readonly<Record<string, string>> = {
  "astar.workerCore.js": "astarWorkerCore.js",
};

/**
 * Every solver that ships wasm: the page directory holding its `wasm/` output,
 * and the url prefix it is served from. The prefix is reached PAGE-relative
 * (`../lg-wasm/…`), never root-absolute — the site is served from a GitHub
 * Pages project sub-path, so a leading slash resolves outside it.
 */
export const WASM_SOLVERS = [
  { page: "rolling-blocks-solver", prefix: "rb-wasm" },
  { page: "shifting-mosaic-solver", prefix: "sm-wasm" },
  { page: "match-three-solver", prefix: "mt-wasm" },
  { page: "logic-grid-solver", prefix: "lg-wasm" },
] as const;
