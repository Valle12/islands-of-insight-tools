# CLAUDE.md

Guidance for Claude Code (claude.ai/code) in this repository. This file carries
the **contracts and the traps** — what is expensive to rediscover. Per-page
narrative lives beside it and should stay there: **`docs/logic-grid.md`** (the
page and engine, rule by rule), **`docs/match-three.md`** (solver, encoding,
symbols, rendering), **`docs/toolchain.md`** (SEO metadata, the clang-tidy gate,
the aggregate CMake rules, the IDE diagnostics bridge), **`CLION-INSPECTIONS.md`**
(C++ static analysis and the red-quality-gate playbook), and
`src/pages/*/a-star/bench/*.md` (measurements and hard boards).

## What this is

A static, zero-framework site of five puzzle solvers for the game *Islands of
Insight*, deployed to GitHub Pages. Each solver is a page under `src/pages/`;
four run their search in C++ compiled to WebAssembly. No backend, no router —
`src/util/serve.ts` maps six URLs to six HTML entry points, and `bun run build`
emits the same six pages into `dist/`.

**match-three runs TWO engines and races them**: a bundled TS Web Worker
(`solverWorker.ts`, arm zero, answers most boards in ms without fetching wasm)
and the C++ portfolio. `solveClient.ts` is the merge point.

## Commands

```bash
bun install

bun run dev              # dev server on :3000 (src/util/serve.ts)
bun run build            # -> dist/ (runs build:wasm first via an import side effect)
bun run build:wasm       # em++ only; skips variants whose inputs have not moved

bun test                 # every unit test (bunfig.toml pins root = "test")
bun run test             # build:wasm + every unit test — no env gates
bun run test:fast        # everything except the five *.slow.test.ts suites (~5s)
bun run test:slow        # only those five
bun run test:changed     # only files affected by the diff vs origin/main
bun run test:mt          # one page + the two shared root suites (also :lg :pd :rb :sm)
bun run test:mem64       # the four mem64.node.test.mjs files, under node
bun run typecheck        # tsc --noEmit
bun run e2e              # playwright, spins up its own webServer
bun run e2e:install      # chromium + system deps (what CI installs)

bun run og:capture       # re-shoot the COMMITTED Open Graph screenshots
bun run seo:indexnow     # submit every canonical url to IndexNow (deploy.yml runs it)

bun run bench:sm | bench:rb | bench:lg | bench:mt   # --diff before.json after.json
bun run fuzz:sm  | fuzz:rb  | fuzz:lg  | fuzz:mt    # -> test-results/<x>-fuzz
bun run harvest:mt       # hand NRPA plateau endgames to the exact prover
```

Subsets: `bun test <dir|file>`, `bun test -t "name"`, `bunx playwright test
e2e/phasic-dial-solver` or `…/config.test.ts:60`. `bun test` takes multiple
positional substring filters (what the per-page scripts use).

Bench/fuzz notes:

- `bench:lg` and `bench:mt` **gate** — `--diff` exits 1 on a regression, which for
  logic-grid means fewer cells decided or a proof lost, not just a slower clock.
  Both need the native exe.
- `fuzz:lg` and `fuzz:rb` boards are solvable by construction. For logic-grid the
  colouring comes first and the clues are read off it, so the sharp check — every
  cell reported FORCED matches that colouring — applies only to an **underclued**
  board; pin small dims (`--width 4 --height 5`) to get under the brute-force cap
  so `--brute` compares whole solution sets, and use `--engine <arm> --rules 0`,
  the only way to hammer `profile`. Its clue flags (`--shapes`, `--darts`,
  `--lotus`, `--viewpoints`, `--galaxies`) are appended rolls drawing nothing at
  0, so every seed byte-reproduces; what DOES move every generated board is a rule
  joining `kColorRules`, which stales fuzz baselines.
- `fuzz:mt` cannot be solvable by construction — a clear destroys its own blocks —
  so it checks what holds regardless: every witness replays under the TS rules and
  neither engine calls a board unsolvable that the other solved. **It is the main
  automated cross-engine guard**, so run it wide.

### Slow suites and env gates

Expensive unit suites are opt-**out**, never opt-in. Five `.slow.test.ts` files
run by default, including in CI: shifting-mosaic `wasm` (~244s), logic-grid
`wasm` (~99s), match-three `wasm` (~75s), rolling-blocks `aStar` (~60s),
match-three `engine.solve` (~22s). Everything else under `test/` is 300–780 ms
except `phasic-dial-solver/turnSolver.test.ts` (~3.9 s).

- `IOI_SKIP_SLOW=1` (what `test:fast` sets) skips those five. They are
  `describe.skipIf`, so they **report as skipped**. **Never reintroduce
  `describe.if` for a cost gate** — its predecessor registered *nothing at all*
  when unset and a 48-fixture sweep sat disabled behind a green run.
  (`describe.if(fixtures.length > 0)` in `turnSolver.test.ts` is the same trap,
  which is why a corpus-is-non-empty test sits outside it.)
- `SM_SLOW_E2E=1` (shifting-mosaic `heapLimit`, ~4 min) and `MT_SLOW_E2E=1`
  (match-three `corpusTiming`, a measurement rather than an assertion) stay
  opt-in. The latter must **reload the page per fixture**, or the previous board's
  step counter is read as this board's answer.

`test:mem64` runs under node, not bun: bun cannot instantiate a Memory64 module
(under `bun test` those files register as skips).

Playwright aria snapshots are inline and match **partially**, so a snapshot keeps
passing when new nodes appear; `--update-snapshots` rewrites only *failing* ones.
`--update-snapshots=all` gives a faithful tree and writes
`test-results/playwright/rebaselines.patch` for `git apply`.

