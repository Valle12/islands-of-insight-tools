/**
 * Captures the Open Graph preview images — one screenshot of each page, at the
 * size and colour scheme the `og:image` tags claim.
 *
 * Run it by hand (`bun run og:capture`) after a visual change worth showing;
 * the results are COMMITTED under `images/og/`. Doing this during `bun run
 * build` instead would need a browser and a live server on every build, in CI
 * and on the deploy runner, and would make `dist` differ run to run.
 *
 * The screenshots are taken by Playwright's own CLI under NODE, not by its API
 * under bun: `chromium.launch()` hangs indefinitely when bun is the host
 * runtime (measured — it never returns and never errors, which is also why the
 * e2e suite shells out to `playwright test`). Everything bun does here is
 * orchestration: start the dev server, walk the page list, stop the server.
 *
 * Flags, all for looking at variations locally — the defaults are what the
 * committed images and the meta tags agree on:
 *
 *   --light             capture in the light scheme instead of dark. Chromium
 *                       defaults to light no matter what the host OS prefers,
 *                       so the scheme is always passed explicitly.
 *   --full-page         capture the entire scrollable page. Shows everything,
 *                       but the result is no longer 1.91:1, and a link scraper
 *                       centre-crops a tall image to that ratio — so this is
 *                       for looking, not for committing.
 *   --width  <px>       viewport width  (default OG_IMAGE_WIDTH)
 *   --height <px>       viewport height (default OG_IMAGE_HEIGHT)
 *   --out <dir>         write somewhere other than images/og/
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  devRoute,
  OG_DIR,
  OG_IMAGE_HEIGHT,
  OG_IMAGE_WIDTH,
  PAGES,
} from "./siteMeta";
import { parseFlags } from "./solverCli";

const ORIGIN = "http://localhost:3000";
const PLAYWRIGHT_CLI = "node_modules/playwright/cli.js";

let scheme = "dark";
let fullPage = false;
let width = OG_IMAGE_WIDTH;
let height = OG_IMAGE_HEIGHT;
let outDir = resolve(import.meta.dir, "../../images", OG_DIR);

parseFlags(Bun.argv.slice(2), {
  "--light": () => (scheme = "light"),
  "--full-page": () => (fullPage = true),
  "--width": next => (width = Number(next())),
  "--height": next => (height = Number(next())),
  "--out": next => (outDir = resolve(next())),
});

/**
 * The pages that register the COOP/COEP shim and reload once when its service
 * worker activates — the same four `e2e/coi.ts` waits on. A screenshot taken
 * before that reload catches a half-built document, so they get a longer wait.
 */
const COI_PATHS = new Set([
  "logic-grid-solver/",
  "match-three-solver/",
  "rolling-blocks-solver/",
  "shifting-mosaic-solver/",
]);

const serverIsUp = async () => {
  try {
    await fetch(ORIGIN, { signal: AbortSignal.timeout(500) });
    return true;
  } catch {
    return false;
  }
};

/** Reuses a dev server if one is already running, so the ports cannot clash. */
const startServer = async () => {
  if (await serverIsUp()) {
    console.log(`Using the dev server already listening on ${ORIGIN}`);
    return null;
  }
  const proc = Bun.spawn(["bun", "run", "src/util/serve.ts"], {
    stdout: "inherit",
    stderr: "inherit",
  });
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await serverIsUp()) return proc;
    await Bun.sleep(250);
  }
  proc.kill();
  throw new Error(`The dev server never came up on ${ORIGIN}`);
};

const server = await startServer();
try {
  mkdirSync(outDir, { recursive: true });
  console.log(
    `${scheme} scheme, ${width}x${height}${fullPage ? ", full page" : ""} -> ${outDir}`,
  );
  if (fullPage || width !== OG_IMAGE_WIDTH || height !== OG_IMAGE_HEIGHT) {
    console.warn(
      "Note: these settings do not match the og:image:width/height the pages " +
        "declare. Fine for a look; re-run with no flags before committing.",
    );
  }

  for (const meta of PAGES) {
    const path = devRoute(meta);
    const file = resolve(outDir, `${meta.image}.png`);
    // The grids are drawn from JS and the text uses a webfont fetched from
    // fonts.googleapis.com, so a screenshot taken at load is a picture of an
    // empty box. The COI pages additionally throw the whole document away once
    // when their service worker activates.
    const wait = COI_PATHS.has(meta.path) ? 9000 : 5000;
    const proc = Bun.spawn(
      [
        "node",
        PLAYWRIGHT_CLI,
        "screenshot",
        "--color-scheme",
        scheme,
        "--viewport-size",
        `${width}, ${height}`,
        "--wait-for-timeout",
        String(wait),
        ...(fullPage ? ["--full-page"] : []),
        `${ORIGIN}${path}`,
        file,
      ],
      { stdout: "inherit", stderr: "inherit" },
    );
    const code = await proc.exited;
    if (code !== 0) {
      throw new Error(`playwright screenshot failed for ${path} (exit ${code})`);
    }
    console.log(`${path} -> ${file}`);
  }
} finally {
  server?.kill();
}
