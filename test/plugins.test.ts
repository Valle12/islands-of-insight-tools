import type { BunPlugin, PluginBuilder } from "bun";
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { pngDataUrl } from "../src/util/plugins";

interface Loaded {
  contents: string;
  loader: string;
}
type OnLoad = (args: { path: string }) => Promise<Loaded> | Loaded;

/**
 * Drives the plugin's `setup` with a stand-in for the bundler, capturing the
 * one `onLoad` it registers. Bun.build itself is not invoked: what is under
 * test is what the hook returns for a tile, not the bundler around it.
 */
function onLoadOf(plugin: BunPlugin): { filter: RegExp; load: OnLoad } {
  let captured: { filter: RegExp; load: OnLoad } | undefined;
  const builder = {
    onLoad(options: { filter: RegExp }, callback: OnLoad) {
      captured = { filter: options.filter, load: callback };
    },
  } as unknown as PluginBuilder;
  plugin.setup(builder);
  if (!captured) throw new Error("the plugin registered no onLoad hook");
  return captured;
}

const IMAGES = resolve(import.meta.dir, "../images");
const TILE = resolve(IMAGES, "blue-block.png");
const PREFIX = "data:image/webp;base64,";

const bytesOfDataUrl = (url: string) =>
  Uint8Array.from(Buffer.from(url.slice(PREFIX.length), "base64"));

describe("pngDataUrl", () => {
  test("claims every PNG except the favicon", () => {
    const { filter } = onLoadOf(pngDataUrl());
    expect(filter.test(TILE)).toBeTrue();
    expect(filter.test("images/og/home.png")).toBeTrue();
    expect(filter.test(resolve(IMAGES, "favicon.png"))).toBeFalse();
    expect(filter.test("images/blue-block.png.map")).toBeFalse();
  });

  test("hands the bundler a module exporting a WebP data url", async () => {
    const { load } = onLoadOf(pngDataUrl());
    const loaded = await load({ path: TILE });
    expect(loaded.loader).toBe("js");
    expect(loaded.contents).toMatch(/^export default "data:image\/webp;base64,[A-Za-z0-9+/=]+";$/);
  });

  test("the WebP is lossless — same pixels as the PNG — and smaller", async () => {
    const { load } = onLoadOf(pngDataUrl());
    const url = JSON.parse(
      (await load({ path: TILE })).contents.replace(/^export default /, "").replace(/;$/, ""),
    ) as string;
    const webp = bytesOfDataUrl(url);
    const png = Uint8Array.from(await Bun.file(TILE).bytes());
    expect(webp.byteLength).toBeLessThan(png.byteLength);

    // Same decoder, same encoder: the two re-encodes are byte-identical
    // exactly when the decoded pixels are.
    const [fromWebp, fromPng] = await Promise.all([
      new Bun.Image(webp).png().bytes(),
      new Bun.Image(png).png().bytes(),
    ]);
    expect(fromWebp).toEqual(fromPng);
    expect(await new Bun.Image(webp).metadata()).toMatchObject({
      width: 96,
      height: 96,
      format: "webp",
    });
  });
});
