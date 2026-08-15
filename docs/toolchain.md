# Toolchain notes: SEO metadata, the clang-tidy gate, the IDE diagnostics bridge

Long-form notes split out of `CLAUDE.md`, which keeps the digest. See also
`CLION-INSPECTIONS.md` for the C++ inspection catalogue.

## SEO and site metadata

`src/util/siteMeta.ts` is the single source of truth: `SITE_URL`, the `PAGES` list (path, source file, og image name, title, description), the sitemap and robots renderers, and the IndexNow key. The `<head>` tags themselves are **hand-written into the six `index.html` files** — there is no templating layer and adding one for six static files would be worse than the duplication — and `test/siteMeta.test.ts` pins every title, description, canonical, og:url and og:image against `siteMeta.ts` so the copies cannot drift. `e2e/seo.test.ts` re-checks the same things on the *served* page, because the bundler rewrites hrefs on the way through.

Adding a page means: an entry in `PAGES`, the head tags in its HTML, its trailing-slash route in `serve.ts`, its entrypoint in `build.ts`, a card in `src/pages/index.html` (**in `PAGES` order** — `e2e/seo.test.ts` pins the two lists against each other) with its `ItemList` entry, a leg in `e2e/index.test.ts`, and `bun run og:capture`. Nothing else needs editing — the sitemap, the IndexNow submission and both SEO test suites read the list. A page that registers the COI shim additionally belongs in the `COI_PATHS` sets in `e2e/seo.test.ts` and `src/util/captureOgImages.ts`.

Five things are load-bearing and easy to undo:

- **The site is a GitHub Pages *project* page**, served from `/islands-of-insight-tools/`. Every absolute url carries that prefix, and a root-absolute href (`/images/favicon.png`) points outside the site — which is exactly what the favicon used to do, 404ing on the live site.
- **The favicon must stay an ABSOLUTE url.** Bun's HTML bundler resolves every asset href it *can* resolve and inlines the result as a base64 `data:` URI — measured at 91 KB per page, and Googlebot-Image cannot fetch a `data:` URI, so the site showed a default globe. A page-relative href does not work either: Bun fails the build with "Could not resolve" rather than leaving it alone. Absolute urls pass through untouched, and `build.ts` re-checks the built output rather than trusting that. Dropping the data URI also took `dist/index.html` from 241 KB to 155 KB.
- **Canonical urls carry a trailing slash.** GitHub Pages 301s `/match-three-solver` to `/match-three-solver/`, so the slash-less form is both a wasted hop and a second url for the same page. Internal links and the sitemap use the slash.
- **Never register one HTMLBundle under two routes in `serve.ts`.** Serving both spellings that way looks obvious and it *crashes bun's dev server*: `panic(main thread): integer overflow`, a few seconds into concurrent load. It does not reproduce on a single page or a small suite — measured on the full e2e run against a green baseline, 97/99 passing became 39/106 with 65 connection-level failures and a bun crash dump, which reads exactly like the flake in the next paragraph and is not one. `serve.ts` registers the canonical trailing-slash route only and 301s the other spelling from `fetch`, which is also what Pages does in production.
  **That panic is a symptom, not a diagnosis.** The same `integer overflow` reproduces with the route table entirely correct, purely from CONCURRENCY: measured 2026-08-01 on bun 1.3.14 / Windows, `bunx playwright test` at the default worker count (cores/2) crashes the dev server ~20 s in and takes the rest of the run down with it, while `--workers=2` finishes the identical suite 136/136 clean. It was bisected by unregistering the newest page and re-running — the panic survived, so it is not about how many entrypoints there are either. CI is unaffected: its runners are small enough that Playwright allocates one worker per shard. So when a local full run collapses into `ERR_CONNECTION_RESET`, check the route table once and then **re-run with `--workers=2` before believing anything is broken**.
- **`robots.txt` shipped from this repo is inert**, and deliberately shipped anyway. Crawlers read robots.txt from the host root only, so `valle12.github.io/robots.txt` is the one that counts, and it lives in the separate **`Valle12.github.io` user-pages repo** — which for a long time this file claimed existed while it did not, leaving the host root a 404 and the `Sitemap:` directive unread by every crawler. Adding a page *here* needs no change there; adding a **new project on this hostname** means another `Sitemap:` line in that repo. **No favicon is set at the host root, on purpose.** Google supports one favicon per **hostname**, read from that hostname's home page, and a subdirectory explicitly cannot override it — so a single icon would represent every project on `valle12.github.io`, not just this one. Until a neutral mark is chosen, search results keep the default globe. Per-page **tab** favicons are unaffected and each page sets its own.
- **`dist` ships nothing `build.ts` does not copy.** A new static file needs a copy in `build.ts` *and* a branch in `serve.ts`'s allowlist, which 404s everything else. The sitemap and robots are *rendered* in both places rather than read off disk, so they cannot go stale.

