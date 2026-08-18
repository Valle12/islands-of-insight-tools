#pragma once

// Must be the FIRST include in every test TU — the fix below only works before
// the MSVC STL is pulled in.
//
// clangd (CLion's C++ engine) trips over MSVC's <utility> when it advertises
// P1328 support: clang does not implement the
// __builtin_is_pointer_interconvertible_* intrinsics the MSVC STL then reaches
// for, so gtest's headers fail to parse and the clang-tidy gate cannot lint
// these files at all. Only the IDE analyzer and the gate are affected — MSVC
// and GCC compile the same code either way.
//
// Two guards, both load-bearing:
//   * _MSC_VER as well as __clang__ narrows this to clangd-against-the-MSVC-STL,
//     the only case that needs it. Bare __clang__ would also catch em++, whose
//     own <yvals_core.h> shim is an #include_next that finds nothing and hard
//     errors.
//   * the inner #ifdef, because only MSVC's STL defines the macro — undefining
//     one that was never defined is what cpp:S959 flags, and the sibling
//     solvers' copies (match-three and logic-grid TestBoards.h) already guard
//     it this way.
#if defined(__clang__) && defined(_MSC_VER)
#include <yvals_core.h>
#ifdef __cpp_lib_is_pointer_interconvertible
#undef __cpp_lib_is_pointer_interconvertible
#endif
#endif