**A local full e2e run collapsing into `ERR_CONNECTION_RESET` is usually
concurrency, not breakage.** Measured on bun 1.3.14 / Windows: the default worker
count (cores/2) panics the dev server (`panic(main thread): integer overflow`)
~20 s in; `--workers=2` finishes the identical suite clean. Check the route table
once, then **re-run with `--workers=2` before believing anything is broken.** CI
is unaffected (one worker per shard).

## Architecture

### Page shape

Every page is `index.html` + a `<page>Solver.ts` class + a `.css`, plus
`src/common/common.ts` registering the Material Web elements. Pages talk to the
DOM by `id`; there is no component layer and no state library.

The solver class is instantiated at module scope behind
`if (process.env.NODE_ENV !== "test")` (`src/util/preload.ts` sets that). Unit
tests construct it themselves by **mounting the page's own markup** — a `MARKUP`
template literal into `document.body.innerHTML` in `beforeEach`, then
`new PageEditor()`. Not a `getElementById` spy: pages also `querySelectorAll` over
chip rows and hand host elements to views with delegated listeners, which detached
stubs swallow silently. `md-dialog` is not registered in the test DOM, so mounts
assign `show`/`close` by hand.

### Bundling

`src/util/plugins.ts` supplies two Bun plugins used by `build.ts` and `serve.ts`:
`sassCompiler`, and `pngDataUrl`, which inlines every PNG *except* `favicon.png`
as base64 — `dist/` has no `images/`, so anything referenced by URL rather than
imported 404s.

