import { copyFileSync } from "fs";
import { resolve } from "path";
import "./buildWasm";
import { pngDataUrl, sassCompiler } from "./plugins";

await Bun.build({
  entrypoints: [
    "./src/pages/index.html",
    "./src/pages/phasic-dial-solver/index.html",
    "./src/pages/rolling-blocks-solver/index.html",
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
