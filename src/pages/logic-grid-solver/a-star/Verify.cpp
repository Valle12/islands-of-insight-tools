#include "Verify.h"

#include "Bitboard.h"
#include "Puzzle.h"
#include "Rules.h"
#include "Types.h"

#include <algorithm>
#include <array>
#include <cstdint>
#include <cstdlib>
#include <utility>
#include <vector>

namespace lg::verify {

bool countMatches(const Model &model, const int actual, const int displayed) {
  if (model.hasRule(rules::Rule::OffByOne))
    return std::abs(actual - displayed) == 1;
  return actual == displayed;
}

namespace {

using rules::Rule;

/// Every cell holding `color`.
Bits maskOf(const Model &model, const Colors &colors, const uint8_t color) {
  Bits out;
  for (int i = model.playable.nextSet(0); i >= 0;
       i = model.playable.nextSet(i + 1)) {
    if (colors[slot(i)] == color)
      out.set(i);
  }
  return out;
}

Violation cellProblem(const uint8_t given, const uint8_t found) {
  using enum Violation;
  if (given == kUnplayable)
    return found == kUnplayable ? None : ShapeChanged;
  if (found == kUnknown)
    return Incomplete;
  if (found != kDark && found != kLight)
    return ShapeChanged;
  // A painted cell is a GIVEN, so an answer that repaints one is not an answer
  // to the puzzle that was asked.
  if (given != kUnknown && given != found)
    return GivenChanged;
  return None;
}

Violation shapeProblem(const Model &model, const Colors &colors) {
  for (int y = 0; y < model.height(); y++) {
    for (int x = 0; x < model.width(); x++) {
      const int index = cellIndex(x, y);
      if (const Violation problem = cellProblem(
              model.puzzle.givens[slot(index)], colors[slot(index)]);
          problem != Violation::None)
        return problem;
    }
  }
  return Violation::None;
}

/**
 * Every square of a merged cell holds one colour.
 *
 * Nothing the SEARCH produces can break this — `Domains::exclude` fans out over
 * the cell, so its squares are decided together — but this oracle also gates
 * colourings that never went through a domain: a fixture's own `solution` key,
 * the page's `verify` export taking an arbitrary array from JS, and brute
 * force. So this is the one place that says out loud what a merged cell IS,
 * and it is what lets every check below go on speaking about squares.
 */
Violation fusedProblem(const Model &model, const Colors &colors) {
  for (const Bits &shape : model.shapes) {
    const int first = shape.nextSet(0);
    const uint8_t color = colors[slot(first)];
    for (int i = shape.nextSet(first + 1); i >= 0; i = shape.nextSet(i + 1)) {
      if (colors[slot(i)] != color)
        return Violation::CellSplit;
    }
  }
  return Violation::None;
}

bool hasSquare(const Model &model, const Colors &colors, const uint8_t color) {
  for (int y = 0; y + 1 < model.height(); y++) {
    for (int x = 0; x + 1 < model.width(); x++) {
      if (colors[slot(cellIndex(x, y))] == color &&
          colors[slot(cellIndex(x + 1, y))] == color &&
          colors[slot(cellIndex(x, y + 1))] == color &&
          colors[slot(cellIndex(x + 1, y + 1))] == color)
        return true;
    }
  }
  return false;
}

Violation squareProblem(const Model &model, const Colors &colors) {
  using enum Violation;
  if (model.hasRule(Rule::NoDark2x2) && hasSquare(model, colors, kDark))
    return Square;
  if (model.hasRule(Rule::NoLight2x2) && hasSquare(model, colors, kLight))
    return Square;
  return None;
}

/// The longest straight run of `color` anywhere, in either direction. Counting
/// once is simpler than asking about each forbidden length separately, and an
/// unplayable cell breaks a run because it never equals a colour.
int longestRun(const Model &model, const Colors &colors, const uint8_t color) {
  int best = 0;
  for (int y = 0; y < model.height(); y++) {
    int run = 0;
    for (int x = 0; x < model.width(); x++) {
      run = colors[slot(cellIndex(x, y))] == color ? run + 1 : 0;
      best = std::max(best, run);
    }
  }
  for (int x = 0; x < model.width(); x++) {
    int run = 0;
    for (int y = 0; y < model.height(); y++) {
      run = colors[slot(cellIndex(x, y))] == color ? run + 1 : 0;
      best = std::max(best, run);
    }
  }
  return best;
}

Violation runProblem(const Model &model, const Colors &colors) {
  // The puzzle's OWN `runs` instances, walked in full. The oracle shares the
  // puzzle with the search and nothing else — not the reducers, not the
  // compiled table — which is what keeps its verdicts independent. Its two
  // mirrors walk the same lists: `shortestRun` in Rules.cpp and `runProblem`
  // in verify.ts.
  if (model.puzzle.runs.empty())
    return Violation::None;
  const int dark = longestRun(model, colors, kDark);
  const int light = longestRun(model, colors, kLight);
  const bool broken = std::ranges::any_of(
      model.puzzle.runs, [dark, light](const rules::SizedRule &rule) {
        return (rule.color == kDark ? dark : light) >= rule.value;
      });
  return broken ? Violation::Run : Violation::None;
}

/// A 2x2 whose diagonals are each one colour, and different from each other.
/// All four must be real colours: two gaps on one diagonal would otherwise
/// read as a matching pair.
bool hasCheckerboard(const Model &model, const Colors &colors) {
  for (int y = 0; y + 1 < model.height(); y++) {
    for (int x = 0; x + 1 < model.width(); x++) {
      const uint8_t topLeft = colors[slot(cellIndex(x, y))];
      const uint8_t topRight = colors[slot(cellIndex(x + 1, y))];
      const uint8_t lowLeft = colors[slot(cellIndex(x, y + 1))];
      const uint8_t lowRight = colors[slot(cellIndex(x + 1, y + 1))];
      const bool real = (topLeft == kDark || topLeft == kLight) &&
                        (topRight == kDark || topRight == kLight);
      if (real && topLeft == lowRight && topRight == lowLeft &&
          topLeft != topRight)
        return true;
    }
  }
  return false;
}

/// A line of three alternating colours with `color` at both ends, in either
/// direction. Both colours are named outright, so a gap can never take part in
/// one: `kUnplayable` equals neither.
bool hasTriple(const Model &model, const Colors &colors, const uint8_t color) {
  const uint8_t other = opposite(color);
  const auto held = [&colors](const int x, const int y) {
    return colors[slot(cellIndex(x, y))];
  };
  for (int y = 0; y < model.height(); y++) {
    for (int x = 0; x < model.width(); x++) {
      if (held(x, y) != color)
        continue;
      if (x + 2 < model.width() && held(x + 1, y) == other &&
          held(x + 2, y) == color)
        return true;
      if (y + 2 < model.height() && held(x, y + 1) == other &&
          held(x, y + 2) == color)
        return true;
    }
  }
  return false;
}

Violation tripleProblem(const Model &model, const Colors &colors) {
  using enum Violation;
  if (model.hasRule(Rule::NoDarkLightDark) && hasTriple(model, colors, kDark))
    return Triple;
  if (model.hasRule(Rule::NoLightDarkLight) && hasTriple(model, colors, kLight))
    return Triple;
  return None;
}

/// A T of `color`: a straight three with a fourth cell on the middle's other
/// side. Scanned from the CENTRE, which sees all four rotations as a bar plus
/// a stem — and sees the T inside a plus, which contains one.
bool hasTee(const Model &model, const Colors &colors, const uint8_t color) {
  const auto held = [&model, &colors, color](const int x, const int y) {
    return x >= 0 && x < model.width() && y >= 0 && y < model.height() &&
           colors[slot(cellIndex(x, y))] == color;
  };
  for (int y = 0; y < model.height(); y++) {
    for (int x = 0; x < model.width(); x++) {
      if (!held(x, y))
        continue;
      if (held(x - 1, y) && held(x + 1, y) &&
          (held(x, y - 1) || held(x, y + 1)))
        return true;
      if (held(x, y - 1) && held(x, y + 1) &&
          (held(x - 1, y) || held(x + 1, y)))
        return true;
    }
  }
  return false;
}

Violation teeProblem(const Model &model, const Colors &colors) {
  using enum Violation;
  if (model.hasRule(Rule::NoDarkT) && hasTee(model, colors, kDark))
    return Tee;
  if (model.hasRule(Rule::NoLightT) && hasTee(model, colors, kLight))
    return Tee;
  return None;
}

/// A 2x2 holding exactly three of `color` and one of the other. Both colours
/// are counted outright, so a 2x2 touching a gap can never qualify: a
/// `kUnplayable` square equals neither.
bool hasThreeOne(const Model &model, const Colors &colors,
                 const uint8_t color) {
  const uint8_t other = opposite(color);
  for (int y = 0; y + 1 < model.height(); y++) {
    for (int x = 0; x + 1 < model.width(); x++) {
      const auto corners = std::to_array<uint8_t>(
          {colors[slot(cellIndex(x, y))], colors[slot(cellIndex(x + 1, y))],
           colors[slot(cellIndex(x, y + 1))],
           colors[slot(cellIndex(x + 1, y + 1))]});
      if (std::ranges::count(corners, color) == 3 &&
          std::ranges::count(corners, other) == 1)
        return true;
    }
  }
  return false;
}

Violation threeOneProblem(const Model &model, const Colors &colors) {
  using enum Violation;
  if (model.hasRule(Rule::NoThreeDarkOneLight) &&
      hasThreeOne(model, colors, kDark))
    return ThreeOne;
  if (model.hasRule(Rule::NoThreeLightOneDark) &&
      hasThreeOne(model, colors, kLight))
    return ThreeOne;
  return None;
}

/// Two cells of `color` touching corner to corner, anywhere at all — being
/// joined through an orthogonal neighbour does not excuse the touch, which is
/// what makes every region of the colour a straight bar. Scanned from each
/// cell's two DOWNWARD diagonals, so every pair is seen exactly once.
bool hasDiagonal(const Model &model, const Colors &colors,
                 const uint8_t color) {
  const auto held = [&model, &colors, color](const int x, const int y) {
    return x >= 0 && x < model.width() && y >= 0 && y < model.height() &&
           colors[slot(cellIndex(x, y))] == color;
  };
  for (int y = 0; y < model.height(); y++) {
    for (int x = 0; x < model.width(); x++) {
      if (!held(x, y))
        continue;
      if (held(x + 1, y + 1) || held(x - 1, y + 1))
        return true;
    }
  }
  return false;
}

Violation diagonalProblem(const Model &model, const Colors &colors) {
  using enum Violation;
  if (model.hasRule(Rule::NoDarkDiagonal) && hasDiagonal(model, colors, kDark))
    return Diagonal;
  if (model.hasRule(Rule::NoLightDiagonal) &&
      hasDiagonal(model, colors, kLight))
    return Diagonal;
  return None;
}

/// A bent tromino of `color`: a 2x2 window holding at least three of it.
/// Three is an elbow outright; four is a full square, which contains one.
bool hasElbow(const Model &model, const Colors &colors, const uint8_t color) {
  for (int y = 0; y + 1 < model.height(); y++) {
    for (int x = 0; x + 1 < model.width(); x++) {
      const auto corners = std::to_array<uint8_t>(
          {colors[slot(cellIndex(x, y))], colors[slot(cellIndex(x + 1, y))],
           colors[slot(cellIndex(x, y + 1))],
           colors[slot(cellIndex(x + 1, y + 1))]});
      if (std::ranges::count(corners, color) >= 3)
        return true;
    }
  }
  return false;
}

Violation elbowProblem(const Model &model, const Colors &colors) {
  using enum Violation;
  if (model.hasRule(Rule::NoDarkElbow) && hasElbow(model, colors, kDark))
    return Elbow;
  if (model.hasRule(Rule::NoLightElbow) && hasElbow(model, colors, kLight))
    return Elbow;
  return None;
}

/// An L-tetromino of `color`, either handedness: a straight three with a
/// fourth cell perpendicular at one END. Scanned from the bar's middle like
/// the T. Every diagonal neighbour of the middle is orthogonally adjacent to
/// exactly one end of either bar, so "a bar plus any diagonal of its middle"
/// is precisely an L — all eight orientations — while a foot at the middle
/// itself would be a T, which this never matches.
bool hasEll(const Model &model, const Colors &colors, const uint8_t color) {
  const auto held = [&model, &colors, color](const int x, const int y) {
    return x >= 0 && x < model.width() && y >= 0 && y < model.height() &&
           colors[slot(cellIndex(x, y))] == color;
  };
  for (int y = 0; y < model.height(); y++) {
    for (int x = 0; x < model.width(); x++) {
      if (!held(x, y))
        continue;
      if (const bool corner = held(x - 1, y - 1) || held(x - 1, y + 1) ||
                              held(x + 1, y - 1) || held(x + 1, y + 1);
          !corner)
        continue;
      if (held(x - 1, y) && held(x + 1, y))
        return true;
      if (held(x, y - 1) && held(x, y + 1))
        return true;
    }
  }
  return false;
}

Violation ellProblem(const Model &model, const Colors &colors) {
  using enum Violation;
  if (model.hasRule(Rule::NoDarkEll) && hasEll(model, colors, kDark))
    return Ell;
  if (model.hasRule(Rule::NoLightEll) && hasEll(model, colors, kLight))
    return Ell;
  return None;
}

/// Two cells of `color` exactly two apart in a straight line. Only the two END
/// squares are read — whatever lies between them, the other colour or even a
/// gap, does not lift the ban, which is what "purely positional" means.
/// Scanned rightward and downward only, so every pair is seen exactly once.
bool hasDistancePair(const Model &model, const Colors &colors,
                     const uint8_t color) {
  for (int y = 0; y < model.height(); y++) {
    for (int x = 0; x < model.width(); x++) {
      if (colors[slot(cellIndex(x, y))] != color)
        continue;
      if (x + 2 < model.width() && colors[slot(cellIndex(x + 2, y))] == color)
        return true;
      if (y + 2 < model.height() && colors[slot(cellIndex(x, y + 2))] == color)
        return true;
    }
  }
  return false;
}

Violation distancePairProblem(const Model &model, const Colors &colors) {
  using enum Violation;
  if (model.hasRule(Rule::NoDarkAnyDark) &&
      hasDistancePair(model, colors, kDark))
    return DistancePair;
  if (model.hasRule(Rule::NoLightAnyLight) &&
      hasDistancePair(model, colors, kLight))
    return DistancePair;
  return None;
}

/// A T whose CROSSING — the bar's middle, where the stem attaches — holds the
/// other colour while the bar's ends and the stem hold `color`. Scanned from
/// the crossing, which sees all four rotations; every cell is named outright,
/// so a gap can never stand in for the crossing.
bool hasMixedTee(const Model &model, const Colors &colors,
                 const uint8_t color) {
  const auto held = [&model, &colors, color](const int x, const int y) {
    return x >= 0 && x < model.width() && y >= 0 && y < model.height() &&
           colors[slot(cellIndex(x, y))] == color;
  };
  for (int y = 0; y < model.height(); y++) {
    for (int x = 0; x < model.width(); x++) {
      if (colors[slot(cellIndex(x, y))] != opposite(color))
        continue;
      if (held(x - 1, y) && held(x + 1, y) &&
          (held(x, y - 1) || held(x, y + 1)))
        return true;
      if (held(x, y - 1) && held(x, y + 1) &&
          (held(x - 1, y) || held(x + 1, y)))
        return true;
    }
  }
  return false;
}

Violation mixedTeeProblem(const Model &model, const Colors &colors) {
  using enum Violation;
  // The rule's id names the ARMS' colour last: a "light-crossed dark T" is
  // three dark cells around a light crossing.
  if (model.hasRule(Rule::NoLightCrossedDarkT) &&
      hasMixedTee(model, colors, kDark))
    return MixedTee;
  if (model.hasRule(Rule::NoDarkCrossedLightT) &&
      hasMixedTee(model, colors, kLight))
    return MixedTee;
  return None;
}

/// A T-pentomino of `color`: a bar of three with a stem of TWO from its
/// middle. Scanned from the crossing like the T, with the stem asked to reach
/// two deep on either side of the bar.
bool hasLongTee(const Model &model, const Colors &colors,
                const uint8_t color) {
  const auto held = [&model, &colors, color](const int x, const int y) {
    return x >= 0 && x < model.width() && y >= 0 && y < model.height() &&
           colors[slot(cellIndex(x, y))] == color;
  };
  for (int y = 0; y < model.height(); y++) {
    for (int x = 0; x < model.width(); x++) {
      if (!held(x, y))
        continue;
      if (held(x - 1, y) && held(x + 1, y) &&
          ((held(x, y - 1) && held(x, y - 2)) ||
           (held(x, y + 1) && held(x, y + 2))))
        return true;
      if (held(x, y - 1) && held(x, y + 1) &&
          ((held(x - 1, y) && held(x - 2, y)) ||
           (held(x + 1, y) && held(x + 2, y))))
        return true;
    }
  }
  return false;
}

Violation longTeeProblem(const Model &model, const Colors &colors) {
  using enum Violation;
  if (model.hasRule(Rule::NoDarkLongT) && hasLongTee(model, colors, kDark))
    return LongTee;
  if (model.hasRule(Rule::NoLightLongT) && hasLongTee(model, colors, kLight))
    return LongTee;
  return None;
}

/// Two cells of `color` a chess knight's move apart — two in one direction and
/// one in the other. Nothing between them is read. Scanned from each cell's
/// four DOWNWARD offsets, so every pair is seen exactly once.
bool hasKnight(const Model &model, const Colors &colors, const uint8_t color) {
  const auto held = [&model, &colors, color](const int x, const int y) {
    return x >= 0 && x < model.width() && y >= 0 && y < model.height() &&
           colors[slot(cellIndex(x, y))] == color;
  };
  for (int y = 0; y < model.height(); y++) {
    for (int x = 0; x < model.width(); x++) {
      if (!held(x, y))
        continue;
      if (held(x + 1, y + 2) || held(x - 1, y + 2) || held(x + 2, y + 1) ||
          held(x - 2, y + 1))
        return true;
    }
  }
  return false;
}

Violation knightProblem(const Model &model, const Colors &colors) {
  using enum Violation;
  if (model.hasRule(Rule::NoDarkKnight) && hasKnight(model, colors, kDark))
    return Knight;
  if (model.hasRule(Rule::NoLightKnight) && hasKnight(model, colors, kLight))
    return Knight;
  return None;
}

/// A bent tromino whose CORNER — the square touching both others — holds the
/// other colour while both ends hold `color`. Scanned from the corner: any
/// vertical neighbour of it paired with any horizontal one is a right angle,
/// which covers the four orientations. A straight line through the corner has
/// no such pair, so a mixed TRIPLE never matches.
bool hasMixedElbow(const Model &model, const Colors &colors,
                   const uint8_t color) {
  const auto held = [&model, &colors, color](const int x, const int y) {
    return x >= 0 && x < model.width() && y >= 0 && y < model.height() &&
           colors[slot(cellIndex(x, y))] == color;
  };
  for (int y = 0; y < model.height(); y++) {
    for (int x = 0; x < model.width(); x++) {
      if (colors[slot(cellIndex(x, y))] != opposite(color))
        continue;
      if ((held(x, y - 1) || held(x, y + 1)) &&
          (held(x - 1, y) || held(x + 1, y)))
        return true;
    }
  }
  return false;
}

Violation mixedElbowProblem(const Model &model, const Colors &colors) {
  using enum Violation;
  // The id reads the shape end-corner-end: `no-dark-light-dark-elbow` is two
  // dark ends around a light corner.
  if (model.hasRule(Rule::NoDarkLightDarkElbow) &&
      hasMixedElbow(model, colors, kDark))
    return MixedElbow;
  if (model.hasRule(Rule::NoLightDarkLightElbow) &&
      hasMixedElbow(model, colors, kLight))
    return MixedElbow;
  return None;
}

/// An empty colour is vacuously one region, which is what lets a board be
/// legally all-dark while `connect-light` is switched on.
bool isOneRegion(const Bits &cells) {
  const int first = cells.nextSet(0);
  if (first < 0)
    return true;
  return component(first, cells) == cells;
}

Violation connectivityProblem(const Model &model, const Bits &dark,
                              const Bits &light) {
  using enum Violation;
  if (model.hasRule(Rule::ConnectDark) && !isOneRegion(dark))
    return Disconnected;
  if (model.hasRule(Rule::ConnectLight) && !isOneRegion(light))
    return Disconnected;
  return None;
}

/**
 * Every region of `held` holds exactly `area` cells.
 *
 * Walked region by region for the same reason the symbol count is: this is a
 * property of a REGION and nothing points at the one that broke, so both halves
 * — too big and too small — are only visible from the region's own side. An
 * empty colour passes vacuously, all zero of its regions being the right size,
 * which is what lets an all-dark board be legal while the light rule is on.
 */
bool everyRegionIs(const Bits &held, const int area) {
  Bits seen;
  for (int i = held.nextSet(0); i >= 0; i = held.nextSet(i + 1)) {
    if (seen.test(i))
      continue;
    const Bits region = component(i, held);
    seen = seen | region;
    if (region.count() != area)
      return false;
  }
  return true;
}

Violation regionSizeProblem(const Model &model, const Bits &dark,
                            const Bits &light) {
  // The puzzle's OWN `areas` instances, like `runProblem` above — the oracle
  // does not ask the reducers, for the same reason it does not read the
  // compiled clause list: it is meant to agree with the search by arriving
  // separately, never by sharing its tables. Every instance runs, so both
  // sizes on one colour are satisfied only by an absent colour.
  const bool wrong = std::ranges::any_of(
      model.puzzle.areas, [&dark, &light](const rules::SizedRule &rule) {
        return !everyRegionIs(rule.color == kDark ? dark : light, rule.value);
      });
  return wrong ? Violation::RegionSize : Violation::None;
}

/// Every maximal region of `held`, walked region by region for the reason
/// `everyRegionIs` is: nothing points at a region, so a property of all of them
/// is only visible from their own side.
std::vector<Bits> regionsOf(const Bits &held) {
  std::vector<Bits> regions;
  Bits seen;
  for (int i = held.nextSet(0); i >= 0; i = held.nextSet(i + 1)) {
    if (seen.test(i))
      continue;
    const Bits region = component(i, held);
    seen = seen | region;
    regions.push_back(region);
  }
  return regions;
}

/// No two regions of `held` congruent. Vacuous at zero regions and at one.
bool allShapesDiffer(const Bits &held) {
  std::vector<Bits> keys;
  for (const Bits &region : regionsOf(held)) {
    const Bits key = canonicalShape(region);
    if (std::ranges::contains(keys, key))
      return false;
    keys.push_back(key);
  }
  return true;
}

/// Every region of `held` congruent to every other. Vacuous the same way.
bool allShapesAgree(const Bits &held) {
  const std::vector<Bits> regions = regionsOf(held);
  if (regions.empty())
    return true;
  const Bits first = canonicalShape(regions.front());
  return std::ranges::all_of(regions, [&first](const Bits &region) {
    return canonicalShape(region) == first;
  });
}

Violation distinctShapeProblem(const Model &model, const Bits &dark,
                               const Bits &light) {
  using enum Rule;
  using enum Violation;
  if (model.hasRule(DistinctShapesDark) && !allShapesDiffer(dark))
    return RegionShapeRepeat;
  if (model.hasRule(DistinctShapesLight) && !allShapesDiffer(light))
    return RegionShapeRepeat;
  return None;
}

Violation sameShapeProblem(const Model &model, const Bits &dark,
                           const Bits &light) {
  using enum Rule;
  using enum Violation;
  if (model.hasRule(SameShapeDark) && !allShapesAgree(dark))
    return RegionShapeMismatch;
  if (model.hasRule(SameShapeLight) && !allShapesAgree(light))
    return RegionShapeMismatch;
  return None;
}

Violation areaProblem(const Model &model, const Colors &colors,
                      const Bits &dark, const Bits &light) {
  const bool wrong = std::ranges::any_of(
      model.areaClues, [&model, &colors, &dark, &light](const int id) {
        const Clue &clue = model.puzzle.clues[slot(id)];
        const Bits &mask = colors[slot(clue.index)] == kDark ? dark : light;
        return !countMatches(model, component(clue.index, mask).count(),
                             clue.value);
      });
  return wrong ? Violation::AreaSize : Violation::None;
}

/**
 * Every region of `color` carries exactly one clue.
 *
 * Walked region by region rather than clue by clue, because BOTH halves of
 * "exactly one" have to be caught and the empty case is only visible from the
 * region's side: a clue-less region is illegal and no clue points at it.
 */
Violation symbolCountProblem(const Model &model, const Bits &held) {
  using enum Violation;
  Bits seen;
  for (int i = held.nextSet(0); i >= 0; i = held.nextSet(i + 1)) {
    if (seen.test(i))
      continue;
    const Bits region = component(i, held);
    seen = seen | region;
    int clues = 0;
    for (int j = region.nextSet(0); j >= 0; j = region.nextSet(j + 1)) {
      if (model.clueAt[slot(j)] >= 0)
        clues++;
    }
    if (clues != 1)
      return clues == 0 ? AreaWithoutSymbol : AreaWithManySymbols;
  }
  return None;
}

Violation symbolProblem(const Model &model, const Bits &dark,
                        const Bits &light) {
  if (model.hasRule(Rule::OneSymbolDark)) {
    if (const Violation problem = symbolCountProblem(model, dark);
        problem != Violation::None)
      return problem;
  }
  if (model.hasRule(Rule::OneSymbolLight))
    return symbolCountProblem(model, light);
  return Violation::None;
}

/**
 * Every dart counts the squares of the OTHER colour along its own line.
 *
 * The line runs from the dart's square to the edge of the board, and a gap is
 * stepped over rather than stopping it — a dart sees past a hole exactly as the
 * eye does. Squares are counted one at a time, so a merged cell lying along the
 * line contributes every square of itself that the line crosses.
 *
 * Walked here rather than read off `Model::darts`, which holds the very same
 * line precomputed. That is the point: an oracle sharing the search's tables
 * can only prove the two agree, and a wrongly built line is exactly the kind of
 * mistake this has to be able to catch. The dart's own cell needs no special
 * case for the same reason it needs none in the search — every square of it
 * holds the dart's own colour, so none of them is ever the other one.
 */
Violation dartProblem(const Model &model, const Colors &colors) {
  for (const int id : model.walked.dartClues) {
    const Clue &clue = model.puzzle.clues[slot(id)];
    // A dart nobody can read is a dart nothing satisfies. Only reachable from a
    // puzzle that skipped `structureProblem`, which is what names it properly.
    if (!isDirection(clue.direction))
      return Violation::DartCount;
    const auto [stepX, stepY] = kDirectionSteps[slot(clue.direction)];
    const uint8_t other = opposite(colors[slot(clue.index)]);
    int count = 0;
    for (int x = columnOf(clue.index) + stepX, y = rowOf(clue.index) + stepY;
         x >= 0 && x < model.width() && y >= 0 && y < model.height();
         x += stepX, y += stepY) {
      if (colors[slot(cellIndex(x, y))] == other)
        count++;
    }
    if (!countMatches(model, count, clue.value))
      return Violation::DartCount;
  }
  return Violation::None;
}

/**
 * Every lotus's region maps to itself across the lotus's axis.
 *
 * The region is the connected same-colour set of squares holding the lotus's
 * cell, and symmetry means the mirror of each of its squares is on the board,
 * playable and the same colour — which by the region's maximality puts the
 * mirror in the region too. Geometry is re-derived from the clue here rather
 * than read off `Model::lotuses`, the discipline `dartProblem` sets: an oracle
 * sharing the search's precomputed tables could only prove the two agree, and
 * a wrongly built mirror map is exactly what this has to catch.
 */
Violation lotusProblem(const Model &model, const Colors &colors) {
  using enum Violation;
  for (const int id : model.walked.lotusClues) {
    const Clue &clue = model.puzzle.clues[slot(id)];
    // A lotus nobody can read is one nothing satisfies. Only reachable from a
    // puzzle that skipped `structureProblem`, which names it properly.
    if (!isAxis(clue.direction) || !isSeat(clue.seat) ||
        (isDiagonalAxis(clue.direction) && !diagonalSeatValid(clue.seat)))
      return LotusAsymmetric;
    const int cx2 = seatX2(clue.index, clue.seat);
    const int cy2 = seatY2(clue.index, clue.seat);
    const uint8_t color = colors[slot(clue.index)];
    const Bits region = component(clue.index, maskOf(model, colors, color));
    for (int i = region.nextSet(0); i >= 0; i = region.nextSet(i + 1)) {
      const auto [mx, my] =
          mirrorSquare(clue.direction, cx2, cy2, columnOf(i), rowOf(i));
      if (mx < 0 || mx >= model.width() || my < 0 || my >= model.height())
        return LotusAsymmetric;
      if (colors[slot(cellIndex(mx, my))] != color)
        return LotusAsymmetric;
    }
  }
  return None;
}

/**
 * Every viewpoint counts the squares it can SEE: its own square, plus the
 * leading run of its own colour along each of the four directions. Sight stops
 * at the first square of the other colour, at a gap — unlike a dart's line,
 * which steps over one — and at the edge of the board. Squares are counted one
 * at a time, so a merged cell contributes exactly the squares the sight
 * crosses, wherever the rest of it lies; its own cell's squares count like any
 * others, being the counted colour by definition.
 *
 * Walked from the clue rather than read off `Model::viewpoints`, the
 * discipline `dartProblem` sets: an oracle sharing the search's precomputed
 * rays could only prove the two agree, and a wrongly built ray is exactly what
 * this has to catch.
 */
Violation viewpointProblem(const Model &model, const Colors &colors) {
  for (const int id : model.walked.viewpointClues) {
    const Clue &clue = model.puzzle.clues[slot(id)];
    const uint8_t own = colors[slot(clue.index)];
    int count = 1;
    for (const auto &[stepX, stepY] : kDirectionSteps) {
      for (int x = columnOf(clue.index) + stepX, y = rowOf(clue.index) + stepY;
           x >= 0 && x < model.width() && y >= 0 && y < model.height() &&
           colors[slot(cellIndex(x, y))] == own;
           x += stepX, y += stepY)
        count++;
    }
    if (!countMatches(model, count, clue.value))
      return Violation::ViewpointCount;
  }
  return Violation::None;
}

/**
 * Every galaxy's region maps to itself under a HALF TURN about the galaxy's
 * own square.
 *
 * The centre may be a square's own centre, a grid line or a corner, and the
 * turn carries a SIGN. Centred on a square, that square is its own image, so
 * the sign can only preserve colour and the rule is what it always was.
 * Centred between squares of DIFFERENT colours it inverts: every cell's image
 * holds the opposite colour, so the dark region and the light region touching
 * the centre are each other's image. The sign is read off the home square and
 * its partner, which always exist — the home square is playable, and its
 * partner is a square touching the centre too.
 *
 * A corner whose two pairs disagree about the sign needs no check of its own:
 * the second pair's squares are in scope, so their walk demands exactly what
 * the first pair's sign refuses.
 *
 * Geometry is re-derived from the clue, the discipline `dartProblem` sets —
 * which matters more here than anywhere, since `Galaxy::seats` is a table the
 * search built and this has to be able to disagree with it. It carries the
 * lotus's readability net for the same reason the lotus does.
 */
/// Whether the whole region holding `start` lands on `target`-coloured squares
/// of the board when turned a half turn about (cx2, cy2).
bool regionTurnsOnto(const Model &model, const Colors &colors, const int start,
                     const int cx2, const int cy2, const uint8_t target) {
  const uint8_t color = colors[slot(start)];
  const Bits region = component(start, maskOf(model, colors, color));
  for (int i = region.nextSet(0); i >= 0; i = region.nextSet(i + 1)) {
    const auto [mx, my] = halfTurn(cx2, cy2, columnOf(i), rowOf(i));
    if (mx < 0 || mx >= model.width() || my < 0 || my >= model.height())
      return false;
    if (colors[slot(cellIndex(mx, my))] != target)
      return false;
  }
  return true;
}

/// Every square touching the centre, so both regions at an inverting seat are
/// walked: the turn is an involution, so one region's image LIES IN the other,
/// but the other may reach further and only its own walk says so.
bool seatSquaresTurnOnto(const Model &model, const Colors &colors,
                         const Clue &clue, const int cx2, const int cy2,
                         const bool invert) {
  for (int dy = 0; dy <= clue.seat >> 1; dy++) {
    for (int dx = 0; dx <= (clue.seat & 1); dx++) {
      const int x = columnOf(clue.index) + dx;
      const int y = rowOf(clue.index) + dy;
      if (x >= model.width() || y >= model.height())
        continue;
      const int start = cellIndex(x, y);
      const uint8_t color = colors[slot(start)];
      if (color == kUnplayable)
        continue;
      if (!regionTurnsOnto(model, colors, start, cx2, cy2,
                           invert ? opposite(color) : color))
        return false;
    }
  }
  return true;
}

Violation galaxyProblem(const Model &model, const Colors &colors) {
  using enum Violation;
  for (const int id : model.walked.galaxyClues) {
    const Clue &clue = model.puzzle.clues[slot(id)];
    if (!isSeat(clue.seat))
      return GalaxyAsymmetric;
    const int cx2 = seatX2(clue.index, clue.seat);
    const int cy2 = seatY2(clue.index, clue.seat);

    // The home square's own image, which is where the SIGN comes from. Off the
    // board or on a gap, the region holding the clue cannot turn at all.
    const auto [px, py] = halfTurn(cx2, cy2, columnOf(clue.index),
                                   rowOf(clue.index));
    if (px < 0 || px >= model.width() || py < 0 || py >= model.height())
      return GalaxyAsymmetric;
    const uint8_t partner = colors[slot(cellIndex(px, py))];
    if (partner == kUnplayable)
      return GalaxyAsymmetric;

    if (!seatSquaresTurnOnto(model, colors, clue, cx2, cy2,
                             colors[slot(clue.index)] != partner))
      return GalaxyAsymmetric;
  }
  return None;
}

/**
 * Every cell of one letter in one region, and no region holding two letters.
 *
 * The subset test does double duty: a group cell painted the other colour is
 * not in the seed's region either, so "same letter, same colour" needs no
 * separate check.
 */
Violation letterProblem(const Model &model, const Colors &colors,
                        const Bits &dark, const Bits &light) {
  for (const LetterGroup &group : model.letters) {
    const int seed = group.cells.front();
    const Bits &mask = colors[slot(seed)] == kDark ? dark : light;
    const Bits region = component(seed, mask);
    if (!group.mask.isSubsetOf(region))
      return Violation::LetterSplit;
    const bool shared =
        std::ranges::any_of(model.letters, [&group, &region](const LetterGroup &other) {
          return other.letter != group.letter && region.intersects(other.mask);
        });
    if (shared)
      return Violation::LetterShared;
  }
  return Violation::None;
}

/// One row of `describe`'s table. Named members so a row reads as a sentence
/// and an enumerator INSERTED rather than appended cannot silently shift every
/// message after it onto the wrong violation.
struct ViolationMessage {
  Violation violation;
  const char *text;
};

} // namespace

/**
 * A table rather than a `switch`, and for the reason `Puzzle.cpp`'s `describe`
 * is one: the switch's value was the compiler telling you about a `Violation`
 * nobody had worded, and the `static_assert` below says the same thing louder.
 * It fires on exactly the omission `-Wswitch` caught — an enumerator added with
 * no message — on the native build as well as the clang one, and the lookup is
 * by enumerator, so the table may be written in any order.
 */
const char *describe(const Violation violation) {
  using enum Violation;
  static constexpr std::array kMessages{
      ViolationMessage{.violation = None, .text = ""},
      ViolationMessage{.violation = Incomplete,
                       .text = "A playable cell was left uncoloured"},
      ViolationMessage{.violation = ShapeChanged,
                       .text = "The board's gaps do not match the puzzle"},
      ViolationMessage{.violation = GivenChanged,
                       .text = "A cell that was already painted came back a "
                               "different colour"},
      ViolationMessage{.violation = Square,
                       .text = "A forbidden 2x2 block of one colour"},
      ViolationMessage{.violation = Run,
                       .text = "A forbidden run of one colour"},
      ViolationMessage{.violation = Checkerboard,
                       .text = "A forbidden checkerboard"},
      ViolationMessage{.violation = Disconnected,
                       .text = "A colour that must be connected is in more "
                               "than one piece"},
      ViolationMessage{.violation = AreaSize,
                       .text = "An area number does not match the size of its "
                               "region"},
      ViolationMessage{.violation = LetterSplit,
                       .text = "Cells with the same letter are in different "
                               "regions"},
      ViolationMessage{.violation = LetterShared,
                       .text = "One region holds two different letters"},
      ViolationMessage{.violation = AreaWithoutSymbol,
                       .text = "An area that must carry one symbol carries "
                               "none"},
      ViolationMessage{.violation = AreaWithManySymbols,
                       .text = "An area that must carry one symbol carries "
                               "several"},
      ViolationMessage{.violation = RegionSize,
                       .text = "A region does not have the area its colour's "
                               "rule requires"},
      ViolationMessage{.violation = CellSplit,
                       .text = "A merged cell came back in two colours"},
      ViolationMessage{.violation = DartCount,
                       .text = "A dart does not count what its line really "
                               "holds"},
      ViolationMessage{.violation = Triple,
                       .text = "A forbidden line of three alternating colours"},
      ViolationMessage{.violation = Tee, .text = "A forbidden T of one colour"},
      ViolationMessage{.violation = LotusAsymmetric,
                       .text = "A symmetry symbol's region does not mirror "
                               "across its axis"},
      ViolationMessage{.violation = ThreeOne,
                       .text = "A forbidden 2x2 of three of one colour and one "
                               "of the other"},
      ViolationMessage{.violation = Diagonal,
                       .text = "A forbidden corner touch of one colour"},
      ViolationMessage{.violation = ViewpointCount,
                       .text = "A viewpoint's number does not match the "
                               "squares it can see"},
      ViolationMessage{.violation = Elbow,
                       .text = "A forbidden elbow of one colour"},
      ViolationMessage{.violation = Ell, .text = "A forbidden L of one colour"},
      ViolationMessage{.violation = DistancePair,
                       .text = "A forbidden pair of one colour two apart"},
      ViolationMessage{.violation = MixedTee,
                       .text = "A forbidden T whose crossing is the other "
                               "colour"},
      ViolationMessage{.violation = LongTee,
                       .text = "A forbidden long T of one colour"},
      ViolationMessage{.violation = Knight,
                       .text = "A forbidden knight's move of one colour"},
      ViolationMessage{.violation = MixedElbow,
                       .text = "A forbidden elbow whose corner is the other "
                               "colour"},
      ViolationMessage{.violation = GalaxyAsymmetric,
                       .text = "A galaxy symbol's region does not map to "
                               "itself turned about it"},
      ViolationMessage{.violation = RegionShapeRepeat,
                       .text = "Two regions of one colour have the same shape"},
      ViolationMessage{.violation = RegionShapeMismatch,
                       .text = "Two regions of one colour have different "
                               "shapes"},
  };
  // Counted against `Count` and never against the last real enumerator: an
  // APPENDED one leaves that one's value alone, so the assert would still hold
  // and the new violation would describe itself as "Unknown violation" — the
  // exact omission this replaced a switch to keep catching.
  static_assert(static_cast<int>(kMessages.size()) ==
                std::to_underlying(Count));
  const auto found =
      std::ranges::find(kMessages, violation, &ViolationMessage::violation);
  return found == kMessages.end() ? "Unknown violation" : found->text;
}

namespace {

/// The half of the list that reads the colouring alone, in the order a board
/// breaking several of them is NAMED by.
Violation colorChecks(const Model &model, const Colors &colors) {
  using enum Violation;
  if (const Violation problem = shapeProblem(model, colors); problem != None)
    return problem;
  // Before anything below, which all read the colouring one SQUARE at a time
  // and are only entitled to do so once a merged cell is known to hold one
  // colour. (`shapeProblem` here means the board's GAPS, not a merged cell —
  // it runs first so a gap or a repainted given is still named as such.)
  if (const Violation problem = fusedProblem(model, colors); problem != None)
    return problem;
  if (const Violation problem = squareProblem(model, colors); problem != None)
    return problem;
  if (const Violation problem = runProblem(model, colors); problem != None)
    return problem;
  // The implied checkerboard rule is deliberately NOT applied here. When both
  // colours are connected a checkerboard already breaks one of them, so the
  // connectivity test below catches it — and leaving it out keeps this file
  // free of anything the pattern compiler derived.
  if (model.hasRule(Rule::NoCheckerboard) && hasCheckerboard(model, colors))
    return Checkerboard;
  if (const Violation problem = tripleProblem(model, colors); problem != None)
    return problem;
  if (const Violation problem = teeProblem(model, colors); problem != None)
    return problem;
  if (const Violation problem = threeOneProblem(model, colors); problem != None)
    return problem;
  if (const Violation problem = diagonalProblem(model, colors); problem != None)
    return problem;
  if (const Violation problem = elbowProblem(model, colors); problem != None)
    return problem;
  if (const Violation problem = ellProblem(model, colors); problem != None)
    return problem;
  if (const Violation problem = distancePairProblem(model, colors);
      problem != None)
    return problem;
  if (const Violation problem = mixedTeeProblem(model, colors); problem != None)
    return problem;
  if (const Violation problem = longTeeProblem(model, colors); problem != None)
    return problem;
  if (const Violation problem = knightProblem(model, colors); problem != None)
    return problem;
  if (const Violation problem = mixedElbowProblem(model, colors);
      problem != None)
    return problem;
  return None;
}

/// The half that needs the two colour masks, continuing the same list.
Violation regionChecks(const Model &model, const Colors &colors,
                       const Bits &dark, const Bits &light) {
  using enum Violation;
  if (const Violation problem = connectivityProblem(model, dark, light);
      problem != None)
    return problem;
  if (const Violation problem = regionSizeProblem(model, dark, light);
      problem != None)
    return problem;
  // Beside the size rule and ahead of the clue-driven checks, matching the
  // order of `REGION_CHECKS` in `verifyRegions.ts` — a board breaking both
  // size and shape has to be NAMED the same on both sides.
  if (const Violation problem = distinctShapeProblem(model, dark, light);
      problem != None)
    return problem;
  if (const Violation problem = sameShapeProblem(model, dark, light);
      problem != None)
    return problem;
  if (const Violation problem = areaProblem(model, colors, dark, light);
      problem != None)
    return problem;
  if (const Violation problem = symbolProblem(model, dark, light);
      problem != None)
    return problem;
  if (const Violation problem = letterProblem(model, colors, dark, light);
      problem != None)
    return problem;
  if (const Violation problem = dartProblem(model, colors); problem != None)
    return problem;
  if (const Violation problem = lotusProblem(model, colors); problem != None)
    return problem;
  if (const Violation problem = galaxyProblem(model, colors); problem != None)
    return problem;
  return viewpointProblem(model, colors);
}

} // namespace

Violation check(const Model &model, const Colors &colors) {
  using enum Violation;
  if (const Violation problem = colorChecks(model, colors); problem != None)
    return problem;
  return regionChecks(model, colors, maskOf(model, colors, kDark),
                      maskOf(model, colors, kLight));
}

} // namespace lg::verify