- **Bun's HTML entrypoints do not bundle Web Workers.** `new Worker(new
  URL("./x.ts", import.meta.url))` survives minification with the `.ts` specifier
  intact and 404s in `dist/`, silently at build time. The match-three worker gets
  its own `Bun.build` pass in `src/util/buildWorker.ts`, called from `build.ts`
  and `serve.ts`, and is reached **page-relative**
  (`../mt-worker/solverWorker.js`) so dev and Pages resolve the same — the trick
  the emscripten workers use with `../rb-wasm/`.
- **Material Symbols come from a subset URL** in `src/common/common.css`
  (`icon_names=…`). An `<md-icon>` naming a glyph not in that list renders as
  garbage text, not a missing icon.
- **The production build must run as `bun run build`**, which pins
  `NODE_ENV=production`; otherwise Bun picks Lit's `development` export condition
  and ships dev-mode Lit. Setting it inside `build.ts` does **not** work —
  `Bun.build` does not read it at call time. The dev server keeps
  `development: true` for HMR and does log the warning; only `development: false`
  suppresses it, at the cost of HMR.

### C++ → WebAssembly

`src/util/buildWasm.ts` drives `em++` (via `Bun.which`; emsdk ≥ 6.0.0 for `-m64`)
and produces **four variants per solver** from the same TUs — wasm32, `-pthread`,
MEMORY64 (8 GB heap), pthreads+MEMORY64 — concurrently for all four C++ solvers.

- **`src/util/wasmAssets.ts` is the single list of what each solver ships and
  where** (`WASM_VARIANT_FILES`, `WASM_SOLVERS`: page dir → `/rb-wasm/`,
  `/sm-wasm/`, `/mt-wasm/`, `/lg-wasm/`), read by both `serve.ts`'s allowlist and
  `build.ts`'s copy step. Missing the `serve.ts` copy 404s in dev; missing the
  `build.ts` copy 404s only in production, after CI is green. Workers are reached
  page-relative, never root-absolute.
  **`WASM_SHARED_FILES` is the second half of that list**: files published into
  EVERY solver's prefix that are not that solver's own output, mapped to the one
  source they are copied from. `astar.workerCore.js` is the only one, so each
  worker imports it as `./astar.workerCore.js` — page-relative like the
  `astar.mjs` beside it, and with no second url prefix to keep in step.
- `src/pages/*/wasm/` is generated and gitignored **except** `astar.worker.js`,
  hand-written source in the same directory — do not delete the directory
  wholesale. Each of the four is now ~25 lines: the loader, the variant table,
  the validate-is-not-instantiate fallback to wasm32 and the error protocol all
  live once in **`src/util/astarWorkerCore.js`**, and a worker supplies only the
  function that copies its own embind result out into a postable `done`.
- Source lists are duplicated in `buildWasm.ts` and the C++ `CMakeLists.txt` and
  must stay in sync; a missing TU fails at link time.
- **Variants are skipped when their inputs have not moved.** The
  `astar*.mjs.stamp` hashes the `sources`, **every `*.h` in the a-star root**
  (headers change output and are in no source list; `bench/` and `test/` are
  native-only and must not invalidate) and the **flags** — **content, never
  mtimes**, since checkout and cache restore rewrite mtimes wholesale.
- **Flags only — never the full argv, never an absolute path.** Hashing the argv
  broke CI: `BOOST_INCLUDE` is set in the compiling job and not the bundling one,
  so one commit produced two hashes. `needsBoost` is hashed as a boolean instead.
- `FORCE_WASM=1` rebuilds regardless. The stamp is deliberately **not** a dotfile
  (`actions/upload-artifact` v4+ drops hidden files).
- `resolveEmcc()` is **lazy and returns null rather than throwing**, so a current
  tree builds with no emsdk — what lets CI's `dist` job run `bun run build`. A
  skip with no compiler to compare against warns loudly: "no emsdk" must never
  look like "verified current".

### The four solver bridges

All four are **portfolios**: an exported `PORTFOLIO` of engine configs, one worker
per arm, the rest terminated once settled. Concurrency is bounded by
`hardwareConcurrency`, not the arm count — every arm runs, queued and back-filled,
and one that exhausts the heap retires itself. Cross-origin isolated pages
collapse to ONE worker on the pthreads build, racing the same arms on real
threads. Variant priority (threads-mem64 > threads > mem64 > default) comes from
`src/util/wasmFeatureProbes.ts`. All stop at the **first non-empty plan**. Errors
are **in-band** (`{…, error}`) because the builds are `-fno-exceptions`: a throw
would reach the page as an aborted module.

**The race itself is `src/util/wasmPool.ts`, not the bridges.** `startWasmPool`
owns spawning, the queue and back-fill, per-arm progress summing, retirement,
teardown and the "everything failed" path; a bridge supplies its arm list, its
puzzle payload and an `onMessage` that says what a message MEANS. Four copies of
that lifecycle is what let two of the four forget to mark the race dead in
`terminate()` (a `done` still in flight then back-fills a fresh worker for a
board the page has discarded) and two let a `new Worker` throw straight through
the click handler. `crossOriginIsolatedPage()` and `armPoolSize()` live there
too — logic-grid deliberately collapses on isolation ONLY, the other three also
when a single slot would just serialise the portfolio.

- **rolling-blocks** — `solve` / `optimize`; engines `cascade` (default),
  `wastar`, `exact`, `cracker`, `beam`, `greedy`. Arm selection is in
  `SolverArms.cpp`, whose `kPortfolio` must stay in sync with the bridge's
  `PORTFOLIO`; gates are in `PuzzleProfile.h`; caps are 64×64 grid, 255 blocks,
  dims ≤ 64. The cascade first **decomposes** the board into independent playable
  regions. The two-block coverage scheme and the cracker-only `Config` fields
  (never exposed at the wasm/CLI boundary) are in `a-star/bench/HARD-BOARDS.md`.
- **shifting-mosaic** — the original portfolio; `PORTFOLIO` is exported so its
  slow suite races the exact production arm set.
- **match-three** — `puzzle.cells` is **flat row-major** while the fixture format
  is column-major (`flatten()` converts). No `proven`, no `ruledOut`.
- **logic-grid** — see `docs/logic-grid.md`.

**Four pages need `SharedArrayBuffer`**, which Pages cannot grant via headers.
`src/common/coiRegister.ts` registers `coi-serviceworker.js` and **reloads once**;
`page.goto()` resolves on the *pre-reload* document, so an e2e interaction in that
window dies with "Execution context was destroyed". Always reach rolling-blocks,
shifting-mosaic, match-three and logic-grid through `gotoIsolated` /
`waitForCoiSettled` in `e2e/coi.ts`. The same four paths are listed in the
`COI_PATHS` sets in `e2e/seo.test.ts` and `src/util/captureOgImages.ts`.

### Step-by-step solution views

match-three, shifting-mosaic and rolling-blocks hide `#editor-section` and show a
sibling `#solution-view` built from the same ids (`#solution-grid`,
`#solution-step-counter`, `#solution-step-text`, `#solution-prev`,
`#solution-next`, `#solution-exit`) with a `dispose()` releasing every listener.
`src/util/gridOutline.ts` holds the shared helpers: a grid with gaps between cells
cannot be outlined with one border, so a zone is an edge class per cell whose
neighbour is outside it.

**Solving leaves the editor**, so an e2e test that edits after solving must click
"Back to editor" first; `#solution-steps` re-opens without re-solving and only
`hideSolution()` (any real edit) throws the answer away.

**`rolling-blocks-solver/replay.ts` is a second copy of `a-star/Replay.cpp`'s
semantics and the two must stay in sync.** Two rules make a naive re-roll wrong:
the satisfied mask is **seeded from the starting footprints**, and an already
satisfied must-touch cell **becomes blocking**.

### Config file I/O

Four shared modules carry what the five editors have in common; a new page should
reach for them rather than copying a sibling, which is what failed Sonar's
`new_duplicated_lines_density` gate when the fifth page arrived.

- **`configFile.ts`** — `downloadJson` / `readJsonFile` / `setupDragAndDrop`.
- **`editorShell.ts`** — `warningBanner`, `parsePositiveInt`, `openResetDialog` /
  `wireResetDialog`, `wireConfigIo`. It finds `#reset-dialog`, `#reset-cancel`,
  `#reset-confirm`, `#download-config`, `#upload-config` **by id** — those ids
  are the contract every page's markup keeps.
- **`configValidation.ts`** — `ConfigResult<T>`, `intInRange`, `readGridSize`.
  **Its error strings are part of the download format's contract** (suites assert
  them verbatim), so they are produced there once.
- **`configVersion.ts`** — the `version` tag and migration chain. **Logic-grid is
  the only page wired to it**; the other four carry no tag, which by its own rule
  makes their files version 1.

Each page keeps its own `config.ts` validator returning `{ok, config} | {ok,
error}` with a human-readable first-failure message, and its own
`applyLoadedConfig`. The download filename matches the fixture family, so a
download is directly usable as a fixture. The rolling-blocks validator enforces
the engine caps, renumbers block ids to 1..n and **ignores a fixture's optional
`turns` key** — a page-level rule only: the native `fixtureio::load` parses
`turns` back out, because that is where `--generate` stores the witness.

**The format version** (rules in `docs/logic-grid.md`): a file with **no tag at
all IS version 1**; `MIGRATIONS` is **append-only and addressed by position** and
the version is derived from its LENGTH; migration runs **before any structural
check**; a file from a **NEWER** build is refused **by name**; and the committed
fixtures are rewritten in the same change, because `fixtureio::load` refuses any
version but the current one.

**Do not reach for `mock.module`.** It is not scoped to the suite that installs
it — it replaces the module for the rest of the `bun test` PROCESS, and whether
that bites depends on directory walk order: green locally on Windows, **300 tests
failed in CI** on Linux. `matchThreeSolver.test.ts` mocks `solveClient` and is
fine only because nothing else imports that module — check that before adding
another.

E2e trap (rolling-blocks): Material components expose an inner `#button` in their
shadow DOM — never target buttons by `#button` index; use the app's own
`data-block-delete-id` style hooks.

### SEO and site metadata

Detail in **`docs/toolchain.md`**. `src/util/siteMeta.ts` is the single source of
truth (`SITE_URL`, `PAGES`, sitemap/robots renderers, IndexNow key); the `<head>`
tags are **hand-written into the six `index.html` files**, pinned against it by
`test/siteMeta.test.ts` and re-checked on the *served* page by `e2e/seo.test.ts`.

Adding a page: an entry in `PAGES`, head tags in its HTML, a trailing-slash route
in `serve.ts`, an entrypoint in `build.ts`, a card in `src/pages/index.html` **in
`PAGES` order** with its `ItemList` entry, a leg in `e2e/index.test.ts`, and
`bun run og:capture`. A page registering the COI shim also joins `COI_PATHS`.

- **The site is a GitHub Pages *project* page** at `/islands-of-insight-tools/`;
  a root-absolute href points outside the site (what the favicon used to do), and
  **the favicon must stay an ABSOLUTE url** or Bun inlines it as a `data:` URI
  Googlebot-Image cannot fetch. **Canonical urls carry a trailing slash**, and
  `robots.txt` shipped from here is inert (crawlers read the host root, in the
  separate `Valle12.github.io` repo).
- **Never register one HTMLBundle under two routes in `serve.ts`** — it crashes
  bun's dev server under concurrent load. Register the canonical route only and
  301 the other from `fetch`, as Pages does. **`dist` ships nothing `build.ts`
  does not copy**: a new static file needs a copy there *and* a branch in
  `serve.ts`'s allowlist.
- **The OG frame is 2400x1257, not 1200x630**, and **a new page can force it up**;
  the number to measure is `#editor-card`'s box plus the body's 24 px padding, not
  `documentElement.scrollHeight`. `og:capture` drives Playwright's **CLI under
  node** (its API hangs forever under bun) and always passes the scheme
  explicitly.

### The logic grid page and solver

Full detail in **`docs/logic-grid.md`**. What bites from outside:

- **The oracle is five files, `verify.ts` the front door.** `verifyCore.ts`
  resolves every rule and clue index once at module load (so a renamed id breaks
  the import rather than silently switching a rule off) and holds the grid
  readers and the flood fill; `verifyPatterns.ts` has the local-window rules,
  `verifyRegions.ts` the ones only answerable region-by-region, `verifyClues.ts`
  the walked geometries (dart ray, viewpoint sight, lotus mirror, galaxy half
  turn). `verify.ts` keeps the structural checks and the dispatch list, and
  RE-EXPORTS `toFlat`/`toGrid`/`UNDERCLUED`/`OFF_BY_ONE`, so no caller knows
  which file a thing is in. **The list's first two entries are load-bearing** —
  `shapeProblem` then `fusedProblem` — because everything after them reads the
  colouring one SQUARE at a time; the three families after that are independent,
  and their order only decides which violation a board breaking several is named
  for (which the suites assert). `board.ts`'s pure clue arithmetic — turning,
  comparing, serialising one clue — is `clueEdits.ts` for the same reason.
- **The board is six files, `board.ts` the front door**, which keeps only
  press → stroke → write: the listeners, `beginStroke`, `applyStroke`,
  `paintCell` and the one `writeCell` everything funnels through.
  `boardLayers.ts` owns the three layers and is the only thing that survives a
  re-render (`getSymbols`, `load`, and a `write` returning `nothing`/`clue`/
  `color`, which is what decides how much repaints); `boardView.ts` owns `#grid`,
  the cell buttons and the outline SVG, and is the only file with a DOM handle;
  `strokes.ts` decides what a press MEANS (the `Stroke` union, the
  re-click-erases rule, the symmetry seat); `mergeEdits.ts` restructures a cell;
  `boardKeys.ts` is the keyboard plus the digit-run state a number past nine
  needs. **`Board` takes a `SolutionHolder`, not the editor** — `hideSolution()`
  is all it ever calls, and the wide type made it import the module that imports
  it back.
- **A cell carries independent layers.** `cell.ts` owns the colour only
  (`UNKNOWN` 0, `DARK` 1, `LIGHT` 2, `UNPLAYABLE` 3) and `cells` is flat
  **column-major**. Clues are a separate sparse `symbols` array of
  `{x, y, type, value}` (+ optional `direction`, `seat`) — that is what makes the
  game's colourless clue representable. `shapes.ts` fuses squares into **merged
  cells**, flat `y * gridWidth + x` indices, **row-major** unlike `cells`.
- **`rules.ts` and `symbols.ts` are append-only catalogues** (like
  `match-three-solver/symbols.ts`): a config stores the INDEX, so appending is
  always safe and inserting or reordering silently rewrites every puzzle ever
  saved. The validator **rejects** an unknown index rather than ignoring it.
  `RuleMask` is `uint64_t` and the CLI's `--rules` an `int64_t` because rule 31's
  bit is past a positive `int`.
- **Since config format v2 the two SIZED rule families are data, not indices**:
  `rules` holds flags only, and `areas?: {color, size: 1..9999}[]` /
  `runs?: {color, length: 2..8}[]` carry the numbers — omitted when empty,
  dark before light then ascending, several instances per colour legal and
  conjunctive. The 22 retired indices are refused in `rules` by name; they
  survive in `RULES` (with `sized` markers) and the C++ enum as v1 bit
  positions, translated by the first real `MIGRATIONS` entry and by
  `rules::splitLegacyMask`, which is what keeps the CLI's `--rules` masks and
  every fuzz seed meaning what they meant. The TS validator accepts any order
  and canonicalises; the C++ intakes REFUSE non-canonical order — deliberate.
  The run cap is the engine's `kMaxRunLength = kMaxPatternCells`; the area cap
  is a format limit only (unsatisfiable-but-enforceable loads fine).
- **The rule row is `RULE_ROW`, a display catalogue the format never sees** —
  headed bands; each dark/light pair folded into one control whose two colour-
  SWATCH segments toggle INDEPENDENTLY (a segment is still a
  `.tool-button.rule-chip` with `data-rule`/`data-rule-index`/`aria-pressed`);
  one value control per sized family+colour whose `+` (`.rule-size-add`,
  deliberately not a `.tool-button`) appends a `.rule-size` slot. **Only
  `ruleRowMarkup` in `toolRowMarkup.ts` reads it**; everything else addresses chips by id, so a test
  that indexes chips by DOM position is the thing this breaks. Flag indices
  are also mirrored in `catalog.test.ts`, `rules_test.cpp` and — unavoidably,
  since it runs under node — `mem64.node.test.mjs`. The sized families need no
  listing any more, but their walks stay INDEPENDENT: the reducers in
  `Rules.cpp`, the oracle in `Verify.cpp` and `verify.ts` each read the
  instance lists without sharing code.
- **Both tool rows are built once and refreshed in place**: `buildSymbolRow` /
  `buildRuleRow` run only from `render()` (board replacement), since rebuilding on
  selection destroys the field being typed into, and `refreshSymbolRow` skips
  writing `input.value` when it matches (assigning moves the caret). Their
  MARKUP — every chip, pair segment, value field, arrow and axis toggle, plus
  `ruleIndexOf` and `SIZED_CONTROLS` — is `toolRowMarkup.ts`, pure functions
  taking the catalogue and the board size, and the clue row's refresh —
  `buildSymbolRow`, `refreshSymbolRow` and the per-kind `symbolValueOf` /
  `symbolAimOf` — is `symbolRowView.ts`, which takes the row element plus the
  editor's two per-kind arrays. **The sized controls are the exception, and own
  their own elements**: a `+` appends a field and focuses it and an emptied one
  disappears on `focusout`, so `sizedRuleControls.ts` holds the raw slot text
  AND builds, drops and listens for those fields on `#rule-row` — two delegated
  `click` handlers on that row, disjoint because `.rule-size-add` is not a
  `.tool-button`. What is still the editor's is `activeRules`, which four other
  things read.
- **The editor is four files**: `logicGridSolver.ts` keeps the board lifecycle,
  the selection commands, the rule chips and config I/O; `symbolRowView.ts` and
  `sizedRuleControls.ts` are the two tool-row halves above; and
  `solveController.ts` owns Solve — the search in flight, the generation counter
  that drops a stale answer, the eight `#solution-*` elements and the mounted
  `SolutionView`. Exactly one thing crosses each way (`configOf`,
  `onReturnToEditor`), and `hideSolution()` stays on the editor because `Board`
  calls it on every edit.
- **Optional config keys are omitted, never written empty** — `shapes`, a clue's
  `direction`, `seat`, a valueless kind's `value` — in all three writers
  (`board.ts getSymbols`, `validateConfig`'s rebuild, `fixtureio::save`), because
  the captured corpus must keep round-tripping byte-identically. At the wasm
  boundary `direction` crosses as **-1 when absent** (so a kind needing one is
  refused by name) while `value`/`seat` default to 0.
- **Every SQUARE of a merged cell carries its own clue slot and nothing re-homes
  one** — a merged cell may hold several clues (the game puts two darts on one
  domino). Combinations no colouring can satisfy are deliberately NOT structural
  errors: the file loads and Solve answers Unsolvable, the honesty rule the givens
  follow.
- **A merged cell is drawn as ONE SVG path** (`shapeOutline.ts` +
  `outlineLayer.ts`), not out of its squares' borders — several boxes cannot draw
  one straight edge, since Blink snaps each to the device pixel grid separately.
  Reverting to CSS brings the stepped rim back. The squares paint NOTHING; the
  seams survive as invisible hit targets.
- Layout traps, each pinned by `e2e/logic-grid-solver/*.test.ts`: `#solution-grid`
  needs `position: relative` as much as `#grid` does; `.grid-cell` needs an
  explicit `box-sizing: border-box` (editor squares are `<button>`s, the answer's
  are `<div>`s); the outline `<svg>` must be SIZED before the empty-shapes early
  return or its 300x150 default lands in the shell's scroll overflow; grid tracks
  are **fixed-size**, never `minmax(0, 1fr)` (match-three and rolling-blocks got
  the identical fix; shifting-mosaic is fluid by design); and **wherever a glyph
  is deliberately larger than its box, spell the focus ring out** —
  `outline-style: auto` follows PAINT bounds.
- Engine contracts: **a painted cell is a GIVEN**; **`Underclued` (rule 15)
  changes what the answer IS** (the cells every solution agrees on, carrying
  `proven`); **a merged cell is ONE variable** and all of that lives in
  `Domains::exclude`; **`Verify.cpp`/`verify.ts` share nothing with the search**
  and `solver.ts` **drops** an arm whose answer fails verification;
  **`Reference.cpp` is the only thing that can catch over-pruning** — do not
  delete it, and do not let it stop covering a propagator you add; **an aborted
  look-ahead proves nothing** (`ProbeResult` is tri-state); **`Profile::
  applicable` is a WHITELIST on both axes** — anything unrecognised must decline,
  or it reports a superset as proof.
- **The DFS keeps its own stack and must not go back to recursing**; the lg wasm
  variants set `STACK_SIZE` (threaded: `DEFAULT_PTHREAD_STACK_SIZE`) to 1 MB.
  `deepSearchBoard` goes through the real wasm on every run because **only the
  wasm lane can catch** that overflow — never move it to a native-only test.

### The match-three solver, encoding, symbols and rendering

Full detail in **`docs/match-three.md`**. What bites from outside:

- **The engine is four files, mirroring the C++ twin's own split.**
  `engineTypes.ts` is the vocabulary (`SolveResult`, `SolveOptions`, the
  sampling constants), `cheapArms.ts` the greedy -> beam -> NRPA ladder and how
  the budget is sliced between them, `prover.ts` the iterative-deepening search
  and its transposition table, and `engine.ts` the assembly — which re-exports
  every type, so `solveClient.ts` and `solverWorker.ts` still import them from
  `./engine`. The same three-way seam as `Search.h` / `SearchGreedy|Beam|Nrpa`
  / `SearchProver.cpp`.
- **`rules.ts` is the definition of record for both engines** — `solutionView.ts`
  replays through `rules.applyMove`, so a witness those rules refuse is unplayable
  whichever engine produced it.
- **The search stops at the first solution it can play and claims nothing about
  its length.** `SolveResult` is `{status:"solved", moves}` | `{"unsolvable"}` |
  `{"budget"}`; `unsolvable` is the one proof left and is about existence.
- **There is no admissible lower bound at all**, which is why nothing here is
  A*-shaped. Do **not** add a "`remaining` moves clear at most `remaining * 3`
  cells" prune — a move clears *at least* three, and that bound cut off exactly
  the cascade solutions. The load-bearing prune is the **stranded symbol**; the
  one admissible bound that pays is **forced-single-clear**, where five blocks can
  clear as a T/L/plus so pricing them as a straight run over-estimates.
- **The board must already have settled** — `boardProblem` refuses a floating
  block or a standing line rather than repairing it. A *solver*-level check,
  deliberately not a validator one.
- **A candidate is accepted only after being replayed through `rules.applyMove`**
  (`solveClient.ts`) — the ONLY thing between a bad witness and the viewer. An
  **empty board**'s zero-move answer looks exactly like "this arm found nothing",
  so `Merged` knows a cleared board is its own answer, and
  **`WasmHandle.terminate` must set `settled`** or a `done` message reaching
  `finish()` synchronously back-fills a fresh worker after teardown.
- **A cell is one number** (`cell.ts`: `EMPTY` 0, `BLOCKED` 1, `FIRST_SYMBOL` 2).
  Go through `symbolCell` / `symbolIndexOf` / `isSymbol`, never the raw `+ 2`;
  `data-kind` is a rendering detail, not what the model stores. **`SYMBOLS` is
  append-only**, and `BLOCKER_IMAGE` is deliberately **not** in it, so any selector
  meaning "the symbols" says `[data-symbol-index]`. Cells take their tile from a
  `--symbol-image` custom property: assert on
  `style.getPropertyValue("--symbol-image")`, never `style.backgroundImage`
  (happy-dom rejects a Windows path).
- **The editor does not rebuild the grid on every edit** (1024 cells at the 32×32
  cap): `renderGrid` is the only full rebuild, `paintCell` returns early when the
  value is unchanged and calls `hideSolution()` **never** `render()`, and picking
  a tool calls `renderTools()`. `Board` registers listeners against an
  `AbortController` and `replaceBoard` calls `dispose()` — a board that kept
  listening paints into its own dead `cells`.
- **NRPA traps** (it is what cracks the hard boards): it optimises
  fewest-blocks-left so its best line is usually PARTIAL — an arm returns a
  solution or nothing; it must **restart** with a fresh policy on exhausting
  iterations, bounded by `kBarrenRestarts` on *barren* restarts specifically; the
  ladder's rungs cost the same on purpose; and **no single configuration wins both
  hard boards**, so do not "simplify" `kPortfolio` to one config. Relatedly:
  **a noise term smaller than one unit of the score it perturbs is not
  randomisation**, wherever a "randomised restart" is not diversifying.
- **The transposition table is bounded and evicts.** Eviction is sound; a **false
  hit** would not be, which is why keys are compared in full and never by hash
  alone, and a budget-aborted subtree is never recorded. **The hash must
  avalanche** (the bucket index is its LOW bits), and **the per-depth scratch must
  not be resized mid-recursion** (dangling `Level &`).
- Both grids use `.grid-cell` with the same `data-x`/`data-y`, so **every editor
  selector must be scoped to `#grid`** and every solution selector to
  `#solution-grid`.

### The phasic dial page

The only page that searches on the main thread: `TurnSolver` is pure TS with no
worker, a `searchSteps()` generator yielding every `YIELD_INTERVAL` combinations
while `calculateTurnsAsync()` awaits between chunks (~0.7 s for six dials × eight
buttons, hence the spinner). A `solveGeneration` counter discards a result whose
board was replaced mid-search.

`maxValues[i]` is **positions minus one**, but nothing on the page says "max". A
dial is an SVG polygon with `max + 1` corners (`dialView.ts`), position 0 is
straight up and solved, and the face is one `role="slider"` with
`aria-valuemin/max/now` — the handle every test uses
(`getByRole("slider", {name: "Blue dial position"})`, never a `Max`/`Value`
field). The page keeps a real model and renders from it; `readConfig()` is a
projection, not a DOM scrape, and every mutation goes through
`invalidateResult()`. Dial colours are positional, so `#remove-dial` can only drop
the **last** dial.

## Test layout

`test/` and `e2e/` mirror `src/pages/` with kebab-case folders; shared tests sit
at the root of each and `test/resources/` is split the same way. Fixtures come
from the app's own download button, so the JSON *is* the download format. The
phasic-dial, match-three and logic-grid resource directories are discovered by
**directory listing**, so dropping a captured fixture in makes it run with no code
change; rolling-blocks and shifting-mosaic are enumerated explicitly (1–48, 1–43)
in nine places, one of them a **cwd-relative** literal in
`e2e/shifting-mosaic-solver/config.test.ts`.

**`test/resources/logic-grid-solver/` holds boards captured from the game and
NOTHING else** (436 of them, 3×2 to 26×19, no two the same puzzle); anything a
test invents lives in `test/logic-grid-solver/boards.ts`, imported by the unit
**and** e2e suites so a board cannot drift between them. **The split is the
point**: a sweep over the corpus measures the solver against real puzzles, and a
made-up board there would pad the number. Match-three is the same — 52 captured
boards, and the "cannot be cleared" board is built inline in the e2e suite because
there is no unsolvable fixture.

**Sweeps over a corpus assert what holds whatever a board turns out to be** — the
module never errors, its oracle never rejects its own propagators' work, any
complete answer verifies — rather than that a board comes out solved. Where "the
corpus still answers" IS asserted it is in the C++ `fixtures_test.cpp`, one engine
per board, **with no exception list**: a board that does not come out is either a
mis-entry or a hole in the engine. Do not move that claim into the TS sweep, which
asks a different question (AGREEMENT across all four arms at a short per-arm
budget, slow boards reporting `unsolved`) — four arms × the slowest board is four
times the cost for the same fact.

**Hand-built boundary boards run BEFORE the captured ones and stay in the fast
lane** (`wasm.test.ts` via the shared `wasmHarness.ts`), so the sweep still means
something if the corpus is ever empty and every format-key-crosses-the-boundary
case (`shapes`, `direction`, `seat`, each clue kind, the deep-search board) is
covered without leaning on what happened to be captured. `wasmBridge.ts` exports
`toPuzzle` for exactly that reason: the suite once kept its own copy of the
payload and swept the whole corpus while never sending a new key.

Match-three's name→length table is a **ceiling, not a pin** (`<=`), since the
search claims nothing about minimality; `matchThreeTest47/50/51` sit in a
`STOCHASTIC` set (NRPA answers). The cross-engine guard is `fuzz:mt` plus the
`rules.applyMove` replay.

## Native C++ builds

`bun run build:wasm` compiles with emscripten; the gtest suites are a separate
native build per solver (`src/pages/*/a-star/`, needs nlohmann_json + gtest, and
boost for the two older solvers — match-three passes `needsBoost: false`).
The pre-configured local dirs (`cmake-build-release-visual-studio`,
`build-native`) must be driven by **CLion's** bundled CMake, from an MSVC
environment (`vcvars64.bat`) for the Ninja dirs — and the rolling-blocks dirs are
Ninja despite their `-visual-studio` names, so the gate is live there.

The repo root carries an **aggregate** `CMakeLists.txt`, which is what CI uses:

```bash
cmake -B build-ci -S . -DCMAKE_BUILD_TYPE=Release -DBUILD_TESTING=ON
cmake --build build-ci -j
ctest --test-dir build-ci -j 4 --output-on-failure
```

**`-j` is never implicit** — neither command parallelises by default, and CLion
passes its own, which is why the pre-configured dirs feel parallel. Export
`CMAKE_BUILD_PARALLEL_LEVEL` / `CTEST_PARALLEL_LEVEL` to make it automatic in a
shell. The aggregate is **additive only** — each `src/pages/*/a-star` stays
independently configurable because CLion's profiles point straight at them, so
never move something a child needs up into the root. `-DIOI_ROLLING_BLOCKS=OFF`
(and `_SHIFTING_MOSAIC`, `_MATCH_THREE`, `_LOGIC_GRID`) drops a solver;
`gtest_discover_tests` sets `LABELS`, so one page runs as `ctest -L logic-grid`.

Three things there are load-bearing, all spelled out in **`docs/toolchain.md`**:
`${PROJECT_SOURCE_DIR}` never `${CMAKE_SOURCE_DIR}` in the `test/CMakeLists.txt`
files (the wrong one resolves `TEST_RESOURCES_DIR` outside the repo, where fixture
tests `GTEST_SKIP()` — a silently green run); the `*_core` `OBJECT` libraries,
correct only while no solver TU needs a target-specific define; and `PROCESSORS 8`
on the shifting-mosaic `gtest_discover_tests`, without which
`shiftingMosaicTest37` blows its per-arm budget and reads as a regression.
**Run the suite in Release** — test37 needs ~115 s there and cannot make its
budget in Debug, so a lone test37 failure means the build type.

Every solver has a real CLI (`a_star.exe`, `match_three.exe`, `logic_grid.exe`)
speaking one protocol — `--fixture <path> [--engine …] [--budget-ms N] […]
[--json]` plus `--generate <path> --seed N [--kind …]`, where the LAST stdout line
starting with `{` is the JSON report (`stage` names the winning arm). All eight
bench/fuzz harnesses speak it through `src/util/solverCli.ts` — **extend it there,
not per-harness**. Generator dimensions are **clamped** rather than re-drawn (so a
pinned dimension consumes no random number), and `--generate` **exits 1 without
writing** when no attempt produced a usable board.

Every validity oracle is compiled into **both** wasm and native (`Replay.{h,cpp}`,
or `Verify.{h,cpp}` for logic-grid). `FixtureIo` / `GenerateCommands` are **native
only** — they drag in nlohmann + exceptions, so they must never join the wasm
source lists — and logic-grid's `Reference.{h,cpp}` is native only for a second
reason: it is exponential brute force that must not be reachable from the page.

All solvers gate on clang-tidy through `cmake/ClangTidyGate.cmake` and fail on any
finding — but only under Ninja/Makefiles and only when the binary's LLVM major
matches `PROFILE_LLVM`. CI builds and tests but does not lint. Read that module
before changing its details; **`docs/toolchain.md`** has the two-line setup for a
new solver and the hand-edit CLion's generated `.clang-tidy` needs before the gate
will run at all.

**MSVC accepts code clang rejects.** A green native build plus a green gtest run
is not sufficient — run `bun run build:wasm` before believing a C++ change is
done.

## Required checks before calling work done

### TypeScript / JavaScript

1. `bun run typecheck` — always, on any `.ts`/`.js` change.
2. **SonarQube MCP `analyze_code_snippet`** on every file you added or changed. It
   analyzes whatever content you pass, so it works on uncommitted code.
   - Pass the **complete** file as `fileContent`; set `language` and `scope`
     (`TEST` for anything under `test/` or `e2e/`). `projectKey` is optional.
   - **Do not pass `codeSnippet` for a review pass** — it *filters* the output, so
     an unrelated problem elsewhere in the file reads as "clean".
   - It catches what `tsc` cannot: S3776 cognitive complexity (>15), S2933
     `readonly`, S3358 nested ternary, S1854 dead assignment, S4138 index-`for`.
     Treat a finding on code you touched as something to fix, not report.

The other SonarQube MCP tools read the **last server-side analysis**, not the
working tree — do not use them to check your own edits. **The quality gate fails
on DUPLICATION almost every time a solver page lands**, and that is the only
condition that ever does; `.sonarcloud.properties` declares the copies the
architecture forces (**that filename is load-bearing** — automatic analysis
ignores `sonar-project.properties` silently). `CLION-INSPECTIONS.md` has the
breakdown and the curl commands.

### C++

1. The clang-tidy gate — but it degrades to a configure-time `WARNING`, so "no
   findings" and "never ran" look similar: check for `-- clang-tidy enforced: …`.
2. `bun run build:wasm`.
3. **`analyze_code_snippet` cannot analyze C++** (the `language` enum has no
   `cpp`). The only route to Sonar findings is SonarLint in the IDE;
   `CLION-INSPECTIONS.md` lists the recurring rules to write to up front, plus
   CLion's own inspections, which are invisible to both the gate and
   `getDiagnostics`.

### The IDE diagnostics bridge

Detail in **`docs/toolchain.md`**. `mcp__ide__getDiagnostics` covers only files the
IDE has **open** — in CLion only the **focused** one — and an empty result is
ambiguous in four different ways:

- **Call it with no `uri`** (an explicit one returns a mangled path and `[]`), and
  check the file is actually listed with a `linesInFile` before believing "clean".
- **The result lags the file in both directions**, so **three consecutive empties
  is the bar for a `.cpp`** — and a stale finding can survive three calls with a
  settled range, so never conclude from the tool alone: read the file and count.
- **A header is not independently analysed**; analyse the `.cpp` files first.
- **`wasm_bindings.cpp` and anything reached only from a wasm TU are invisible to
  every tool** and report clean because of it.

**So: for C++ changes, finish by asking the user to open and focus each changed
file in CLion, then call `getDiagnostics` (no `uri`) and check the file is
actually listed before concluding it is clean.** For TS/JS the hand-off is
unnecessary — `analyze_code_snippet` covers it headlessly.

## CI

`.github/workflows/test.yml` is a job DAG (~5½ min cold, ~3¼ min with a warm wasm
cache):

```
wasm ──┬──▶ bun-test [shards]
       ├──▶ e2e      [2 shards]
       ├──▶ mem64
       └──▶ dist              cpp        typecheck
```

- **`wasm`** is the only expensive artifact — sixteen LTO variants, hence its
  45-minute cold-cache allowance — and uploads `astar*.{mjs,wasm,stamp}` for the
  four jobs downstream. Its cache `path:` list is **per solver and
  explicit** — a new solver needs three lines there and three in `deploy.yml`,
  even though the cache KEY's glob picks it up automatically. **That key is exact:
  never add `restore-keys`**, or a prefix match restores wasm built from different
  C++ and every suite downstream tests the stale binary — green and meaningless.
  **`EMSDK_VERSION` is pinned because the key assumes it** and must match in both
  workflows. `.github/actions/setup-wasm` is shared, so the emsdk pin and the
  `BOOST_INCLUDE` symlink cannot drift.
- **`bun-test` fans out over six shards** — one per `*.slow.test.ts` plus one
  running everything else under `IOI_SKIP_SLOW=1`. Between them they run **every**
  test, so **the shard list and the slow-file set must move together**: gating a
  suite with `skipIf` without adding its shard makes it run nowhere.
- **`mem64` names every `mem64.node.test.mjs` explicitly** — a solver missing from
  that line is a MEMORY64 build nothing ever instantiates. **`dist`** proves the
  production bundle builds on every PR and publishes the artifact `deploy.yml`
  reuses.

Sonar's `githubactions` rules shape the YAML: **S7637** (third-party actions
pinned to a commit SHA with the tag in a trailing comment; `actions/*` exempt) and
**S8543** (no `bunx <pkg>` in a workflow — both call sites go through
package.json, which also guarantees the pinned version). Deliberately absent: an
apt cache and ccache (measured), and `paths`/`paths-ignore` filters, because a
skipped required check never reports and branch protection would block the PR
forever.

`deploy.yml` first tries to download `dist` from the successful Test run on the
**parent** of the version-bump commit, otherwise builds with the shared wasm
cache. That reuse is only sound because dist content does not depend on the
version — **rendering a version anywhere on the site invalidates it.**
`update-version` refuses to run unless `main`'s head has a green Test run.

## Keeping this file current

Update it in the same change that introduces something it would have been useful
to know beforehand: a new page or solver, a new build/test command or env gate, a
new shared utility in `src/util/` or `cmake/`, a change to the fixture layout or
the wasm variant set, or a newly discovered toolchain trap. Do not log routine
feature work here, and keep the split — per-rule, per-clue and per-arm narrative
belongs in `docs/`, this file keeps the contract and the trap.

## Conventions worth knowing

- `tsconfig.json` sets `noUncheckedIndexedAccess`, which is why array and
  `querySelector` access is littered with `!`.
- There is no prettier/eslint config; match the surrounding style (~80 columns,
  `arrowParens: "avoid"`).
- Deployment is `workflow_dispatch` only (`.github/workflows/deploy.yml`): it
  bumps the version on a branch, PRs it to `main`, merges, then publishes Pages
  from the reused-or-rebuilt `dist`.
