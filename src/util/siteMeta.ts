/**
 * The single source of truth for everything a crawler sees.
 *
 * Five things read this file and they must not disagree: the `<head>` of each
 * page (hand-written, and pinned to this list by `test/siteMeta.test.ts`), the
 * sitemap and robots.txt written by `build.ts`, the Open Graph screenshots
 * captured by `captureOgImages.ts`, the URL list submitted by `indexNow.ts`,
 * and the dev-server routes in `serve.ts`.
 *
 * The site is a GitHub Pages PROJECT page, so it is served from the subpath
 * `/islands-of-insight-tools/` rather than a host root. Every absolute URL here
 * therefore carries that prefix, and nothing may assume a leading `/` resolves
 * to the site root.
 */

/** Always ends in a slash — every URL below is built by concatenation. */
export const SITE_URL = "https://valle12.github.io/islands-of-insight-tools/";

export type PageMeta = {
  /**
   * Canonical path relative to `SITE_URL`: empty for the home page, otherwise
   * ending in a slash. GitHub Pages 301s the slash-less form
   * (`/match-three-solver` -> `/match-three-solver/`), so the trailing slash is
   * the form that must appear in canonicals, sitemaps and internal links.
   */
  readonly path: string;
  /** Source HTML, relative to the repo root. */
  readonly file: string;
  /** Basename of the Open Graph screenshot under `images/og/`. */
  readonly image: string;
  readonly title: string;
  readonly description: string;
};

/**
 * The six pages as a table: slug, then title, then description — one row per
 * line, and the home page's slug is the empty string.
 *
 * Deliberately a table rather than six formatted object literals. Sonar's
 * duplication detector normalises string literals, so entries of identical
 * shape read to it as one block repeated once per page: at ten lines each that
 * was a 40-line duplicate and, on its own, a failed quality gate. Rows this
 * short cannot form a block long enough to match. Lining the columns up is also
 * what makes a table worth reading.
 *
 * Descriptions are ~150-160 characters — long enough to fill a Google snippet,
 * short enough not to be truncated — and lead with the words someone stuck on
 * the puzzle would actually type. The game's own wiki calls the third one
 * "Rolling Block" in the singular while the page is titled "Rolling Blocks";
 * the description carries the other spelling so both are covered.
 */
const SOURCE: readonly (readonly [
  slug: string,
  title: string,
  description: string,
])[] = [
  ["", "Islands of Insight Tools | Free Puzzle Solvers", "Free browser-based solvers for Islands of Insight puzzles: Logic Grid, Match Three, Phasic Dial, Rolling Blocks and Shifting Mosaic. Get the solution."],
  ["logic-grid-solver", "Logic Grid Solver | Islands of Insight Tools", "Solve Islands of Insight Logic Grid puzzles. Paint the dark and light cells, switch on the rules the puzzle uses, place its clues, and get the finished grid."],
  ["match-three-solver", "Match Three Solver | Islands of Insight Tools", "Stuck on a Match Three puzzle in Islands of Insight? Paint the board of coloured blocks and blockades and get the exact sequence of swaps that clears it."],
  ["phasic-dial-solver", "Phasic Dial Solver | Islands of Insight Tools", "Solve Islands of Insight Phasic Dial puzzles. Enter each dial and what every button turns, and get the fewest presses that returns them all to centre."],
  ["rolling-blocks-solver", "Rolling Blocks Solver | Islands of Insight Tools", "Solve Islands of Insight Rolling Block puzzles. Lay out the board and the blocks, and get the exact rolls that cover every marked tile or reach the goal."],
  ["shifting-mosaic-solver", "Shifting Mosaic Solver | Islands of Insight Tools", "Solve Islands of Insight Shifting Mosaic sliding-block puzzles. Draw the obstructions, the goal block and the goal zone, and get the moves step by step."],
];

/**
 * `path`, `file` and `image` all follow from the slug, so they are derived here
 * rather than written out per page — three fewer places for a typo to hide, and
 * a new page cannot disagree with itself about its own directory name.
 */
