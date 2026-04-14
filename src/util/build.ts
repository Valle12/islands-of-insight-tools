import { sassCompiler } from "./plugins";

await Bun.build({
  entrypoints: [
    "./src/pages/index.html",
    "./src/pages/phasic-dial-solver/index.html",
  ],
  outdir: "./dist",
  plugins: [sassCompiler()],
  target: "browser",
  compile: true,
  minify: true,
});
