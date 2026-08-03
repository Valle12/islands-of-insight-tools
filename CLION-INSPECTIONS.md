# CLion inspections the automated gates do NOT catch

The clang-tidy build gate (`cmake/ClangTidyGate.cmake`) and the IDE MCP
bridge (`getDiagnostics` = SonarLint, focused file only) both miss CLion's
own "Project Default" inspections. They only show up in **Code → Inspect
Code…** inside CLion, so write new C++ to these rules from the start —
retrofitting them later means a manual IDE pass.

## Write-time checklist (the CLion-only inspections, with the idiom)

- **Entity can have internal linkage** — everything file-local goes in an
  anonymous namespace: helpers, constants, and in gtest TUs also the param
  structs and fixture classes (`TEST_P`/`INSTANTIATE_TEST_SUITE_P` work
  fine with fixtures inside `namespace { … }`). Inside one, `static` is
  redundant — drop it.
- **Variable can be made constexpr** — compile-time-known locals
  (test dimensions, literal tables) are `constexpr`, not `const`.
- **Local variable / parameter can be made const** — includes lambda value
  parameters: `[](const uint32_t n) { … }`.
- **Parameter can be made pointer/reference to const** — pointers that are
  only read through get `const T *`.
- **Structured bindings can be used** — unpack aggregates instead of
  repeated member access: `const auto [legal, solvedAtEnd, firstSolvedAt]
  = replayTurns(…)`, `for (const auto &[dx, dy, next] : trans)`,
  `const auto [order, bi, dir] = moves[i]`. Also valid inside an if-init.
- **Variable can be moved to init statement** — a local used only by the
  following `if` goes into it: `if (const auto idx = …; cells_[idx] == …)`.
- **Variable can be moved to inner scope** — declare in the innermost
  block that uses it; moving a `constexpr` table into a loop costs
  nothing.
- **Template arguments can be deduced** (CTAD) — `std::array kDirs{…}`,
  `std::pair key{a, b}`, `std::array kSteps = {std::pair{1, 0}, …}`,
  `boost::dynamic_bitset sat(n)` (only WITH a constructor argument — a
  default-constructed `boost::dynamic_bitset<> b;` still needs the `<>`),
  Not applicable when the element type must differ from the literals
  (`std::array<int8_t, 4>`). **Never CTAD from a `<cstdint>` limit
  macro**: `std::vector v(n, UINT16_MAX)` deduces
  `vector<unsigned short>` under MSVC (its macro is a `ui16` literal) but
  `vector<int>` under em++ — a silent type/memory divergence between the
  native and wasm builds. Keep `std::vector<uint16_t> v(n, UINT16_MAX)`.
  **Don't CTAD `std::function` from a lambda** either: MSVC/clang/em++
  all accept it, but CLion's own engine fails the deduction and reports a
  compiler error — keep the explicit `std::function<void(uint32_t)>(…)`.
- **Redundant parameter list in lambda declarator** — `[&] {` not
  `[&]() {`.
- **Redundant cast expression** — never cast to the value's own type.
- **Designated initializers can be used** — brace-init aggregates by
  member name: `{.blockId = id, .direction = dir}`. Style is `.x = x`
  (spaces), wrap at ~80 columns.
- **Declarator is never used** — a function nothing in the TU names, but
  something else finds. The case that recurs is a gtest `PrintTo(const
  Case &, std::ostream *)` reached through ADL by the universal printer;
  mark it `[[maybe_unused]]` rather than deleting it, or the ctest listing
  goes back to dumping the parameter's raw bytes.
- **Possibly unused #include directive** — two flavors: genuinely unused
  includes (remove), and includes whose symbols also arrive transitively.
  For the second kind, remove a PROJECT include only when an interface
  header this repo controls guarantees it (e.g. `Types.h` via `Replay.h`
  → `Block.h`); keep std includes whose symbols the file genuinely uses
  (see intentional findings below).

## Headless equivalents (run before handing code over)

Several inspections map 1:1 to clang-tidy checks the gate deliberately
does not enable. A one-off run from the a-star directory lists (or with
`--fix` applies) them:

