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

struct AreaRule {
  Rule rule = Rule::AreaTwoDark;
  uint8_t color = kDark;
  int area = 2;
};

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
  // Listed, like `kRunRules` above and `AREA_RULES` in verify.ts. The oracle
  // does not ask `rules::globalArea`, for the same reason it does not read the
  // compiled clause list: it is meant to agree with the search by arriving
  // separately, never by sharing its tables.
  using enum Rule;
  constexpr auto kAreaRules = std::to_array<AreaRule>({
      {.rule = AreaTwoDark, .color = kDark, .area = 2},
      {.rule = AreaTwoLight, .color = kLight, .area = 2},
      {.rule = AreaFourDark, .color = kDark, .area = 4},
      {.rule = AreaFourLight, .color = kLight, .area = 4},
      {.rule = AreaFiveDark, .color = kDark, .area = 5},
      {.rule = AreaFiveLight, .color = kLight, .area = 5},
  });
  const bool wrong = std::ranges::any_of(
      kAreaRules, [&model, &dark, &light](const AreaRule &row) {
        return model.hasRule(row.rule) &&
               !everyRegionIs(row.color == kDark ? dark : light, row.area);
      });
  return wrong ? Violation::RegionSize : Violation::None;
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
  for (const int id : model.dartClues) {
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
    if (count != clue.value)
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
  for (const int id : model.lotusClues) {
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
  case RegionSize:
    return "A region does not have the area its colour's rule requires";
  case CellSplit:
    return "A merged cell came back in two colours";
  case DartCount:
    return "A dart does not count what its line really holds";
  case Triple:
    return "A forbidden line of three alternating colours";
  case Tee:
    return "A forbidden T of one colour";
  case LotusAsymmetric:
    return "A symmetry symbol's region does not mirror across its axis";
  }
  return "Unknown violation";
}

Violation check(const Model &model, const Colors &colors) {
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

  const Bits dark = maskOf(model, colors, kDark);
  const Bits light = maskOf(model, colors, kLight);
  if (const Violation problem = connectivityProblem(model, dark, light);
      problem != None)
    return problem;
  if (const Violation problem = regionSizeProblem(model, dark, light);
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
  return lotusProblem(model, colors);
}

} // namespace lg::verify
