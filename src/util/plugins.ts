import type { BunPlugin } from "bun";

/**
 * Inlines every PNG the pages import as a `data:` URL, re-encoded as LOSSLESS
 * WebP on the way: the same pixels at about 60 % of the bytes (measured on the
 * game's tiles — 60.5 KB of PNG became 37.4 KB), which is what trims the two
 * single-file pages that carry the tiles. `Bun.Image`'s bundled WebP codec is
 * byte-identical across platforms, so `dist` does not depend on the machine
 * that built it.
 *
 * `favicon.png` is excluded on purpose: it has to stay a real file behind an
 * absolute url so crawlers can fetch it (see build.ts).
 */
export const pngDataUrl = (): BunPlugin => ({
  name: "pngDataUrl",
  setup(build) {
    build.onLoad({ filter: /(?<!favicon)\.png$/ }, async args => ({
      contents: `export default ${JSON.stringify(
        await new Bun.Image(args.path).webp({ lossless: true }).dataurl(),
      )};`,
      loader: "js",
    }));
  },
});
