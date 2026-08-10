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

/// The smallest value among `color`'s instances, or 0 when it has none — the
/// one reducer both sized families share. Sound because instances are
/// conjunctive: the smallest area caps growth hardest, and the shortest
/// forbidden run subsumes every longer one.
int smallestValue(const std::vector<SizedRule> &instances,
                  const uint8_t color) {
  int smallest = 0;
  for (const auto &[ruleColor, value] : instances) {
    if (ruleColor != color)
      continue;
    if (smallest == 0 || value < smallest)
      smallest = value;
  }
  return smallest;
}

/// The shortest run of `color` these instances forbid, or 0 when runs of that
/// colour are unconstrained. A board that forbids dark pairs already forbids
/// every longer dark run, so only the shortest one is worth laying out.
int shortestRun(const std::vector<SizedRule> &runs, const uint8_t color) {
  return smallestValue(runs, color);
}

/// The rule inputs the sized-aware builders read together. The flag mask
/// alone no longer describes a puzzle's rules, and threading three arguments
/// through every gate is how one of them gets dropped.
struct Active {
  RuleMask mask = 0;
  const std::vector<SizedRule> &areas;
  const std::vector<SizedRule> &runs;
};

/**
 * The shortest run of `color` that is forbidden once IMPLICATIONS are folded in.
 *
 * An area instance forbids a run one longer than its number, since a line of
 * N+1 cells is one region of N+1. So the straight shapes an area rules out come
 * out of `addRuns` rather than being laid out a second time beside the bent
 * ones — and a duplicate clause would not merely be dead weight, it would make
 * `GenerateCommands::cost()` score one broken straight as two.
 *
 * Kept OUT of `shortestRun` deliberately: that reducer means "the run family
 * itself", whose two mirrors — `runProblem` in Verify.cpp and in verify.ts —
 * walk the same instance lists and have to keep meaning the same thing. This
 * is a derived fact, like the checkerboard lemma below, and derived facts live
 * on this side.
 */
int impliedRun(const Active &active, const uint8_t color) {
  const int direct = shortestRun(active.runs, color);
  // The SMALLEST active area, because the instances are conjunctive: with both
  // sizes on, the shorter forbidden run wins and subsumes the longer one.
  const int area = smallestArea(active.areas, color);
  if (area == 0)
    return direct;
  return direct == 0 ? area + 1 : std::min(direct, area + 1);
}

/// Whether `color`'s distance rule — two of it exactly two apart in a straight
/// line — is active. Asked by several builders below, since a straight three's
/// END cells are exactly such a pair: any pattern containing one is subsumed.
bool hasDistanceRule(const RuleMask mask, const uint8_t color) {
  using enum Rule;
  return has(mask, color == kDark ? NoDarkAnyDark : NoLightAnyLight);
}

/// Whether `color`'s elbow rule is active — the bent tromino as its own rule,
/// the same four shapes an area of two contributes.
bool hasElbowRule(const RuleMask mask, const uint8_t color) {
  using enum Rule;
  return has(mask, color == kDark ? NoDarkElbow : NoLightElbow);
}

/**
 * Whether connect(color) and the colour's elbow ban are both on — the
 * combination that pins every PAIR of the colour to one row or column.
 *
 * The lemma, in the checkerboard lemma's style: two cells of the colour lie in
 * one region, so a simple 4-connected path of the colour joins them; if they
 * differ in both coordinates the path turns somewhere, and the turn's three
 * cells are a playable bent tromino of the colour — which the elbow rule
 * forbids. Holds with gaps (the path routes around them and still turns on
 * playable cells) and with merged cells (arrangement rules count squares, and
 * a bent merged cell contains the same tromino).
 */
bool collinearColour(const RuleMask mask, const uint8_t color) {
  using enum Rule;
  return has(mask, color == kDark ? ConnectDark : ConnectLight) &&
         hasElbowRule(mask, color);
}