The Open Graph screenshots live in `images/og/` and are **committed**. `bun run og:capture` re-shoots them, and it drives Playwright's **CLI under node** rather than its API: `chromium.launch()` hangs forever under bun — no error, no timeout — which is also why `bun run e2e` shells out to `playwright test`. Its flags (`--light`, `--full-page`, `--width`, `--height`, `--out`) are for looking at variations locally; the defaults are what the meta tags declare, and the script warns when they are overridden.

Two things about that capture size. **Chromium renders light unless told otherwise**, whatever the host OS prefers, so the scheme is always passed explicitly — the committed shots are `dark`. And **the frame is 2400x1257, not the usual 1200x630**: Open Graph wants 1.91:1 and a scraper centre-crops anything else, so a taller screenshot loses its edges rather than showing more. Widening at that ratio is the only way to fit a taller page in, which is why the size has grown twice — 1200x630 cut every solver off mid-grid, 1600x838 fitted five pages, logic-grid then needed 951 px and lost its rules and Solve button, and the galaxy-era rule batch grew its card to 1205 px again.

**A new page can therefore force this size up, and the number to measure is the CARD, not the screenshot.** `#editor-card` is capped at `min(100%, 960px)`, so past about 1000 px a wider viewport buys height and nothing else — it does not reflow the content, it just adds empty margin beside it. Measure `#editor-card`'s bounding box plus the body's 24 px padding top and bottom, then pick the smallest 1.91:1 frame that clears it; `document.documentElement.scrollHeight` is **not** that number, because `body { min-height: 100vh }` clamps it up to the viewport and makes an overflowing page look like it fits. Changing the size means `OG_IMAGE_WIDTH`/`HEIGHT` in `siteMeta.ts`, the `og:image:width`/`height` tags in **every** `index.html`, and a re-run of `bun run og:capture`. `test/siteMeta.test.ts` checks the declared tags, the constants and the committed PNG headers all agree.

**Automatic indexing does not exist for Google.** Its Indexing API accepts only `JobPosting` and `BroadcastEvent` and ignores everything else, and Google has never adopted IndexNow. `sitemap.xml` is the automatic mechanism: submit it once in Search Console and Google re-fetches it on its own, so a new page is discovered without further action. The `indexnow` job in `deploy.yml` covers Bing, Yandex, Seznam and Naver, runs *after* `deploy` (the urls have to be live when they are submitted) and is `continue-on-error`. The sitemap carries **no `lastmod`**: CI checks out shallow so a git date would be the same commit for every url, and a build timestamp would claim every page changed on every deploy.

## The clang-tidy gate on a new solver

**A new solver with C++ gets the gate too.** Drop a CLion-generated `.clang-tidy` next to its `CMakeLists.txt` and add two lines before the first `add_executable`:

```cmake
include("${CMAKE_CURRENT_SOURCE_DIR}/../../../../cmake/ClangTidyGate.cmake")
clang_tidy_gate(OPTION XX_CLANG_TIDY PROFILE_LLVM 23)
```

CLion's generated profile needs one hand-edit before it will run: it enables `performance-faster-string-find`, which clang-tidy 23 reports as deprecated. That arrives as a `[clang-tidy-config]` diagnostic, `--warnings-as-errors=*` promotes it to a fatal error on *every* file, and the gate's config probe then disables linting entirely. Negate it (`-performance-faster-string-find`) as the existing profiles do (copying one of them is the shortcut). To check a profile without a full build:

```powershell
& $tidy --warnings-as-errors=* "--config-file=<dir>/.clang-tidy" <empty.cpp> -- -std=c++23
```

