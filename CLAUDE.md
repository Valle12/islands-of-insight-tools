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

`node --test test/shifting-mosaic-solver/mem64.node.test.mjs` (`bun run test:mem64`) runs under node, not bun: bun cannot instantiate a Memory64 module.

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

`src/util/buildWasm.ts` drives `em++` (resolved via `Bun.which`, emsdk ≥ 6.0.0 required for `-m64`) and produces:

- **rolling-blocks**: one wasm32 module.
- **shifting-mosaic**: four variants from the *same* translation units — plain wasm32, `-pthread`, MEMORY64 (8GB heap), and pthreads+MEMORY64 — built concurrently.

`src/pages/*/wasm/` is generated output and gitignored, **except** `astar.worker.js`, which is hand-written source living in the same directory. Do not delete the directory wholesale.

The source lists are duplicated in three places that must stay in sync: `buildWasm.ts`, the `em++` steps in `.github/workflows/test.yml`, and the C++ `CMakeLists.txt`. A missing TU fails at link time with undefined symbols.

### The two solver bridges differ

- **rolling-blocks** (`wasmBridge.ts` → `searchWasm`): one worker, messages `progress | done | error`.
- **shifting-mosaic** (`wasmBridge.ts` → `searchShiftingMosaicWasm`): a **portfolio**. `PORTFOLIO` is an ordered array of engine configs; each is one worker racing the others, first non-empty solution wins, and the rest are terminated. Concurrency is bounded by `hardwareConcurrency`, not the arm count — every arm always runs, queued and back-filled. An arm that exhausts the heap retires itself and the race continues. If every arm comes back empty the bridge re-runs them sequentially (`onPhase("sequential")`) so the UI can say the strategy changed. `PORTFOLIO` is exported so `test/shifting-mosaic-solver/wasm.test.ts` races the exact production arm set.

The shifting-mosaic page needs `SharedArrayBuffer`, which GitHub Pages cannot grant via headers. `src/common/coiRegister.ts` registers `coi-serviceworker.js` and **reloads once** when it activates. `page.goto()` resolves on the *pre-reload* document, so any e2e interaction in that window can die with "Execution context was destroyed". Always reach that page through `gotoIsolated` / `waitForCoiSettled` in `e2e/coi.ts`.

### Config file I/O

`src/util/configFile.ts` holds `downloadJson` / `readJsonFile` / `setupDragAndDrop`, shared by the phasic-dial and shifting-mosaic pages. Each page keeps its own `config.ts` validator returning `{ ok: true, config } | { ok: false, error }` with a human-readable first-failure message, and its own `applyLoadedConfig`. The download filename matches the fixture family (`phasicDialTest.json`, `shiftingMosaicTest.json`) so a downloaded file is directly usable as a test fixture. `#warning-banner` / `#drop-overlay` / `.hidden` styles live in `src/common/common.css`.

### Long searches on the main thread

`TurnSolver` (phasic dial) is pure TS with no worker. Its search is a `searchSteps()` generator that yields every `YIELD_INTERVAL` combinations; `calculateTurns()` drains it straight through, `calculateTurnsAsync()` awaits between chunks so the page stays interactive. Six dials with eight buttons is ~0.7 s of work, hence the spinner. A `solveGeneration` counter (same pattern as the shifting-mosaic editor's) discards a result whose board was reset or replaced mid-search.

## Test layout

`test/` and `e2e/` mirror `src/pages/` with kebab-case folders (`phasic-dial-solver`, `rolling-blocks-solver`, `shifting-mosaic-solver`); shared tests sit at the root of each. `test/resources/` is split the same way. Fixtures are produced by the app's own download button, so the JSON *is* the download format.

`test/resources/phasic-dial-solver/` is discovered by directory listing rather than a hard-coded list, so dropping a captured `phasicDialTest*.json` in makes it run with no code change. Every other fixture family is enumerated explicitly, and the bounds disagree: the C++ suites run rollingBlocksTest 1–39 and shiftingMosaicTest 1–43, while `test/rolling-blocks-solver/aStar.test.ts` lists only 1–30.

Fixture paths appear in nine places — the two `TEST_RESOURCES_DIR` macros in the C++ test `CMakeLists.txt`, four TS/MJS test files, `src/util/benchShiftingMosaic.ts` (regex over `readdirSync`), `src/util/benchWasmSimd.ts`, and a **cwd-relative** literal in `e2e/shifting-mosaic-solver/config.test.ts`. Renaming or moving a fixture means touching all of them.

## Native C++ builds

`bun run build:wasm` compiles with emscripten; the gtest suites are a separate native build per solver (`src/pages/*/a-star/`, needs boost + nlohmann_json + gtest). CI configures fresh Release build dirs; locally there are pre-configured ones (`cmake-build-release-visual-studio`, `build-native`) that must be driven by **CLion's** bundled CMake, from an MSVC environment (`vcvars64.bat`) for the Ninja dirs.

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
3. **`analyze_code_snippet` cannot analyze C++** — the tool's `language` enum has no `cpp`/`c`, and passing one is a hard validation error (confirmed 2026-07-28). The only route to Sonar findings for C++ is SonarLint inside the IDE.

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
