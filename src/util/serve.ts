import { resolve } from "node:path";
import index from "./../pages/index.html";
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

const server = Bun.serve({
  routes: {
    "/": index,
    "/phasic-dial-solver": phasicDialSolver,
    "/rolling-blocks-solver": rollingBlocksSolver,
    "/shifting-mosaic-solver": shiftingMosaicSolver,
  },
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/astar.mjs") {
      const file = Bun.file(resolve(wasmDir, "astar.mjs"));
      return new Response(file, {
        headers: { "Content-Type": "application/javascript" },
      });
    }
    if (url.pathname === "/astar.wasm") {
      const file = Bun.file(resolve(wasmDir, "astar.wasm"));
      return new Response(file, {
        headers: { "Content-Type": "application/wasm" },
      });
    }
    if (url.pathname === "/astar.worker.js") {
      const file = Bun.file(resolve(wasmDir, "astar.worker.js"));
      return new Response(file, {
        headers: { "Content-Type": "application/javascript" },
      });
    }
    // Shifting-mosaic solver assets (all build variants: wasm32, pthreads,
    // MEMORY64). Served by extension — bun can hand the browser the mem64
    // binary even though it cannot instantiate it itself.
    if (url.pathname.startsWith("/sm-wasm/")) {
      const name = url.pathname.slice("/sm-wasm/".length);
      const allowed = new Set([
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
      if (allowed.has(name)) {
        return new Response(Bun.file(resolve(shiftingMosaicWasmDir, name)), {
          headers: {
            "Content-Type": name.endsWith(".wasm")
              ? "application/wasm"
              : "application/javascript",
          },
        });
      }
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
