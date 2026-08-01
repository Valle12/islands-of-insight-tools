import { resolve } from "node:path";
import {
  bundleMatchThreeWorker,
  WORKER_DIR,
  WORKER_FILE,
} from "./buildWorker";
import index from "./../pages/index.html";
import logicGridSolver from "./../pages/logic-grid-solver/index.html";
import matchThreeSolver from "./../pages/match-three-solver/index.html";
import phasicDialSolver from "./../pages/phasic-dial-solver/index.html";
import rollingBlocksSolver from "./../pages/rolling-blocks-solver/index.html";
import shiftingMosaicSolver from "./../pages/shifting-mosaic-solver/index.html";
import {
  INDEXNOW_KEY,
  OG_DIR,
  PAGES,
  renderRobots,
  renderSitemap,
  ROBOTS_FILE,
  SITEMAP_FILE,
} from "./siteMeta";

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
const imagesDir = resolve(import.meta.dir, "./../../images");

/**
 * The crawler-facing files, mirroring the block at the end of build.ts so dev
 * and dist answer the same urls. `null` means "not one of mine", which is what
 * keeps this out of the request handler's own branching.
 *
 * The two text files are RENDERED from siteMeta rather than read off disk:
 * dist's copies are generated at build time, and reading a stale file here is
 * exactly the drift worth avoiding.
 */
const crawlerFile = (pathname: string): Response | null => {
  if (pathname === `/${SITEMAP_FILE}`) {
    return new Response(renderSitemap(), {
      headers: { "Content-Type": "application/xml" },
    });
  }
  if (pathname === `/${ROBOTS_FILE}`) {
    return new Response(renderRobots(), {
      headers: { "Content-Type": "text/plain" },
    });
  }
  if (pathname === `/${INDEXNOW_KEY}.txt`) {
    return new Response(INDEXNOW_KEY, {
      headers: { "Content-Type": "text/plain" },
    });
  }
  if (pathname === "/favicon.png") {
    return new Response(Bun.file(resolve(imagesDir, "favicon.png")), {
      headers: { "Content-Type": "image/png" },
    });
  }
  // Open Graph screenshots, named after the page they show. Matched against
  // the page list rather than the directory so the route cannot be used to
  // read an arbitrary file out of images/.
  const name = pathname.startsWith(`/${OG_DIR}/`)
    ? pathname.slice(OG_DIR.length + 2)
    : "";
  if (PAGES.some(page => `${page.image}.png` === name)) {
    return new Response(Bun.file(resolve(imagesDir, OG_DIR, name)), {
      headers: { "Content-Type": "image/png" },
    });
  }
  return null;
};

const server = Bun.serve({
  // The canonical trailing-slash form only, ONE route per bundle. Registering
  // the same HTMLBundle under two keys crashes bun's dev server outright —
  // `panic(main thread): integer overflow` after a few seconds of concurrent
  // load, measured against a green baseline on the full e2e suite. The
  // slash-less spelling is redirected in `fetch` below instead, which is also
  // what GitHub Pages does with it in production.
  routes: {
    "/": index,
    "/logic-grid-solver/": logicGridSolver,
    "/match-three-solver/": matchThreeSolver,
    "/phasic-dial-solver/": phasicDialSolver,
    "/rolling-blocks-solver/": rollingBlocksSolver,
    "/shifting-mosaic-solver/": shiftingMosaicSolver,
  },
  async fetch(req) {
    const url = new URL(req.url);
    // `/match-three-solver` -> `/match-three-solver/`, the same 301 GitHub
    // Pages issues, so an old link resolves here and dev behaves like
    // production rather than 404ing on the spelling the canonical url avoids.
    // The home page is never a candidate: its path is "" and a pathname is
    // never shorter than "/".
    const canonical = PAGES.find(
      page => page.path !== "" && `/${page.path}` === `${url.pathname}/`,
    );
    if (canonical) {
      // Only the pathname is being corrected, so the query and hash have to
      // travel with it — `new URL(path, base)` keeps neither.
      const target = new URL(`/${canonical.path}`, url);
      target.search = url.search;
      target.hash = url.hash;
      return Response.redirect(target, 301);
    }
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
    const crawler = crawlerFile(url.pathname);
    if (crawler) return crawler;
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
