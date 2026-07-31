import { resolve } from "node:path";

/**
 * The match-three search runs in a plain TypeScript worker, which Bun's HTML
 * entrypoints do NOT bundle: `new Worker(new URL("./x.ts", import.meta.url))`
 * survives minification with the `.ts` specifier intact, so it 404s in `dist/`
 * (measured). The worker therefore gets its own `Bun.build` pass and is served
 * from a top-level directory, exactly like the emscripten `astar.worker.js`
 * files under `/rb-wasm/` and `/sm-wasm/`.
 *
 * The page reaches it as `../mt-worker/solverWorker.js` rather than an absolute
 * path: relative to `/match-three-solver` (dev, no trailing slash) and to
 * `/match-three-solver/index.html` (Pages) that resolves to the same
 * `/mt-worker/solverWorker.js` either way.
 */
export const WORKER_DIR = "mt-worker";
export const WORKER_FILE = "solverWorker.js";

const WORKER_ENTRY = resolve(
  import.meta.dir,
  "./../pages/match-three-solver/solverWorker.ts",
);

/** Bundles the worker and returns its JavaScript source. */
export async function bundleMatchThreeWorker(): Promise<string> {
  const result = await Bun.build({
    entrypoints: [WORKER_ENTRY],
    target: "browser",
    format: "esm",
    minify: true,
  });

  const artifact = result.outputs[0];
  if (!result.success || !artifact) {
    throw new AggregateError(result.logs, "Failed to bundle the match-three worker");
  }
  return artifact.text();
}
