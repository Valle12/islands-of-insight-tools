# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A static, zero-framework site of three puzzle solvers for the game *Islands of Insight*, deployed to GitHub Pages. Each solver is a page under `src/pages/`; two of them run their search in C++ compiled to WebAssembly. There is no backend and no client-side router — `src/util/serve.ts` maps four URLs to four HTML entry points, and `bun run build` emits the same four pages into `dist/`.

(`README.md` is unmodified `bun init` boilerplate — its `bun run index.ts` instruction is wrong, there is no `index.ts`.)

## Commands

```bash
bun install

bun run dev              # dev server on :3000 (src/util/serve.ts)
bun run build            # -> dist/ (runs build:wasm first via an import side effect)
bun run build:wasm       # em++ only; needed before `bun test` on a clean checkout

bun test                 # unit tests (bunfig.toml pins root = "test")
bun run test             # build:wasm + the full suite with the rolling-blocks gate on
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

Two suites are opt-in:

- `ROLLING_BLOCKS_TEST=true` — the wasm fixture sweep in `test/rolling-blocks-solver/aStar.test.ts`. It is a `describe.if`, so without the variable it registers **nothing at all** and the run still looks green. `bun run test`, `bun run rolling-blocks-test` and CI set it; a bare `bun test` does not.
- `SM_SLOW_E2E=1` — `e2e/shifting-mosaic-solver/heapLimit.slow.test.ts` (~4 min). A `test.skip`, so it at least reports as skipped.

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

Material Symbols icons come from a **subset URL** in `src/common/common.css` (`icon_names=add,cancel,delete,download,…`). A `<md-icon>` naming a glyph not in that list renders as garbage text, not a missing icon.

**The production build must run as `bun run build`**, which pins `NODE_ENV=production`. Material Web pulls in Lit, whose package exports carry a `development` condition; Bun's bundler selects it otherwise and ships the development build of Lit, which logs "Lit is in dev mode" on every page load. Setting it inside `build.ts` does **not** work — `Bun.build` does not read `process.env.NODE_ENV` at call time (measured: all 20 dev-mode sites stayed in the bundle), so it has to be on the process from the start. Invoking `bun src/util/build.ts` directly silently produces a dev-mode bundle.

The dev server keeps `development: true` for HMR and therefore *does* log that warning — expected locally, and the reason the build pins the variable rather than relying on the ambient environment. `NODE_ENV=production` and the `{ hmr: true }` object form were both measured and neither suppresses it; only `development: false` does, at the cost of HMR.

### C++ → WebAssembly

`src/util/buildWasm.ts` drives `em++` (resolved via `Bun.which`, emsdk ≥ 6.0.0 required for `-m64`) and produces **four variants per solver** from the same translation units — plain wasm32, `-pthread`, MEMORY64 (8GB heap), and pthreads+MEMORY64 — built concurrently (rolling-blocks and shifting-mosaic alike). Assets are served/copied under `/rb-wasm/` and `/sm-wasm/` respectively (`serve.ts` allowlist, `build.ts` copies; workers are reached page-relative as `../rb-wasm/astar.worker.js`).

`src/pages/*/wasm/` is generated output and gitignored, **except** `astar.worker.js`, which is hand-written source living in the same directory. Do not delete the directory wholesale.

The source lists are duplicated in three places that must stay in sync: `buildWasm.ts`, the `em++` steps in `.github/workflows/test.yml`, and the C++ `CMakeLists.txt`. A missing TU fails at link time with undefined symbols.

### The two solver bridges

Both bridges are now **portfolios** with identical mechanics: an exported `PORTFOLIO` array of engine configs, one worker per arm racing the others, first non-empty solution wins, the rest terminated. Concurrency is bounded by `hardwareConcurrency`, not the arm count — every arm always runs, queued and back-filled. An arm that exhausts the heap retires itself and the race continues. Cross-origin isolated pages collapse to ONE worker on the pthreads build, whose in-module race runs the same arm set on real threads (with a sequential in-module fallback announced as `onPhase("sequential")`). Variant priority (threads-mem64 > threads > mem64 > default) comes from the shared probes in `src/util/wasmFeatureProbes.ts`.

- **rolling-blocks** (`wasmBridge.ts` → `searchRollingBlocksWasm`): wasm exports `solve(puzzle, config)` and `optimize(puzzle, turns)` — config keys (all optional): `engine` (`cascade` default | `wastar` | `exact` | `cracker` | `beam` | `greedy`), `weight` (2), `maxMs` (60000), `maxNodes`, `maxStatesStored`, `maxHeapBytes` (0 = unlimited), `seed`, `beamWidth`, `gated`, `postProcess` (true), `optimizeMaxMs` (30000). `solve` returns `{turns, stats:{nodesExpanded, statesStored, stoppedOnMemory, wallMs, engine}}` or `{turns: [], error}` for boards beyond the engine caps (64×64 grid, 255 blocks, dims ≤ 64). Arm selection lives in `SolverArms.cpp` (shared by CLI and bindings; its `kPortfolio` must stay in sync with the bridge's `PORTFOLIO`): `cascade` first **decomposes** the board into independent playable regions (a rectangular footprint can never straddle an Unplayable cell, so blocks are confined to their starting region forever — sub-puzzles solve separately and plans concatenate; this took the first fuzz campaign from 21/30 to 30/30), then chains exact (gated) → cracker (gated) → wastar w2 → greedy → beam → cracker jittered → wastar w4 → wastar w1 with budget shares of the total (order re-measured on that campaign — greedy solo cracked boards wastar and beam both missed). Gates live in `PuzzleProfile.h` (the cracker takes must-touch-dominant boards with ≤ 2 blocks — measured: fixtures 37/38/39 fall in 106/60/7907 expansions where weighted A* needed millions; via the cascade they solve in 5–141 ms, see `a-star/bench/baseline-cascade.json`). Two-block coverage boards route through the three-phase split scheme in `SolverArms.cpp` (plain sequential split → `LegOrderSearch`, a best-first search over LEG ORDER with required-subset cracker legs, pose-space coverability and orphan + coverage-intact prunes → joint finisher; every candidate plan is full-replay-validated; it carries fixture 34 in well under a second where wastar needed 4 s). The cracker-only `Config` fields `requiredCells` / `coveragePartner` / `jointCoverageIntact` exist for these legs and are never exposed at the wasm/CLI boundary; `a-star/bench/HARD-BOARDS.md` documents the scheme and the still-open fuzz-7007 board.
- **shifting-mosaic** (`wasmBridge.ts` → `searchShiftingMosaicWasm`): the original portfolio; `PORTFOLIO` is exported so `test/shifting-mosaic-solver/wasm.test.ts` races the exact production arm set.

**Both** solver pages need `SharedArrayBuffer` for their threads builds, which GitHub Pages cannot grant via headers. `src/common/coiRegister.ts` registers `coi-serviceworker.js` and **reloads once** when it activates. `page.goto()` resolves on the *pre-reload* document, so any e2e interaction in that window can die with "Execution context was destroyed". Always reach the rolling-blocks AND shifting-mosaic pages through `gotoIsolated` / `waitForCoiSettled` in `e2e/coi.ts`.

### Config file I/O

`src/util/configFile.ts` holds `downloadJson` / `readJsonFile` / `setupDragAndDrop`, shared by all three solver pages. Each page keeps its own `config.ts` validator returning `{ ok: true, config } | { ok: false, error }` with a human-readable first-failure message, and its own `applyLoadedConfig`. The download filename matches the fixture family (`phasicDialTest.json`, `shiftingMosaicTest.json`, `rollingBlocksTest.json`) so a downloaded file is directly usable as a test fixture. `#warning-banner` / `#drop-overlay` / `.hidden` styles live in `src/common/common.css`. The rolling-blocks validator also enforces the engine caps (64×64 grid, 255 blocks, dims ≤ 64 — same constants the UI fields and the wasm boundary use) and renumbers block ids to 1..n on load; **this validator** ignores a fixture's optional `turns` key. That is a page-level rule, not a repo-wide one — the native `fixtureio::load` deliberately does the opposite and parses `turns` back out, because that key is where `--generate` stores the replay-validated witness.

E2e traps for the rolling-blocks page: several inline aria snapshots include the page subtitle text, and Material components expose an inner `#button` in their shadow DOM — never target buttons by `#button` index (adding any icon button shifts every index; use the app's own `data-block-delete-id` style hooks).

### Long searches on the main thread

`TurnSolver` (phasic dial) is pure TS with no worker. Its search is a `searchSteps()` generator that yields every `YIELD_INTERVAL` combinations; `calculateTurns()` drains it straight through, `calculateTurnsAsync()` awaits between chunks so the page stays interactive. Six dials with eight buttons is ~0.7 s of work, hence the spinner. A `solveGeneration` counter (same pattern as the shifting-mosaic editor's) discards a result whose board was reset or replaced mid-search.

## Test layout

`test/` and `e2e/` mirror `src/pages/` with kebab-case folders (`phasic-dial-solver`, `rolling-blocks-solver`, `shifting-mosaic-solver`); shared tests sit at the root of each. `test/resources/` is split the same way. Fixtures are produced by the app's own download button, so the JSON *is* the download format.

`test/resources/phasic-dial-solver/` is discovered by directory listing rather than a hard-coded list, so dropping a captured `phasicDialTest*.json` in makes it run with no code change. Every other fixture family is enumerated explicitly: the C++ suites run rollingBlocksTest 1–48 and shiftingMosaicTest 1–43, and `test/rolling-blocks-solver/aStar.test.ts` runs the same full 1–48 range through wasm on the cascade engine (120 s per-test timeout, 90 s solve budget). Real captured rolling-blocks boards top out at 13×15 / 8 blocks / dimension-6 blocks / 83 must-touch — the 64×64 caps and fuzz sizes are stress headroom, not game reality.

Fixture paths appear in nine places — the two `TEST_RESOURCES_DIR` macros in the C++ test `CMakeLists.txt`, four TS/MJS test files, `src/util/benchShiftingMosaic.ts` (regex over `readdirSync`), `src/util/benchWasmSimd.ts`, and a **cwd-relative** literal in `e2e/shifting-mosaic-solver/config.test.ts`. Renaming or moving a fixture means touching all of them.

## Native C++ builds

`bun run build:wasm` compiles with emscripten; the gtest suites are a separate native build per solver (`src/pages/*/a-star/`, needs boost + nlohmann_json + gtest). CI configures fresh Release build dirs; locally there are pre-configured ones (`cmake-build-release-visual-studio`, `build-native`) that must be driven by **CLion's** bundled CMake, from an MSVC environment (`vcvars64.bat`) for the Ninja dirs. The rolling-blocks dirs are Ninja despite their `-visual-studio` names, so the clang-tidy gate is live there.

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

## Keeping this file current

Update `CLAUDE.md` in the same change that introduces something it would have been useful to know beforehand: a new page or solver, a new build/test command or env gate, a new shared utility in `src/util/` or `cmake/`, a change to the fixture layout or the wasm variant set, or a newly discovered toolchain trap. Do not log routine feature work here.

## Conventions worth knowing

- `tsconfig.json` sets `noUncheckedIndexedAccess`, which is why array and `querySelector` access is littered with `!`.
- There is no prettier/eslint config in the repo; match the surrounding style (~80 columns, `arrowParens: "avoid"`).
- Bench baselines under `src/pages/shifting-mosaic-solver/a-star/bench/*.json` store fixture names as keys and are read by `--diff`.
- Deployment is `workflow_dispatch` only (`.github/workflows/deploy.yml`): it bumps the version on a branch, PRs it to `main`, merges, then builds and publishes Pages.
