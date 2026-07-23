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
    if (url.pathname === "/sm-wasm/astar.mjs") {
      const file = Bun.file(resolve(shiftingMosaicWasmDir, "astar.mjs"));
      return new Response(file, {
        headers: { "Content-Type": "application/javascript" },
      });
    }
    if (url.pathname === "/sm-wasm/astar.wasm") {
      const file = Bun.file(resolve(shiftingMosaicWasmDir, "astar.wasm"));
      return new Response(file, {
        headers: { "Content-Type": "application/wasm" },
      });
    }
    if (url.pathname === "/sm-wasm/astar.worker.js") {
      const file = Bun.file(resolve(shiftingMosaicWasmDir, "astar.worker.js"));
      return new Response(file, {
        headers: { "Content-Type": "application/javascript" },
      });
    }
    if (url.pathname === "/sm-wasm/astar.threads.mjs") {
      const file = Bun.file(resolve(shiftingMosaicWasmDir, "astar.threads.mjs"));
      return new Response(file, {
        headers: { "Content-Type": "application/javascript" },
      });
    }
    if (url.pathname === "/sm-wasm/astar.threads.wasm") {
      const file = Bun.file(resolve(shiftingMosaicWasmDir, "astar.threads.wasm"));
      return new Response(file, {
        headers: { "Content-Type": "application/wasm" },
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
  development: true,
});

console.log(`Listening on http://localhost:${server.port}`);
