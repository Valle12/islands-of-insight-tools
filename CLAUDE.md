# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A static, zero-framework site of four puzzle solvers for the game *Islands of Insight*, deployed to GitHub Pages. Each solver is a page under `src/pages/`; two of them run their search in C++ compiled to WebAssembly. There is no backend and no client-side router — `src/util/serve.ts` maps five URLs to five HTML entry points, and `bun run build` emits the same five pages into `dist/`.

**match-three is the one solver written in pure TypeScript.** No wasm: its search runs in a bundled TS Web Worker (`solverWorker.ts`), and 6×6 boards land in a median ~40 ms. See "The match-three solver" below.

(`README.md` is unmodified `bun init` boilerplate — its `bun run index.ts` instruction is wrong, there is no `index.ts`.)

## Commands

```bash
bun install

bun run dev              # dev server on :3000 (src/util/serve.ts)
bun run build            # -> dist/ (runs build:wasm first via an import side effect)
bun run build:wasm       # em++ only; skips variants whose inputs have not moved

bun test                 # every unit test (bunfig.toml pins root = "test")
bun run test             # build:wasm + every unit test — no env gates
bun run test:fast        # everything except the three *.slow.test.ts suites (~5s)
bun run test:slow        # only those three
bun run test:changed     # only the files affected by the diff vs origin/main
bun run test:mt          # one page + the two shared root suites (also :pd :rb :sm)
bun run e2e              # playwright, spins up its own webServer

bun run bench:sm         # shifting-mosaic bench; --diff before.json after.json
bun run fuzz:sm          # generate-and-solve campaign into test-results/sm-fuzz
bun run bench:rb         # rolling-blocks bench over all fixtures; --diff works too
bun run fuzz:rb          # rolling-blocks campaign into test-results/rb-fuzz
                         # (--kind goal|coverage|mixed|cycle; boards are solvable
                         #  by construction and the witness is replay-validated)
```

Running a subset:

```bash
bun test test/phasic-dial-solver                 # a directory
bun test test/configFile.test.ts                 # one file
bun test -t "should load a config from a file"   # by test name
bunx playwright test e2e/phasic-dial-solver
bunx playwright test e2e/shifting-mosaic-solver/config.test.ts:60
```

The expensive unit suites are opt-**out**, never opt-in. Three files carry
`.slow.test.ts`, and they run by default — including in CI, which sets nothing:

| File | Measured |
| --- | --- |
| `test/shifting-mosaic-solver/wasm.slow.test.ts` | ~244s |
| `test/rolling-blocks-solver/aStar.slow.test.ts` | ~60s |
| `test/match-three-solver/engine.solve.slow.test.ts` | ~44s |

Every other file under `test/` measures 300–780ms, except
`test/phasic-dial-solver/turnSolver.test.ts` at ~3.9s — still inside bun's 5 s
default, so it stays in the fast lane.

- `IOI_SKIP_SLOW=1` (what `bun run test:fast` sets) skips those three. They are
  `describe.skipIf`, so they **report as skipped**. This replaced
  `ROLLING_BLOCKS_TEST`, which was a `describe.if`: unset, it registered
  **nothing at all** and a 48-fixture sweep sat disabled behind a green run.
  **Never reintroduce `describe.if` for a cost gate** — inverting the default so
  forgetting a variable costs time rather than coverage is the whole point.
  (`describe.if(fixtures.length > 0)` in `turnSolver.test.ts` is the same trap
  in miniature, which is why a corpus-is-non-empty test sits outside it.)
- `SM_SLOW_E2E=1` — `e2e/shifting-mosaic-solver/heapLimit.slow.test.ts` (~4 min).
  Still opt-in, and a `test.skip`, so it reports as skipped.

`bun test` takes multiple positional substring filters, which is what the
per-page scripts use (`test:sm` = the page directory plus `configFile.test.ts`
and `utilMethods.test.ts`). `bun test slow` selects the three by name.
`bun test --changed=<ref>` walks the import graph — measured: on the match-three
commit it selected exactly the match-three files.

`bun run test:mem64` runs the two `mem64.node.test.mjs` files (shifting-mosaic + rolling-blocks) under node, not bun: bun cannot instantiate a Memory64 module. Under `bun test` they register as skips.

