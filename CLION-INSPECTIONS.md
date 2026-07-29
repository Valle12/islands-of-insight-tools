# CLion inspections the automated gates do NOT catch

The clang-tidy build gate (`cmake/ClangTidyGate.cmake`) and the IDE MCP
bridge (`getDiagnostics` = SonarLint, focused file only) both miss CLion's
own "Project Default" inspections. They only show up in **Code → Inspect
Code…** inside CLion, so check for these patterns while WRITING C++ —
retrofitting them later means a manual IDE pass.

## Headless equivalents (run these before handing code over)

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
| Local variable / parameter can be made const | `misc-const-correctness` |
| Type can be replaced with auto | `modernize-use-auto` |
| Possibly unused #include directive | `misc-include-cleaner` — but ONLY the "included header X **is not used directly**" lines; the "no header providing …" lines are IWYU strictness CLion does not flag |

Notes on `--fix`: it does not reformat, so long lines must be re-wrapped
to the repo's ~80 columns by hand afterwards, and it writes `.x=x` — the
repo style is `.x = x`.

## CLion-only — check by eye while writing

- **Structured bindings can be used** — `pair`/`tuple`/aggregate returns
  unpacked via `.first`/`.second` or repeated member access.
- **Variable can be made constexpr** — compile-time-known locals declared
  `const`.
- **Variable can be moved to init statement** — declare inside
  `if (auto x = …; cond)` when only used there.
- **Variable can be moved to inner scope** — declarations hoisted above
  the only block that uses them.
- **Template arguments can be deduced** — spell `std::array kDirs{…}` /
  `std::pair key{a, b}` instead of listing arguments CTAD infers. (Not
  applicable when the element type must differ from the literals, e.g.
  `std::array<int8_t, 4>`.)
- **Redundant parameter list in lambda declarator** — write `[&] {` not
  `[&]() {`.
- **Redundant cast expression** — casts to the value's own type.
- **Entity can have internal linkage** — file-local free
  functions/globals belong in an anonymous namespace.
- **Declarator is never used** — dead locals; MSVC and the tidy profile
  are both quiet about these.

## Known intentional findings — leave them

- `#include <yvals_core.h>` under `#ifdef __clang__` in the gtest TUs is
  the clang+MSVC-STL `__cpp_lib_is_pointer_interconvertible` workaround.
  CLion may flag it as possibly unused; removing it breaks the clang-tidy
  gate's parse of gtest headers.
- Includes that ARE used but only under `#ifdef __EMSCRIPTEN_PTHREADS__`
  look unused to the native indexer — keep them inside the `#ifdef`
  (see `SolverArms.cpp`) so both tools agree.
- `int main(const int argc, char **argv)` — const-correctness wants the
  pointee const, but `char **argv` is the only portably guaranteed main
  signature; leave it.
