import type { BunPlugin } from "bun";
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
