import { resolve } from "path";
import index from "./../pages/index.html";
import phasicDialSolver from "./../pages/phasic-dial-solver/index.html";
import rollingBlocksSolver from "./../pages/rolling-blocks-solver/index.html";

const wasmDir = resolve(
  import.meta.dir,
  "./../pages/rolling-blocks-solver/wasm",
);

const server = Bun.serve({
  routes: {
    "/": index,
    "/phasic-dial-solver": phasicDialSolver,
    "/rolling-blocks-solver": rollingBlocksSolver,
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
    console.log(`No route found for ${url.pathname}`);
    return new Response("Not found", { status: 404 });
  },
  development: true,
});

console.log(`Listening on http://localhost:${server.port}`);
