import { copyFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import "./buildWasm";
import { pngDataUrl, sassCompiler } from "./plugins";

await Bun.build({
  entrypoints: [
    "./src/pages/index.html",
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

const wasmDir = resolve(
  import.meta.dir,
  "../pages/rolling-blocks-solver/wasm",
);
for (const file of ["astar.mjs", "astar.wasm", "astar.worker.js"]) {
  copyFileSync(resolve(wasmDir, file), resolve("./dist", file));
}

// Shifting-mosaic solver WASM — served under /sm-wasm to avoid the flat
// astar.* name collision with the rolling-blocks module. The .threads.*
// variant is the pthreads build, used when the page is cross-origin
// isolated (see coi-serviceworker below).
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
]) {
  copyFileSync(
    resolve(shiftingMosaicWasmDir, file),
    resolve("./dist", "sm-wasm", file),
  );
}

// COOP/COEP service-worker shim — must live at the site root so its scope
// covers every page (GitHub Pages cannot set real response headers).
copyFileSync(
  resolve(import.meta.dir, "../common/coi-serviceworker.js"),
  resolve("./dist", "coi-serviceworker.js"),
);
