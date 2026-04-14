import { sassCompiler } from "./plugins";

await Bun.build({
  entrypoints: [
    "./src/pages/index.html",
    "./src/pages/phasic-dial-solver/index.html",
  ],
  outdir: "./dist",
  publicPath: "/islands-of-insight-tools/",
  plugins: [sassCompiler()],
  target: "browser",
});
