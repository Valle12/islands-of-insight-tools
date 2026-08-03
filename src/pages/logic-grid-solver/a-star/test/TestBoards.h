#pragma once

// clang parsing the MSVC STL trips over gtest's pointer-interconvertible
// detection; undefining the feature macro before any standard header is the
// workaround, and it is why this file is included FIRST by every test TU.
// Emscripten is clang too but ships libc++, which has no such header — and the
// bench harness does compile this file with em++.
#if defined(__clang__) && !defined(__EMSCRIPTEN__)
#include <yvals_core.h>
#ifdef __cpp_lib_is_pointer_interconvertible
#undef __cpp_lib_is_pointer_interconvertible
#endif
#endif

#include "Puzzle.h"
#include "Rules.h"
#include "Types.h"

#include <cstdint>
#include <string>
#include <utility>
#include <vector>

namespace lg::test {

/**
 * A puzzle from a picture, one string per row:
 *
 *   '.'      an uncoloured cell        '#'      a gap in the board
 *   'D'/'L'  a cell already painted    '1'-'9'  an area number
 *   'a'-'z'  a letter clue
 *
 * A clue always lands on an uncoloured cell, which is the colourless clue the
 * game actually shows. Area numbers past nine need `withClue`.
 */
inline Puzzle board(const std::vector<std::string> &rows,
                    const rules::RuleMask mask = 0) {
  Puzzle puzzle;
  puzzle.height = static_cast<int>(rows.size());
  puzzle.width = rows.empty() ? 0 : static_cast<int>(rows.front().size());
  puzzle.ruleMask = mask;
  puzzle.givens.fill(kUnplayable);

  for (int y = 0; y < puzzle.height; y++) {
    const std::string &row = rows[slot(y)];
    for (int x = 0; x < puzzle.width; x++) {
      const char glyph = row[slot(x)];
      const int index = cellIndex(x, y);
      if (glyph == '#')
        continue;
      puzzle.givens[slot(index)] = kUnknown;
      if (glyph == 'D')
        puzzle.givens[slot(index)] = kDark;
      else if (glyph == 'L')
        puzzle.givens[slot(index)] = kLight;
      else if (glyph >= '1' && glyph <= '9')
        puzzle.clues.push_back({.index = index,
                                .kind = kClueArea,
                                .value = glyph - '0'});
      else if (glyph >= 'a' && glyph <= 'z')
        puzzle.clues.push_back({.index = index,
                                .kind = kClueLetter,
                                .value = glyph - 'a'});
    }
  }
  return puzzle;
}

/// Adds an area number too big to write in a picture.
inline void withClue(Puzzle &puzzle, const int x, const int y,
                     const int value) {
  puzzle.clues.push_back(
      {.index = cellIndex(x, y), .kind = kClueArea, .value = value});
}

/**
 * Puts a dart on a cell. A second call rather than a glyph, for the same reason
 * `withShape` is one: the picture's alphabet is spoken for, and a dart carries
 * two things rather than one.
 *
 * `direction` is `kDirUp`, `kDirRight`, `kDirDown` or `kDirLeft`.
 */
inline void withDart(Puzzle &puzzle, const int x, const int y, const int value,
                     const int direction) {
  puzzle.clues.push_back({.index = cellIndex(x, y),
                          .kind = kClueDart,
                          .value = value,
                          .direction = direction});
}

/**
 * Fuses squares into one merged cell. A second call rather than a glyph: the
 * picture's alphabet is entirely spoken for, and a shape needs to say which
 * squares go together rather than just that a square is in one.
 */
inline void withShape(Puzzle &puzzle,
                      const std::vector<std::pair<int, int>> &squares) {
  std::vector<int> shape;
  shape.reserve(squares.size());
  for (const auto &[x, y] : squares)
    shape.push_back(cellIndex(x, y));
  puzzle.shapes.push_back(std::move(shape));
}

/// Paints a cell that already carries a clue — the picture cannot say both.
inline void withGiven(Puzzle &puzzle, const int x, const int y,
                      const uint8_t color) {
  puzzle.givens[slot(cellIndex(x, y))] = color;
}

/// A colouring as a picture: 'D' dark, 'L' light, '.' undecided, '#' a gap.
inline std::vector<std::string> draw(const Model &model,
                                     const Colors &colors) {
  std::vector<std::string> rows;
  for (int y = 0; y < model.height(); y++) {
    std::string row;
    for (int x = 0; x < model.width(); x++) {
      if (const uint8_t color = colors[slot(cellIndex(x, y))]; color == kDark)
        row.push_back('D');
      else if (color == kLight)
        row.push_back('L');
      else if (color == kUnplayable)
        row.push_back('#');
      else
        row.push_back('.');
    }
    rows.push_back(row);
  }
  return rows;
}

/// A colouring from a picture: the inverse of `draw`. Anything that is not
/// 'D', 'L' or '#' is an undecided cell.
inline Colors colors(const std::vector<std::string> &rows) {
  Colors out{};
  out.fill(kUnplayable);
  for (size_t y = 0; y < rows.size(); y++) {
    const std::string &row = rows[y];
    for (size_t x = 0; x < row.size(); x++) {
      const char glyph = row[x];
      const int index =
          cellIndex(static_cast<int>(x), static_cast<int>(y));
      if (glyph == '#')
        continue;
      if (glyph == 'D')
        out[slot(index)] = kDark;
      else if (glyph == 'L')
        out[slot(index)] = kLight;
      else
        out[slot(index)] = kUnknown;
    }
  }
  return out;
}

/// The rule mask for a list of rules, which reads better than shifting bits in
/// every test.
inline rules::RuleMask ruleSet(const std::vector<rules::Rule> &active) {
  rules::RuleMask mask = 0;
  for (const rules::Rule rule : active)
    mask |= rules::bit(rule);
  return mask;
}

} // namespace lg::test