```powershell
$tidy = "C:\Program Files\JetBrains\CLion 2024.1.4\bin\clang\win\x64\bin\clang-tidy.exe"
& $tidy -p cmake-build-debug-visual-studio `
  "--checks=-*,modernize-use-designated-initializers,misc-const-correctness,modernize-use-auto,misc-include-cleaner" `
  "--header-filter=.*a-star.*" --extra-arg=-EHsc --extra-arg-before=--driver-mode=cl <files>
```

**`-p` must name a directory that actually has a
`compile_commands.json`,** and the *release* dirs do not — only the debug
ones export one. Point `-p` at a dir without it and clang-tidy does not
fail: it silently falls back to default flags, which are **not C++23**, so
`std::ranges`, `std::to_array`, `std::popcount` and vector CTAD all come
back as `clang-diagnostic-error` and every real check runs against a
half-parsed TU. Measured on the logic-grid tree: the release dir produced
40+ cascading errors plus a fistful of bogus `misc-const-correctness`
findings on reference parameters; the debug dir, same files, same command,
produced one genuine finding. **A run that emits `no member named 'ranges'
in namespace 'std'` is a broken invocation, not a codebase problem** — fix
`-p` before reading anything else in the output.

| CLion inspection | clang-tidy check |
|---|---|
| Designated initializers can be used | `modernize-use-designated-initializers` |
| Local variable / parameter can be made const | `misc-const-correctness` (misses value params and some locals CLion finds) |
| Type can be replaced with auto | `modernize-use-auto` |
| Possibly unused #include directive | `misc-include-cleaner` — but ONLY the "included header X **is not used directly**" lines; the "no header providing …" lines are IWYU strictness CLion does not flag, and tidy misses CLion's transitive-removability findings entirely |

**`wasm_bindings.cpp` needs its own invocation, and nothing else reaches
it.** It is in no CMake target and no compile database, so neither the gate
nor SonarLint nor Inspect Code has anything to analyse it with — see the
`getDiagnostics` section in `CLAUDE.md`. Target wasm32 against the emsdk
sysroot, isolated from the MSVC headers: without `-nostdinc -nostdinc++`
the driver mixes the two and buries the output under `typedef redefinition`
errors from `bits/alltypes.h`.

```powershell
$sr = "<emsdk>\upstream\emscripten\cache\sysroot"
& $tidy "--checks=-*,modernize-use-auto,misc-const-correctness,modernize-use-designated-initializers" `
  "--header-filter=.*a-star.*" --quiet wasm_bindings.cpp -- `
  -std=c++23 -D__EMSCRIPTEN__ -fno-exceptions `
  --target=wasm32-unknown-emscripten "--sysroot=$sr" -nostdinc -nostdinc++ `
  "-isystem$sr\include\c++\v1" "-isystem$sr\include\compat" "-isystem$sr\include" -I.
```

The `--header-filter` matters here: this is the only way headers reached
solely from a wasm TU get analysed at all (`MemoryProbe.h`'s emscripten
branch, for one).

Everything else in the checklist has no tidy equivalent — it must be
right when written, or found via Inspect Code in the IDE.

Notes on `--fix`: it does not reformat, so long lines must be re-wrapped
to the repo's ~80 columns by hand afterward, and it writes `.x=x` — the
repo style is `.x = x`.

## SonarLint (S-rules) — the other focused-file-only findings

SonarLint's C++ rules arrive through the same IDE bridge (`getDiagnostics`,
focused file only) and are equally invisible to the clang-tidy gate. The
recurring ones, measured on the SolverArms.cpp cleanup (2026-07-29), with
the idiom that satisfies them:

- **Cognitive complexity ≤ 25 per function** and **nesting ≤ 3**
  (if|for|do|while|switch). Extract helpers; a heavily-stateful function
  wants a small class (see `ChunkedAlternation`) — parameters become
  members, its lambdas become methods. Lambdas RESET the nesting counter,
  so folding an inner loop body into a named local lambda fixes a depth-4
  chain — but lambda bodies still count toward the enclosing function's
  cognitive complexity, so for complexity use free functions instead.