/**
 * The colour's corner-touch ban, direct or implied: `addCollinearPairs` lays
 * the diagonal pairs among its off-axis family, so every subsumption gate that
 * used to ask for the diagonal RULE asks this instead — under either source
 * the two-cell clause exists and fires before the larger shape could.
 */
bool hasDiagonalBan(const RuleMask mask, const uint8_t color) {
  using enum Rule;
  return has(mask, color == kDark ? NoDarkDiagonal : NoLightDiagonal) ||
         collinearColour(mask, color);
}

void addRuns(const Active &active, const uint8_t color, Patterns &into) {
  const int length = impliedRun(active, color);
  if (length == 0)
    return;
  // An implied run the table cannot hold — any area of eight or more, whose
  // implied run outgrows `kMaxPatternCells` — is skipped rather than laid
  // out: `runPattern` writes `cells[i]` with no bound of its own, and
  // dropping a clause only under-prunes, since `regionArea` enforces every
  // area size whole. A DIRECT run instance can never take this branch — the
  // intake cap is `kMaxRunLength = kMaxPatternCells` precisely because this
  // table is the only thing enforcing a run.
  if (length > kMaxPatternCells)
    return;
  // A run of three or more contains its end cells two apart, so the distance
  // rule's two-cell clause fires on every instance first. A domino does not —
  // adjacent is distance one — so length two stays.
  if (length >= 3 && hasDistanceRule(active.mask, color))
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
 * the rule, that no region is SMALLER than the number. The SMALLEST instance
 * is the right one to ask about: any smaller cap forbids trominoes just as
 * hard, and an area of ONE forbids pairs outright — its implied run of two,
 * which subsumes the trominoes below.
 */
void addAreaShapes(const Active &active, const uint8_t color, Patterns &into) {
  if (smallestArea(active.areas, color) != 2)
    return;
  // The straight pair came from `addRuns`. The bent four go the same way when
  // pairs of this colour are forbidden outright, since every one contains a
  // pair — and then nothing of this colour can be coloured at all.
  if (impliedRun(active, color) == 2)
    return;
  // A bent tromino contains a corner touch, so the corner-touch ban's
  // two-cell clause fires before any tromino instance could — while the
  // straight three stays with `addRuns`, which a diagonal pair says nothing
  // about.
  if (hasDiagonalBan(active.mask, color))
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
  // The triple's two ENDS are the colour, two apart, and the distance rule
  // does not care what sits between them — its two-cell clause fires on every
  // instance first. The first subsumer the triples ever had: nothing else
  // names both colours at once.
  if (hasDistanceRule(mask, color))
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
void addTees(const Active &active, const uint8_t color, Patterns &into) {
  using enum Rule;
  const RuleMask mask = active.mask;
  if (!has(mask, color == kDark ? NoDarkT : NoLightT))
    return;
  if (const int run = impliedRun(active, color); run != 0 && run <= 3)
    return;
  // A T's stem touches both of the bar's end cells corner to corner, so the
  // corner-touch ban's two-cell clause fires before any T instance could.
  if (hasDiagonalBan(mask, color))
    return;
  // A T contains a bent tromino (a bar end, the middle and the stem) and its
  // bar's ends sit two apart, so the elbow and distance rules subsume it too.
  if (hasElbowRule(mask, color) || hasDistanceRule(mask, color))
    return;
  for (const Pattern &pattern : teePatterns(color))
    into.emplace_back(pattern);
}

/// The four ways a 2x2 can hold three of `color` and one of the other: the odd
/// cell takes each corner in turn.
std::array<Pattern, 4> threeOnePatterns(const uint8_t color) {
  const auto box = std::to_array<PatternCell>({
      {.dx = 0, .dy = 0, .color = color},
      {.dx = 1, .dy = 0, .color = color},
      {.dx = 0, .dy = 1, .color = color},
      {.dx = 1, .dy = 1, .color = color},
  });
  std::array<Pattern, 4> out{};
  for (int odd = 0; odd < 4; odd++) {
    auto &[cells, count] = out[slot(odd)];
    for (int i = 0; i < 4; i++) {
      cells[slot(count)] = box[slot(i)];
      if (i == odd)
        cells[slot(count)].color = opposite(color);
      count++;
    }
  }
  return out;
}

/**
 * The 3+1 rules — a 2x2 holding three of the colour and one of the other.
 *
 * Subsumed three ways, each because the three majority cells alone already
 * break a stronger clause in the table: they always contain an orthogonal
 * pair, they ARE a bent tromino, and they always contain a diagonally
 * adjacent pair. The area gate is `== 2` exactly, not "2 or 3": an area of
 * THREE puts no trominoes in the table, and a bent tromino of the colour can
 * be a complete legal region of three with the fourth cell the other colour —
 * which only this rule forbids. As with the T, an instance that cannot fire
 * first would double-score one broken shape in `GenerateCommands::cost()`.
 */
void addThreeOnes(const Active &active, const uint8_t color, Patterns &into) {
  using enum Rule;
  const RuleMask mask = active.mask;
  if (!has(mask, color == kDark ? NoThreeDarkOneLight : NoThreeLightOneDark))
    return;
  if (impliedRun(active, color) == 2)
    return;
  if (smallestArea(active.areas, color) == 2)
    return;
  if (hasDiagonalBan(mask, color))
    return;
  // The three majority cells ARE a bent tromino, so the colour's elbow rule
  // fires first — and the odd cell is the corner of a majority-other-majority
  // elbow, so that mixed rule does too. The OTHER mixed elbow does not: its
  // ends would be the odd colour, of which this shape holds only one.
  if (hasElbowRule(mask, color) ||
      has(mask, color == kDark ? NoDarkLightDarkElbow : NoLightDarkLightElbow))
    return;
  for (const Pattern &pattern : threeOnePatterns(color))
    into.emplace_back(pattern);
}

/// The two ways one colour can touch corner to corner: the falling diagonal of
/// a 2x2 and the rising one. Two cells each — the first patterns whose cells
/// are not orthogonally contiguous, which the compiler never required:
/// contiguity is a region concept, and a pattern is just a list of offsets.
std::array<Pattern, 2> diagonalPatterns(const uint8_t color) {
  const auto cell = [color](const int dx, const int dy) {
    return PatternCell{.dx = static_cast<int8_t>(dx),
                       .dy = static_cast<int8_t>(dy),
                       .color = color};
  };
  return {
      fromCells(std::to_array({cell(0, 0), cell(1, 1)})),
      fromCells(std::to_array({cell(1, 0), cell(0, 1)})),
  };
}

/// The diagonal rules — never subsumed: the only other two-cell patterns are
/// the orthogonal pairs, and a straight pair contains no corner touch. Several
/// LARGER shapes contain one, and each of those is dropped at its own builder
/// when a diagonal rule is active.
void addDiagonals(const RuleMask mask, const uint8_t color, Patterns &into) {
  using enum Rule;
  if (!has(mask, color == kDark ? NoDarkDiagonal : NoLightDiagonal))
    return;
  for (const Pattern &pattern : diagonalPatterns(color))
    into.emplace_back(pattern);
}

/**
 * The elbow rules — the four bent trominoes standing alone. Subsumed exactly
 * where `addAreaShapes`' trominoes are: a forbidden pair (every bent tromino
 * contains one) and the colour's diagonal rule (its ends touch corner to
 * corner). The third gate is the DEDUP: at a smallest area of exactly two,
 * `addAreaShapes` lays out these identical four — and only at two, because an
 * area of three leaves a bent region of three perfectly legal, which is what
 * the elbow rule alone forbids.
 */
void addElbows(const Active &active, const uint8_t color, Patterns &into) {
  const RuleMask mask = active.mask;
  if (!hasElbowRule(mask, color))
    return;
  if (impliedRun(active, color) == 2)
    return;
  // Direct diagonal rule OR the collinear family this very rule helps switch
  // on: under connect(colour) the off-axis pairs subsume every bent tromino,
  // so the elbow's own shapes would only double-score a broken pair.
  if (hasDiagonalBan(mask, color))
    return;
  if (smallestArea(active.areas, color) == 2)
    return;
  for (const Pattern &pattern : bentPatterns(color))
    into.emplace_back(pattern);
}

/// The eight fixed L-tetrominoes: a straight three with a foot perpendicular
/// at one end — four rotations in BOTH handednesses, each anchored at its
/// bounding box's top-left like every pattern here.
std::array<Pattern, 8> ellPatterns(const uint8_t color) {
  const auto cell = [color](const int dx, const int dy) {
    return PatternCell{.dx = static_cast<int8_t>(dx),
                       .dy = static_cast<int8_t>(dy),
                       .color = color};
  };
  return {
      fromCells(std::to_array({cell(0, 0), cell(0, 1), cell(0, 2), cell(1, 2)})),
      fromCells(std::to_array({cell(1, 0), cell(1, 1), cell(1, 2), cell(0, 2)})),
      fromCells(std::to_array({cell(0, 0), cell(1, 0), cell(0, 1), cell(0, 2)})),
      fromCells(std::to_array({cell(0, 0), cell(1, 0), cell(1, 1), cell(1, 2)})),
      fromCells(std::to_array({cell(0, 0), cell(1, 0), cell(2, 0), cell(2, 1)})),
      fromCells(std::to_array({cell(0, 0), cell(1, 0), cell(2, 0), cell(0, 1)})),
      fromCells(std::to_array({cell(2, 0), cell(0, 1), cell(1, 1), cell(2, 1)})),
      fromCells(std::to_array({cell(0, 0), cell(0, 1), cell(1, 1), cell(2, 1)})),
  };
}

/**
 * The L rules. Every L contains a straight three (its bar), a bent tromino
 * (its foot's corner), a corner touch, a pair two apart (the bar's ends) and a
 * knight's move (the foot to the bar's far end) — so each of those rules
 * subsumes it. A smallest area of three or less does too: an L is a connected
 * FOUR, which `regionArea` refuses at every complete assignment. An area of
 * four does not — an L-shaped region of exactly four is legal under it, and
 * only this rule forbids the shape.
 */
void addElls(const Active &active, const uint8_t color, Patterns &into) {
  using enum Rule;
  const RuleMask mask = active.mask;
  if (!has(mask, color == kDark ? NoDarkEll : NoLightEll))
    return;
  if (const int run = impliedRun(active, color); run != 0 && run <= 3)
    return;
  if (hasElbowRule(mask, color))
    return;
  if (const int area = smallestArea(active.areas, color);
      area != 0 && area <= 3)
    return;
  if (hasDiagonalBan(mask, color))
    return;
  if (hasDistanceRule(mask, color))
    return;
  if (has(mask, color == kDark ? NoDarkKnight : NoLightKnight))
    return;
  for (const Pattern &pattern : ellPatterns(color))
    into.emplace_back(pattern);
}

/// The two ways one colour can sit exactly two apart in a straight line. Only
/// the END cells are named — whatever lies between, the other colour or even a
/// gap, is no part of the pattern, which is what makes the ban purely
/// positional and lets the clause fire ACROSS a gap.
std::array<Pattern, 2> distancePatterns(const uint8_t color) {
  const auto cell = [color](const int dx, const int dy) {
    return PatternCell{.dx = static_cast<int8_t>(dx),
                       .dy = static_cast<int8_t>(dy),
                       .color = color};
  };
  return {
      fromCells(std::to_array({cell(0, 0), cell(2, 0)})),
      fromCells(std::to_array({cell(0, 0), cell(0, 2)})),
  };
}

/// The distance rules — never subsumed, like the diagonals: the only other
/// two-cell patterns name adjacent, diagonal or knight-offset cells, none of
/// which is a straight two apart.
void addDistancePairs(const RuleMask mask, const uint8_t color,
                      Patterns &into) {
  if (!hasDistanceRule(mask, color))
    return;
  for (const Pattern &pattern : distancePatterns(color))
    into.emplace_back(pattern);
}

/// The four rotations of the T-pentomino: a bar of three with a stem of TWO
/// from its middle.
std::array<Pattern, 4> longTeePatterns(const uint8_t color) {
  const auto cell = [color](const int dx, const int dy) {
    return PatternCell{.dx = static_cast<int8_t>(dx),
                       .dy = static_cast<int8_t>(dy),
                       .color = color};
  };
  return {
      fromCells(std::to_array(
          {cell(0, 0), cell(1, 0), cell(2, 0), cell(1, 1), cell(1, 2)})),
      fromCells(std::to_array(
          {cell(1, 0), cell(1, 1), cell(0, 2), cell(1, 2), cell(2, 2)})),
      fromCells(std::to_array(
          {cell(0, 0), cell(0, 1), cell(0, 2), cell(1, 1), cell(2, 1)})),
      fromCells(std::to_array(
          {cell(2, 0), cell(0, 1), cell(1, 1), cell(2, 1), cell(2, 2)})),
  };
}

/**
 * The long-T rules. A long T contains a plain T (bar plus the stem's first
 * cell), an L (its stem line plus one bar end), and everything an L contains —
 * so every gate the L has applies, plus the T rule itself. The area gate
 * reaches four here: a long T is a connected FIVE, which a smallest area of
 * four or less refuses at every complete assignment through `regionArea`.
 */
void addLongTees(const Active &active, const uint8_t color, Patterns &into) {
  using enum Rule;
  const RuleMask mask = active.mask;
  if (!has(mask, color == kDark ? NoDarkLongT : NoLightLongT))
    return;
  if (has(mask, color == kDark ? NoDarkT : NoLightT))
    return;
  if (const int run = impliedRun(active, color); run != 0 && run <= 3)
    return;
  if (hasElbowRule(mask, color))
    return;
  if (has(mask, color == kDark ? NoDarkEll : NoLightEll))
    return;
  if (const int area = smallestArea(active.areas, color);
      area != 0 && area <= 4)
    return;
  if (hasDiagonalBan(mask, color))
    return;
  if (hasDistanceRule(mask, color))
    return;
  if (has(mask, color == kDark ? NoDarkKnight : NoLightKnight))
    return;
  for (const Pattern &pattern : longTeePatterns(color))
    into.emplace_back(pattern);
}

/// The four ways one colour can sit a knight's move apart: four patterns cover
/// all eight directions unordered, the diagonal pair's trick again. Two of
/// them anchor with their FIRST cell off the bounding box's top-left corner,
/// which `instantiate` has always supported — the rising diagonal is prior
/// art — and the shape tests pin against a normalising refactor.
std::array<Pattern, 4> knightPatterns(const uint8_t color) {
  const auto cell = [color](const int dx, const int dy) {
    return PatternCell{.dx = static_cast<int8_t>(dx),
                       .dy = static_cast<int8_t>(dy),
                       .color = color};
  };
  return {
      fromCells(std::to_array({cell(0, 0), cell(1, 2)})),
      fromCells(std::to_array({cell(1, 0), cell(0, 2)})),
      fromCells(std::to_array({cell(0, 0), cell(2, 1)})),
      fromCells(std::to_array({cell(2, 0), cell(0, 1)})),
  };
}

/// The knight rules — never subsumed: no other pattern names two cells a
/// knight's move apart and nothing smaller fits inside a two-cell pattern.
void addKnights(const RuleMask mask, const uint8_t color, Patterns &into) {
  using enum Rule;
  if (!has(mask, color == kDark ? NoDarkKnight : NoLightKnight))
    return;
  for (const Pattern &pattern : knightPatterns(color))
    into.emplace_back(pattern);
}

/// The four rotations of a T whose CROSSING — the bar's middle, where the stem
/// attaches — holds the other colour while the three remaining cells hold
/// `color`. The same cells as `teePatterns`, with one colour flipped.
std::array<Pattern, 4> mixedTeePatterns(const uint8_t color) {
  const uint8_t other = opposite(color);
  const auto cell = [](const int dx, const int dy, const uint8_t held) {
    return PatternCell{.dx = static_cast<int8_t>(dx),
                       .dy = static_cast<int8_t>(dy),
                       .color = held};
  };
  return {
      fromCells(std::to_array({cell(0, 0, color), cell(1, 0, other),
                               cell(2, 0, color), cell(1, 1, color)})),
      fromCells(std::to_array({cell(1, 0, color), cell(0, 1, color),
                               cell(1, 1, other), cell(2, 1, color)})),
      fromCells(std::to_array({cell(0, 0, color), cell(0, 1, other),
                               cell(1, 1, color), cell(0, 2, color)})),
      fromCells(std::to_array({cell(1, 0, color), cell(0, 1, color),
                               cell(1, 1, other), cell(1, 2, color)})),
  };
}

/**
 * The mixed-T rules — `color` is the ARMS' colour, the one the rule's id names
 * last. Subsumed by the arms' triple rule (the bar IS colour-other-colour),
 * the arms' distance rule (the bar's ends are two apart), the arms' diagonal
 * rule (the stem touches both bar ends corner to corner), and the mixed elbow
 * whose ends are the arms' colour (one bar end, the crossing and the stem are
 * exactly that elbow).
 */
void addMixedTees(const RuleMask mask, const uint8_t color, Patterns &into) {
  using enum Rule;
  if (!has(mask, color == kDark ? NoLightCrossedDarkT : NoDarkCrossedLightT))
    return;
  if (has(mask, color == kDark ? NoDarkLightDark : NoLightDarkLight))
    return;
  if (hasDistanceRule(mask, color))
    return;
  if (hasDiagonalBan(mask, color))
    return;
  if (has(mask, color == kDark ? NoDarkLightDarkElbow : NoLightDarkLightElbow))
    return;
  for (const Pattern &pattern : mixedTeePatterns(color))
    into.emplace_back(pattern);
}

/// The four orientations of a bent tromino whose CORNER — the square touching
/// both others — holds the other colour while both ends hold `color`.
std::array<Pattern, 4> mixedElbowPatterns(const uint8_t color) {
  const uint8_t other = opposite(color);
  const auto cell = [](const int dx, const int dy, const uint8_t held) {
    return PatternCell{.dx = static_cast<int8_t>(dx),
                       .dy = static_cast<int8_t>(dy),
                       .color = held};
  };
  return {
      fromCells(std::to_array(
          {cell(0, 0, other), cell(1, 0, color), cell(0, 1, color)})),
      fromCells(std::to_array(
          {cell(0, 0, color), cell(1, 0, other), cell(1, 1, color)})),
      fromCells(std::to_array(
          {cell(0, 0, color), cell(0, 1, other), cell(1, 1, color)})),
      fromCells(std::to_array(
          {cell(1, 0, color), cell(0, 1, color), cell(1, 1, other)})),
  };
}

/// The mixed-elbow rules — `color` is the ENDS' colour. Subsumed only by that
/// colour's corner-touch ban: its two ends ARE a diagonal pair, and nothing
/// else in the table fits inside three cells of two colours.
void addMixedElbows(const RuleMask mask, const uint8_t color, Patterns &into) {
  using enum Rule;
  if (!has(mask, color == kDark ? NoDarkLightDarkElbow : NoLightDarkLightElbow))
    return;
  if (hasDiagonalBan(mask, color))
    return;
  for (const Pattern &pattern : mixedElbowPatterns(color))
    into.emplace_back(pattern);
}

/**
 * The collinearity lemma compiled — see `collinearColour` for the proof. Every
 * OFF-AXIS pair of the colour is forbidden: {(0,0),(dx,dy)} for the falling
 * orientations and {(dx,0),(0,dy)} for the rising ones, dx and dy positive.
 * Like the distance pair, only the two END squares are named, so the clause is
 * purely positional and fires across gaps — and two off-axis squares of one
 * merged cell collapse to a unit clause, which is exactly right: a bent cell
 * of the colour would contain the forbidden tromino all by itself.
 *
 * Dedup, not subsumption: the (1,1) members are the diagonal patterns and the
 * (1,2)/(2,1) members the knight patterns, so where those RULES are on their
 * own builders lay the pair and this one skips it — a clause laid twice would
 * double-score one broken pair in `GenerateCommands::cost()`. Nothing subsumes
 * the family: no other clause fits inside two cells.
 */
void addCollinearPairs(const RuleMask mask, const uint8_t color,
                       Patterns &into) {
  using enum Rule;
  if (!collinearColour(mask, color))
    return;
  const bool diagonals =
      has(mask, color == kDark ? NoDarkDiagonal : NoLightDiagonal);
  const bool knights =
      has(mask, color == kDark ? NoDarkKnight : NoLightKnight);
  const auto cell = [color](const int dx, const int dy) {
    return PatternCell{.dx = static_cast<int8_t>(dx),
                       .dy = static_cast<int8_t>(dy),
                       .color = color};
  };
  for (int dy = 1; dy < kMaxSide; dy++) {
    for (int dx = 1; dx < kMaxSide; dx++) {
      if (diagonals && dx == 1 && dy == 1)
        continue;
      if (knights && ((dx == 1 && dy == 2) || (dx == 2 && dy == 1)))
        continue;
      into.emplace_back(fromCells(std::to_array({cell(0, 0), cell(dx, dy)})));
      into.emplace_back(fromCells(std::to_array({cell(dx, 0), cell(0, dy)})));
    }
  }
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
      "no-three-dark-one-light",
      "no-three-light-one-dark",
      "no-dark-diagonal",
      "no-light-diagonal",
      "area-three-dark",
      "area-three-light",
      "off-by-one",
      "no-dark-elbow",
      "no-light-elbow",
      "no-dark-l",
      "no-light-l",
      "no-dark-any-dark",
      "no-light-any-light",
      "area-six-dark",
      "area-six-light",
      "area-seven-dark",
      "area-seven-light",
      "no-light-crossed-dark-t",
      "no-dark-crossed-light-t",
      "no-dark-long-t",
      "no-light-long-t",
      "area-twenty-four-dark",
      "area-twenty-four-light",
      "no-dark-knight",
      "no-light-knight",
      "no-dark-light-dark-elbow",
      "no-light-dark-light-elbow",
  });
  static_assert(kNames.size() == kRuleCount,
                "every rule needs its id, in index order");
  return kNames[slot(std::to_underlying(rule))];
}