Playwright aria snapshots are inline. `--update-snapshots` only rewrites *failing* ones; aria matching is **partial**, so a snapshot keeps passing when new nodes appear. Use `--update-snapshots=all` to get a faithful tree — it writes `test-results/playwright/rebaselines.patch` for `git apply`.

## Architecture

### Page shape

Every page is `index.html` + a `<page>Solver.ts` class + a `.css`, plus `src/common/common.ts` which registers the Material Web custom elements used across all pages. Pages talk to the DOM by `id` directly; there is no component layer and no state library.

The solver class is instantiated at module scope behind `if (process.env.NODE_ENV !== "test")` (`src/util/preload.ts` sets that). Unit tests therefore construct it themselves, almost always by `spyOn(document, "getElementById")` returning hand-made elements and capturing the listener the constructor registers.

### Bundling

`src/util/plugins.ts` supplies two Bun plugins used by both `build.ts` and `serve.ts`:

- `pngDataUrl` inlines every PNG *except* `favicon.png` as a base64 data URL. A new image needs only an `import`, no copy step — but `dist/` has no `images/` directory, so anything referenced by URL rather than imported will 404.
- `sassCompiler` compiles `.scss`.

**Bun's HTML entrypoints do not bundle Web Workers.** `new Worker(new URL("./x.ts", import.meta.url), …)` survives minification with the `.ts` specifier intact, so it 404s in `dist/` — measured, and it fails silently at build time. The match-three worker therefore gets its own `Bun.build` pass in `src/util/buildWorker.ts`, called from both `build.ts` (writes `dist/mt-worker/solverWorker.js`) and `serve.ts` (bundles per request, since HMR does not reach a worker). The page reaches it as `../mt-worker/solverWorker.js`: relative to `/match-three-solver` (dev, no trailing slash) *and* `/match-three-solver/index.html` (Pages), that resolves to the same absolute path — the same trick the emscripten workers use with `../rb-wasm/`.

Material Symbols icons come from a **subset URL** in `src/common/common.css` (`icon_names=add,cancel,delete,download,…`). A `<md-icon>` naming a glyph not in that list renders as garbage text, not a missing icon.

**The production build must run as `bun run build`**, which pins `NODE_ENV=production`. Material Web pulls in Lit, whose package exports carry a `development` condition; Bun's bundler selects it otherwise and ships the development build of Lit, which logs "Lit is in dev mode" on every page load. Setting it inside `build.ts` does **not** work — `Bun.build` does not read `process.env.NODE_ENV` at call time (measured: all 20 dev-mode sites stayed in the bundle), so it has to be on the process from the start. Invoking `bun src/util/build.ts` directly silently produces a dev-mode bundle.

The dev server keeps `development: true` for HMR and therefore *does* log that warning — expected locally, and the reason the build pins the variable rather than relying on the ambient environment. `NODE_ENV=production` and the `{ hmr: true }` object form were both measured and neither suppresses it; only `development: false` does, at the cost of HMR.

### C++ → WebAssembly

`src/util/buildWasm.ts` drives `em++` (resolved via `Bun.which`, emsdk ≥ 6.0.0 required for `-m64`) and produces **four variants per solver** from the same translation units — plain wasm32, `-pthread`, MEMORY64 (8GB heap), and pthreads+MEMORY64 — built concurrently (rolling-blocks and shifting-mosaic alike). Assets are served/copied under `/rb-wasm/` and `/sm-wasm/` respectively (`serve.ts` allowlist, `build.ts` copies; workers are reached page-relative as `../rb-wasm/astar.worker.js`).

`src/pages/*/wasm/` is generated output and gitignored, **except** `astar.worker.js`, which is hand-written source living in the same directory. Do not delete the directory wholesale.

The source lists are duplicated in two places that must stay in sync: `buildWasm.ts` and the C++ `CMakeLists.txt`. A missing TU fails at link time with undefined symbols. (There used to be a third copy — a hand-written `em++` loop in `.github/workflows/test.yml`. CI now calls `bun run build:wasm`, which also made it concurrent rather than eight serial builds.)