- **≤ 7 parameters.** Bundle the plumbing every call shares into a context
  struct (`SplitContext`) and the per-call knobs into an options struct
  (`ChunkOptions`); reference members in an aggregate are fine. **When any
  argument has a side effect** — `placeBlock(…, rng.uniform(…),
  rng.uniform(…), …)` in `GenerateCommands.cpp` — bundle only the *pure*
  arguments (there, `minX`/`maxX` → one `XRange`, landing on exactly 7).
  Argument evaluation order is unspecified but in practice fixed per
  compiler, whereas a braced-init-list is guaranteed left-to-right: moving
  rng draws into one reorders them and silently changes every generated
  fixture. Verify with the oracle the feature already has — regenerate
  `bench/fuzz-7007-hard.json` (and a goal + a mixed board) and hash-compare
  against the checked-in file.
- **Lambdas ≤ 20 lines** — make them named functions or methods. And no
  redundant `-> type` on a lambda whose return type is deduced anyway.
- **Explicitly capture scope variables** in lambdas passed to other
  functions — `[&puzzle, &dist, extraWalls]`, not `[&]`. Purely local
  lambdas may keep `[&]`.
- **Loop conditions stay pure counter checks** (S1994): no `&& !flag`
  smuggled into a `for` condition — use a helper with early return (an
  INDEX loop; a range-based bool loop trips the gate's
  `readability-use-anyofallof` instead) or restructure.
- **Loop stop conditions must be invariant** — `i < v.size()` where the body
  can rewrite `v` is "Refactor this loop so that it is less error-prone",
  even when the body `return`s immediately after touching it. Cache the
  bound (`const size_t count = v.size();`) and say in a comment why that is
  still correct.
- **No `for (i = 0; i < v.size(); i++)` over a vector the body grows** —
  the hand-rolled BFS queue. Sonar reads it as a raw loop it wants
  range-based (which would be an iterator-invalidation bug) *and* as
  "error-prone". Use `std::queue` with `while (!q.empty()) { const auto cur
  = q.front(); q.pop(); … }`; traversal order is identical FIFO, and for
  precompute the deque allocations do not show up (measured on
  `fillClassClusterTable`: suite time unchanged). When the vector is an
  arena the code must keep (parent chains for path reconstruction), keep the
  arena and make the queue a separate cursor of indices into it (see
  `Reconnector` in `AStarOptimizer.cpp`).
- **`std::byte` for byte-oriented bit twiddling** — packing bits into a
  `uint8_t` is flagged; use `std::byte packed{}` with `packed |= std::byte{1}
  << bit`. Convert back with `std::to_integer<char>(packed)`, NOT
  `static_cast<char>` — a cast from an enum type to something other than its
  underlying type trips the `std::to_underlying` rule instead.
- **String-keyed `unordered_map`/`unordered_set` want a transparent
  hasher** — `std::unordered_set<std::string, StringHash, std::equal_to<>>`
  with `struct StringHash { using is_transparent [[maybe_unused]] = void;
  size_t operator()(std::string_view) const noexcept; }`. The
  `[[maybe_unused]]` is required: only the container reads the alias, so
  CLion otherwise reports "type alias is never used". A `const std::string &`
  parameter compared against such keys becomes `std::string_view` (callers
  passing a `stateKey(…)` temporary stay safe — it outlives the call).
- **≤ 1 nested `break`** per loop — extraction into functions turns the
  inner breaks into returns.
- **`using enum X;`** when a scope repeats `X::` several times.
- **`std::to_underlying`** (C++23, `<utility>`) when casting an enum to an
  integral type that is not its underlying type — `kInverse[
  std::to_underlying(dir)]`, not `static_cast<size_t>(dir)`. **When the
  value is being STREAMED, keep an outer `static_cast<int>`** — the rule
  asks for an "intermediary", not a replacement. Most enums here are
  `: uint8_t`, and `ostream << uint8_t` prints the CHARACTER with that
  code: swapping `static_cast<int>(outcome.status)` for a bare
  `std::to_underlying(...)` in a gtest failure message turns "status 2"
  into an invisible control byte, and no test fails to tell you (measured
  2026-08-02 on `fixtures_test.cpp`). Write
  `static_cast<int>(std::to_underlying(e))`.
