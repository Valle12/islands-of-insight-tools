#pragma once

// Every test TU includes this FIRST: the clang-against-MSVC-STL workaround
// below has to precede any standard-library header, and the board notation the
// suites share is what the rest of the file carries.
#ifdef __clang__
#include <yvals_core.h>
// Only MSVC's STL defines this, and only there does clang need it gone.
#ifdef __cpp_lib_is_pointer_interconvertible
#undef __cpp_lib_is_pointer_interconvertible
#endif
#endif

#include "Types.h"

#include <cstdint>
#include <string>
#include <vector>

namespace mt::test {

/// Boards are written as rows top to bottom: '.' empty, '#' blocked, and a
/// letter per symbol index — the same notation the TypeScript tests use.
inline Board board(const std::vector<std::string> &rows) {
  Board result;
  result.height = static_cast<int>(rows.size());
  result.width = static_cast<int>(rows.front().size());
  for (int y = 0; y < result.height; y++) {
    for (int x = 0; x < result.width; x++) {
      const char glyph = rows[static_cast<size_t>(y)][static_cast<size_t>(x)];
      const size_t at = flat(result.width, x, y);
      if (glyph == '#')
        result.cells[at] = kBlocked;
      else if (glyph != '.')
        result.cells[at] = static_cast<uint8_t>(kFirstSymbol + (glyph - 'a'));
    }
  }
  return result;
}

/// The inverse of `board`, so an expectation can be written as a picture.
inline std::vector<std::string> draw(const Board &value) {
  std::vector<std::string> rows;
  rows.reserve(static_cast<size_t>(value.height));
  for (int y = 0; y < value.height; y++) {
    std::string row;
    for (int x = 0; x < value.width; x++) {
      if (const uint8_t cell = value.at(x, y); cell == kEmpty)
        row.push_back('.');
      else if (cell == kBlocked)
        row.push_back('#');
      else
        row.push_back(static_cast<char>('a' + cell - kFirstSymbol));
    }
    rows.push_back(row);
  }
  return rows;
}

} // namespace mt::test