Findings the gate raised on the newest solver, all of which it is worth writing to from the start: `bugprone-misplaced-widening-cast` (a `static_cast<size_t>` around index *arithmetic* — widen the operands instead, which is what match-three's `flat()` / `slot()` helpers in `Types.h` exist for), `readability-use-anyofallof`, `readability-convert-member-functions-to-static`, `modernize-use-auto` on a cast initializer, `bugprone-use-after-move` (read everything you need to merge BEFORE the move), and `performance-unnecessary-copy-initialization` on `const std::string name = GetParam()`.

## The IDE diagnostics bridge

`mcp__ide__getDiagnostics` returns whatever the attached IDE reports — in VS Code that is the TS language server plus installed extensions; in CLion it is SonarLint. It only covers files the IDE has **open**, and in CLion only the file that currently has **focus**.

Two traps, both measured:

- **Call it with no `uri`.** Passing an explicit `uri` came back with a mangled `file://wsl.localhost/...` path and an empty array — indistinguishable from a clean file. The argless call lists every known file and reports `linesInFile` for the ones actually loaded, which is how you tell "clean" from "not analyzed".
- An empty result for a file the IDE never opened is meaningless.
- **The result lags the file, in both directions, by more calls than you
  expect.** On a freshly focused file the FIRST call can come back `[]` and
  the second return real findings — measured on `SearchProver.cpp`, where
  one empty result would have read as a clean pass. After an edit the
  reverse happens: the finding you just fixed keeps being re-reported
  against stale ranges before the file settles. **Three consecutive
  empties is the bar for calling a `.cpp` clean.**
  **A stale finding can survive three calls, and a STABLE range is not
  evidence it is real.** Measured 2026-08-03 on `test/puzzle_test.cpp`: a
  `std::to_underlying` finding was re-reported three times after the fix,
  its range shifting once and then holding steady for two calls, before
  going clean on the fourth with no further edit. Ranges settling looks
  exactly like a genuine finding and is not one. So never conclude from
  the tool alone — **go read the file and count the occurrences of what
  it is complaining about**. One already-correct cast in the whole file is
  what settled that case; the tool caught up afterwards.

**A header is not independently analysed.** Sonar's C++ analysis runs over
translation units, so `getDiagnostics` on a focused `.h` reports nothing
whether it is clean or merely never compiled on its own — the two are
indistinguishable. The header's code IS covered when a `.cpp` that includes
it is analysed, so the honest reading of an empty header result is "no
findings reported, covered indirectly via N analysed TUs", not "clean".
Analyse the `.cpp` files first for this reason.

**`wasm_bindings.cpp` is invisible to every tool above and reports clean
because of it.** It is in no CMake target and no `compile_commands.json` —
`buildWasm.ts` hands it straight to `em++` — so SonarLint has no compile
command for it, `getDiagnostics` returns `[]` whatever the file contains, and
the clang-tidy gate never sees it either. Its whole body sits behind
`#ifdef __EMSCRIPTEN__`, so the native build does not even parse it. Measured
2026-08-02 on the logic-grid one: empty three calls running, while the file
held the same `using enum Status` finding SonarLint had just reported in
`main.cpp`. **The blind spot covers any header reached only from a wasm TU
too** — `MemoryProbe.h`'s emscripten branch carried two `modernize-use-auto`
findings nothing else in the toolchain could reach. `CLION-INSPECTIONS.md` has
the wasm32-target clang-tidy invocation that does analyse it.

**So: for C++ changes, finish by asking the user to open and focus each changed file in CLion, then call `getDiagnostics` (no `uri`) and check the file is actually listed before concluding it is clean.** For TS/JS this hand-off is unnecessary — `analyze_code_snippet` covers it headlessly.

## The aggregate CMake build

Three things are load-bearing and easy to undo.

- **`${PROJECT_SOURCE_DIR}`, never `${CMAKE_SOURCE_DIR}`, in the three `test/CMakeLists.txt`.** Under the aggregate the latter is the repo root, so `TEST_RESOURCES_DIR` would resolve *outside* the repo — where the rolling-blocks fixture tests `GTEST_SKIP()` rather than fail. A silently green run.
- **`a_star_core` / `shifting_mosaic_core` / `match_three_core` are `OBJECT` libraries** consumed by both the CLI and the gtest binary. The solver TUs used to be listed in both targets and compiled (and clang-tidied) twice. This is only correct because `TEST_RESOURCES_DIR` is the sole per-target compile definition and no solver TU reads it — **if a solver TU ever needs a target-specific define, the object library has to be split.**
- **`PROCESSORS 8` on the shifting-mosaic `gtest_discover_tests`** (`SM_TEST_PROCESSORS`, kept in sync with `ARMS` in `ParallelCascade.h`). Each fixture spawns 8 `std::thread`s, so it claims 8 ctest slots — one per thread it really runs — and ctest never oversubscribes: at `-j 4` the count exceeds the parallel level so the test runs **alone**, and at `-j 16` two run at a time. The cheap rolling-blocks, match-three and logic-grid tests fill the remaining slots — all three use `PROCESSORS 1`, because their arms are single-threaded natively (each thread race is `__EMSCRIPTEN_PTHREADS__`-only). Without it `ctest -j` runs them 4- or 16-wide, they starve each other, and `shiftingMosaicTest37` blows its per-arm budget — which reads as a regression and is not one. Measured at `-j 4`: 311/311 in ~152 s, test37 alone at 112 s.

`gtest_discover_tests` also sets `LABELS`, so a single page's suite runs as `ctest --test-dir build-ci -L rolling-blocks` (or `-L shifting-mosaic`, `-L match-three`, `-L logic-grid`).
