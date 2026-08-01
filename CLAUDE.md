# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A static, zero-framework site of five puzzle solvers for the game *Islands of Insight*, deployed to GitHub Pages. Each solver is a page under `src/pages/`; three of them run their search in C++ compiled to WebAssembly, and one (logic-grid) has no search at all yet. There is no backend and no client-side router — `src/util/serve.ts` maps six URLs to six HTML entry points, and `bun run build` emits the same six pages into `dist/`.

**match-three runs TWO engines and races them.** Its TypeScript search (a bundled Web Worker, `solverWorker.ts`) is arm zero and answers most boards in milliseconds without fetching a single wasm module; the C++ portfolio races beside it for the boards it cannot crack. `solveClient.ts` is the merge point. See "The match-three solver" below.

## Commands

```bash
bun install

bun run dev              # dev server on :3000 (src/util/serve.ts)
bun run build            # -> dist/ (runs build:wasm first via an import side effect)
bun run build:wasm       # em++ only; skips variants whose inputs have not moved

bun test                 # every unit test (bunfig.toml pins root = "test")
bun run test             # build:wasm + every unit test — no env gates
bun run test:fast        # everything except the four *.slow.test.ts suites (~5s)
bun run test:slow        # only those four
bun run test:changed     # only the files affected by the diff vs origin/main
bun run test:mt          # one page + the two shared root suites
                         #  (also :lg :pd :rb :sm)
bun run typecheck        # tsc --noEmit
bun run e2e              # playwright, spins up its own webServer
bun run e2e:install      # chromium + its system deps (what CI installs)

bun run og:capture       # re-shoot the Open Graph screenshots into images/og/,
                         #  which are COMMITTED. Starts a dev server unless one
                         #  is already up. Shells out to playwright's CLI under
                         #  node — see "SEO and site metadata".
bun run seo:indexnow     # submit every canonical url to IndexNow. deploy.yml
                         #  runs this after the Pages deployment goes live.

bun run bench:sm         # shifting-mosaic bench; --diff before.json after.json
bun run fuzz:sm          # generate-and-solve campaign into test-results/sm-fuzz
bun run bench:rb         # rolling-blocks bench over all fixtures; --diff works too
bun run fuzz:rb          # rolling-blocks campaign into test-results/rb-fuzz
                         # (--kind goal|coverage|mixed|cycle; boards are solvable
                         #  by construction and the witness is replay-validated)
bun run bench:mt         # match-three bench; the TS engine in-process by default,
                         #  the native CLI with --exe. That default exe path is
                         #  the CLion release dir, so --exe is required unless
                         #  you have built there. --diff joins two baselines by
                         #  fixture (so it compares the two ENGINES) and exits 1
                         #  on a regression, which is what lets it gate.
bun run harvest:mt       # is an NRPA plateau a trap? harvests its best partial
                         # lines and hands each endgame to the exact prover.
                         #  [--fixture N] [--seeds a,b] [--level N]
                         #  [--iterations N] [--ms N] [--exe <path>]; writes
                         #  test-results/mt-harvest. Needs the native exe.
bun run fuzz:mt          # match-three campaign into test-results/mt-fuzz; every
                         #  witness is replayed through the TS rules (see below).
                         #  --max-cells bounds which boards ALSO go through the
                         #  TS engine; a board whose answers diverge is kept on
                         #  disk, the rest are deleted unless --keep-all.
```

Running a subset:

```bash
bun test test/phasic-dial-solver                 # a directory
bun test test/configFile.test.ts                 # one file
bun test -t "should load a config from a file"   # by test name
bunx playwright test e2e/phasic-dial-solver
bunx playwright test e2e/shifting-mosaic-solver/config.test.ts:60
```

The expensive unit suites are opt-**out**, never opt-in. Four files carry
`.slow.test.ts`, and they run by default — including in CI, which sets nothing:

| File | Measured |
| --- | --- |
| `test/shifting-mosaic-solver/wasm.slow.test.ts` | ~244s |
| `test/match-three-solver/wasm.slow.test.ts` | ~75s |
| `test/rolling-blocks-solver/aStar.slow.test.ts` | ~60s |
| `test/match-three-solver/engine.solve.slow.test.ts` | ~22s |

Every other file under `test/` measures 300–780ms, except
`test/phasic-dial-solver/turnSolver.test.ts` at ~3.9s — still inside bun's 5 s
default, so it stays in the fast lane.

- `IOI_SKIP_SLOW=1` (what `bun run test:fast` sets) skips those four. They are
  `describe.skipIf`, so they **report as skipped**. This replaced
  `ROLLING_BLOCKS_TEST`, which was a `describe.if`: unset, it registered
  **nothing at all** and a 48-fixture sweep sat disabled behind a green run.
  **Never reintroduce `describe.if` for a cost gate** — inverting the default so
  forgetting a variable costs time rather than coverage is the whole point.
  (`describe.if(fixtures.length > 0)` in `turnSolver.test.ts` is the same trap
  in miniature, which is why a corpus-is-non-empty test sits outside it.)
- `SM_SLOW_E2E=1` — `e2e/shifting-mosaic-solver/heapLimit.slow.test.ts` (~4 min).
  Still opt-in, and a `test.skip`, so it reports as skipped.
- `MT_SLOW_E2E=1` — `e2e/match-three-solver/corpusTiming.slow.test.ts`, same
  shape. Not an assertion but a measurement: it drives all 52 captured boards
  through the real page and reports how long each takes. Measured 2026-08-01,
  cross-origin isolated on 16 cores: **52/52 finish, total 16.9 s, median
  104 ms, slowest 7.9 s.** Before the search stopped proving, that was 49 boards
  settling at a median 361 ms plus three running a 300 s budget each — about
  fifteen minutes for the corpus against seventeen seconds.
  `bench/QUALITY.md` carries the table.
  **Reload the page per fixture**: reusing one leaves the previous board's
  "Step 1 of 7" in the solution counter and the poll reads it as this board's
  answer within milliseconds — which is how the first version of this reported a
  46 ms median and move counts belonging to other boards.

`bun test` takes multiple positional substring filters, which is what the
per-page scripts use (`test:sm` = the page directory plus `configFile.test.ts`
and `utilMethods.test.ts`). `bun test slow` selects the four by name.
`bun test --changed=<ref>` walks the import graph — measured: on the match-three
commit it selected exactly the match-three files.

`bun run test:mem64` runs the three `mem64.node.test.mjs` files (shifting-mosaic + rolling-blocks + match-three) under node, not bun: bun cannot instantiate a Memory64 module. Under `bun test` they register as skips.

Playwright aria snapshots are inline. `--update-snapshots` only rewrites *failing* ones; aria matching is **partial**, so a snapshot keeps passing when new nodes appear. Use `--update-snapshots=all` to get a faithful tree — it writes `test-results/playwright/rebaselines.patch` for `git apply`.

## Architecture

### Page shape

Every page is `index.html` + a `<page>Solver.ts` class + a `.css`, plus `src/common/common.ts` which registers the Material Web custom elements used across all pages. Pages talk to the DOM by `id` directly; there is no component layer and no state library.

The solver class is instantiated at module scope behind `if (process.env.NODE_ENV !== "test")` (`src/util/preload.ts` sets that). Unit tests therefore construct it themselves, and they do it by **mounting the page's own markup**: a `MARKUP` template literal trimmed to the ids and hooks the class reaches for, assigned to `document.body.innerHTML` in `beforeEach`, then `new PageEditor()`. Not a `getElementById` spy — every page also runs `querySelectorAll` over its chip rows or hands a host element to a view class that registers delegated listeners on it, and detached stubs swallow those interactions silently. `md-dialog` is not registered in the test DOM, so mounts that use one assign `show`/`close` onto it by hand.

### Bundling

`src/util/plugins.ts` supplies two Bun plugins used by both `build.ts` and `serve.ts`:

- `pngDataUrl` inlines every PNG *except* `favicon.png` as a base64 data URL. A new image needs only an `import`, no copy step — but `dist/` has no `images/` directory, so anything referenced by URL rather than imported will 404.
- `sassCompiler` compiles `.scss`.

**Bun's HTML entrypoints do not bundle Web Workers.** `new Worker(new URL("./x.ts", import.meta.url), …)` survives minification with the `.ts` specifier intact, so it 404s in `dist/` — measured, and it fails silently at build time. The match-three worker therefore gets its own `Bun.build` pass in `src/util/buildWorker.ts`, called from both `build.ts` (writes `dist/mt-worker/solverWorker.js`) and `serve.ts` (bundles per request, since HMR does not reach a worker). The page reaches it as `../mt-worker/solverWorker.js`: relative to `/match-three-solver` (dev, no trailing slash) *and* `/match-three-solver/index.html` (Pages), that resolves to the same absolute path — the same trick the emscripten workers use with `../rb-wasm/`.

