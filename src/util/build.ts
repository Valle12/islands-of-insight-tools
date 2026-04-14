import { pngDataUrl, sassCompiler } from "./plugins";

await Bun.build({
  entrypoints: [
    "./src/pages/index.html",
    "./src/pages/phasic-dial-solver/index.html",
  ],
  outdir: "./dist",
  plugins: [sassCompiler(), pngDataUrl()],
  target: "browser",
  minify: true,
  compile: true,
});
