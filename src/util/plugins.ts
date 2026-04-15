import type { BunPlugin } from "bun";
import { readFileSync } from "fs";
import { compile } from "sass";

export const sassCompiler = (): BunPlugin => ({
  name: "sassCompiler",
  setup(build) {
    build.onLoad({ filter: /\.scss$/ }, args => {
      const result = compile(args.path, {
        silenceDeprecations: ["if-function"],
      });
      return {
        contents: result.css,
        loader: "css",
      };
    });
  },
});

export const pngDataUrl = (): BunPlugin => ({
  name: "pngDataUrl",
  setup(build) {
    build.onLoad({ filter: /(?<!favicon)\.png$/ }, args => {
      const data = readFileSync(args.path).toString("base64");
      return {
        contents: `export default "data:image/png;base64,${data}";`,
        loader: "js",
      };
    });
  },
});
