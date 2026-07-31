import { copyFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import "./buildWasm";
import {
  bundleMatchThreeWorker,
  WORKER_DIR,
  WORKER_FILE,
} from "./buildWorker";
import { pngDataUrl, sassCompiler } from "./plugins";

// NOTE: this file must be launched with NODE_ENV=production — the `build`
// script does it, and CI runs `bun run build`. Material Web pulls in Lit, whose
// package exports carry a `development` condition that Bun's bundler selects
// unless NODE_ENV says otherwise; that ships the development build of Lit, which
// warns on every page load in production.
//
// It cannot be set from inside this file: Bun.build does not read
// process.env.NODE_ENV at call time (measured — assigning it here left all 20
// dev-mode sites in the bundle), so it has to be on the process from the start.
await Bun.build({
  entrypoints: [
    "./src/pages/index.html",
    "./src/pages/match-three-solver/index.html",
    "./src/pages/phasic-dial-solver/index.html",
    "./src/pages/rolling-blocks-solver/index.html",
    "./src/pages/shifting-mosaic-solver/index.html",
  ],
  outdir: "./dist",
  plugins: [sassCompiler(), pngDataUrl()],
  target: "browser",
  minify: true,
  compile: true,
});

// Rolling-blocks solver WASM — served under /rb-wasm, mirroring the
// shifting-mosaic layout below (the old flat astar.* files at the dist root
// are gone with the single-variant build).
const wasmDir = resolve(
  import.meta.dir,
  "../pages/rolling-blocks-solver/wasm",
);
mkdirSync(resolve("./dist", "rb-wasm"), { recursive: true });
for (const file of [
  "astar.mjs",
  "astar.wasm",
  "astar.worker.js",
  "astar.threads.mjs",
  "astar.threads.wasm",
  "astar.mem64.mjs",
  "astar.mem64.wasm",
  "astar.threads.mem64.mjs",
  "astar.threads.mem64.wasm",
]) {
  copyFileSync(resolve(wasmDir, file), resolve("./dist", "rb-wasm", file));
}

// Shifting-mosaic solver WASM — served under /sm-wasm to avoid the flat
// astar.* name collision with the rolling-blocks module. The .threads.*
// variant is the pthreads build (cross-origin isolated pages, see
// coi-serviceworker below); the .mem64.* variant is the MEMORY64 build
// (8GB heap) the bridge prefers where the runtime supports Memory64.
const shiftingMosaicWasmDir = resolve(
  import.meta.dir,
  "../pages/shifting-mosaic-solver/wasm",
);
mkdirSync(resolve("./dist", "sm-wasm"), { recursive: true });
for (const file of [
  "astar.mjs",
  "astar.wasm",
  "astar.worker.js",
  "astar.threads.mjs",
  "astar.threads.wasm",
  "astar.mem64.mjs",
  "astar.mem64.wasm",
  "astar.threads.mem64.mjs",
  "astar.threads.mem64.wasm",
]) {
  copyFileSync(
    resolve(shiftingMosaicWasmDir, file),
    resolve("./dist", "sm-wasm", file),
  );
}

// The match-three search worker — a second bundle pass, because the HTML
// entrypoints above leave `new Worker(new URL("./x.ts", …))` untransformed.
mkdirSync(resolve("./dist", WORKER_DIR), { recursive: true });
await Bun.write(
  resolve("./dist", WORKER_DIR, WORKER_FILE),
  await bundleMatchThreeWorker(),
);

// COOP/COEP service-worker shim — must live at the site root so its scope
// covers every page (GitHub Pages cannot set real response headers).
copyFileSync(
  resolve(import.meta.dir, "../common/coi-serviceworker.js"),
  resolve("./dist", "coi-serviceworker.js"),
);
