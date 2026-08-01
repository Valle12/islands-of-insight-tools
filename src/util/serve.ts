import { resolve } from "node:path";
import {
  bundleMatchThreeWorker,
  WORKER_DIR,
  WORKER_FILE,
} from "./buildWorker";
import index from "./../pages/index.html";
import matchThreeSolver from "./../pages/match-three-solver/index.html";
import phasicDialSolver from "./../pages/phasic-dial-solver/index.html";
import rollingBlocksSolver from "./../pages/rolling-blocks-solver/index.html";
import shiftingMosaicSolver from "./../pages/shifting-mosaic-solver/index.html";

const wasmDir = resolve(
  import.meta.dir,
  "./../pages/rolling-blocks-solver/wasm",
);
const shiftingMosaicWasmDir = resolve(
  import.meta.dir,
  "./../pages/shifting-mosaic-solver/wasm",
);
const matchThreeWasmDir = resolve(
  import.meta.dir,
  "./../pages/match-three-solver/wasm",
);

const server = Bun.serve({
  routes: {
    "/": index,
    "/match-three-solver": matchThreeSolver,
    "/phasic-dial-solver": phasicDialSolver,
    "/rolling-blocks-solver": rollingBlocksSolver,
    "/shifting-mosaic-solver": shiftingMosaicSolver,
  },
  async fetch(req) {
    const url = new URL(req.url);
    // Solver wasm assets (all build variants: wasm32, pthreads, MEMORY64),
    // one directory per solver. Served by extension — bun can hand the
    // browser the mem64 binary even though it cannot instantiate it itself.
    const wasmVariantFiles = new Set([
      "astar.mjs",
      "astar.wasm",
      "astar.worker.js",
      "astar.threads.mjs",
      "astar.threads.wasm",
      "astar.mem64.mjs",
      "astar.mem64.wasm",
      "astar.threads.mem64.mjs",
      "astar.threads.mem64.wasm",
    ]);
    const wasmDirs: Record<string, string> = {
      "/rb-wasm/": wasmDir,
      "/sm-wasm/": shiftingMosaicWasmDir,
      "/mt-wasm/": matchThreeWasmDir,
    };
    for (const [prefix, dir] of Object.entries(wasmDirs)) {
      if (!url.pathname.startsWith(prefix)) continue;
      const name = url.pathname.slice(prefix.length);
      if (wasmVariantFiles.has(name)) {
        return new Response(Bun.file(resolve(dir, name)), {
          headers: {
            "Content-Type": name.endsWith(".wasm")
              ? "application/wasm"
              : "application/javascript",
          },
        });
      }
    }
    // Bundled per request rather than once at startup: HMR does not reach the
    // worker, so rebuilding here is what makes a reload pick up an edit to the
    // engine it pulls in. The bundle is small enough that it costs milliseconds.
    if (url.pathname === `/${WORKER_DIR}/${WORKER_FILE}`) {
      return new Response(await bundleMatchThreeWorker(), {
        headers: { "Content-Type": "application/javascript" },
      });
    }
    if (url.pathname === "/coi-serviceworker.js") {
      const file = Bun.file(
        resolve(import.meta.dir, "./../common/coi-serviceworker.js"),
      );
      return new Response(file, {
        headers: { "Content-Type": "application/javascript" },
      });
    }
    console.log(`No route found for ${url.pathname}`);
    return new Response("Not found", { status: 404 });
  },
  // Hot-module reloading and Bun's error overlay. This also makes the bundler
  // select Lit's `development` export condition, so every page here logs Lit's
  // "in dev mode" warning — expected locally, and the reason `bun run build`
  // pins NODE_ENV=production so it cannot reach the deployed bundle.
  //
  // Setting it to `false` is the only way to silence the warning here:
  // measured, NODE_ENV=production on the process and the object form
  // (`{ hmr: true }`) both leave dev-mode Lit in place. Not worth losing HMR.
  development: true,
});

console.log(`Listening on http://localhost:${server.port}`);