**Variants are skipped when their inputs have not moved.** Each writes an `astar*.mjs.stamp` next to its output holding a sha256 over the `sources`, **every `*.h` in the a-star directory root**, and the full argv, plus the `em++ --version` string. All four inputs are load-bearing:

- the headers because `AStar.h`, `PuzzleProfile.h`, `ParallelCascade.h` and friends are in no `sources` list yet absolutely change the output. Only the a-star **root** is hashed — `bench/` and `test/` are native-only and must not invalidate the wasm;
- the argv because it carries `SM_SIMD`, `-m64`, `-pthread`, `BOOST_INCLUDE` and the memory ceilings;
- **content, never mtimes** — a fresh `git checkout` and an `actions/cache` restore both rewrite mtimes wholesale, so an mtime check would trust a restored-but-stale output.

`FORCE_WASM=1` rebuilds regardless. The stamp is deliberately **not** a dotfile: `actions/upload-artifact` v4+ drops hidden files unless told otherwise, and a stamp that failed to travel with its binary would make the CI `dist` job try to compile.

`resolveEmcc()` is **lazy and returns null rather than throwing**, so a tree whose wasm is already current builds with no emsdk at all — which is what lets the CI `dist` job and deploy's cache-hit path run `bun run build` on a runner that never installed emscripten. A skip with no compiler to compare versions against warns loudly, because "no emsdk" must never look like "verified current".

### The two solver bridges

Both bridges are now **portfolios** with identical mechanics: an exported `PORTFOLIO` array of engine configs, one worker per arm racing the others, first non-empty solution wins, the rest terminated. Concurrency is bounded by `hardwareConcurrency`, not the arm count — every arm always runs, queued and back-filled. An arm that exhausts the heap retires itself and the race continues. Cross-origin isolated pages collapse to ONE worker on the pthreads build, whose in-module race runs the same arm set on real threads (with a sequential in-module fallback announced as `onPhase("sequential")`). Variant priority (threads-mem64 > threads > mem64 > default) comes from the shared probes in `src/util/wasmFeatureProbes.ts`.