- **No C-style arrays** — `constexpr auto k = std::to_array<T>({…})` keeps
  designated initializers and needs no element count.
- **Moves must be noexcept** (S5018) for types stored in vectors: a
  `boost::dynamic_bitset<>` member makes the implicit move non-noexcept,
  so declare the rule of five with `noexcept = default` moves (plus a
  converting ctor, since the type is no longer an aggregate).
- **`operator<` on a comparison key wants `operator<=>`** — even when the
  only consumer is a `std::set` (which rewrites `<` from it). Defaulting it
  fails if any member lacks `<=>`: `boost::dynamic_bitset<>` has only the
  relational operators, so return `std::strong_ordering` and spell that
  member's half out from the same `<` the old operator used (`<compare>`).
  `std::array` does have `<=>`, so `poses <=> other.poses` is enough.
- **A generic `throw std::runtime_error` is S112** — derive a named
  exception (`class FixtureError final : public std::runtime_error { using
  std::runtime_error::runtime_error; };`). Keeping `std::runtime_error` as
  the base leaves every `catch (const std::exception &)` site unchanged.
- **A `for` loop whose body also advances the counter** is "Refactor this
  loop so that it is less error-prone" — the argv walk where an option
  consumes the next element. Move the index into a cursor object
  (`ArgCursor` in `BenchOptions.h` and in the rolling-blocks `main.cpp`) and
  drive it from a `while`.
- **If-init statements**: a local used only by the following `if` goes
  into it (same as the CLion inspection above; Sonar flags it too).
- **No nested conditional operators** (S3358) — a ternary inside another
  ternary's branch, including one hidden in a call argument:
  `opts.width > 0 ? opts.width : rng.uniform(4, cluster ? 6 : 10)`. Lift
  the inner one into a named local. **Lift only the PURE part.** In
  `GenerateCommands.cpp` the inner `cluster ? 6 : 10` is a constant and
  safe to name, but hoisting the enclosing `rng.uniform(…)` would draw a
  number even when the caller pinned that dimension — changing every board
  generated with `--width`/`--height`/`--symbols`. Same family of trap as
  the argument-bundling one above: verify by regenerating fixtures across
  several seeds AND one fully-pinned case, then hash-compare.
- **Catch a specific exception, not `std::exception`** — enumerate what the
  callee actually throws and catch those by name. `fixtureio::load` raises
  exactly `FixtureError` and `nlohmann::json::exception`, so `loadFixture`
  in match-three's `main.cpp` catches the two and shares one local lambda
  for the report-and-emit. Narrowing a catch is a behaviour change: drive
  every failure path once afterward (missing file, malformed document,
  out-of-range value) and confirm each still reports.
- **A `const std::string &` parameter that is only compared** becomes
  `std::string_view` — not just the ones feeding a transparent container
  (`stochastic(name)` in `fixtures_test.cpp`).

Traps when fixing Sonar findings — the clang-tidy gate watches the same
code:

- Extracting a returned local? Do NOT declare it `const` — that blocks
  NRVO/auto-move and `performance-no-automatic-move` fails the build.
- A new `const` member function returning a value wants `[[nodiscard]]`
  (`modernize-use-nodiscard`).
- `push_back(T(…))` on a fresh temporary must be `emplace_back(…)`
  (`modernize-use-emplace`).
- Refactors here are behavior-preserving only if verified: run the wasm
  build (clang), the native Ninja build (gate), and the fixture suite
  before trusting a restructuring of measured solver code.

## The SonarCloud quality gate — read this BEFORE adding a solver

The gate is on **new** code only, and four of its five conditions are ratings
that ordinary care keeps at A. The fifth is the one that fails, and it fails
almost every time a solver page lands:

