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

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <utility>
#include <vector>

namespace lg::test {

/**
 * Aborts on a mask naming a RETIRED bit. Since format version 2 the sized
 * rules are instances (`withAreaRule` / `withRunRule` below) and since version
 * 3 the ten rarest arrangements are drawn patterns (`withPattern`); the engine
 * no longer reads either family's mask bits, so a test that smuggled one in
 * would compile, constrain nothing, and stay green forever. Louder than
 * `assert` on purpose: Release defines NDEBUG, which compiles an assert out,
 * and this header also builds under em++'s -fno-exceptions, which rules a
 * `throw` out.
 */
inline rules::RuleMask flagsOnly(const rules::RuleMask mask) {
  if ((mask & rules::kSizedRuleBits) != 0) {
    std::fputs("TestBoards: a sized rule has no mask bit any more — use "
               "withAreaRule / withRunRule\n",
               stderr);
    std::abort();
  }
  if ((mask & rules::kDrawnRuleBits) != 0) {
    std::fputs("TestBoards: a retired arrangement has no mask bit any more — "
               "use withPattern\n",
               stderr);
    std::abort();
  }
  return mask;
}

/**
 * A puzzle from a picture, one string per row:
 *
 *   '.'      an uncolored cell        '#'      a gap in the board
 *   'D'/'L'  a cell already painted    '1'-'9'  an area number
 *   'a'-'z'  a letter clue
 *
 * A clue always lands on an uncolored cell, which is the colorless clue the
 * game actually shows. Area numbers past nine need `withClue`.
 */
inline Puzzle board(const std::vector<std::string> &rows,
                    const rules::RuleMask mask = 0) {
  Puzzle puzzle;
  puzzle.height = static_cast<int>(rows.size());
  puzzle.width = rows.empty() ? 0 : static_cast<int>(rows.front().size());
  puzzle.ruleMask = flagsOnly(mask);
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
 * Puts a lotus on a cell: a symmetry clue carrying an axis rather than a
 * value. `axis` is `kAxisHorizontal`, `kAxisDiagonalDown`, `kAxisVertical` or
 * `kAxisDiagonalUp`; `seat` shifts the axis point half a square right (bit 0)
 * and down (bit 1), which is how one sits on a merged cell's grid lines.
 */
inline void withLotus(Puzzle &puzzle, const int x, const int y, const int axis,
                      const int seat = 0) {
  puzzle.clues.push_back({.index = cellIndex(x, y),
                          .kind = kClueLotus,
                          .value = 0,
                          .direction = axis,
                          .seat = seat});
}

/**
 * Puts a viewpoint on a cell: a counting clue with no direction at all — its
 * number is its own square plus the leading same-color run along each of the
 * four rays. The `Clue` default direction is left standing, which is exactly
 * what `clueValueProblem` ignoring it exists to allow.
 */
inline void withViewpoint(Puzzle &puzzle, const int x, const int y,
                          const int value) {
  puzzle.clues.push_back(
      {.index = cellIndex(x, y), .kind = kClueViewpoint, .value = value});
}

/**
 * Puts a galaxy on a cell: a symmetry clue with no value and no direction.
 * `seat` shifts its center half a square right (bit 0) and down (bit 1), which
 * is how one sits on a grid line or a corner — and unlike a lotus's it needs
 * no merged cell under it. The `Clue` default direction is left standing,
 * exactly as the viewpoint's is.
 */
inline void withGalaxy(Puzzle &puzzle, const int x, const int y,
                       const int seat = 0) {
  puzzle.clues.push_back(
      {.index = cellIndex(x, y), .kind = kClueGalaxy, .seat = seat});
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

/// Adds one area instance — every region of `color` has exactly `size` cells.
/// Inserted in canonical order the way intake demands, so calls may layer in
/// any order a test finds readable.
inline void withAreaRule(Puzzle &puzzle, const uint8_t color, const int size) {
  const rules::SizedRule rule{.color = color, .value = size};
  puzzle.areas.insert(
      std::ranges::lower_bound(puzzle.areas, rule, rules::sizedLess), rule);
}

/// Adds one run instance — no straight run of `length` cells of `color`.
inline void withRunRule(Puzzle &puzzle, const uint8_t color,
                        const int length) {
  const rules::SizedRule rule{.color = color, .value = length};
  puzzle.runs.insert(
      std::ranges::lower_bound(puzzle.runs, rule, rules::sizedLess), rule);
}

/**
 * A forbidden arrangement from a picture, one string per row of the box:
 *
 *   '.'  a square the pattern does not name
 *   'D'  a square that must be dark      'L'  a square that must be light
 *
 * The same spelling `kLegacyPatterns` uses, so a shape reads the same in a
 * test as it does in the catalog.
 */
/// The color one character of a picture names: 'D' dark, 'L' light, and
/// anything else a square the pattern says nothing about.
inline uint8_t patternSquare(const char square) {
  if (square == 'D')
    return kDark;
  if (square == 'L')
    return kLight;
  return kUnknown;
}

inline rules::DrawnPattern pattern(const std::vector<std::string> &picture) {
  rules::DrawnPattern drawn;
  drawn.height = static_cast<int>(picture.size());
  drawn.width = picture.empty() ? 0 : static_cast<int>(picture.front().size());
  for (const std::string &row : picture) {
    for (const char square : row)
      drawn.cells.push_back(patternSquare(square));
  }
  return drawn;
}

/// Adds one drawn pattern. Inserted in canonical order the way intake demands,
/// so calls may layer in any order a test finds readable.
inline void withPattern(Puzzle &puzzle, const rules::DrawnPattern &drawn) {
  puzzle.patterns.insert(std::ranges::lower_bound(puzzle.patterns, drawn,
                                                  rules::patternLess),
                         drawn);
}

/// A coloring as a picture: 'D' dark, 'L' light, '.' undecided, '#' a gap.
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

/// A coloring from a picture: the inverse of `draw`. Anything that is not
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
/// every test. Flags only — a sized rule aborts via `flagsOnly`, because its
/// bit would otherwise ride along constraining nothing.
inline rules::RuleMask ruleSet(const std::vector<rules::Rule> &active) {
  rules::RuleMask mask = 0;
  for (const rules::Rule rule : active)
    mask |= rules::bit(rule);
  return flagsOnly(mask);
}

} // namespace lg::test
