import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  canonicalUrl,
  INDEXNOW_KEY,
  OG_DIR,
  OG_IMAGE_HEIGHT,
  OG_IMAGE_WIDTH,
  ogImageUrl,
  PAGES,
  renderRobots,
  renderSitemap,
  SITE_URL,
  SITEMAP_FILE,
} from "../src/util/siteMeta";

/**
 * The head metadata is hand-written into each index.html — there is no
 * templating layer on this site and adding one for five static files would be
 * worse than the duplication. This is what makes the duplication safe: it
 * fails the moment a title, description, canonical or og:url in the HTML stops
 * matching siteMeta.ts, which is what every generated artefact reads.
 */
const readPage = (file: string) =>
  readFileSync(resolve(import.meta.dir, "..", file), "utf8");

/**
 * A tag whose attributes are wrapped over several lines still has to match —
 * which every long <meta> here is, since that is how the file is formatted.
 * `\s+` and `[^>]*` both cross newlines, so no dotall flag is involved; there
 * is deliberately no `.` in any of these patterns.
 *
 * A miss yields `undefined`, which fails against the expected string rather
 * than passing quietly.
 */
const attr = (html: string, pattern: RegExp) => pattern.exec(html)?.[1];

/**
 * A PNG's IHDR carries width then height as big-endian uint32s at byte 16 and
 * 20 — enough to check an image's shape without pulling in a decoder.
 */
const pngSize = (file: string) => {
  const bytes = readFileSync(resolve(import.meta.dir, "..", file));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
};

const metaContent = (html: string, name: string) =>
  attr(
    html,
    new RegExp(`<meta\\s+(?:name|property)="${name}"\\s+content="([^"]*)"`),
  );

describe("SiteMeta", () => {
  test("every page is listed once, with the canonical trailing slash", () => {
    const paths = PAGES.map(page => page.path);
    expect(new Set(paths).size).toBe(PAGES.length);
    expect(paths).toContain("");
    for (const path of paths.filter(Boolean)) {
      expect(path.endsWith("/")).toBe(true);
      expect(path.startsWith("/")).toBe(false);
    }
  });

  describe.each(PAGES.map(page => [page.file, page] as const))(
    "%s",
    (_file, page) => {
      const html = readPage(page.file);

      test("title matches siteMeta", () => {
        expect(attr(html, /<title>([^<]*)<\/title>/)).toBe(page.title);
      });

      test("description matches siteMeta", () => {
        expect(metaContent(html, "description")).toBe(page.description);
        expect(metaContent(html, "og:description")).toBe(page.description);
        expect(metaContent(html, "twitter:description")).toBe(
          page.description,
        );
      });

      test("canonical and og:url are the absolute canonical url", () => {
        const canonical = attr(
          html,
          /<link\s+rel="canonical"\s+href="([^"]*)"/,
        );
        expect(canonical).toBe(canonicalUrl(page));
        expect(metaContent(html, "og:url")).toBe(canonicalUrl(page));
      });

      test("og:title and twitter:title match the title", () => {
        expect(metaContent(html, "og:title")).toBe(page.title);
        expect(metaContent(html, "twitter:title")).toBe(page.title);
      });

      test("og:image points at this page's screenshot", () => {
        expect(metaContent(html, "og:image")).toBe(ogImageUrl(page));
        expect(metaContent(html, "twitter:image")).toBe(ogImageUrl(page));
      });

      /**
       * The declared size, the capture size and the committed file all have to
       * be the same number. A scraper that trusts the tags and then receives a
       * differently-shaped image renders the card wrong, and the capture size
       * is a flag away from changing (`og:capture --width`).
       */
      test("the declared og:image size matches the real screenshot", () => {
        expect(metaContent(html, "og:image:width")).toBe(
          String(OG_IMAGE_WIDTH),
        );
        expect(metaContent(html, "og:image:height")).toBe(
          String(OG_IMAGE_HEIGHT),
        );
        expect(pngSize(`images/${OG_DIR}/${page.image}.png`)).toEqual({
          width: OG_IMAGE_WIDTH,
          height: OG_IMAGE_HEIGHT,
        });
      });

      /**
       * The one rule that is about crawlability rather than consistency.
       * Bun's HTML bundler inlines every asset href it can RESOLVE as a base64
       * data: URI, and Googlebot-Image cannot fetch one of those — which is
       * why the site showed a default globe. An absolute url is left alone.
       * build.ts re-checks the built output; this catches the source.
       */
      test("the favicon is an absolute url, never a data uri", () => {
        const icon = attr(html, /<link\s+rel="icon"[^>]*href="([^"]*)"/);
        expect(icon).toBe(`${SITE_URL}favicon.png`);
      });
    },
  );

  test("the sitemap lists exactly the canonical urls", () => {
    const sitemap = renderSitemap();
    const locs = [...sitemap.matchAll(/<loc>([^<]*)<\/loc>/g)].map(
      match => match[1],
    );
    expect(locs).toEqual(PAGES.map(canonicalUrl));
    expect(sitemap).toContain(
      'xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"',
    );
  });

  test("robots.txt points at the sitemap", () => {
    expect(renderRobots()).toContain(`Sitemap: ${SITE_URL}${SITEMAP_FILE}`);
  });

  test("the IndexNow key is a bare 32-character hex string", () => {
    // It becomes a filename and a url path segment, so anything else would
    // need escaping somewhere and would fail ownership verification.
    expect(INDEXNOW_KEY).toMatch(/^[0-9a-f]{32}$/);
  });
});