Material Symbols icons come from a **subset URL** in `src/common/common.css` (`icon_names=add,cancel,delete,download,…`). A `<md-icon>` naming a glyph not in that list renders as garbage text, not a missing icon.

**The production build must run as `bun run build`**, which pins `NODE_ENV=production`. Material Web pulls in Lit, whose package exports carry a `development` condition; Bun's bundler selects it otherwise and ships the development build of Lit, which logs "Lit is in dev mode" on every page load. Setting it inside `build.ts` does **not** work — `Bun.build` does not read `process.env.NODE_ENV` at call time (measured: all 20 dev-mode sites stayed in the bundle), so it has to be on the process from the start. Invoking `bun src/util/build.ts` directly silently produces a dev-mode bundle.

The dev server keeps `development: true` for HMR and therefore *does* log that warning — expected locally, and the reason the build pins the variable rather than relying on the ambient environment. `NODE_ENV=production` and the `{ hmr: true }` object form were both measured and neither suppresses it; only `development: false` does, at the cost of HMR.

### C++ → WebAssembly

`src/util/buildWasm.ts` drives `em++` (resolved via `Bun.which`, emsdk ≥ 6.0.0 required for `-m64`) and produces **four variants per solver** from the same translation units — plain wasm32, `-pthread`, MEMORY64 (8GB heap), and pthreads+MEMORY64 — built concurrently, for all three C++ solvers. Assets are served/copied under `/rb-wasm/`, `/sm-wasm/` and `/mt-wasm/` (`serve.ts` allowlist, `build.ts` copies; workers are reached page-relative as `../rb-wasm/astar.worker.js`). Twelve LTO variants is why the CI wasm job allows 35 minutes on a cold cache.

`src/pages/*/wasm/` is generated output and gitignored, **except** `astar.worker.js`, which is hand-written source living in the same directory. Do not delete the directory wholesale.

The source lists are duplicated in two places that must stay in sync: `buildWasm.ts` and the C++ `CMakeLists.txt`. A missing TU fails at link time with undefined symbols. (There used to be a third copy — a hand-written `em++` loop in `.github/workflows/test.yml`. CI now calls `bun run build:wasm`, which also made it concurrent rather than eight serial builds.)

**Variants are skipped when their inputs have not moved.** Each writes an `astar*.mjs.stamp` next to its output holding a sha256 over the `sources`, **every `*.h` in the a-star directory root**, and the compiler **flags**, plus the `em++ --version` string. All four inputs are load-bearing:

- the headers because `AStar.h`, `PuzzleProfile.h`, `ParallelCascade.h` and friends are in no `sources` list yet absolutely change the output. Only the a-star **root** is hashed — `bench/` and `test/` are native-only and must not invalidate the wasm;
- the flags because they carry `SM_SIMD`, `-m64`, `-pthread`, `EXPORT_NAME` and the memory ceilings;
- **content, never mtimes** — a fresh `git checkout` and an `actions/cache` restore both rewrite mtimes wholesale, so an mtime check would trust a restored-but-stale output.

**Flags only — never the full argv, and never an absolute path.** `build()` keeps `flagArgs` separate from the source list, the `-o` target and the `-I $BOOST_INCLUDE` for exactly this reason. Hashing the whole argv broke CI on the first run: the composite action sets `BOOST_INCLUDE` in the job that compiles and not in the job that only bundles, so one commit produced two different hashes and the second job tried to rebuild with no compiler. `needsBoost` is hashed as a boolean in the path's place, so switching a solver's boost dependency still invalidates while the machine-specific path does not.

`FORCE_WASM=1` rebuilds regardless. The stamp is deliberately **not** a dotfile: `actions/upload-artifact` v4+ drops hidden files unless told otherwise, and a stamp that failed to travel with its binary would make the CI `dist` job try to compile.

`resolveEmcc()` is **lazy and returns null rather than throwing**, so a tree whose wasm is already current builds with no emsdk at all — which is what lets the CI `dist` job and deploy's cache-hit path run `bun run build` on a runner that never installed emscripten. A skip with no compiler to compare versions against warns loudly, because "no emsdk" must never look like "verified current".

### The three solver bridges

All three are **portfolios** with the same mechanics: an exported `PORTFOLIO` array of engine configs, one worker per arm racing the others, the rest terminated once the answer is settled. Concurrency is bounded by `hardwareConcurrency`, not the arm count — every arm always runs, queued and back-filled. An arm that exhausts the heap retires itself and the race continues. Cross-origin isolated pages collapse to ONE worker on the pthreads build, whose in-module race runs the same arm set on real threads. Variant priority (threads-mem64 > threads > mem64 > default) comes from the shared probes in `src/util/wasmFeatureProbes.ts`.

All three now stop at the **first non-empty plan**. Match-three used to be the exception — it aggregated, because a plan was not the answer and a *shortest* plan was — and dropping that is what made its hard boards fast: the whole 52-board corpus finishes in 16.9 s where three of them used to run a five-minute budget each.