```
new_duplicated_lines_density   must be <= 3%
```

Measured on PR #42 (the logic-grid solver): **3.7%**, from 374 duplicated new
lines. Every one of them is infrastructure this repo duplicates ON PURPOSE, one
copy per solver:

| file | dup lines | why there are four copies |
|---|---|---|
| `a-star/MemoryProbe.h` | 168 | verbatim; only the `RB_`/`MT_` macro prefix and a `const auto` differ |
| `wasmBridge.ts` | 85 | the worker race, copied per page |
| `wasm/astar.worker.js` | 39 | hand-written worker, reached page-relative from its own `*-wasm/` dir |
| `a-star/Budget.h` | 38 | genuinely diverged — logic-grid's carries progress publishing |
| `util/buildWasm.ts` | 32 | the four-variant block per solver |
| `a-star/test/fixtures_test.cpp` | 12 | the corpus sweep |

**Do not "fix" this by extracting the C++ into a shared directory.** `CLAUDE.md`
is explicit that each `src/pages/*/a-star` stays independently configurable
because CLion's profiles point straight at it, and `buildWasm.ts` hashes every
`*.h` in that directory's ROOT for the rebuild stamp — a header moved out of it
would stop invalidating the wasm when it changed, which is a silently stale
binary. The TS side is different: `src/util/` already holds shared code and the
repo has extracted there before (`editorShell.ts`, `configFile.ts`,
`configValidation.ts`, when the fifth editor pushed this same gate over).

So the options, in order:

1. **Extract on the TS side only**, and migrate EVERY copy in the same change.
   Migrating one leaves the new shared file duplicating the copies left behind —
   which scores the same, because the shared file is new code.
2. **Declare the deliberate copies.** `sonar.cpd.exclusions` is what it is for,
   and **`.sonarcloud.properties`** at the repo root carries it for the three
   files the architecture forces to be duplicated, with the reasoning and with a
   note on what is deliberately left counted.
   **The filename is the whole trick.** This project runs SonarCloud *automatic
   analysis*, which reads `.sonarcloud.properties`. A `sonar-project.properties`
   is the CLI scanner's filename — automatic analysis ignores it in silence, so
   the gate simply stays red with no hint that the file was never read. Measured
   on PR #42: identical content under the wrong name changed nothing (3.7% then
   3.5%, the drop being unrelated edits).
   If it still does not take, the same value can be set in the UI —
   *Administration → Analysis Scope → Duplication Exclusions* — but prefer the
   file, because the reasoning lives next to it.
3. **Accept the failure and say so in the PR.** Legitimate when the duplication
   really is the architecture, but it stops being legitimate the moment someone
   stops reading the number.

Whichever route, check the actual figures rather than guessing — the gate and
the per-file breakdown are public for a public project:

```bash
curl -s "https://sonarcloud.io/api/qualitygates/project_status?projectKey=Valle12_islands-of-insight-tools&pullRequest=<N>"
curl -s "https://sonarcloud.io/api/measures/component_tree?component=Valle12_islands-of-insight-tools&pullRequest=<N>&metricKeys=new_duplicated_lines,new_lines&qualifiers=FIL&ps=300"
curl -s "https://sonarcloud.io/api/issues/search?componentKeys=Valle12_islands-of-insight-tools&pullRequest=<N>&resolved=false&ps=100"
```

Note the JSON shape: a measure's value for a PR is in `periods[0].value`, NOT
`value` — reading `value` returns nothing and looks like "no duplication".

## Known intentional findings — leave them

- `MemoryProbe.h`'s two Windows findings, both required by the Win32 API:
  `cpp:S954` (move the `#include`s to the top) cannot be obeyed — `Windows.h`
  has to follow the `WIN32_LEAN_AND_MEAN` define and `Psapi.h` has to follow
  `Windows.h`; and `cpp:S3630` (replace `reinterpret_cast`) is the documented
  calling convention for `GetProcessMemoryInfo`, which takes a
  `PROCESS_MEMORY_COUNTERS *` and is handed the `_EX` form on purpose. Both are
  commented in the file.
