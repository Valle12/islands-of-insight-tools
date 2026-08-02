import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import "./buildWasm";
import {
  bundleMatchThreeWorker,
  WORKER_DIR,
  WORKER_FILE,
} from "./buildWorker";
import { pngDataUrl, sassCompiler } from "./plugins";
import {
  INDEXNOW_KEY,
  OG_DIR,
  PAGES,
  renderRobots,
  renderSitemap,
  ROBOTS_FILE,
  SITEMAP_FILE,
} from "./siteMeta";
import { WASM_SOLVERS, WASM_VARIANT_FILES } from "./wasmAssets";

// NOTE: this file must be launched with NODE_ENV=production — the `build`
// script does it, and CI runs `bun run build`. Material Web pulls in Lit, whose
// package exports carry a `development` condition that Bun's bundler selects
// unless NODE_ENV says otherwise; that ships the development build of Lit, which
// warns on every page load in production.
//
// It cannot be set from inside this file: Bun.build does not read
// process.env.NODE_ENV at call time (measured — assigning it here left all 20
// dev-mode sites in the bundle), so it has to be on the process from the start.
await Bun.build({
  entrypoints: [
    "./src/pages/index.html",
    "./src/pages/logic-grid-solver/index.html",
    "./src/pages/match-three-solver/index.html",
    "./src/pages/phasic-dial-solver/index.html",
    "./src/pages/rolling-blocks-solver/index.html",
    "./src/pages/shifting-mosaic-solver/index.html",
  ],
  outdir: "./dist",
  plugins: [sassCompiler(), pngDataUrl()],
  target: "browser",
  minify: true,
  compile: true,
});

// Every solver's WASM, each under its own /xx-wasm prefix — the flat astar.*
// names would collide at the dist root, and the .threads.* / .mem64.* variants
// are what the bridges pick between (see coi-serviceworker below for what makes
// the pthreads build reachable at all).
//
// Driven by the shared list rather than a block per solver: those blocks were
// four copies of the same nine filenames, and a solver added by copy-paste is
// how one of them ends up missing a variant.
for (const { page, prefix } of WASM_SOLVERS) {
  const from = resolve(import.meta.dir, `../pages/${page}/wasm`);
  mkdirSync(resolve("./dist", prefix), { recursive: true });
  for (const file of WASM_VARIANT_FILES)
    copyFileSync(resolve(from, file), resolve("./dist", prefix, file));
}

// The match-three search worker — a second bundle pass, because the HTML
// entrypoints above leave `new Worker(new URL("./x.ts", …))` untransformed.
mkdirSync(resolve("./dist", WORKER_DIR), { recursive: true });
await Bun.write(
  resolve("./dist", WORKER_DIR, WORKER_FILE),
  await bundleMatchThreeWorker(),
);

// COOP/COEP service-worker shim — must live at the site root so its scope
// covers every page (GitHub Pages cannot set real response headers).
copyFileSync(
  resolve(import.meta.dir, "../common/coi-serviceworker.js"),
  resolve("./dist", "coi-serviceworker.js"),
);

// Everything below is what crawlers and link scrapers read. `dist` ships
// nothing this file does not copy, so each of these also needs a branch in
// serve.ts to exist during development — see the static allowlist there.
const imagesDir = resolve(import.meta.dir, "../../images");

writeFileSync(resolve("./dist", SITEMAP_FILE), renderSitemap());
writeFileSync(resolve("./dist", ROBOTS_FILE), renderRobots());

// IndexNow ownership proof: the file is named after the key and contains it.
// `keyLocation` in the submission points here, which is what lets a key under
// a project subpath vouch for the URLs beneath it.
writeFileSync(resolve("./dist", `${INDEXNOW_KEY}.txt`), INDEXNOW_KEY);

// The favicon as a real file. Every page links it by ABSOLUTE url precisely so
// the bundler leaves the reference alone; this is the file that reference
// resolves to, and Googlebot-Image has to be able to fetch it.
copyFileSync(
  resolve(imagesDir, "favicon.png"),
  resolve("./dist", "favicon.png"),
);

// Open Graph screenshots. Captured by `bun run og:capture` and committed —
// regenerating them here would need a browser and a running server on every
// build, and would make dist non-reproducible.
mkdirSync(resolve("./dist", OG_DIR), { recursive: true });
for (const page of PAGES) {
  const source = resolve(imagesDir, OG_DIR, `${page.image}.png`);
  if (!existsSync(source)) {
    throw new Error(
      `Missing Open Graph image ${source}. Run \`bun run og:capture\`.`,
    );
  }
  copyFileSync(source, resolve("./dist", OG_DIR, `${page.image}.png`));
}

// The favicon reference must survive as a URL. Bun inlines every asset href it
// can resolve as a base64 data: URI, which is 91 KB a page AND uncrawlable —
// Googlebot-Image has no way to fetch one, so the site shows the default globe.
// Absolute urls are left alone, but that is the bundler's behaviour rather than
// a promise, so it is checked rather than assumed.
for (const page of PAGES) {
  const built = resolve("./dist", page.path, "index.html");
  const icon = /<link[^>]*rel="icon"[^>]*>/.exec(
    await Bun.file(built).text(),
  )?.[0];
  if (icon === undefined || icon.includes("data:")) {
    throw new Error(
      `${built}: the favicon must be a crawlable url, got ${icon ?? "no <link rel=icon> at all"}`,
    );
  }
}