- **rolling-blocks** (`wasmBridge.ts` → `searchRollingBlocksWasm`): wasm exports `solve(puzzle, config)` and `optimize(puzzle, turns)` — config keys (all optional): `engine` (`cascade` default | `wastar` | `exact` | `cracker` | `beam` | `greedy`), `weight` (2), `maxMs` (60000), `maxNodes`, `maxStatesStored`, `maxHeapBytes` (0 = unlimited), `seed`, `beamWidth`, `gated`, `postProcess` (true), `optimizeMaxMs` (30000). `solve` returns `{turns, stats:{nodesExpanded, statesStored, stoppedOnMemory, wallMs, engine}}` or `{turns: [], error}` for boards beyond the engine caps (64×64 grid, 255 blocks, dims ≤ 64). Arm selection lives in `SolverArms.cpp` (shared by CLI and bindings; its `kPortfolio` must stay in sync with the bridge's `PORTFOLIO`): `cascade` first **decomposes** the board into independent playable regions (a rectangular footprint can never straddle an Unplayable cell, so blocks are confined to their starting region forever — sub-puzzles solve separately and plans concatenate; this took the first fuzz campaign from 21/30 to 30/30), then chains exact (gated) → cracker (gated) → wastar w2 → greedy → beam → cracker jittered → wastar w4 → wastar w1 with budget shares of the total (order re-measured on that campaign — greedy solo cracked boards wastar and beam both missed). Gates live in `PuzzleProfile.h` (the cracker takes must-touch-dominant boards with ≤ 2 blocks — measured: fixtures 37/38/39 fall in 106/60/7907 expansions where weighted A* needed millions; via the cascade they solve in 5–141 ms, see `a-star/bench/baseline-cascade.json`). Two-block coverage boards route through the three-phase split scheme in `SolverArms.cpp` (plain sequential split → `LegOrderSearch`, a best-first search over LEG ORDER with required-subset cracker legs, pose-space coverability and orphan + coverage-intact prunes → joint finisher; every candidate plan is full-replay-validated; it carries fixture 34 in well under a second where wastar needed 4 s). The cracker-only `Config` fields `requiredCells` / `coveragePartner` / `jointCoverageIntact` exist for these legs and are never exposed at the wasm/CLI boundary; `a-star/bench/HARD-BOARDS.md` documents the scheme and the still-open fuzz-7007 board.
- **shifting-mosaic** (`wasmBridge.ts` → `searchShiftingMosaicWasm`): the original portfolio; `PORTFOLIO` is exported so `test/shifting-mosaic-solver/wasm.slow.test.ts` races the exact production arm set.
- **match-three** (`wasmBridge.ts` → `searchMatchThreeWasm`, merged in `solveClient.ts`): wasm exports `solve(puzzle, config)` and `verify(puzzle, moves)`. `puzzle` is `{gridWidth, gridHeight, cells}` with cells **flat and row-major** (the fixture format is column-major — `flatten()` in the bridge converts). Config keys (all optional): `engine` (`cascade` default | `greedy` | `beam` | `nrpa` | `exhaustive`), `maxMs` (300000), `tableBytes`, `maxHeapBytes`, `seed`, `beamWidth`, `nrpaLevel`, `nrpaIterations`. `solve` returns `{moves, unsolvable, stats}` or `{moves: [], error}` — there is no `proven` and no `ruledOut`, because nothing here claims a length is minimal. Errors are in-band because the build is `-fno-exceptions`: a throw would reach the page as an aborted module rather than a message it can show.

**Three** solver pages need `SharedArrayBuffer` for their threads builds, which GitHub Pages cannot grant via headers. `src/common/coiRegister.ts` registers `coi-serviceworker.js` and **reloads once** when it activates. `page.goto()` resolves on the *pre-reload* document, so any e2e interaction in that window can die with "Execution context was destroyed". Always reach the rolling-blocks, shifting-mosaic AND match-three pages through `gotoIsolated` / `waitForCoiSettled` in `e2e/coi.ts` (`MATCH_THREE_URL` is exported there); `e2e/index.test.ts` needs a `waitForCoiSettled` before every Home click that leaves one of them.

### Step-by-step solution views

Three pages answer with a **step view rather than a list**: match-three, shifting-mosaic and rolling-blocks all hide `#editor-section` and show a sibling `#solution-view` built from the same ids — `#solution-grid`, `#solution-step-counter`, `#solution-step-text`, `#solution-prev`, `#solution-next`, `#solution-exit` — with a `dispose()` that releases every listener before the view is dropped. `src/util/gridOutline.ts` carries the two helpers they share (`markBlockEdges`, `markZoneEdges`): a grid with gaps between cells cannot be outlined with one border, so a zone is drawn as an edge class per cell whose neighbour is outside it.

Rolling-blocks additionally keeps its full move list (`#solution-moves`) inside that view, with the current row `aria-current="step"` and clickable to jump. **Solving therefore leaves the editor**, so an e2e test that edits the board after solving has to click "Back to editor" first. The answer survives that: `#solution-steps` re-opens the same path without re-solving, and only `hideSolution()` (any real edit) throws it away.

**`src/pages/rolling-blocks-solver/replay.ts` is a second copy of `a-star/Replay.cpp`'s semantics and the two must stay in sync.** The C++ one is the oracle the solver and its gtests use; the TS one is what the page needs to draw the board *between* two rolls, and it is also what `test/rolling-blocks-solver/aStar.slow.test.ts` validates all 48 wasm answers with. Everything it implements already lives in `Block` — it only sequences `clone` → `roll` → `checkValidity` → `updateMustTouchCells`. The two rules that make a naive re-roll wrong: the satisfied mask is **seeded from the starting footprints**, and a must-touch cell that is already satisfied **becomes blocking**, so a star can only be stepped on once.

### Config file I/O

`src/util/configFile.ts` holds `downloadJson` / `readJsonFile` / `setupDragAndDrop`, shared by all five solver pages. Each page keeps its own `config.ts` validator returning `{ ok: true, config } | { ok: false, error }` with a human-readable first-failure message, and its own `applyLoadedConfig`. The download filename matches the fixture family (`phasicDialTest.json`, `shiftingMosaicTest.json`, `rollingBlocksTest.json`, `matchThreeTest.json`, `logicGridTest.json`) so a downloaded file is directly usable as a test fixture. `#warning-banner` / `#drop-overlay` / `.hidden` styles live in `src/common/common.css`. The rolling-blocks validator also enforces the engine caps (64×64 grid, 255 blocks, dims ≤ 64 — same constants the UI fields and the wasm boundary use) and renumbers block ids to 1..n on load; **this validator** ignores a fixture's optional `turns` key. That is a page-level rule, not a repo-wide one — the native `fixtureio::load` deliberately does the opposite and parses `turns` back out, because that key is where `--generate` stores the replay-validated witness.

E2e traps for the rolling-blocks page: several inline aria snapshots include the page subtitle text, and Material components expose an inner `#button` in their shadow DOM — never target buttons by `#button` index (adding any icon button shifts every index; use the app's own `data-block-delete-id` style hooks).

### SEO and site metadata

`src/util/siteMeta.ts` is the single source of truth: `SITE_URL`, the `PAGES` list (path, source file, og image name, title, description), the sitemap and robots renderers, and the IndexNow key. The `<head>` tags themselves are **hand-written into the six `index.html` files** — there is no templating layer and adding one for six static files would be worse than the duplication — and `test/siteMeta.test.ts` pins every title, description, canonical, og:url and og:image against `siteMeta.ts` so the copies cannot drift. `e2e/seo.test.ts` re-checks the same things on the *served* page, because the bundler rewrites hrefs on the way through.

Adding a page means: an entry in `PAGES`, the head tags in its HTML, its trailing-slash route in `serve.ts`, its entrypoint in `build.ts`, a card in `src/pages/index.html` (**in `PAGES` order** — `e2e/seo.test.ts` pins the two lists against each other) with its `ItemList` entry, a leg in `e2e/index.test.ts`, and `bun run og:capture`. Nothing else needs editing — the sitemap, the IndexNow submission and both SEO test suites read the list. A page that registers the COI shim additionally belongs in the `COI_PATHS` sets in `e2e/seo.test.ts` and `src/util/captureOgImages.ts`.

Five things are load-bearing and easy to undo:

- **The site is a GitHub Pages *project* page**, served from `/islands-of-insight-tools/`. Every absolute url carries that prefix, and a root-absolute href (`/images/favicon.png`) points outside the site — which is exactly what the favicon used to do, 404ing on the live site.
- **The favicon must stay an ABSOLUTE url.** Bun's HTML bundler resolves every asset href it *can* resolve and inlines the result as a base64 `data:` URI — measured at 91 KB per page, and Googlebot-Image cannot fetch a `data:` URI, so the site showed a default globe. A page-relative href does not work either: Bun fails the build with "Could not resolve" rather than leaving it alone. Absolute urls pass through untouched, and `build.ts` re-checks the built output rather than trusting that. Dropping the data URI also took `dist/index.html` from 241 KB to 155 KB.
- **Canonical urls carry a trailing slash.** GitHub Pages 301s `/match-three-solver` to `/match-three-solver/`, so the slash-less form is both a wasted hop and a second url for the same page. Internal links and the sitemap use the slash.
- **Never register one HTMLBundle under two routes in `serve.ts`.** Serving both spellings that way looks obvious and it *crashes bun's dev server*: `panic(main thread): integer overflow`, a few seconds into concurrent load. It does not reproduce on a single page or a small suite — measured on the full e2e run against a green baseline, 97/99 passing became 39/106 with 65 connection-level failures and a bun crash dump, which reads exactly like the flake in the next paragraph and is not one. `serve.ts` registers the canonical trailing-slash route only and 301s the other spelling from `fetch`, which is also what Pages does in production.
  **That panic is a symptom, not a diagnosis.** The same `integer overflow` reproduces with the route table entirely correct, purely from CONCURRENCY: measured 2026-08-01 on bun 1.3.14 / Windows, `bunx playwright test` at the default worker count (cores/2) crashes the dev server ~20 s in and takes the rest of the run down with it, while `--workers=2` finishes the identical suite 136/136 clean. It was bisected by unregistering the newest page and re-running — the panic survived, so it is not about how many entrypoints there are either. CI is unaffected: its runners are small enough that Playwright allocates one worker per shard. So when a local full run collapses into `ERR_CONNECTION_RESET`, check the route table once and then **re-run with `--workers=2` before believing anything is broken**.
- **`robots.txt` shipped from this repo is inert**, and deliberately shipped anyway. Crawlers read robots.txt from the host root only, so `valle12.github.io/robots.txt` — a separate `Valle12.github.io` user-pages repo — is the one that counts. That repo is also the only way to get a favicon into Google results at all: Google supports **one favicon per hostname**, read from that hostname's home page.
- **`dist` ships nothing `build.ts` does not copy.** A new static file needs a copy in `build.ts` *and* a branch in `serve.ts`'s allowlist, which 404s everything else. The sitemap and robots are *rendered* in both places rather than read off disk, so they cannot go stale.

The Open Graph screenshots live in `images/og/` and are **committed**. `bun run og:capture` re-shoots them, and it drives Playwright's **CLI under node** rather than its API: `chromium.launch()` hangs forever under bun — no error, no timeout — which is also why `bun run e2e` shells out to `playwright test`. Its flags (`--light`, `--full-page`, `--width`, `--height`, `--out`) are for looking at variations locally; the defaults are what the meta tags declare, and the script warns when they are overridden.

Two things about that capture size. **Chromium renders light unless told otherwise**, whatever the host OS prefers, so the scheme is always passed explicitly — the committed shots are `dark`. And **the frame is 1920x1005, not the usual 1200x630**: Open Graph wants 1.91:1 and a scraper centre-crops anything else, so a taller screenshot loses its edges rather than showing more. Widening at that ratio is the only way to fit a taller page in, which is why the size has grown twice — 1200x630 cut every solver off mid-grid, 1600x838 fitted five pages, and logic-grid then needed 951 px and lost its rules and Solve button.

**A new page can therefore force this size up, and the number to measure is the CARD, not the screenshot.** `#editor-card` is capped at `min(100%, 960px)`, so past about 1000 px a wider viewport buys height and nothing else — it does not reflow the content, it just adds empty margin beside it. Measure `#editor-card`'s bounding box plus the body's 24 px padding top and bottom, then pick the smallest 1.91:1 frame that clears it; `document.documentElement.scrollHeight` is **not** that number, because `body { min-height: 100vh }` clamps it up to the viewport and makes an overflowing page look like it fits. Changing the size means `OG_IMAGE_WIDTH`/`HEIGHT` in `siteMeta.ts`, the `og:image:width`/`height` tags in **every** `index.html`, and a re-run of `bun run og:capture`. `test/siteMeta.test.ts` checks the declared tags, the constants and the committed PNG headers all agree.

**Automatic indexing does not exist for Google.** Its Indexing API accepts only `JobPosting` and `BroadcastEvent` and ignores everything else, and Google has never adopted IndexNow. `sitemap.xml` is the automatic mechanism: submit it once in Search Console and Google re-fetches it on its own, so a new page is discovered without further action. The `indexnow` job in `deploy.yml` covers Bing, Yandex, Seznam and Naver, runs *after* `deploy` (the urls have to be live when they are submitted) and is `continue-on-error`. The sitemap carries **no `lastmod`**: CI checks out shallow so a git date would be the same commit for every url, and a build timestamp would claim every page changed on every deploy.

### The logic grid page

The newest page, and the only one with **no search behind it**: `solver.ts` is a
stub returning `{status: "unimplemented"}` and `#solution-panel` says so. There
is no worker, no wasm, no COI shim and no `#solution-view` — a solved logic grid
is one finished board rather than a sequence of steps, so when the search lands
it will most likely render into the editor grid.

**A cell carries two independent layers.** `cell.ts` owns the colour only
(`UNKNOWN` 0, `DARK` 1, `LIGHT` 2, `UNPLAYABLE` 3) and `cells` is a flat
column-major integer grid of exactly that. Clues live in a **separate sparse
`symbols` array** of `{x, y, type, value}`, which is what makes the game's
colourless clue representable: a clue on an `UNKNOWN` cell is one whose colour
has still to be deduced, and colouring the cell later leaves the clue alone. A
clue takes the colour of the cell it sits on and has none of its own — that is
why `cellView.ts` draws it as the element's own **text**, with the ink following
`data-color`, rather than as a background image the way match-three does.

**`rules.ts` and `symbols.ts` are both append-only catalogues**, for the same
reason `match-three-solver/symbols.ts` is: a config stores the INDEX of an
active rule and of a clue's kind, so inserting or reordering an entry silently
rewrites every puzzle ever saved. Appending is always safe. Both rows are
rendered from the list by JS (`#rule-row`, `#symbol-row`) precisely so a new
entry costs no markup and no test edit. The validator **rejects** an index it
does not know rather than ignoring it — a silently dropped rule would load a
different puzzle under the same name.

**A clue kind is a split control, and its value field lives INSIDE the row.**
Each kind renders as chip + divider + its own `<input class="symbol-value">`,
in the shape of a Material split button, rather than one shared field below the
row — a shared field has to keep saying which clue it belongs to, and every kind
added makes that worse. Typing in a field selects its kind, so a field can never
be edited while a different chip is armed, and each field reports its **own**
validity (`aria-invalid`) rather than the selected kind's.

That is why both rows are **built once and refreshed in place**:
`buildSymbolRow` / `buildRuleRow` write `innerHTML` and run only from `render()`
(board replacement), while `refreshSymbolRow` / `refreshRuleRow` toggle classes
and attributes on every selection change. Rebuilding on selection would destroy
the field being typed into, and `refreshSymbolRow` additionally skips writing
`input.value` when it already matches — assigning it moves the caret to the end.
The same discipline is what keeps a rule chip focused after a keyboard toggle.

Three things in `board.ts` are load-bearing:

- **The right mouse button is a real input here.** The selected chip drives the
  left button; the right one paints the *other* colour for `dark`/`light` and
  erases for everything else, so the untouched page is left-dark/right-light
  with nothing clicked. `contextmenu` on `#grid` is `preventDefault`ed, or a
  right-drag pops the menu and ends the stroke on the first cell.
- **The re-click-erases rule commits once, at `pointerdown`.** A stroke that
  would write what the cell already holds clears it instead, and that decision
  is then applied to every cell the drag touches. Deciding it per cell makes a
  drag across a half-painted row alternate between painting and erasing.
- **Digits accumulate per cell.** An area number runs past nine, so consecutive
  digits typed on one focused cell grow the number; painting, or moving to
  another cell, ends the run. A leading zero is ignored rather than clamped, and
  a number that would outgrow the board leaves the last good value standing.

Painting `UNPLAYABLE` drops the cell's clue (a gap is not clued, and the
validator refuses a file that says otherwise); the eraser clears both layers;
colouring a clued cell keeps its clue.

### The match-three solver

The rules are in `rules.ts` and the TypeScript search in `engine.ts`; both are pure and synchronous so the unit tests never touch a worker. `src/pages/match-three-solver/a-star/` holds a second engine in C++, and `rules.ts` remains the **definition of record** for both: `solutionView.ts` renders a solution by replaying it through `rules.applyMove`, so a witness those rules refuse is unplayable no matter which engine produced it.

The rules, unchanged by any of the optimization work:

- **Matches** are the union of every horizontal run ≥3 and every vertical run ≥3. `+`, `T` and `L` need no special case — they are just cells that both passes mark. Gravity is per column and stops at `BLOCKED`, so a column is a set of independent segments; clear/drop repeats until stable (a *cascade*).
- **A move** swaps two orthogonally adjacent cells that are both blocks and hold different symbols, and is legal only if it clears something. Candidate generation only probes right/down neighbours (all four would offer each swap twice) and only checks the two moved cells, since a new match must pass through one of them.
- **The board must already have settled.** `boardProblem` refuses a floating block or a line still standing rather than repairing it — solving a repaired board would answer a puzzle the player never had. This is a *solver*-level check, deliberately not a validator one: `config.ts` passes any well-formed file, so the editor will happily hold a half-drawn board that Solve then refuses by name.
- **The forced-single-clear bound** (`forcedClear.ts`, `a-star/ForcedClear.h`) is the one admissible lower bound that pays, and it is a prune in both provers. Every clear takes ≥3 blocks of the symbol it clears, so a symbol at exactly **4 or 5** blocks must lose all of them in ONE clear — taking 3 strands the rest. All of them must therefore reach one clearing shape, and that costs moves: a block changes column only via a horizontal swap of one column, and such a swap moves blocks of two *different* symbols, so a symbol gains at most one unit of horizontal displacement per move. Measured while the search still proved: test47's `ruledOut` went 11 → 12 at a 60 s budget, with *fewer* nodes — the prune survived the drop of proving because it is a prune, not a proof. **Four cells can only clear as a straight run of four, but five can also clear as a T/L/plus** (perpendicular 3+3 sharing a cell) — pricing five as a straight run only would over-estimate, and an over-estimating bound in a prover is not conservative, it is wrong. `forcedClear.test.ts` pins that case.
- **Region decomposition does not apply**, unlike the rolling-blocks cascade's. Measured: all three hard boards are ONE 4-connected component, and splitting on the depth-1..6 frontier killed zero extra states. Gravity plus cascades couple the whole board.
- **Do not add a "`remaining` moves clear at most `remaining * 3` cells" prune.** A move clears *at least* three, never at most: one swap can cascade the whole board away. That bound was tried and it cut off exactly the cascade solutions (caught by `engine.test.ts`'s `CASCADE_CLEARS`). There is consequently **no admissible lower bound at all**, which is why nothing here is A*-shaped: pressure has to come from above, as an upper bound to search under.
- The load-bearing prune is the **stranded symbol** — a symbol down to one or two blocks can never line up again. Both engines keep per-symbol counts incrementally and check them in O(1) per node rather than rescanning the board.

**The search stops at the first solution it can play, and claims nothing about its length.** `SolveResult` is `{status:"solved", moves}` | `{status:"unsolvable"}` | `{status:"budget"}`:

- There is no `proven`, no `groupingProven` and no `ruledOut`. Proving a length minimal was the whole reason the hard boards ran to the budget, and it bought almost nothing: measured across the corpus, **the first solution found is the minimal one on 48 of 49 boards**. Exactly two boards pay for the change — `matchThreeTest46` (8 moves where 7 exist) and, on the single-arm native cascade, `matchThreeTest47` (21 where 20 exist; the page's portfolio still returns 20).
- `unsolvable` is the ONE proof left, and it is about existence rather than length: reached by exhausting `maxDepth = floor(blocks / MIN_RUN)`, which terminates on its own because every move clears ≥ MIN_RUN cells.
- `budget` means nothing was found. It no longer carries a number, because nothing is being ruled out.
- The page opens the solution viewer by itself the moment a solution arrives. There is no "not proven to be the shortest" note and no "Stop — use best so far" button; Cancel is a plain cancel, and reaching it means nothing was found.

**The arms, in the order they run.** Both engines have the same set (`fastSolvers.ts` + `engine.ts` in TypeScript, `Search*.cpp` + `SolverArms.cpp` in C++), and both give the fast ones a *cap* on the budget rather than a floor, so an easy board pays nothing for them:

1. **greedy** — rollouts, biggest clear first, refusing to strand a symbol unless every move does. Rollout one is purely greedy; every restart after it samples from a softmax over `cleared`. Measured over all 52 captured boards with the arm run alone: **it answers 38, and every one of those 38 answers is already the proven optimum, worst case 4 ms.** It says nothing about the other 14. Gives up after 60 restarts without an improvement.
2. **beam** — level-synchronous over move count, widening 128 → 512 → 2048. Never shortened anything greedy found on this corpus.
3. **NRPA** (`nrpa.ts`, `SearchNrpa.cpp`) — Nested Rollout Policy Adaptation: a weight per move code, playouts sampling ∝ `exp(weight)`, each nesting level nudging the policy toward the best sequence it saw. **This is the arm that cracked `matchThreeTest50` (23 moves) and `matchThreeTest51` (15–16) — both of which every systematic arm returns nothing for at any budget**, and on the page it is also what answers `matchThreeTest47` at 20 rather than the exhaustive search's 21. Its details are the subject of `a-star/bench/HARD-BOARDS.md`; three things about it are load-bearing and easy to undo:
   - **It optimises fewest-blocks-left, so its best line is usually PARTIAL.** Returning that as a solution emitted a move list that does not clear the board (`fixtures_test` caught it). An arm returns a solution or nothing.
   - **It must RESTART when a level-N search exhausts its iterations**, with a fresh policy. Without that it stopped with two thirds of its slice unspent; restarts took test50 from 2 of 8 seeds to 5 of 8. The reason is measured: a plateau state is *provably dead* 3 times in 4 (`bun run harvest:mt` harvests them and hands each to the exact prover — the endgame is tiny, so `unsolvable` there is a real proof). A run that plateaus has run out of *this policy*, not out of search.
   - **The restart loop needs two bounds or it spins on a dead board.** `kBarrenRestarts = 64` (measured: four unit tests timed out without it, and it took the whole `bun test` from 596 s to 366 s), plus a stranded-symbol check at the root. The counter is on *barren restarts*, deliberately NOT on restarts-since-improvement: test50's winning restart jumps from 9 blocks left straight to 0 while every other restart also reaches 9, so the tempting version would cut off exactly the draw that wins.
   - **The restart ladder's rungs cost the same on purpose** (~10 000 playouts each). A rung is `iterations ^ level` playouts, so the natural-looking counts are 16× apart — level 4 × 20 is 160 000 playouts, about 94 s, more than a whole slice, and a ladder containing it gets two restarts and then nothing.
   - **No single NRPA configuration wins both hard boards, so the portfolio races two.** Measured over eight seeds at 45 s: level 2 × 100 pinned takes test50 6/8 but test47 2/8; the cycling ladder takes test47 5/8 but test50 2/8. Five configurations were tried and each gain cost the other board. `kPortfolio` therefore carries one pinned arm, one ladder arm, and one redundant pinned arm — do not "simplify" them to one config.
   - Success is **per-seed** as well as per-config, so more arms beat one arm thinking longer.
4. **`exhaustive`** — one pass at `maxDepth`, returning the moment it finds anything. It is both the finder of last resort (it answers `matchThreeTest47`) and **the only arm that can report `unsolvable`**, which it does by searching that depth out with nothing found. It inherits whatever the cheaper arms did not spend. This replaced two arms, `iddfs` and `bnb`: iterative deepening existed only to guarantee the first find was the shortest, and one dive to `maxDepth` does both jobs once that guarantee is dropped.

**Every arm is skipped once any witness exists**, since the search returns on the first one. `findsOnly` in the C++ cascade's leg list survives on `beam` and `nrpa` to say they could never have done anything else.

**A noise term smaller than one unit of the score it perturbs is not randomisation.** The greedy arms scored `alive*1e6 + cleared*256 + rng()*255`, so the noise could only break exact ties: measured on test51, **4000 restarts produced two distinct outcomes.** Real sampling took the same rollouts from 19 blocks stuck to 7 left, and 2 → 1517 outcomes. Worth remembering anywhere a "randomised restart" is not diversifying.

**The transposition table is bounded and evicts** (`transTable.ts`, `TransTable.h`): 4-bit-packed exact keys in a flat `Uint32Array`, 4-way buckets, a 256 MB ceiling per arm. Eviction is sound — an entry only ever prevents re-searching a subtree already proven barren at that remaining depth, so losing one re-searches to the same conclusion, slower. What would be unsound is a **false hit**, which is why keys are compared in full and never by hash alone, or recording a budget-aborted subtree, which the `searchedOut && no solutions found` discipline excludes. Two measured traps live in those files:

- **The hash must avalanche.** The bucket index is the hash's LOW bits, and a bare multiply's low bits never see the operands' high bits; without a murmur-style finalizer, boards differing only in high-nibble cells all landed in one bucket and the grow-on-overflow path ballooned a 229-entry table to its ceiling, then evicted entries a live search still needed. A shadow-`Map` harness over a full solve is what caught it.
- **Do not resize the per-depth scratch mid-recursion.** A deeper frame's `emplace_back` on the `levels_` vector reallocates and leaves every enclosing frame's `Level &` dangling; it is sized once, up front.

This replaced a `Map<string, number>` whose ~200-char keys cost a measured 284 bytes each and grew without bound — the reason `matchThreeTest50/51` used to die at 19.1 GB and 7.4 GB RSS. At a 300 s budget they now hold ~500 MB flat.

**The budget is 60 s** (`SOLVE_BUDGET_MS`), and it now bounds only the boards where NOTHING is found — the search returns as soon as it has an answer. Measured on the real page over the 52 captured boards: **52/52 finish, total 16.9 s, median 104 ms, slowest 7.9 s**, so a minute is roughly eight times the worst case anything real has needed. Every test that leans on a budget still passes an explicit one.

**How the bridge races the two engines** (`solveClient.ts`). One `Merged` object collects from both sides — the TypeScript worker and every wasm arm — and it has one rule left, the load-bearing one: **a candidate is accepted only after being replayed through `rules.applyMove`.** `Merged.done` is then simply `alreadyClear || unsolvable || best !== null`, and the first accepted candidate ends the race. With no proving left, that replay is the ONLY thing between a bad witness and the viewer.

One case needs naming because a browser found it and no unit test would have: an **empty board**'s zero-move answer looks exactly like "this arm found nothing", so `Merged` knows a cleared board is its own answer.

**`WasmHandle.terminate` must set `settled`**, not just kill the workers. `retire` and `spawnNext` guard only on that flag, so a `done` message that reaches `finish()` synchronously falls through to `retire` and back-fills a FRESH worker after the portfolio was torn down — one that runs its whole budget with nobody listening. Rare while the race ended on a proof; the normal case now that the first witness ends it with most of the portfolio still queued.

`solutionView.ts` replays the move list through `rules.applyMove` rather than being handed board snapshots, so the engine stays the single source of truth. It marks **only** the two cells to swap (`data-swap="a"|"b"`, plus a `↔`/`↕` badge straddling the gap between them). Outlining what the move clears as well was tried and removed: on a move that takes a dozen blocks it left the board unreadable, and the step text gives the count anyway.

The step text names cells by **position, never by tile** — several tiles cannot be named usefully ("Purple 2", "Nude"), the ringed cells already say which two, and every symbol appended makes naming worse.

### The match-three cell encoding

`src/pages/match-three-solver/cell.ts` is the single definition: **a cell is one number**, never a string. `EMPTY = 0`, `BLOCKED = 1`, `FIRST_SYMBOL = 2`, and the symbol at index `i` of `symbols.ts` is stored as `FIRST_SYMBOL + i` — so `cells` in the config JSON is a flat integer grid and `isSymbol` is one comparison. Go through `symbolCell` / `symbolIndexOf` / `isSymbol` rather than open-coding the `+ 2`. The `data-kind` DOM attribute (`empty` / `blocked` / `symbol`) is a *rendering* detail for CSS and e2e selectors — it is not what the model stores.

### The match-three symbols

`src/pages/match-three-solver/symbols.ts` owns `SYMBOLS`, an ordered list of the game's own block tiles (`id`, `label`, and the PNG from `images/`). There is **no per-board palette**: a cell stores an index into this global list, the tool row always offers every symbol, and the config carries no symbol mapping at all.

**The list is append-only.** Inserting or reordering an entry silently repaints every board ever saved, because saved boards reference symbols by index. Appending is always safe and needs no migration — a board simply never mentions the indices it does not use, which is what lets new tiles land without touching existing fixtures.

Renaming an entry is safe — nothing is stored by name, only by position — but **moving one is not**. Index 2 was `pink` before the tile now at index 5 arrived; only the ids changed, the artwork stayed put.

To add one: drop a 96px PNG in `images/` (`ffmpeg -i in.png -vf scale=96:96:flags=lanczos out.png` if it is bigger — `pngDataUrl` inlines every PNG into the page as base64, so full-resolution art costs ~90 KB a tile), then append an entry to `SYMBOLS`. Nothing else needs editing: the chip row, the validator's cell ceiling and the e2e suite all read the list's length.

The chips show the tile and nothing else — with eight symbols a name beside each was noise. The label survives as the chip's `aria-label`/`title`, which is what `e2e/match-three-solver/symbols.ts` reads. `#tool-status` names the *kind* of tool only ("Color", "Blocked", "Eraser") for the same reason: which tile is selected is the highlighted chip's job to show, and printing "Purple 2" at the player was not useful.

`BLOCKER_IMAGE` is the game's blockade texture and is deliberately **not** in `SYMBOLS`: a blocked cell is the structural value `BLOCKED`, and giving it a slot would shift every index and repaint every saved board. It only renders alongside them — as the cell background, and as the chip that *leads* the row carrying `data-tool="blocked"` instead of a `data-symbol-index`. Any selector that means "the symbols" must therefore say `[data-symbol-index]`; an unscoped `.symbol-chip` includes the blockade.

Eraser and Reset are `md-icon` buttons (`ink_eraser`, `refresh`). Both names had to be added to the `icon_names` subset in `src/common/common.css` — without that they render as garbage text, not a missing icon.

Cells get their tile from a `--symbol-image` custom property set by `cellView.ts`, with `background-image: var(--symbol-image)` in the stylesheet. Not set as `background-image` directly, for two reasons: which image is a runtime choice but *that* it is the background is a rule, and happy-dom silently rejects a `background-image` whose URL is a Windows path — which is exactly what a PNG import resolves to under `bun test`, where there is no `pngDataUrl` plugin. Assert on `style.getPropertyValue("--symbol-image")`, never `style.backgroundImage`.

Because symbols are fixed and named, e2e assertions may use them: cells are labelled `Column 3, Row 2, Blue` and carry `data-symbol="blue"`. The e2e suite still does not import `symbols.ts` — Playwright's loader cannot resolve the PNG imports — so `e2e/match-three-solver/symbols.ts` reads the list off the page's own chip row instead, and appending a symbol needs no e2e edit.

### Match-three rendering (the reason a 32×32 board stays responsive)

Unlike the rolling-blocks page, this editor does **not** rebuild the grid on every edit. Three rules, all of them load-bearing at the 32×32 cap (1024 cells, where one full rebuild measures ~3.5 ms and a pointermove-per-cell drag would have run one per event):

- `Board.renderGrid` is the only full rebuild. It fills a `DocumentFragment` and `replaceChildren`s it in one go, and caches the buttons in `cellElements`.
- `paintCell` rewrites that one cached button via `dressCell` and returns early when the cell already holds the value — a drag fires many pointermoves per cell, and all but the first must be free. It calls `solver.hideSolution()` only, **never** `solver.render()`.
- Picking a tool or a symbol calls `renderTools()` (the two chip rows), not `render()`. Only a board *replacement* — resize, reset, config load — calls `render()`.

`Board` registers all its listeners against an internal `AbortController`, and the editor's `replaceBoard` calls `dispose()` before swapping. `#grid` outlives any single `Board`, so a board that kept listening would keep painting into its own dead `cells` and make every later stroke do the work once per board ever created — which typing a two-digit grid size creates several of.

### Long searches on the main thread

`TurnSolver` (phasic dial) is pure TS with no worker. Its search is a `searchSteps()` generator that yields every `YIELD_INTERVAL` combinations; `calculateTurns()` drains it straight through, `calculateTurnsAsync()` awaits between chunks so the page stays interactive. Six dials with eight buttons is ~0.7 s of work, hence the spinner. A `solveGeneration` counter (same pattern as the shifting-mosaic editor's) discards a result whose board was reset or replaced mid-search.

### The phasic dial page

The config stores `maxValues[i]` = **positions minus one**, and that has not changed — but nothing on the page says "max" any more. A dial is an SVG polygon with `max + 1` corners (`dialView.ts`), position 0 is straight up and is the solved one, and the pointer is dragged or arrow-keyed round it. Fewer than three positions degrades to a ring rather than a polygon, and there is no upper cap, so a config with a larger `max` renders rather than being rejected. The face is one `role="slider"` with `aria-valuemin/max/now`, which is the handle every test uses — `getByRole("slider", { name: "Blue dial position" })`, never a `Max`/`Value` field.

Unlike before, **the page keeps a real model** (`maxValues` / `values` / `buttons`) and renders from it; `readConfig()` is a projection of that model, not a DOM scrape. Every mutation goes through `invalidateResult()`, so an edit drops the answer and the per-card press badges at once. Dial colours are positional (blue…purple), so `#remove-dial` can only ever drop the **last** dial; buttons are anonymous, so any card's delete works and the rest renumber.

## Test layout

`test/` and `e2e/` mirror `src/pages/` with kebab-case folders (`logic-grid-solver`, `match-three-solver`, `phasic-dial-solver`, `rolling-blocks-solver`, `shifting-mosaic-solver`); shared tests sit at the root of each. `test/resources/` is split the same way. Fixtures are produced by the app's own download button, so the JSON *is* the download format.

`test/resources/phasic-dial-solver/` and `test/resources/match-three-solver/` are discovered by directory listing rather than a hard-coded list, so dropping a captured fixture in makes it run with no code change. The other fixture families are enumerated explicitly: the C++ suites run rollingBlocksTest 1–48 and shiftingMosaicTest 1–43, and `test/rolling-blocks-solver/aStar.slow.test.ts` runs the same full 1–48 range through wasm on the cascade engine (120 s per-test timeout, 90 s solve budget). Real captured rolling-blocks boards top out at 13×15 / 8 blocks / dimension-6 blocks / 83 must-touch — the 64×64 caps and fuzz sizes are stress headroom, not game reality.

`test/resources/match-three-solver/` holds 52 boards captured from the game (`matchThreeTest.json`, then `matchThreeTest1..51.json`), swept by directory listing — `config.test.ts` (format), `engine.test.ts` (legal game state), `engine.solve.slow.test.ts` (TypeScript engine), `wasm.slow.test.ts` (C++ engine) and the C++ `fixtures_test.cpp`. They span 2×2 to 13×23, 1 to 20 moves, with and without blockades, and between them use every symbol.

**Every one is expected to be a legal game state** — that half of the assertion covers all 52 and stays cheap. `matchThreeTest47/50/51.json` (69–105 blocks) are named in a `STOCHASTIC` set in both sweeps: their answers come from NRPA, so the sweeps only require honesty and `wasm.slow.test.ts` carries the positive witness assertions with the seeds measured to find them.

**The lengths are now CEILINGS, not pins, and the cross-engine check moved.** `engine.solve.slow.test.ts`, `wasm.slow.test.ts` and `a-star/test/fixtures_test.cpp` still carry the same name→length table, but they assert `moves.length <= ceiling` rather than equality: the search returns the first solution it finds and claims nothing about minimality, so the table is a quality net against an arm-ordering regression. Every value is the measured optimum except `matchThreeTest46`, which is 8 where the optimum is 7.

What used to make the duplication a *rules* check — a length differing between the engines — is gone with it. Two things carry that load instead, and both were always the stronger guard: **every witness is replayed through `rules.applyMove`** before it can reach the viewer or pass a test, and **`fuzz:mt` cross-checks the two engines** on solvability. Its two `proven`-based invariants were deleted rather than left in place, because with nothing proving them they could only ever have passed vacuously — a campaign printing "No divergences" while checking less than it used to is worse than one that checks less and says so.

**All three hard boards now answer on the page, and fast**: `matchThreeTest47` in 2.4 s (20 moves, the known optimum), `matchThreeTest50` in 1.4 s (23) and `matchThreeTest51` in 7.9 s (16). Their answers come from NRPA, which is stochastic — test51 returns 15 or 16 depending on the seed — so no exact length is pinned for them anywhere.

There is no unsolvable fixture in the corpus. `e2e/match-three-solver/solve.test.ts` builds its "cannot be cleared" board inline instead.

One fixture is named as a stable example with blockades in it — `matchThreeTest28.json` (6×6, 5 moves, blockades in both bottom corners) — in `matchThreeSolver.test.ts`, `mem64.node.test.mjs`, `wasm.slow.test.ts` and the two e2e suites.

Both grids on the page use `.grid-cell` with the same `data-x`/`data-y`, so **every editor selector in a test must be scoped to `#grid`** and every solution selector to `#solution-grid`; an unscoped one silently matches two elements once the solution view has rendered.

Rolling-blocks and shifting-mosaic fixture paths appear in nine places — the two `TEST_RESOURCES_DIR` macros in the C++ test `CMakeLists.txt`, four TS/MJS test files, `src/util/benchShiftingMosaic.ts` (regex over `readdirSync`), `src/util/benchWasmSimd.ts`, and a **cwd-relative** literal in `e2e/shifting-mosaic-solver/config.test.ts`. Match-three needs none of that — its suites list the directory — beyond the `matchThreeTest28.json` example named in three files.

## Native C++ builds

`bun run build:wasm` compiles with emscripten; the gtest suites are a separate native build per solver (`src/pages/*/a-star/`, needs nlohmann_json + gtest, and boost for the two older solvers — match-three needs none, which is why its `build()` call passes `needsBoost: false`). Locally there are pre-configured dirs (`cmake-build-release-visual-studio`, `build-native`) that must be driven by **CLion's** bundled CMake, from an MSVC environment (`vcvars64.bat`) for the Ninja dirs. The rolling-blocks dirs are Ninja despite their `-visual-studio` names, so the clang-tidy gate is live there.

### The root `CMakeLists.txt` is an aggregate

The repo root carries a `CMakeLists.txt` that `add_subdirectory()`s all three solvers, which is what CI uses:

```bash
cmake -B build-ci -S . -DCMAKE_BUILD_TYPE=Release -DBUILD_TESTING=ON
cmake --build build-ci -j                            # ~73 s at -j 16, 3 solvers
ctest --test-dir build-ci -j 4 --output-on-failure   # 311 tests, ~152 s
```

**`-j` is never implicit — you have to pass it.** Neither `cmake --build` nor
`ctest` parallelises by default, and the `-j` in `.github/workflows/test.yml` is
only in that YAML. CLion passes its own `-j` when *it* drives a build, which is
why the pre-configured dirs feel parallel and a hand-run `cmake --build` does
not. To make it automatic in a shell, export the two standard env vars:

```bash
export CMAKE_BUILD_PARALLEL_LEVEL=16   # what `cmake --build` uses without -j
export CTEST_PARALLEL_LEVEL=4          # what `ctest` uses without -j
```

It is **additive only** — each `src/pages/*/a-star` stays independently configurable, because CLion's profiles point straight at them. Never move something a child needs up into the root. `-DIOI_ROLLING_BLOCKS=OFF` / `-DIOI_SHIFTING_MOSAIC=OFF` / `-DIOI_MATCH_THREE=OFF` drop a solver from the aggregate. A fresh CLion "Open project" on the **repo root** now loads the aggregate rather than a page; the existing per-page profiles are unaffected.

Three things are load-bearing and easy to undo:

- **`${PROJECT_SOURCE_DIR}`, never `${CMAKE_SOURCE_DIR}`, in the three `test/CMakeLists.txt`.** Under the aggregate the latter is the repo root, so `TEST_RESOURCES_DIR` would resolve *outside* the repo — where the rolling-blocks fixture tests `GTEST_SKIP()` rather than fail. A silently green run.
- **`a_star_core` / `shifting_mosaic_core` / `match_three_core` are `OBJECT` libraries** consumed by both the CLI and the gtest binary. The solver TUs used to be listed in both targets and compiled (and clang-tidied) twice. This is only correct because `TEST_RESOURCES_DIR` is the sole per-target compile definition and no solver TU reads it — **if a solver TU ever needs a target-specific define, the object library has to be split.**
- **`PROCESSORS 8` on the shifting-mosaic `gtest_discover_tests`** (`SM_TEST_PROCESSORS`, kept in sync with `ARMS` in `ParallelCascade.h`). Each fixture spawns 8 `std::thread`s, so it claims 8 ctest slots — one per thread it really runs — and ctest never oversubscribes: at `-j 4` the count exceeds the parallel level so the test runs **alone**, and at `-j 16` two run at a time. The cheap rolling-blocks and match-three tests fill the remaining slots — both use `PROCESSORS 1`, because every match-three arm is single-threaded natively (its thread race is `__EMSCRIPTEN_PTHREADS__`-only, like rolling-blocks'). Without it `ctest -j` runs them 4- or 16-wide, they starve each other, and `shiftingMosaicTest37` blows its per-arm budget — which reads as a regression and is not one. Measured at `-j 4`: 311/311 in ~152 s, test37 alone at 112 s.

`gtest_discover_tests` also sets `LABELS`, so a single page's suite runs as `ctest --test-dir build-ci -L rolling-blocks` (or `-L shifting-mosaic`, `-L match-three`).

All three solvers have a real CLI (`a_star.exe` for rolling-blocks, `match_three.exe` for match-three): `--fixture <path> [--engine cascade|wastar|exact|cracker|beam|greedy] [--weight N] [--budget-ms N] [--max-nodes N] [--max-states N] [--max-heap-bytes N] [--seed N] [--beam N] [--gated] [--no-post] [--json]`, plus `--generate <path> --seed N [--shuffle N] [--kind goal|coverage|mixed]`; the LAST stdout line starting with `{` is the JSON report, with `stage` naming the winning arm and `alreadySolved` flagging boards solved before any move. Match-three's is the same protocol with its own flags (`--engine cascade|exhaustive|greedy|beam|nrpa`, `--table-bytes N`, `--nrpa-level N`, `--nrpa-iterations N`, `--quiet`, and `--generate … --kind random|cluster [--width N] [--height N] [--symbols N]`). Those three generator dimensions are **clamped** to `kMaxSide` / `kSymbolCount` — `Board::cells` is a fixed `kMaxCells` array and the per-symbol counters are `kSymbolCount` wide, so `--width 33 --height 32` used to write 1056 of 1024 entries. Clamping rather than re-drawing keeps every rng draw where it was, so a pinned dimension still consumes no random number. `--generate` also **exits 1 without writing** when no attempt produced a usable board, rather than saving the last candidate under a success line. All six bench/fuzz harnesses speak that protocol through `src/util/solverCli.ts` (`runCli` child-process runner + `parseFlags` flag-map parser) — extend it there, not per-harness.

Every solver's replay validity oracle lives in a `Replay.{h,cpp}` compiled into **both** wasm and native, and its `FixtureIo.{h,cpp}` / `GenerateCommands.{h,cpp}` are native only — they drag in nlohmann + exceptions, so they must never join the wasm source lists. Generator invariants worth knowing: rolling-blocks goal boards paint goals only under blocks with at least one legal roll (a frozen block keeps its own patch covered through any scramble — measured on seed 42) and re-scramble up to 3× if the start is still solved; coverage walks mark cells must-touch on first touch, which makes the walk itself the forward witness; mixed boards keep the two families in regions split by an unplayable divider column so the witnesses cannot interact.

**Match-three cannot generate solvable-by-construction boards**, unlike a rolling-blocks scramble: a clear destroys the blocks it consumed, so there is no solution to play backwards. Its generator instead builds legal states of unknown solvability, and `fuzz:mt` checks the properties that hold regardless — every witness replays under the TypeScript rules, and neither engine calls a board unsolvable that the other solved. **With the corpus length pins reduced to ceilings, this is the main automated cross-engine guard**, so run it wide. Two things it had to learn the hard way: **a symbol's block count must be a multiple of three** (five blocks of one symbol is dead before the first move, which is why the first version produced nothing solvable), and boards are filled **match-free by construction** bottom-up rather than settled afterwards, so the planned counts survive.

Run the suite in **Release**: `shiftingMosaicTest37` needs ~115 s there and blows its per-arm budget in Debug, so a lone test37 failure means the build type, not a regression.

All three solvers gate on clang-tidy through `cmake/ClangTidyGate.cmake` and fail on any finding — but only under Ninja/Makefiles and only when the binary's LLVM major matches the `PROFILE_LLVM` argument. CI builds and tests but does not lint. That module is the single copy of the gate's hard-won details (why no `-checks=` argument, why the executable is searched for, why the config probe uses an empty TU rather than `--verify-config`); read it before changing any of them.

**MSVC accepts code clang rejects.** A green native build plus a green gtest run is not sufficient — run `bun run build:wasm` before believing a C++ change is done.

## Required checks before calling work done

### TypeScript / JavaScript

1. `bun run typecheck` (`tsc --noEmit`) — always, on any `.ts`/`.js` change. CI runs it too, in its own job.
2. **SonarQube MCP `analyze_code_snippet`** on every file you added or changed. This is not the "last analysis report" — it analyzes whatever content you pass, so it works on uncommitted and unsaved code. Verified 2026-07-28 against a snippet that exists nowhere in the repo.
   - Pass the **complete** file as `fileContent` and set `language` (`ts`/`tsx`/`js`/`jsx`/`css`/`scss`/`html`) and `scope` (`MAIN`, or `TEST` for anything under `test/` or `e2e/`).
   - **Do not pass `codeSnippet` for a review pass** — it *filters* the output to issues inside that snippet, so an unrelated problem elsewhere in the file reads as "clean".
   - `projectKey` is optional. Measured both ways on the same input: `Valle12_islands-of-insight-tools` and the org default returned identical findings, so omitting it is fine.
   - It catches things `tsc` cannot: S3776 cognitive complexity (>15), S2933 fields that should be `readonly`, S3358 nested ternary, S1854 dead assignment, S4138 index-`for` over `for-of`. Treat a finding on code you touched as something to fix, not report.

The other SonarQube MCP tools (`search_sonar_issues_in_projects`, `get_component_measures`, coverage, quality gate) read the **last server-side analysis**, not the working tree. Do not use them to check your own edits.

### C++

1. The build gates on clang-tidy itself and fails on any finding. Both solvers enable it by default via the shared `cmake/ClangTidyGate.cmake` (`SM_CLANG_TIDY` / `RB_CLANG_TIDY`). Leave it on; `-D<NAME>=OFF` is for fast iteration only. It is a no-op under the Visual Studio generator and when the clang-tidy major differs from the `PROFILE_LLVM` argument — so a clean build is only meaningful from a **Ninja** dir with CLion's bundled clang-tidy. It degrades to a configure-time `WARNING`, never a hard error, so "no findings" and "never ran" look similar: check for `-- clang-tidy enforced: …` in the configure output.
2. `bun run build:wasm` — MSVC accepts code clang rejects, so the native build passing proves nothing on its own.
3. **`analyze_code_snippet` cannot analyze C++** — the tool's `language` enum has no `cpp`/`c`, and passing one is a hard validation error (confirmed 2026-07-28). The only route to Sonar findings for C++ is SonarLint inside the IDE. The recurring SonarLint C++ rules (complexity/nesting/parameter caps, lambda limits, `using enum`, `std::to_underlying`, noexcept moves, …) and their idioms are listed in `CLION-INSPECTIONS.md` — write new C++ to them up front.
4. **CLion's own inspections** (designated initializers, const-correctness, CTAD, unused includes, …) are invisible to both the clang-tidy gate and `getDiagnostics`. `CLION-INSPECTIONS.md` lists them, the one-off clang-tidy command that covers the mappable subset headlessly, and the intentional findings to leave alone — follow it while writing C++.

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

### The IDE diagnostics bridge

`mcp__ide__getDiagnostics` returns whatever the attached IDE reports — in VS Code that is the TS language server plus installed extensions; in CLion it is SonarLint. It only covers files the IDE has **open**, and in CLion only the file that currently has **focus**.

Two traps, both measured:

- **Call it with no `uri`.** Passing an explicit `uri` came back with a mangled `file://wsl.localhost/...` path and an empty array — indistinguishable from a clean file. The argless call lists every known file and reports `linesInFile` for the ones actually loaded, which is how you tell "clean" from "not analyzed".
- An empty result for a file the IDE never opened is meaningless.
- **The result lags the file by about one call, in both directions.** On a
  freshly focused file the FIRST call can come back `[]` and the second
  return real findings — measured on `SearchProver.cpp`, where one empty
  result would have read as a clean pass. After an edit the reverse
  happens: the finding you just fixed is re-reported once, against stale
  ranges, before the file settles. So **query twice**, and treat a finding
  that survived a fix which plainly addressed it as stale until a second
  call confirms it. Three consecutive empties is the practical bar for
  calling a `.cpp` clean.

**A header is not independently analysed.** Sonar's C++ analysis runs over
translation units, so `getDiagnostics` on a focused `.h` reports nothing
whether it is clean or merely never compiled on its own — the two are
indistinguishable. The header's code IS covered when a `.cpp` that includes
it is analysed, so the honest reading of an empty header result is "no
findings reported, covered indirectly via N analysed TUs", not "clean".
Analyse the `.cpp` files first for this reason.

**So: for C++ changes, finish by asking the user to open and focus each changed file in CLion, then call `getDiagnostics` (no `uri`) and check the file is actually listed before concluding it is clean.** For TS/JS this hand-off is unnecessary — `analyze_code_snippet` covers it headlessly.

## CI

`.github/workflows/test.yml` is a job DAG, not one serial job. It was ~20 min as a
single job; the critical path is now ~5½ min cold and ~3¼ min with a warm wasm
cache.

```
wasm ──┬──▶ bun-test [5 shards]
       ├──▶ e2e      [2 shards]
       ├──▶ mem64
       └──▶ dist              cpp        typecheck
```

- **`wasm`** is the only expensive artifact; it runs `bun run build:wasm` (no
  `bun ci` needed) and uploads `astar*.{mjs,wasm,stamp}` for the four jobs
  downstream. `cpp` and `typecheck` are independent of it. Its cache `path:`
  list is **per solver and explicit** — a new solver needs three lines there and
  three in `deploy.yml`, even though the cache KEY's `src/pages/*/a-star/*`
  glob and the artifact globs pick it up automatically.
- **`bun-test` fans out over five shards** — one per `*.slow.test.ts` suite plus
  one running everything else under `IOI_SKIP_SLOW=1`. Between them they run
  **every** test, which is why no env gate can leave a suite unregistered.
- **`mem64` names every `mem64.node.test.mjs` explicitly.** A solver whose file
  is missing from that one `run:` line is a MEMORY64 build nothing ever
  instantiates — which is exactly what happened to rolling-blocks once.
- **`dist`** proves the production bundle still builds on every PR (nothing
  checked that before) and publishes the artifact `deploy.yml` reuses.
- `.github/actions/setup-wasm` is a composite action shared with `deploy.yml`, so
  the emsdk pin and the `BOOST_INCLUDE` symlink cannot drift between them.

Sonar's `githubactions` rules gate this repo, and two of them shape the YAML:

- **S7637** — third-party actions are pinned to a commit SHA with the tag in a
  trailing comment (`oven-sh/setup-bun@0c5077e… # v2.2.0`). `actions/*` are
  first-party and exempt.
- **S8543** — no `bunx <pkg>` in a workflow, because Sonar cannot see that the
  package is already pinned in `bun.lock`. Both call sites went through
  package.json instead (`bun run typecheck`, `bun run e2e:install`), which also
  guarantees the pinned version rather than whatever bunx resolves.

Two rules that are easy to get wrong:

- **The wasm cache key is exact — never add `restore-keys`.** A prefix match
  would restore wasm built from different C++ and every suite downstream would
  test the stale binary: green, and meaningless. GitHub's `*` does not cross
  directory boundaries, so `a-star/test/**` and `a-star/bench/**` correctly do
  not invalidate it.
- **`EMSDK_VERSION` is pinned *because* that key assumes it.** `setup-emsdk`
  defaults to `latest`, which would make "same C++ plus same flags means same
  wasm" a lie. It must match in `test.yml` and `deploy.yml`.

Deliberately absent: an apt-package cache and ccache. Both were measured against
the `cpp` job, whose ~200 s is dominated by `shiftingMosaicTest37` (~112 s of the
~130 s ctest). apt is 19 s total, and ccache can only touch the ~50 s build that
the OBJECT libraries and `-j` already shrank — neither earns a third-party
action. Also absent: `paths`/`paths-ignore` filters to skip the C++ jobs on
TS-only PRs, because a skipped required check never reports and branch protection
would block the PR forever.

`deploy.yml` first tries to download `dist` from the successful Test run on the
**parent** of the version-bump commit (`update-version` creates the commit the
build job checks out, so no run exists for that SHA yet), and otherwise builds
with the shared wasm cache. The reuse is only sound because dist content does not
depend on the version — nothing under `src/` reads `package.json`; it names only
the release zip and the tag. **Rendering a version anywhere on the site
invalidates that step.** `update-version` also refuses to run unless `main`'s head
has a green Test run.

## Keeping this file current

Update `CLAUDE.md` in the same change that introduces something it would have been useful to know beforehand: a new page or solver, a new build/test command or env gate, a new shared utility in `src/util/` or `cmake/`, a change to the fixture layout or the wasm variant set, or a newly discovered toolchain trap. Do not log routine feature work here.

## Conventions worth knowing

- `tsconfig.json` sets `noUncheckedIndexedAccess`, which is why array and `querySelector` access is littered with `!`.
- There is no prettier/eslint config in the repo; match the surrounding style (~80 columns, `arrowParens: "avoid"`).
- Bench baselines under `src/pages/shifting-mosaic-solver/a-star/bench/*.json` store fixture names as keys and are read by `--diff`.
- Deployment is `workflow_dispatch` only (`.github/workflows/deploy.yml`): it bumps the version on a branch, PRs it to `main`, merges, then publishes Pages from the reused-or-rebuilt `dist` (see "CI").
