import { expect, test } from "@playwright/test";
import {
  canonicalUrl,
  devRoute,
  INDEXNOW_KEY,
  ogImageUrl,
  PAGES,
  ROBOTS_FILE,
  SITE_URL,
  SITEMAP_FILE,
} from "../src/util/siteMeta";
import { waitForCoiSettled } from "./coi";

/**
 * `test/siteMeta.test.ts` proves the SOURCE html agrees with siteMeta. This
 * proves the served page does — the bundler rewrites hrefs on its way through,
 * which is exactly how the favicon became an uncrawlable data: URI — and that
 * the files a crawler asks for by name actually answer.
 *
 * siteMeta.ts is safe to import here (unlike symbols.ts): it pulls in no PNGs,
 * which is what Playwright's loader cannot resolve.
 */

/** The three pages whose service worker reloads the document once. */
const COI_PATHS = new Set([
  "match-three-solver/",
  "rolling-blocks-solver/",
  "shifting-mosaic-solver/",
]);

const head = (selector: string) => `head >> ${selector}`;

test.describe("SEO", () => {
  for (const meta of PAGES) {
    test(`${devRoute(meta)} carries its metadata`, async ({ page }) => {
      await page.goto(devRoute(meta));
      // Before the first assertion, not after: the pending reload tears down
      // the execution context an assertion is running in.
      if (COI_PATHS.has(meta.path)) await waitForCoiSettled(page);

      await expect(page).toHaveTitle(meta.title);
      await expect(page.locator(head('meta[name="description"]'))).toHaveAttribute(
        "content",
        meta.description,
      );
      await expect(page.locator(head('link[rel="canonical"]'))).toHaveAttribute(
        "href",
        canonicalUrl(meta),
      );
      await expect(page.locator(head('meta[property="og:url"]'))).toHaveAttribute(
        "content",
        canonicalUrl(meta),
      );
      await expect(
        page.locator(head('meta[property="og:image"]')),
      ).toHaveAttribute("content", ogImageUrl(meta));

      // The whole point of the absolute href: a data: URI here is invisible to
      // Googlebot-Image and is what left the site with a default globe.
      await expect(page.locator(head('link[rel="icon"]'))).toHaveAttribute(
        "href",
        `${SITE_URL}favicon.png`,
      );

      const structured = await page
        .locator(head('script[type="application/ld+json"]'))
        .textContent();
      expect(JSON.parse(structured ?? "")["@context"]).toBe(
        "https://schema.org",
      );
    });
  }

  test("the crawler-facing files are served", async ({ request }) => {
    const sitemap = await request.get(`/${SITEMAP_FILE}`);
    expect(sitemap.status()).toBe(200);
    for (const meta of PAGES) {
      expect(await sitemap.text()).toContain(`<loc>${canonicalUrl(meta)}</loc>`);
    }

    const robots = await request.get(`/${ROBOTS_FILE}`);
    expect(robots.status()).toBe(200);
    expect(await robots.text()).toContain(`Sitemap: ${SITE_URL}${SITEMAP_FILE}`);

    // The IndexNow ownership file is named after the key and contains it.
    const key = await request.get(`/${INDEXNOW_KEY}.txt`);
    expect(key.status()).toBe(200);
    expect((await key.text()).trim()).toBe(INDEXNOW_KEY);

    expect((await request.get("/favicon.png")).status()).toBe(200);
    for (const meta of PAGES) {
      expect((await request.get(`/og/${meta.image}.png`)).status()).toBe(200);
    }
  });

  test("the slash-less spelling redirects and keeps its query", async ({
    request,
  }) => {
    const response = await request.get("/match-three-solver?ref=test", {
      maxRedirects: 0,
    });
    expect(response.status()).toBe(301);
    // The query has to survive the correction — only the pathname is wrong.
    expect(response.headers()["location"]).toContain(
      "/match-three-solver/?ref=test",
    );
  });

  test("every solver is reachable from home without a redirect", async ({
    page,
    request,
  }) => {
    await page.goto("/");
    const hrefs = await page.locator("#tool-list a").evaluateAll(anchors =>
      anchors.map(anchor => anchor.getAttribute("href")),
    );
    // GitHub Pages 301s the slash-less form, so a missing slash is a wasted
    // hop for every visitor and a second url for the same page.
    expect(hrefs).toEqual(
      PAGES.filter(meta => meta.path).map(meta => `./${meta.path}`),
    );
    for (const meta of PAGES.filter(m => m.path)) {
      expect((await request.get(devRoute(meta))).status()).toBe(200);
    }
  });
});
