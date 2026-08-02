#include "Rules.h"

#include "Types.h"

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <utility>

namespace lg::rules {
namespace {

/// A pattern from a fixed list of cells.
///
/// `Pattern::cells` is sized for the LONGEST pattern any rule needs, so a
/// shorter list cannot simply be assigned to it — the two array types differ.
/// Copying in keeps every pattern written as a plain list of its own cells,
/// and the static assert is what turns "this pattern outgrew the array" into a
/// compile error rather than a silent truncation.
template <std::size_t N>
Pattern fromCells(const std::array<PatternCell, N> &cells) {
  static_assert(N <= kMaxPatternCells, "pattern longer than kMaxPatternCells");
  Pattern pattern;
  pattern.count = static_cast<int>(N);
  std::ranges::copy(cells, pattern.cells.begin());
  return pattern;
}

/// A straight run of `length` cells of one colour, laid along (stepX, stepY).
Pattern runPattern(const int length, const uint8_t color, const int stepX,
                   const int stepY) {
  Pattern pattern;
  pattern.count = length;
  for (int i = 0; i < length; i++) {
    pattern.cells[slot(i)] = {.dx = static_cast<int8_t>(stepX * i),
                              .dy = static_cast<int8_t>(stepY * i),
                              .color = color};
  }
  return pattern;
}

/// The shortest run of `color` this rule set forbids, or 0 when runs of that
/// colour are unconstrained. A board that forbids dark pairs already forbids
/// every longer dark run, so only the shortest one is worth laying out.
int shortestRun(const RuleMask mask, const uint8_t color) {
  // Every run rule is spelled out. This means "the family of run rules", and a
  // family that computes its members instead of listing them silently stops
  // covering the next one appended to the catalogue.
  using enum Rule;
  if (has(mask, color == kDark ? NoDark1x2 : NoLight1x2))
    return 2;
  if (has(mask, color == kDark ? NoDark1x3 : NoLight1x3))
    return 3;
  if (has(mask, color == kDark ? NoDark1x4 : NoLight1x4))
    return 4;
  if (has(mask, color == kDark ? NoDark1x5 : NoLight1x5))
    return 5;
  return 0;
}

void addRuns(const RuleMask mask, const uint8_t color, Patterns &into) {
  const int length = shortestRun(mask, color);
  if (length == 0)
    return;
  into.emplace_back(runPattern(length, color, 1, 0));
  into.emplace_back(runPattern(length, color, 0, 1));
}

Pattern squarePattern(const uint8_t color) {
  return fromCells(std::to_array<PatternCell>({
      {.dx = 0, .dy = 0, .color = color},
      {.dx = 1, .dy = 0, .color = color},
      {.dx = 0, .dy = 1, .color = color},
      {.dx = 1, .dy = 1, .color = color},
  }));
}

/// A 2x2 whose main diagonal is `color` and whose anti-diagonal is the other.
Pattern checkerPattern(const uint8_t color) {
  return fromCells(std::to_array<PatternCell>({
      {.dx = 0, .dy = 0, .color = color},
      {.dx = 1, .dy = 1, .color = color},
      {.dx = 1, .dy = 0, .color = opposite(color)},
      {.dx = 0, .dy = 1, .color = opposite(color)},
  }));
}

} // namespace

const char *name(const Rule rule) {
  // In index order, mirroring RULES in rules.ts exactly.
  constexpr auto kNames = std::to_array<const char *>({
      "no-dark-2x2",
      "no-light-2x2",
      "no-dark-1x2",
      "no-light-1x2",
      "no-dark-1x3",
      "no-light-1x3",
      "no-dark-1x4",
      "no-light-1x4",
      "no-dark-1x5",
      "no-light-1x5",
      "no-checkerboard",
      "connect-dark",
      "connect-light",
      "one-symbol-dark",
      "one-symbol-light",
      "underclued",
  });
  static_assert(kNames.size() == kRuleCount,
                "every rule needs its id, in index order");
  return kNames[slot(std::to_underlying(rule))];
}

Patterns patternsFor(const RuleMask mask) {
  using enum Rule;
  Patterns patterns;
  if (has(mask, NoDark2x2))
    patterns.emplace_back(squarePattern(kDark));
  if (has(mask, NoLight2x2))
    patterns.emplace_back(squarePattern(kLight));

  addRuns(mask, kDark, patterns);
  addRuns(mask, kLight, patterns);

  // The checkerboard lemma, which is why BOTH connect rules together imply the
  // checkerboard patterns even when the board never asked for them. Suppose a
  // 2x2 held one; join its two dark corners by a dark path and its two light
  // corners by a light path, then close each with the diagonal it spans. The
  // two closed curves meet exactly once — where the diagonals cross — and no
  // dark cell is a light cell, so nowhere else. A pair of closed curves in the
  // plane cannot cross an odd number of times, so one of the two paths does not
  // exist and one of the two rules is broken.
  if (has(mask, NoCheckerboard) ||
      (has(mask, ConnectDark) && has(mask, ConnectLight))) {
    patterns.emplace_back(checkerPattern(kDark));
    patterns.emplace_back(checkerPattern(kLight));
  }
  return patterns;
}

} // namespace lg::rules
