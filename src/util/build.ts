import { copyFileSync, mkdirSync } from "fs";
import { resolve } from "path";
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
// astar.* name collision with the rolling-blocks module.
const shiftingMosaicWasmDir = resolve(
  import.meta.dir,
  "../pages/shifting-mosaic-solver/wasm",
);
mkdirSync(resolve("./dist", "sm-wasm"), { recursive: true });
for (const file of ["astar.mjs", "astar.wasm", "astar.worker.js"]) {
  copyFileSync(
    resolve(shiftingMosaicWasmDir, file),
    resolve("./dist", "sm-wasm", file),
  );
}
