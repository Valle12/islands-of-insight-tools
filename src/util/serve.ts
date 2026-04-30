import { resolve } from "path";
import index from "./../pages/index.html";
import phasicDialSolver from "./../pages/phasic-dial-solver/index.html";
import rollingBlocksSolver from "./../pages/rolling-blocks-solver/index.html";

const server = Bun.serve({
  routes: {
    "/": index,
    "/phasic-dial-solver": phasicDialSolver,
    "/rolling-blocks-solver": rollingBlocksSolver,
  },
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/solver.worker.js") {
      const result = await Bun.build({
        entrypoints: [
          resolve(
            import.meta.dir,
            "./../pages/rolling-blocks-solver/solver.worker.ts",
          ),
        ],
        target: "browser",
      });
      return new Response(await result.outputs[0]?.text(), {
        headers: { "Content-Type": "application/javascript" },
      });
    }
    console.log(`No route found for ${url.pathname}`);
    return new Response("Not found", { status: 404 });
  },
  development: true,
});

console.log(`Listening on http://localhost:${server.port}`);
