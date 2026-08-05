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

/**
 * The shortest run of `color` that is forbidden once IMPLICATIONS are folded in.
 *
 * An area rule forbids a run one longer than its number, since a line of N+1
 * cells is one region of N+1. So the straight shapes an area rule rules out come
 * out of `addRuns` rather than being laid out a second time beside the bent
 * ones — and a duplicate clause would not merely be dead weight, it would make
 * `GenerateCommands::cost()` score one broken straight as two.
 *
 * Kept OUT of `shortestRun` deliberately: that ladder means "the family of run
 * rules", and it has two mirrors — `kRunRules` in Verify.cpp and `RUN_RULES` in
 * verify.ts — which have to keep meaning the same thing. This is a derived fact,
 * like the checkerboard lemma below, and derived facts live on this side.
 */
int impliedRun(const RuleMask mask, const uint8_t color) {
  const int direct = shortestRun(mask, color);
  // The SMALLEST active area, because the rules are conjunctive: with both
  // sizes on, the shorter forbidden run wins and subsumes the longer one.
  const int area = smallestGlobalArea(mask, color);
  if (area == 0)
    return direct;
  return direct == 0 ? area + 1 : std::min(direct, area + 1);
}

void addRuns(const RuleMask mask, const uint8_t color, Patterns &into) {
  const int length = impliedRun(mask, color);
  if (length == 0)
    return;
  into.emplace_back(runPattern(length, color, 1, 0));
  into.emplace_back(runPattern(length, color, 0, 1));
}

/// The four bent trominoes: a 2x2 box with one corner left out, once per corner.
std::array<Pattern, 4> bentPatterns(const uint8_t color) {
  const auto box = std::to_array<PatternCell>({
      {.dx = 0, .dy = 0, .color = color},
      {.dx = 1, .dy = 0, .color = color},
      {.dx = 0, .dy = 1, .color = color},
      {.dx = 1, .dy = 1, .color = color},
  });
  std::array<Pattern, 4> out{};
  for (int omit = 0; omit < 4; omit++) {
    auto &[cells, count] = out[slot(omit)];
    for (int i = 0; i < 4; i++) {
      if (i == omit)
        continue;
      cells[slot(count)] = box[slot(i)];
      count++;
    }
  }
  return out;
}

/**
 * The half of an area rule this table can carry: no region BIGGER than the
 * number. A connected set of three or more cells always contains a connected
 * three, so for an area of TWO, forbidding every tromino says exactly that.
 *
 * Only for two, and the asymmetry is deliberate. The same argument at four asks
 * for every connected FIVE — the 61 non-straight fixed pentominoes, since the
 * straight one is `addRuns`'s — which is roughly 15 000 clause instances per
 * colour on the largest board against the trominoes' 1 200, and every one of
 * them is rescanned whenever a square it names is decided. `regionArea` in
 * `Propagate.cpp` enforces both halves at any size for the cost of a component
 * walk, so four is left entirely to it while two keeps the cheap table it was
 * measured with. What neither size gets from this table is the other half of
 * the rule, that no region is SMALLER than the number.
 */
void addAreaShapes(const RuleMask mask, const uint8_t color, Patterns &into) {
  if (smallestGlobalArea(mask, color) != 2)
    return;
  // The straight pair came from `addRuns`. The bent four go the same way when
  // pairs of this colour are forbidden outright, since every one contains a
  // pair — and then nothing of this colour can be coloured at all.
  if (impliedRun(mask, color) == 2)
    return;
  for (const Pattern &pattern : bentPatterns(color))
    into.emplace_back(pattern);
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

/// A line of three alternating colours — `color`, the other, `color` again —
/// laid along (stepX, stepY). The colour the rule's id names first is the one
/// at both ENDS.
Pattern triplePattern(const uint8_t color, const int stepX, const int stepY) {
  const auto cell = [](const int dx, const int dy, const uint8_t held) {
    return PatternCell{.dx = static_cast<int8_t>(dx),
                       .dy = static_cast<int8_t>(dy),
                       .color = held};
  };
  return fromCells(std::to_array({cell(0, 0, color),
                                  cell(stepX, stepY, opposite(color)),
                                  cell(stepX * 2, stepY * 2, color)}));
}

void addTriples(const RuleMask mask, const uint8_t color, Patterns &into) {
  using enum Rule;
  if (!has(mask, color == kDark ? NoDarkLightDark : NoLightDarkLight))
    return;
  into.emplace_back(triplePattern(color, 1, 0));
  into.emplace_back(triplePattern(color, 0, 1));
}

/// The four rotations of the T-tetromino: a bar of three with a fourth cell on
/// the middle's other side. Offsets stay non-negative like every pattern here,
/// so each rotation is anchored at its own bounding box's top-left.
std::array<Pattern, 4> teePatterns(const uint8_t color) {
  const auto cell = [color](const int dx, const int dy) {
    return PatternCell{.dx = static_cast<int8_t>(dx),
                       .dy = static_cast<int8_t>(dy),
                       .color = color};
  };
  return {
      fromCells(std::to_array({cell(0, 0), cell(1, 0), cell(2, 0), cell(1, 1)})),
      fromCells(std::to_array({cell(1, 0), cell(0, 1), cell(1, 1), cell(2, 1)})),
      fromCells(std::to_array({cell(0, 0), cell(0, 1), cell(1, 1), cell(0, 2)})),
      fromCells(std::to_array({cell(1, 0), cell(0, 1), cell(1, 1), cell(1, 2)})),
  };
}

/**
 * The T rules — subsumed when a run of three or shorter is already forbidden
 * for the colour, because every T contains a straight three. Instances that
 * cannot fire first would be worse than dead weight: `GenerateCommands::cost()`
 * counts violated clauses, so one broken bar would score twice — the same bias
 * the run and area dedup above guards against. `impliedRun` already folds an
 * area of two in (it implies a run of three), so one comparison covers both
 * subsumers. Nothing subsumes the triples: they name both colours.
 */
void addTees(const RuleMask mask, const uint8_t color, Patterns &into) {
  using enum Rule;
  if (!has(mask, color == kDark ? NoDarkT : NoLightT))
    return;
  if (const int run = impliedRun(mask, color); run != 0 && run <= 3)
    return;
  for (const Pattern &pattern : teePatterns(color))
    into.emplace_back(pattern);
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
      "area-two-dark",
      "area-two-light",
      "area-four-dark",
      "area-four-light",
      "area-five-dark",
      "area-five-light",
      "no-dark-light-dark",
      "no-light-dark-light",
      "no-dark-t",
      "no-light-t",
  });
  static_assert(kNames.size() == kRuleCount,
                "every rule needs its id, in index order");
  return kNames[slot(std::to_underlying(rule))];
}

int smallestGlobalArea(const RuleMask mask, const uint8_t color) {
  int smallest = 0;
  for (const auto &[rule, ruleColor, area] : kAreaFamily) {
    if (ruleColor != color || !has(mask, rule))
      continue;
    if (smallest == 0 || area < smallest)
      smallest = area;
  }
  return smallest;
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

  addAreaShapes(mask, kDark, patterns);
  addAreaShapes(mask, kLight, patterns);

  addTriples(mask, kDark, patterns);
  addTriples(mask, kLight, patterns);

  addTees(mask, kDark, patterns);
  addTees(mask, kLight, patterns);

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
