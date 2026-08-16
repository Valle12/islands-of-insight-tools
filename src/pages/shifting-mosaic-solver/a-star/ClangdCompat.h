#pragma once

// Must be the FIRST include in any translation unit that uses it — the fix
// below only works before the MSVC STL is pulled in.
//
// clangd (CLion's C++ engine) trips over MSVC's <utility> when it advertises
// P1328 support: _Is_pointer_address_convertible fails to fold to a constant,
// and every std::pair comparison, std::vector<Position> equality and gtest
// TEST_P registration in the file reports a phantom "must be initialized by a
// constant expression" error. Only the IDE analyser is affected — MSVC, GCC
// and emscripten all compile the same code.
//
// Requiring _MSC_VER as well narrows this to clangd-against-the-MSVC-STL,
// which is the only case that needs it. That matters because AStar.cpp is also
// compiled by em++, whose clang defines __clang__ with no MSVC STL underneath:
// emscripten's own <yvals_core.h> shim is an #include_next that finds nothing
// and hard-errors.
#if defined(__clang__) && defined(_MSC_VER)
#include <yvals_core.h>
// Only MSVC's STL defines it; undefining a macro that was never defined is
// what cpp:S959 flags, and the sibling solvers' copies already guard it.
#ifdef __cpp_lib_is_pointer_interconvertible
#undef __cpp_lib_is_pointer_interconvertible
#endif
#endif