int smallestArea(const std::vector<SizedRule> &areas, const uint8_t color) {
  return smallestValue(areas, color);
}

SplitRules splitLegacyMask(const RuleMask mask) {
  SplitRules split;
  split.flags = mask & ~kSizedRuleBits;
  for (const auto &[rule, sized] : kLegacyAreas) {
    if (has(mask, rule))
      split.areas.push_back(sized);
  }
  for (const auto &[rule, sized] : kLegacyRuns) {
    if (has(mask, rule))
      split.runs.push_back(sized);
  }
  // The tables run dark,light per size in ENUM order, so a straight collection
  // is deduplicated (each bit appears once) but not sorted. Sorting draws no
  // randomness, which is what lets the generator canonicalise after its rng
  // decisions without moving a single seed.
  std::ranges::sort(split.areas, sizedLess);
  std::ranges::sort(split.runs, sizedLess);
  return split;
}

Patterns patternsFor(const RuleMask mask, const std::vector<SizedRule> &areas,
                     const std::vector<SizedRule> &runs) {
  using enum Rule;
  const Active active{.mask = mask, .areas = areas, .runs = runs};
  Patterns patterns;
  // A monochrome 2x2 contains a corner touch of its own colour and any three
  // of its squares are a bent tromino, so under that colour's corner-touch
  // ban or elbow rule a smaller clause always fires first.
  if (has(mask, NoDark2x2) && !hasDiagonalBan(mask, kDark) &&
      !hasElbowRule(mask, kDark))
    patterns.emplace_back(squarePattern(kDark));
  if (has(mask, NoLight2x2) && !hasDiagonalBan(mask, kLight) &&
      !hasElbowRule(mask, kLight))
    patterns.emplace_back(squarePattern(kLight));

  addRuns(active, kDark, patterns);
  addRuns(active, kLight, patterns);

  addAreaShapes(active, kDark, patterns);
  addAreaShapes(active, kLight, patterns);

  addTriples(mask, kDark, patterns);
  addTriples(mask, kLight, patterns);

  addTees(active, kDark, patterns);
  addTees(active, kLight, patterns);

  addThreeOnes(active, kDark, patterns);
  addThreeOnes(active, kLight, patterns);

  addDiagonals(mask, kDark, patterns);
  addDiagonals(mask, kLight, patterns);

  addElbows(active, kDark, patterns);
  addElbows(active, kLight, patterns);

  addElls(active, kDark, patterns);
  addElls(active, kLight, patterns);

  addDistancePairs(mask, kDark, patterns);
  addDistancePairs(mask, kLight, patterns);

  // The mixed pairs take the colour of what the shape holds THREE of — the
  // arms, and the elbow's two ends.
  addMixedTees(mask, kDark, patterns);
  addMixedTees(mask, kLight, patterns);

  addLongTees(active, kDark, patterns);
  addLongTees(active, kLight, patterns);

  addKnights(mask, kDark, patterns);
  addKnights(mask, kLight, patterns);

  addMixedElbows(mask, kDark, patterns);
  addMixedElbows(mask, kLight, patterns);

  // The collinearity lemma — connect(colour) + the colour's elbow ban pin the
  // whole colour to one row or column, compiled as every off-axis pair. The
  // second derived emission after the checkerboard below, and the reason the
  // subsumption gates above ask `hasDiagonalBan` rather than the diagonal
  // rule alone.
  addCollinearPairs(mask, kDark, patterns);
  addCollinearPairs(mask, kLight, patterns);

  // The checkerboard lemma, which is why BOTH connect rules together imply the
  // checkerboard patterns even when the board never asked for them. Suppose a
  // 2x2 held one; join its two dark corners by a dark path and its two light
  // corners by a light path, then close each with the diagonal it spans. The
  // two closed curves meet exactly once — where the diagonals cross — and no
  // dark cell is a light cell, so nowhere else. A pair of closed curves in the
  // plane cannot cross an odd number of times, so one of the two paths does not
  // exist and one of the two rules is broken.
  //
  // EITHER corner-touch ban subsumes both patterns: a checkerboard is a dark
  // corner touch and a light one in the same 2x2, so whichever colour's ban
  // is on — the rule or the collinear family — its two-cell clause fires on
  // every instance first. Either MIXED elbow rule does the same — a
  // checkerboard's 2x2 holds both mixed elbows, whichever diagonal carries
  // the ends.
  if ((has(mask, NoCheckerboard) ||
       (has(mask, ConnectDark) && has(mask, ConnectLight))) &&
      !hasDiagonalBan(mask, kDark) && !hasDiagonalBan(mask, kLight) &&
      !has(mask, NoDarkLightDarkElbow) && !has(mask, NoLightDarkLightElbow)) {
    patterns.emplace_back(checkerPattern(kDark));
    patterns.emplace_back(checkerPattern(kLight));
  }
  return patterns;
}

} // namespace lg::rules