- `#include <yvals_core.h>` under `#ifdef __clang__` in the gtest TUs is
  the clang+MSVC-STL `__cpp_lib_is_pointer_interconvertible` workaround.
  Removing it breaks the clang-tidy gate's parse of gtest headers.
- Includes that ARE used but only under `#ifdef __EMSCRIPTEN_PTHREADS__`
  look unused to the native indexer — keep them inside the `#ifdef`
  (see `SolverArms.cpp`) so both tools agree.
- `int main(const int argc, char **argv)` — const-correctness wants the
  pointee const, but `char **argv` is the only portably guaranteed main
  signature; leave it.
- `NodeKey.h`'s std includes (`<cstddef>` etc.): flagged as transitively
  removable, but every one declares symbols the header genuinely uses and
  no project header guarantees them — removing would be include-what-you-
  use-incorrect. Leave them.
- `<cstddef>` in the logic-grid `Rules.cpp`, `Search.cpp`, `Types.h` and
  `test/reference_test.cpp`: reported as possibly unused because
  `<array>`/`<vector>` drag it in, but every one names `size_t`
  (`Rules.cpp` as `template <std::size_t N>`, `Types.h` in `slot()`). Same
  rule as `NodeKey.h` below — `misc-include-cleaner` agrees and does not
  flag them. `Profile.cpp` was in this list until its `Frontier::closed`
  became a `std::byte`; it now uses the header unambiguously and is no
  longer reported.
- `<system_error>` in the logic-grid `main.cpp`: flagged, but `readNumber`
  compares against `std::errc{}`, whose header this is. Note that
  `misc-include-cleaner` is NO help here — under the MSVC STL it also
  reports `<charconv>` and `<string_view>` in the same file, both of which
  it plainly uses (`std::from_chars`, `std::string_view`), so its verdict on
  that TU carries no information either way.
- **`static_cast<size_t>(hash)` in the logic-grid `Profile.cpp`'s
  `FrontierHash::hashOf`** — reported as a redundant cast, and it is
  redundant on the native build alone. `hash` is a `uint64_t` because FNV-1a
  is a 64-bit mix, and `size_t` is 32 bits under wasm32, where the cast is
  the truncation the function means. Dropping it makes it an implicit
  narrowing that only the native reader sees as a no-op.
- `<cmath>` in the match-three `SearchGreedy.cpp` and `SearchNrpa.cpp`:
  flagged as possibly unused, but both call `std::exp` — it only *looks*
  removable because `SeededRng.h` drags `<random>` in. Same rule as
  `NodeKey.h` above: a std include whose symbols the file genuinely uses
  stays, whatever happens to arrive transitively today.
- Match-three `SearchProver.cpp` has NO `#include "Rules.h"` while its
  three sibling arms do. That is deliberate, not an oversight: `Search.h`
  stopped including `Rules.h` (it used nothing from it), the other three
  arms gained a direct include, and this one already has `ForcedClear.h`,
  whose interface takes a `rules::SymbolCounts &` and so genuinely
  guarantees it. Adding a second route would be the finding, not the fix.
- **`cpp:S1144` "unused member function `operator=`"** on a rule-of-five
  block written for S5018 (`StateKey` in `SolverArms.cpp`). The five are
  declared together only to force the moves `noexcept` — a
  `boost::dynamic_bitset<>` member otherwise costs the implicit move its
  noexcept — and the keys are only ever move-CONSTRUCTED into the
  `std::set`, so the move assignment really is uncalled. Sonar can prove it
  because the struct sits in an anonymous namespace. Deleting just that one
  breaks the rule of five and, since a user-declared move constructor
  deletes the implicit copies, leaves the type unassignable by any route.
  The clang-tidy profile does not enable
  `cppcoreguidelines-special-member-functions`, so nothing forces the
  matter either way: two analyzers want opposite things over a 2-minute
  smell. Leave the five intact — the noexcept guarantee is load-bearing,
  the unused operator is not.
