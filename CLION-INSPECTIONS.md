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
  `std::function(lambda)`. Not applicable when the element type must
  differ from the literals (`std::array<int8_t, 4>`).
- **Redundant parameter list in lambda declarator** — `[&] {` not
  `[&]() {`.
- **Redundant cast expression** — never cast to the value's own type.
- **Designated initializers can be used** — brace-init aggregates by
  member name: `{.blockId = id, .direction = dir}`. Style is `.x = x`
  (spaces), wrap at ~80 columns.
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
& $tidy -p cmake-build-release-visual-studio `
  "--checks=-*,modernize-use-designated-initializers,misc-const-correctness,modernize-use-auto,misc-include-cleaner" `
  "--header-filter=.*a-star.*" --extra-arg=-EHsc --extra-arg-before=--driver-mode=cl <files>
```

| CLion inspection | clang-tidy check |
|---|---|
| Designated initializers can be used | `modernize-use-designated-initializers` |
| Local variable / parameter can be made const | `misc-const-correctness` (misses value params and some locals CLion finds) |
| Type can be replaced with auto | `modernize-use-auto` |
| Possibly unused #include directive | `misc-include-cleaner` — but ONLY the "included header X **is not used directly**" lines; the "no header providing …" lines are IWYU strictness CLion does not flag, and tidy misses CLion's transitive-removability findings entirely |

Everything else in the checklist has no tidy equivalent — it must be
right when written, or found via Inspect Code in the IDE.

Notes on `--fix`: it does not reformat, so long lines must be re-wrapped
to the repo's ~80 columns by hand afterwards, and it writes `.x=x` — the
repo style is `.x = x`.

## Known intentional findings — leave them

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