- **rolling-blocks** (`wasmBridge.ts` → `searchRollingBlocksWasm`): wasm exports `solve(puzzle, config)` and `optimize(puzzle, turns)` — config keys (all optional): `engine` (`cascade` default | `wastar` | `exact` | `cracker` | `beam` | `greedy`), `weight` (2), `maxMs` (60000), `maxNodes`, `maxStatesStored`, `maxHeapBytes` (0 = unlimited), `seed`, `beamWidth`, `gated`, `postProcess` (true), `optimizeMaxMs` (30000). `solve` returns `{turns, stats:{nodesExpanded, statesStored, stoppedOnMemory, wallMs, engine}}` or `{turns: [], error}` for boards beyond the engine caps (64×64 grid, 255 blocks, dims ≤ 64). Arm selection lives in `SolverArms.cpp` (shared by CLI and bindings; its `kPortfolio` must stay in sync with the bridge's `PORTFOLIO`): `cascade` first **decomposes** the board into independent playable regions (a rectangular footprint can never straddle an Unplayable cell, so blocks are confined to their starting region forever — sub-puzzles solve separately and plans concatenate; this took the first fuzz campaign from 21/30 to 30/30), then chains exact (gated) → cracker (gated) → wastar w2 → greedy → beam → cracker jittered → wastar w4 → wastar w1 with budget shares of the total (order re-measured on that campaign — greedy solo cracked boards wastar and beam both missed). Gates live in `PuzzleProfile.h` (the cracker takes must-touch-dominant boards with ≤ 2 blocks — measured: fixtures 37/38/39 fall in 106/60/7907 expansions where weighted A* needed millions; via the cascade they solve in 5–141 ms, see `a-star/bench/baseline-cascade.json`). Two-block coverage boards route through the three-phase split scheme in `SolverArms.cpp` (plain sequential split → `LegOrderSearch`, a best-first search over LEG ORDER with required-subset cracker legs, pose-space coverability and orphan + coverage-intact prunes → joint finisher; every candidate plan is full-replay-validated; it carries fixture 34 in well under a second where wastar needed 4 s). The cracker-only `Config` fields `requiredCells` / `coveragePartner` / `jointCoverageIntact` exist for these legs and are never exposed at the wasm/CLI boundary; `a-star/bench/HARD-BOARDS.md` documents the scheme and the still-open fuzz-7007 board.
- **shifting-mosaic** (`wasmBridge.ts` → `searchShiftingMosaicWasm`): the original portfolio; `PORTFOLIO` is exported so `test/shifting-mosaic-solver/wasm.slow.test.ts` races the exact production arm set.

**Both** solver pages need `SharedArrayBuffer` for their threads builds, which GitHub Pages cannot grant via headers. `src/common/coiRegister.ts` registers `coi-serviceworker.js` and **reloads once** when it activates. `page.goto()` resolves on the *pre-reload* document, so any e2e interaction in that window can die with "Execution context was destroyed". Always reach the rolling-blocks AND shifting-mosaic pages through `gotoIsolated` / `waitForCoiSettled` in `e2e/coi.ts`.

### Config file I/O

`src/util/configFile.ts` holds `downloadJson` / `readJsonFile` / `setupDragAndDrop`, shared by all four solver pages. Each page keeps its own `config.ts` validator returning `{ ok: true, config } | { ok: false, error }` with a human-readable first-failure message, and its own `applyLoadedConfig`. The download filename matches the fixture family (`phasicDialTest.json`, `shiftingMosaicTest.json`, `rollingBlocksTest.json`, `matchThreeTest.json`) so a downloaded file is directly usable as a test fixture. `#warning-banner` / `#drop-overlay` / `.hidden` styles live in `src/common/common.css`. The rolling-blocks validator also enforces the engine caps (64×64 grid, 255 blocks, dims ≤ 64 — same constants the UI fields and the wasm boundary use) and renumbers block ids to 1..n on load; **this validator** ignores a fixture's optional `turns` key. That is a page-level rule, not a repo-wide one — the native `fixtureio::load` deliberately does the opposite and parses `turns` back out, because that key is where `--generate` stores the replay-validated witness.

E2e traps for the rolling-blocks page: several inline aria snapshots include the page subtitle text, and Material components expose an inner `#button` in their shadow DOM — never target buttons by `#button` index (adding any icon button shifts every index; use the app's own `data-block-delete-id` style hooks).

### The match-three solver

The rules are in `rules.ts`, the search in `engine.ts`, and both are pure and synchronous so the unit tests never touch a worker. Worth knowing before changing either:

- **Matches** are the union of every horizontal run ≥3 and every vertical run ≥3. `+`, `T` and `L` need no special case — they are just cells that both passes mark. Gravity is per column and stops at `BLOCKED`, so a column is a set of independent segments; clear/drop repeats until stable (a *cascade*).
- **A move** swaps two orthogonally adjacent cells that are both blocks and hold different symbols, and is legal only if it clears something. `legalMoves` only probes right/down neighbours (all four would offer each swap twice) and only checks the two moved cells, since a new match must pass through one of them.
- **The board must already have settled.** `boardProblem` refuses a floating block or a line still standing rather than repairing it — solving a repaired board would answer a puzzle the player never had. This is a *solver*-level check, deliberately not a validator one: `config.ts` passes any well-formed file, so the editor will happily hold a half-drawn board that Solve then refuses by name.
- **The search is IDDFS, and only ever reports a proven-minimal move count.** Depth `d` is reported only once every shorter length has been searched out. It terminates on its own — every move clears ≥3 cells, so `maxDepth = floor(blocks / 3)` — which is what makes `unsolvable` a proof rather than a timeout. The three outcomes are `solved` / `unsolvable` / `budget`, and `budget` deliberately reports *nothing* rather than an unproven length.
- **Do not add a "`remaining` moves clear at most `remaining * 3` cells" prune.** A move clears *at least* three, never at most: one swap can cascade the whole board away. That bound was tried and it cut off exactly the cascade solutions (caught by `engine.test.ts`'s `CASCADE_CLEARS`).
- The load-bearing prune is `hasStrandedSymbol` — a symbol down to one or two blocks can never line up again. With it plus the transposition table, random 6×6 boards measure median 39 ms / p90 1.5 s, and the hardest of 400 finished in under 8 s against the 30 s `SOLVE_BUDGET_MS`.
- The transposition table records only subtrees searched **to the end** with nothing found; an entry from a budget-aborted subtree would prune away the answer.
- Among minimal solutions the search then prefers one that groups same-symbol moves, on whatever budget is left. `groupingProven: false` means only that tie-break went unproven — the move count is never reported unproven.

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

## Test layout

`test/` and `e2e/` mirror `src/pages/` with kebab-case folders (`match-three-solver`, `phasic-dial-solver`, `rolling-blocks-solver`, `shifting-mosaic-solver`); shared tests sit at the root of each. `test/resources/` is split the same way. Fixtures are produced by the app's own download button, so the JSON *is* the download format.

`test/resources/phasic-dial-solver/` and `test/resources/match-three-solver/` are discovered by directory listing rather than a hard-coded list, so dropping a captured fixture in makes it run with no code change. The other fixture families are enumerated explicitly: the C++ suites run rollingBlocksTest 1–48 and shiftingMosaicTest 1–43, and `test/rolling-blocks-solver/aStar.slow.test.ts` runs the same full 1–48 range through wasm on the cascade engine (120 s per-test timeout, 90 s solve budget). Real captured rolling-blocks boards top out at 13×15 / 8 blocks / dimension-6 blocks / 83 must-touch — the 64×64 caps and fuzz sizes are stress headroom, not game reality.

`test/resources/match-three-solver/` holds 52 boards captured from the game (`matchThreeTest.json`, then `matchThreeTest1..51.json`), swept by directory listing in both `config.test.ts` (format) and `engine.test.ts` (settled, solvable, witness replayed). They span 2×2 to 13×23, 1 to 14 moves, with and without blockades, and between them use every symbol.

**Every one is expected to be a legal game state** — that half of the corpus's assertion covers all 52 and stays cheap. Solvability no longer does: `matchThreeTest47/50/51.json` (69–105 blocks) outrun the 30 s budget, so `engine.test.ts` names them in a `BEYOND_BUDGET` set, probes them at 2 s and asserts they come back `budget` — never `unsolvable`, which would be a proof the search never reached. **The set is the checklist**: make the search faster and those tests go red, which is the signal to move a name out of it. The sweep costs ~47 s now, nearly all of it `matchThreeTest44.json` (12×12, 71 blocks, 14 moves, ~13 s), so the solvable half carries a 60 s per-test timeout — Bun's 5 s default would fail it.

What those three actually cost, measured with the budget lifted (2026-07-31):

- **`matchThreeTest47.json` is solvable** — 11×12, 69 blocks, **20 moves in 46 min 42 s**, proven minimal and replay-validated. So it is a budget problem, nothing worse.
- **`matchThreeTest50.json` and `51.json` were never reached.** Both were still on depth 12 after 30 min when the OS killed them at 19.1 GB and 7.4 GB RSS — 26.5 GB between them on a 32 GB machine. **Memory is the wall before time is**, and the transposition table is what spends it: one `boardKey` string per state searched out, ~200 chars for a 9×23 board.
- Cost per extra depth measured ~1.6–3.0× in both time and RSS (`d10`→`d11` alone: 765 s / 616 s). Extrapolating the corpus's 3.5–5.1 blocks-per-move, those two want roughly 20–30 moves, so the gap is orders of magnitude — not a budget bump. Any attempt to reach them has to cap or shrink the table first (bounded/evicting map, or a packed key instead of a string); raising `SOLVE_BUDGET_MS` alone just runs into the same kill.

A consequence: there is no unsolvable fixture any more. `e2e/match-three-solver/solve.test.ts` builds its "cannot be cleared" board inline instead.

Two fixtures *are* named, only as a stable example with blockades in it — `matchThreeTest28.json` (6×6, 5 moves, blockades in both bottom corners) in `matchThreeSolver.test.ts` and the two e2e suites.

Both grids on the page use `.grid-cell` with the same `data-x`/`data-y`, so **every editor selector in a test must be scoped to `#grid`** and every solution selector to `#solution-grid`; an unscoped one silently matches two elements once the solution view has rendered.

Rolling-blocks and shifting-mosaic fixture paths appear in nine places — the two `TEST_RESOURCES_DIR` macros in the C++ test `CMakeLists.txt`, four TS/MJS test files, `src/util/benchShiftingMosaic.ts` (regex over `readdirSync`), `src/util/benchWasmSimd.ts`, and a **cwd-relative** literal in `e2e/shifting-mosaic-solver/config.test.ts`. Match-three needs none of that — its suites list the directory — beyond the `matchThreeTest28.json` example named in three files.

## Native C++ builds

`bun run build:wasm` compiles with emscripten; the gtest suites are a separate native build per solver (`src/pages/*/a-star/`, needs boost + nlohmann_json + gtest). Locally there are pre-configured dirs (`cmake-build-release-visual-studio`, `build-native`) that must be driven by **CLion's** bundled CMake, from an MSVC environment (`vcvars64.bat`) for the Ninja dirs. The rolling-blocks dirs are Ninja despite their `-visual-studio` names, so the clang-tidy gate is live there.

### The root `CMakeLists.txt` is an aggregate

The repo root carries a `CMakeLists.txt` that `add_subdirectory()`s both solvers, which is what CI uses:

```bash
cmake -B build-ci -S . -DCMAKE_BUILD_TYPE=Release -DBUILD_TESTING=ON
cmake --build build-ci -j                            # ~82 s
ctest --test-dir build-ci -j 4 --output-on-failure   # 236 tests, ~132 s
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

It is **additive only** — each `src/pages/*/a-star` stays independently configurable, because CLion's profiles point straight at them. Never move something a child needs up into the root. `-DIOI_ROLLING_BLOCKS=OFF` / `-DIOI_SHIFTING_MOSAIC=OFF` drop a solver from the aggregate. A fresh CLion "Open project" on the **repo root** now loads the aggregate rather than a page; the existing per-page profiles are unaffected.

Three things are load-bearing and easy to undo:

- **`${PROJECT_SOURCE_DIR}`, never `${CMAKE_SOURCE_DIR}`, in the two `test/CMakeLists.txt`.** Under the aggregate the latter is the repo root, so `TEST_RESOURCES_DIR` would resolve *outside* the repo — where the rolling-blocks fixture tests `GTEST_SKIP()` rather than fail. A silently green run.
- **`a_star_core` / `shifting_mosaic_core` are `OBJECT` libraries** consumed by both the CLI and the gtest binary. The solver TUs used to be listed in both targets and compiled (and clang-tidied) twice. This is only correct because `TEST_RESOURCES_DIR` is the sole per-target compile definition and no solver TU reads it — **if a solver TU ever needs a target-specific define, the object library has to be split.**
- **`PROCESSORS 8` on the shifting-mosaic `gtest_discover_tests`** (`SM_TEST_PROCESSORS`, kept in sync with `ARMS` in `ParallelCascade.h`). Each fixture spawns 8 `std::thread`s, so it claims 8 ctest slots — one per thread it really runs — and ctest never oversubscribes: at `-j 4` the count exceeds the parallel level so the test runs **alone**, and at `-j 16` two run at a time. The 165 cheap rolling-blocks tests fill the remaining slots. Without it `ctest -j` runs them 4- or 16-wide, they starve each other, and `shiftingMosaicTest37` blows its per-arm budget — which reads as a regression and is not one. Measured at `-j 4`: 236/236, test37 alone at 112 s.

`gtest_discover_tests` also sets `LABELS`, so a single page's suite runs as `ctest --test-dir build-ci -L rolling-blocks` (or `-L shifting-mosaic`).

Both solvers now have a real CLI (`a_star.exe` for rolling-blocks): `--fixture <path> [--engine cascade|wastar|exact|cracker|beam|greedy] [--weight N] [--budget-ms N] [--max-nodes N] [--max-states N] [--max-heap-bytes N] [--seed N] [--beam N] [--gated] [--no-post] [--json]`, plus `--generate <path> --seed N [--shuffle N] [--kind goal|coverage|mixed]`; the LAST stdout line starting with `{` is the JSON report (same protocol as the shifting-mosaic CLI), with `stage` naming the winning arm and `alreadySolved` flagging boards solved before any move. All four bench/fuzz harnesses speak that protocol through `src/util/solverCli.ts` (`runCli` child-process runner + `parseFlags` flag-map parser) — extend it there, not per-harness. Fixture loading and the replay validity oracle live in `Replay.{h,cpp}` (wasm + native); `FixtureIo.{h,cpp}` and `GenerateCommands.{h,cpp}` are native only — they drag in nlohmann + exceptions, so they must never join the wasm source lists. Generator invariants worth knowing: goal boards paint goals only under blocks with at least one legal roll (a frozen block keeps its own patch covered through any scramble — measured on seed 42) and re-scramble up to 3× if the start is still solved; coverage walks mark cells must-touch on first touch, which makes the walk itself the forward witness; mixed boards keep the two families in regions split by an unplayable divider column so the witnesses cannot interact.

Run the suite in **Release**: `shiftingMosaicTest37` needs ~115 s there and blows its per-arm budget in Debug, so a lone test37 failure means the build type, not a regression.

Both solvers gate on clang-tidy through `cmake/ClangTidyGate.cmake` and fail on any finding — but only under Ninja/Makefiles and only when the binary's LLVM major matches the `PROFILE_LLVM` argument. CI builds and tests but does not lint. That module is the single copy of the gate's hard-won details (why no `-checks=` argument, why the executable is searched for, why the config probe uses an empty TU rather than `--verify-config`); read it before changing any of them.

**MSVC accepts code clang rejects.** A green native build plus a green gtest run is not sufficient — run `bun run build:wasm` before believing a C++ change is done.

## Required checks before calling work done

### TypeScript / JavaScript

1. `bunx tsc --noEmit` — always, on any `.ts`/`.js` change.
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

CLion's generated profile needs one hand-edit before it will run: it enables `performance-faster-string-find`, which clang-tidy 23 reports as deprecated. That arrives as a `[clang-tidy-config]` diagnostic, `--warnings-as-errors=*` promotes it to a fatal error on *every* file, and the gate's config probe then disables linting entirely. Negate it (`-performance-faster-string-find`) as both existing profiles do. To check a profile without a full build:

```powershell
& $tidy --warnings-as-errors=* "--config-file=<dir>/.clang-tidy" <empty.cpp> -- -std=c++23
```

### The IDE diagnostics bridge

`mcp__ide__getDiagnostics` returns whatever the attached IDE reports — in VS Code that is the TS language server plus installed extensions; in CLion it is SonarLint. It only covers files the IDE has **open**, and in CLion only the file that currently has **focus**.

Two traps, both measured:

- **Call it with no `uri`.** Passing an explicit `uri` came back with a mangled `file://wsl.localhost/...` path and an empty array — indistinguishable from a clean file. The argless call lists every known file and reports `linesInFile` for the ones actually loaded, which is how you tell "clean" from "not analyzed".
- An empty result for a file the IDE never opened is meaningless.

**So: for C++ changes, finish by asking the user to open and focus each changed file in CLion, then call `getDiagnostics` (no `uri`) and check the file is actually listed before concluding it is clean.** For TS/JS this hand-off is unnecessary — `analyze_code_snippet` covers it headlessly.

## CI

`.github/workflows/test.yml` is a job DAG, not one serial job. It was ~20 min as a
single job; the critical path is now ~5½ min cold and ~3¼ min with a warm wasm
cache.

```
wasm ──┬──▶ bun-test [4 shards]
       ├──▶ e2e      [2 shards]
       ├──▶ mem64
       └──▶ dist              cpp        typecheck
```

- **`wasm`** is the only expensive artifact; it runs `bun run build:wasm` (no
  `bun ci` needed) and uploads `astar*.{mjs,wasm,stamp}` for the four jobs
  downstream. `cpp` and `typecheck` are independent of it.
- **`bun-test` fans out over four shards** — one per `*.slow.test.ts` suite plus
  one running everything else under `IOI_SKIP_SLOW=1`. Between them they run
  **every** test, which is why no env gate can leave a suite unregistered.
- **`dist`** proves the production bundle still builds on every PR (nothing
  checked that before) and publishes the artifact `deploy.yml` reuses.
- `.github/actions/setup-wasm` is a composite action shared with `deploy.yml`, so
  the emsdk pin and the `BOOST_INCLUDE` symlink cannot drift between them.

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