export const PAGES: readonly PageMeta[] = SOURCE.map(
  ([slug, title, description]) => ({
    path: slug === "" ? "" : `${slug}/`,
    file: slug === "" ? "src/pages/index.html" : `src/pages/${slug}/index.html`,
    image: slug === "" ? "home" : slug,
    title,
    description,
  }),
);

/**
 * Open Graph wants 1.91:1 — a scraper centre-crops anything else, so a taller
 * screenshot loses its top and bottom rather than showing more.
 *
 * The frame is therefore sized by the TALLEST page, and widened to keep the
 * ratio. 1200x630 cut every solver off mid-grid; 1600x838 fitted all five of
 * them, and logic-grid then arrived needing 951 px (a 903 px card plus the
 * body's 24 px padding top and bottom) and lost its rules and Solve button.
 *
 * 1920x1005 was the next size up that cleared 951 — and then the galaxy-era
 * rule batch grew logic-grid's rule row to 53 chips and the card to 1205 px,
 * needing 1253, and 2400x1257 cleared that. The region-shape pairs took the
 * rule row to 57 and the card to 1239 px, needing 1287; 2560x1341 clears it
 * (1.6x the 1600x838 frame, so the ratio is unchanged).
 *
 * Note that widening past ~1000 px buys height and nothing else:
 * `#editor-card` stays at 960 px for the board these shots are taken with, so
 * a wider viewport does not reflow the content, it only adds empty margin
 * beside it. (Logic-grid and shifting-mosaic DO grow the card past 960 for a
 * wide grid, but the shot is of a freshly loaded page, whose board is far too
 * small to reach it.) That is why the width follows the RATIO and nothing
 * more — measure the card, do not guess.
 *
 * Every page's og:image:width / og:image:height declares these two numbers, and
 * `test/siteMeta.test.ts` fails if they drift apart or from the committed PNGs.
 */
export const OG_IMAGE_WIDTH = 2560;
export const OG_IMAGE_HEIGHT = 1341;

/** Where the OG screenshots live in `dist/` and in the dev server. */
export const OG_DIR = "og";

/**
 * IndexNow ownership key. The file `dist/<key>.txt` contains exactly this
 * string; submissions pass it as `keyLocation`, which is what lets a key living
 * under a subdirectory prove ownership of URLs under that same subdirectory.
 * Changing it means re-shipping the file, so it is a constant, not a secret —
 * the protocol is public by design and the key only authorises "recrawl this",
 * never a content change.
 */
export const INDEXNOW_KEY = "160bd2adfe814480b1dfc620314f1e88";

export const canonicalUrl = (page: PageMeta) => `${SITE_URL}${page.path}`;

export const ogImageUrl = (page: PageMeta) =>
  `${SITE_URL}${OG_DIR}/${page.image}.png`;

/** Dev-server path for a page: "/" for home, "/match-three-solver/" otherwise. */
export const devRoute = (page: PageMeta) => `/${page.path}`;

export const SITEMAP_FILE = "sitemap.xml";
export const ROBOTS_FILE = "robots.txt";

/**
 * No `<lastmod>`. It is optional, and neither value available here is honest:
 * CI checks out shallow so a git-derived date is the same commit for every
 * page, and a build timestamp would claim all five pages changed on every
 * deploy — which is how a sitemap teaches Google to ignore the field.
 */
export const renderSitemap = () => {
  const urls = PAGES.map(
    page => `  <url>\n    <loc>${canonicalUrl(page)}</loc>\n  </url>`,
  ).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;
};

/**
 * Advisory only, and deliberately shipped anyway.
 *
 * Crawlers read robots.txt from the HOST root and nowhere else, so
 * `valle12.github.io/robots.txt` is the file that governs this site — not this
 * one, which lands under the project subpath. This exists so the root site can
 * point at the sitemap, so tools that do fetch a subpath robots.txt find
 * something sane, and so the file is already correct if a custom domain ever
 * makes it live.
 */
export const renderRobots = () => `User-agent: *
Allow: /

Sitemap: ${SITE_URL}${SITEMAP_FILE}
`;
