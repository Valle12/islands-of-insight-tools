#include "Verify.h"

#include "Bitboard.h"
#include "Puzzle.h"
#include "Rules.h"
#include "Types.h"

#include <algorithm>
#include <array>
#include <cstdint>

namespace lg::verify {
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

struct RunRule {
  Rule rule = Rule::NoDark1x2;
  uint8_t color = kDark;
  int length = 2;
};

Violation runProblem(const Model &model, const Colors &colors) {
  // Every run rule is listed. This is one of the three places that mean "the
  // family of run rules" — with `shortestRun` in Rules.cpp and RUN_RULES in
  // verify.ts — and a rule appended to the catalogue has to be added to all
  // three by hand, because none of them may compute its members.
  using enum Rule;
  constexpr auto kRunRules = std::to_array<RunRule>({
      {.rule = NoDark1x2, .color = kDark, .length = 2},
      {.rule = NoLight1x2, .color = kLight, .length = 2},
      {.rule = NoDark1x3, .color = kDark, .length = 3},
      {.rule = NoLight1x3, .color = kLight, .length = 3},
      {.rule = NoDark1x4, .color = kDark, .length = 4},
      {.rule = NoLight1x4, .color = kLight, .length = 4},
      {.rule = NoDark1x5, .color = kDark, .length = 5},
      {.rule = NoLight1x5, .color = kLight, .length = 5},
  });
  const int dark = longestRun(model, colors, kDark);
  const int light = longestRun(model, colors, kLight);
  const bool broken =
      std::ranges::any_of(kRunRules, [&model, dark, light](const RunRule &row) {
        const int found = row.color == kDark ? dark : light;
        return model.hasRule(row.rule) && found >= row.length;
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

Violation areaProblem(const Model &model, const Colors &colors,
                      const Bits &dark, const Bits &light) {
  const bool wrong = std::ranges::any_of(
      model.areaClues, [&model, &colors, &dark, &light](const int id) {
        const Clue &clue = model.puzzle.clues[slot(id)];
        const Bits &mask = colors[slot(clue.index)] == kDark ? dark : light;
        return component(clue.index, mask).count() != clue.value;
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

} // namespace

const char *describe(const Violation violation) {
  using enum Violation;
  switch (violation) {
  case None:
    return "";
  case Incomplete:
    return "A playable cell was left uncoloured";
  case ShapeChanged:
    return "The board's gaps do not match the puzzle";
  case GivenChanged:
    return "A cell that was already painted came back a different colour";
  case Square:
    return "A forbidden 2x2 block of one colour";
  case Run:
    return "A forbidden run of one colour";
  case Checkerboard:
    return "A forbidden checkerboard";
  case Disconnected:
    return "A colour that must be connected is in more than one piece";
  case AreaSize:
    return "An area number does not match the size of its region";
  case LetterSplit:
    return "Cells with the same letter are in different regions";
  case LetterShared:
    return "One region holds two different letters";
  case AreaWithoutSymbol:
    return "An area that must carry one symbol carries none";
  case AreaWithManySymbols:
    return "An area that must carry one symbol carries several";
  }
  return "Unknown violation";
}

Violation check(const Model &model, const Colors &colors) {
  using enum Violation;
  if (const Violation problem = shapeProblem(model, colors); problem != None)
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

  const Bits dark = maskOf(model, colors, kDark);
  const Bits light = maskOf(model, colors, kLight);
  if (const Violation problem = connectivityProblem(model, dark, light);
      problem != None)
    return problem;
  if (const Violation problem = areaProblem(model, colors, dark, light);
      problem != None)
    return problem;
  if (const Violation problem = symbolProblem(model, dark, light);
      problem != None)
    return problem;
  return letterProblem(model, colors, dark, light);
}

} // namespace lg::verify
