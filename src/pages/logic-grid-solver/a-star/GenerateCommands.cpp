#include "GenerateCommands.h"

#include "Bitboard.h"
#include "FixtureIo.h"
#include "Puzzle.h"
#include "Regions.h"
#include "Rules.h"
#include "SeededRng.h"
#include "Types.h"
#include "Verify.h"

#include <algorithm>
#include <array>
#include <cstdint>
#include <iostream>
#include <string>
#include <vector>

namespace lg::generate {
namespace {

using rules::Rule;

inline constexpr int kRestarts = 40;
inline constexpr int kStepsPerRestart = 20000;
/// How often a step ignores the score and flips something anyway, which is
/// what gets a local search off a plateau.
inline constexpr int kNoisePercent = 8;

/// Keeps the merged-cell draws off the main stream. Any constant does; what
/// matters is that `--shapes 0` touches the main rng not at all, so every seed
/// still regenerates the board it always did.
inline constexpr uint32_t kShapeSalt = 0x5EA'11EDU;

/// The rules that constrain a colouring. `Underclued` is not one of them: it
/// changes what the answer is, never which colourings are legal.
///
/// The ORDER is load-bearing in a way the list itself is not: `emptyBoard` draws
/// once per entry from the same rng that then feeds the local search, so
/// appending here shifts every board this generator produces for a given seed.
/// Nothing on disk depends on that — the captured fixtures are captures — but a
/// fuzz baseline has to be retaken.
constexpr auto kColorRules = std::to_array<Rule>(
    {Rule::NoDark2x2, Rule::NoLight2x2, Rule::ConnectDark, Rule::ConnectLight,
     Rule::NoLight1x2, Rule::NoDark1x2, Rule::NoLight1x3, Rule::NoDark1x3,
     Rule::NoLight1x4, Rule::NoDark1x4, Rule::NoCheckerboard, Rule::NoLight1x5,
     Rule::NoDark1x5, Rule::OneSymbolDark, Rule::OneSymbolLight,
     Rule::AreaTwoDark, Rule::AreaTwoLight, Rule::AreaFourDark,
     Rule::AreaFourLight, Rule::AreaFiveDark, Rule::AreaFiveLight,
     Rule::NoDarkLightDark, Rule::NoLightDarkLight, Rule::NoDarkT,
     Rule::NoLightT, Rule::NoThreeDarkOneLight, Rule::NoThreeLightOneDark,
     Rule::NoDarkDiagonal, Rule::NoLightDiagonal, Rule::AreaThreeDark,
     Rule::AreaThreeLight,
     // Appended with the elbow-era batch, in storage order. `OffByOne` is
     // deliberately NOT here — like `Underclued` it constrains no colouring,
     // it changes what the clues' numbers mean — so random masks never carry
     // it and the perturbation draws in `clueOneRegion` stay unreachable for
     // every seed a maskless campaign ever ran.
     Rule::NoDarkElbow, Rule::NoLightElbow, Rule::NoDarkEll, Rule::NoLightEll,
     Rule::NoDarkAnyDark, Rule::NoLightAnyLight, Rule::AreaSixDark,
     Rule::AreaSixLight, Rule::AreaSevenDark, Rule::AreaSevenLight,
     Rule::NoLightCrossedDarkT, Rule::NoDarkCrossedLightT, Rule::NoDarkLongT,
     Rule::NoLightLongT, Rule::AreaTwentyFourDark, Rule::AreaTwentyFourLight,
     Rule::NoDarkKnight, Rule::NoLightKnight, Rule::NoDarkLightDarkElbow,
     Rule::NoLightDarkLightElbow});

Bits heldBy(const Model &model, const Colors &colors, const uint8_t color) {
  Bits held;
  for (int i = model.playable.nextSet(0); i >= 0;
       i = model.playable.nextSet(i + 1)) {
    if (colors[slot(i)] == color)
      held.set(i);
  }
  return held;
}

int piecesBeyondOne(const Model &model, const Colors &colors,
                    const uint8_t color, const Rule rule) {
  if (!model.hasRule(rule))
    return 0;
  const Bits held = heldBy(model, colors, color);
  const int seed = held.nextSet(0);
  if (seed < 0)
    return 0;
  return held.without(component(seed, held)).count();
}

/**
 * How far every region of `color` is from the size its rule demands.
 *
 * For an area of TWO the clause table already scores a region that is too BIG,
 * since every one of those contains a forbidden tromino, and all this has to
 * add is the too-small half — without which the local search reaches `cost == 0`
 * with singletons still standing, `verify::check` throws the result out, and
 * every attempt fails. For area FOUR there are no clauses at all, so this is
 * the whole gradient and it has to score both halves.
 *
 * Counted as the distance from the target rather than as a flag per region, so
 * a region three cells short scores worse than one that is one cell short and
 * the search has something to walk down — and as the distance to the NEARER
 * legal outcome, growing to the number or vanishing altogether. A region has
 * two ways to be legal, and pricing only the growth marooned the walk the
 * moment area TWENTY-FOUR joined the family: on a board that cannot hold a
 * region that big, every shrinking flip scored worse than standing still,
 * while the legal all-other-colour board sat a few flips away downhill.
 */
int regionsOffSize(const Model &model, const Colors &colors) {
  int bad = 0;
  for (const auto &[color, area] : model.puzzle.areas) {
    const Bits held = heldBy(model, colors, color);
    Bits seen;
    for (int i = held.nextSet(0); i >= 0; i = held.nextSet(i + 1)) {
      if (seen.test(i))
        continue;
      const Bits region = component(i, held);
      seen = seen | region;
      const int size = region.count();
      bad += std::min(std::abs(size - area), size);
    }
  }
  return bad;
}

/**
 * One flip-candidate set per region that is off the size its rule wants: the
 * region itself, which flipping shrinks, and the ring around it, which
 * flipping grows it into.
 *
 * This is the gradient `regionsOffSize` measures, turned into a move list. The
 * area rules of FOUR contribute no clauses at all — the pattern table stops at
 * two, see `addAreaShapes` — so without it `walk` finds nothing in `broken` and
 * falls back on `nudge`, which flips a uniformly random cell. Measured on an
 * 8x8 before it existed: `AreaFourDark` alone produced 1 board in 6 attempts at
 * ~17 s each and both area-four rules together 0 in 12, where the
 * clause-covered `AreaTwoDark` managed 6 of 6 at 50 ms apiece.
 *
 * Kept as one entry PER REGION rather than as a single pooled set so `walk` can
 * repair one at a time, exactly as it does with one randomly chosen broken
 * clause. Scoring the pool instead costs a `cost()` per cell of every bad
 * region at every step, which on a board with many of them is most of the
 * board: measured on the both-area-two mask, where the 8x8 is usually
 * infeasible and the walk runs its whole restart budget out, pooling took the
 * give-up path from 123 s to 308 s for the same answer.
 */
std::vector<Bits> offSizeRegions(const Model &model, const Colors &colors) {
  std::vector<Bits> regions;
  for (const auto &[color, area] : model.puzzle.areas) {
    const Bits held = heldBy(model, colors, color);
    Bits seen;
    for (int i = held.nextSet(0); i >= 0; i = held.nextSet(i + 1)) {
      if (seen.test(i))
        continue;
      const Bits region = component(i, held);
      seen = seen | region;
      if (region.count() != area)
        regions.push_back((region | region.border()) & model.playable);
    }
  }
  return regions;
}

bool clauseHolds(const Clause &clause, const Colors &colors) {
  for (int i = 0; i < clause.count; i++) {
    if (colors[slot(clause.cells[slot(i)])] != clause.colors[slot(i)])
      return false;
  }
  return true;
}

/// How far this colouring is from legal. Zero means it is a solution of the
/// clue-free board, which is what the generator is looking for.
int cost(const Model &model, const Colors &colors) {
  using enum Rule;
  int bad = 0;
  for (const Clause &clause : model.clauses)
    bad += clauseHolds(clause, colors) ? 1 : 0;
  bad += piecesBeyondOne(model, colors, kDark, ConnectDark);
  bad += piecesBeyondOne(model, colors, kLight, ConnectLight);
  bad += regionsOffSize(model, colors);
  return bad;
}

void randomise(const Model &model, SeededRng &rng, Colors &colors) {
  colors.fill(kUnplayable);
  for (int i = model.playable.nextSet(0); i >= 0;
       i = model.playable.nextSet(i + 1))
    colors[slot(i)] = rng.uniform(0, 1) == 0 ? kDark : kLight;
}

/// Flips whichever cell of a broken arrangement leaves the board least broken.
void repairClause(const Model &model, const Clause &clause, SeededRng &rng,
                  Colors &colors) {
  int bestCell = clause.cells[0];
  int bestCost = -1;
  for (int i = 0; i < clause.count; i++) {
    const int cell = clause.cells[slot(i)];
    const uint8_t was = colors[slot(cell)];
    colors[slot(cell)] = opposite(was);
    const int after = cost(model, colors);
    colors[slot(cell)] = was;
    if (bestCost < 0 || after < bestCost) {
      bestCost = after;
      bestCell = cell;
    }
  }
  if (rng.uniform(0, 99) < kNoisePercent)
    bestCell = clause.cells[slot(rng.uniform(0, clause.count - 1))];
  colors[slot(bestCell)] = opposite(colors[slot(bestCell)]);
}

/// Flips whichever of one off-size region's candidates leaves the board least
/// broken. The same shape as `repairClause`, noise included, but over a set
/// from `offSizeRegions` rather than over one forbidden arrangement.
void repairRegion(const Model &model, const Bits &candidates, SeededRng &rng,
                  Colors &colors) {
  std::vector<int> cells;
  for (int i = candidates.nextSet(0); i >= 0; i = candidates.nextSet(i + 1))
    cells.push_back(i);
  if (cells.empty())
    return;

  int bestCell = cells.front();
  int bestCost = -1;
  for (const int cell : cells) {
    const uint8_t was = colors[slot(cell)];
    colors[slot(cell)] = opposite(was);
    const int after = cost(model, colors);
    colors[slot(cell)] = was;
    if (bestCost < 0 || after < bestCost) {
      bestCost = after;
      bestCell = cell;
    }
  }
  if (rng.uniform(0, 99) < kNoisePercent)
    bestCell = cells[slot(rng.uniform(0, static_cast<int>(cells.size()) - 1))];
  colors[slot(bestCell)] = opposite(colors[slot(bestCell)]);
}

/// With no broken arrangement left and every region already the size its rule
/// wants, only connectivity can still be wrong; nudging a random cell is
/// enough to keep the walk moving.
void nudge(const Model &model, SeededRng &rng, Colors &colors) {
  const int count = model.playableCount;
  if (count == 0)
    return;
  int wanted = rng.uniform(0, count - 1);
  for (int i = model.playable.nextSet(0); i >= 0;
       i = model.playable.nextSet(i + 1)) {
    if (wanted == 0) {
      colors[slot(i)] = opposite(colors[slot(i)]);
      return;
    }
    wanted--;
  }
}

bool walk(const Model &model, SeededRng &rng, Colors &colors) {
  for (int step = 0; step < kStepsPerRestart; step++) {
    if (cost(model, colors) == 0)
      return true;
    std::vector<int> broken;
    int id = 0;
    for (const Clause &clause : model.clauses) {
      if (clauseHolds(clause, colors))
        broken.push_back(id);
      id++;
    }
    if (broken.empty()) {
      // Cost is still nonzero, so what is left is a region rule — and the area
      // rules of four are never in `broken` at all, having no clauses. One
      // region at a time, the same way a broken clause is picked below.
      const std::vector<Bits> offSize = offSizeRegions(model, colors);
      if (offSize.empty()) {
        nudge(model, rng, colors);
        continue;
      }
      const int pick = rng.uniform(0, static_cast<int>(offSize.size()) - 1);
      repairRegion(model, offSize[slot(pick)], rng, colors);
      continue;
    }
    const int chosen = broken[slot(rng.uniform(0, static_cast<int>(broken.size()) - 1))];
    repairClause(model, model.clauses[slot(chosen)], rng, colors);
  }
  return cost(model, colors) == 0;
}

bool paintLegal(const Model &model, SeededRng &rng, Colors &colors) {
  for (int restart = 0; restart < kRestarts; restart++) {
    randomise(model, rng, colors);
    if (walk(model, rng, colors))
      return true;
  }
  return false;
}

/**
 * Keeps only the SMALLEST area rule of each colour — the binding one, which is
 * `smallestArea`'s own argument.
 *
 * A v1 mask can name several sizes on one colour, and `splitLegacyMask` is
 * faithful to it because the ENGINE still walks conjunctive lists. The FORMAT
 * does not: `fixtureio::load` refuses a second entry per colour, and every
 * generated board is written and then read straight back through it. The rule
 * table here draws each of its entries independently, so without this roughly
 * half of all boards would name two dark or two light areas and fail on the
 * way back in.
 *
 * Runs strictly AFTER every rng decision and draws nothing, so no seed's
 * stream moves — only what an already-drawn mask MEANS. `splitLegacyMask`
 * returns its lists sorted, so each colour's entries are contiguous and the
 * first of a run is its smallest.
 */
void keepOneAreaPerColor(std::vector<rules::SizedRule> &areas) {
  const auto extra = std::ranges::unique(areas, {}, &rules::SizedRule::color);
  areas.erase(extra.begin(), extra.end());
}

/// Tears a v1-style mask into the puzzle's modern fields: flags stay in the
/// mask, sized bits become canonical `areas`/`runs` instances. Runs strictly
/// AFTER every rng decision and draws nothing — which is what keeps every
/// seed's board byte-identical across the format change.
void applyLegacyMask(Puzzle &puzzle, const rules::RuleMask mask) {
  auto [flags, areas, runs] = rules::splitLegacyMask(mask);
  keepOneAreaPerColor(areas);
  puzzle.ruleMask = flags;
  puzzle.areas = std::move(areas);
  puzzle.runs = std::move(runs);
}

Puzzle emptyBoard(SeededRng &rng, const Options &options) {
  Puzzle puzzle;
  // Clamped rather than refused, the match-three generator's rule: `Bits`
  // wraps a wider row into the next one (`cellIndex` is y * 32 + x) and the
  // border-arc arrays are sized for kMaxSide, so an oversized request must
  // never reach the model — and clamping keeps every rng draw where it was,
  // so a pinned dimension still consumes no random number.
  puzzle.width =
      options.width > 0 ? std::min(options.width, kMaxSide) : rng.uniform(4, 8);
  puzzle.height = options.height > 0 ? std::min(options.height, kMaxSide)
                                     : rng.uniform(4, 8);
  puzzle.givens.fill(kUnplayable);
  for (int y = 0; y < puzzle.height; y++) {
    for (int x = 0; x < puzzle.width; x++) {
      const bool gap = rng.uniform(0, 99) < 8;
      puzzle.givens[slot(cellIndex(x, y))] = gap ? kUnplayable : kUnknown;
    }
  }
  // Both paths below still SPEAK v1: `--rules` takes the 53-bit mask it always
  // did, and the rule table keeps one draw per entry — sized entries included,
  // so no seed's rng stream moves. The translation into instances happens once
  // the mask is complete.
  if (options.rules >= 0) {
    applyLegacyMask(puzzle, static_cast<rules::RuleMask>(options.rules));
    return puzzle;
  }
  // One in SIX per entry, recalibrated when the elbow-era batch grew the list
  // from 31 to 51: at the old one-in-four a random mask averaged thirteen
  // rules, and the local search stopped finding colourings under them at all.
  // One in six keeps the expected count where the campaigns were measured —
  // about eight — and shifts every seed's mask, which the append had already
  // done.
  rules::RuleMask mask = 0;
  for (const Rule rule : kColorRules) {
    if (rng.uniform(0, 5) == 0)
      mask |= rules::bit(rule);
  }
  applyLegacyMask(puzzle, mask);
  return puzzle;
}

/// Every cell of one labelled region that does not already carry a clue.
std::vector<int> freeCellsOf(const Bits &side, const Regions &regions,
                             const Bits &used, const int id) {
  std::vector<int> cells;
  for (int i = side.nextSet(0); i >= 0; i = side.nextSet(i + 1)) {
    if (regions.id[slot(i)] == id && !used.test(i))
      cells.push_back(i);
  }
  return cells;
}

/// How often each kind of clue lands. An underclued board gets far fewer, which
/// is the whole of what makes it underclued.
struct ClueChances {
  int area = 0;
  int letter = 0;
  /// Off unless `--darts` asks for them, so a campaign without it draws no
  /// random number for a dart and reproduces every board it always did.
  int dart = 0;
  /// Off unless `--lotus` asks, with the same contract again.
  int lotus = 0;
  /// Off unless `--viewpoints` asks, with the same contract a third time.
  int viewpoint = 0;
  /// Off unless `--galaxies` asks, with the same contract a fourth time.
  int galaxy = 0;
};

/// The state that crosses every region: where the clues go, which cells already
/// carry one, and the next unused letter.
struct ClueRun {
  SeededRng &rng;
  Puzzle &puzzle;
  Bits &used;
  int letter = 0;
};

/// How many squares of the other colour a dart at `spot` aimed `direction`
/// really sees, read off the colouring so the clue is satisfiable by
/// construction. The same walk `Verify` does, and for the same reason: gaps are
/// stepped over, and the dart's own cell can never be the colour it counts.
int dartValueAt(const Model &model, const Colors &colors, const int spot,
                const int direction) {
  const auto [stepX, stepY] = kDirectionSteps[slot(direction)];
  const uint8_t other = opposite(colors[slot(spot)]);
  int count = 0;
  for (int x = columnOf(spot) + stepX, y = rowOf(spot) + stepY;
       x >= 0 && x < model.width() && y >= 0 && y < model.height();
       x += stepX, y += stepY) {
    if (colors[slot(cellIndex(x, y))] == other)
      count++;
  }
  return count;
}

/**
 * Whether the region holding `spot` really mirrors across `axis` through its
 * centre, read off the colouring the way `dartValueAt` reads a count — the
 * same walk `Verify` does. A lotus has no value to derive; the clue must
 * simply be TRUE where it lands, and this is what says so. Draws nothing.
 */
bool lotusHoldsAt(const Model &model, const Colors &colors, const int spot,
                  const int axis) {
  const int cx2 = 2 * columnOf(spot);
  const int cy2 = 2 * rowOf(spot);
  const uint8_t color = colors[slot(spot)];
  Bits held;
  for (int i = model.playable.nextSet(0); i >= 0;
       i = model.playable.nextSet(i + 1)) {
    if (colors[slot(i)] == color)
      held.set(i);
  }
  const Bits region = component(spot, held);
  for (int i = region.nextSet(0); i >= 0; i = region.nextSet(i + 1)) {
    const auto [mx, my] = mirrorSquare(axis, cx2, cy2, columnOf(i), rowOf(i));
    if (mx < 0 || mx >= model.width() || my < 0 || my >= model.height())
      return false;
    if (colors[slot(cellIndex(mx, my))] != color)
      return false;
  }
  return true;
}

/**
 * How many squares a viewpoint at `spot` really sees, read off the colouring:
 * its own square plus the leading same-colour run along each of the four rays.
 * The same walk `Verify` does — sight stops at a gap, unlike a dart's line —
 * so the clue is satisfiable by construction, and always at least one.
 */
int viewpointValueAt(const Model &model, const Colors &colors, const int spot) {
  const uint8_t own = colors[slot(spot)];
  int count = 1;
  for (const auto &[stepX, stepY] : kDirectionSteps) {
    for (int x = columnOf(spot) + stepX, y = rowOf(spot) + stepY;
         x >= 0 && x < model.width() && y >= 0 && y < model.height() &&
         colors[slot(cellIndex(x, y))] == own;
         x += stepX, y += stepY)
      count++;
  }
  return count;
}

/**
 * Whether the region holding `spot` really maps to itself under a HALF TURN
 * about it, read off the colouring the way `lotusHoldsAt` reads a mirror —
 * the same walk `Verify` does. A galaxy has no value to derive; the clue must
 * simply be TRUE where it lands, and this is what says so. Draws nothing.
 */
bool galaxyHoldsAt(const Model &model, const Colors &colors, const int spot) {
  const uint8_t color = colors[slot(spot)];
  const int gx = columnOf(spot);
  const int gy = rowOf(spot);
  const Bits region = component(spot, heldBy(model, colors, color));
  // Seat 0 — the generator places galaxies at a square's own CENTRE and never
  // on a grid line, so the doubled centre is (2gx, 2gy) and this is the plain
  // point reflection it always was. A `--galaxy-seats` roll would be an
  // appended draw behind a `> 0` short circuit, the established pattern, and
  // is deliberately not one yet.
  for (int i = region.nextSet(0); i >= 0; i = region.nextSet(i + 1)) {
    const auto [mx, my] = halfTurn(2 * gx, 2 * gy, columnOf(i), rowOf(i));
    if (mx < 0 || mx >= model.width() || my < 0 || my >= model.height())
      return false;
    if (colors[slot(cellIndex(mx, my))] != color)
      return false;
  }
  return true;
}

/**
 * The value a numeric clue DISPLAYS for a true count of `value`: the count
 * itself as the rules stand, one off it under `off-by-one`. The direction is
 * one draw, made only when the rule is on the generated mask — and since
 * `OffByOne` never joins `kColorRules`, a maskless campaign cannot reach it
 * and keeps every board it ever produced. A true count at the displayed floor
 * of zero can only go up.
 */
int displayedValue(SeededRng &rng, const rules::RuleMask mask,
                   const int value) {
  if (!rules::has(mask, Rule::OffByOne))
    return value;
  if (const bool up = rng.uniform(0, 1) == 1; !up && value - 1 >= 0)
    return value - 1;
  return value + 1;
}

/**
 * Puts at most one clue on one region, reading its value off the colouring.
 *
 * The `rng` draws here are in a fixed order — the spot, the area roll, the
 * letter roll, the dart roll, the lotus roll, the viewpoint roll, then the
 * galaxy roll — and every one after the first is behind a short circuit that
 * skips it entirely when it cannot apply. Reordering them, or hoisting one
 * out of its condition, silently changes every board this generator has ever
 * produced; each new kind is appended LAST-so-far and skipped outright at a
 * zero chance, which is what keeps `--darts 0`, `--lotus 0`, `--viewpoints 0`
 * and `--galaxies 0` reproducing exactly the boards they always did. The
 * lotus's and the galaxy's satisfiability CHECKS draw nothing, so a failed
 * one costs the region its clue and nothing else; a viewpoint's value is READ
 * off the colouring like a dart's, so its roll is the only number it draws —
 * except under `off-by-one`, where every numeric clue appends ONE more draw
 * to bend its displayed value, unreachable for any mask without that rule.
 * Hash-compare regenerated fixtures across several seeds after touching this.
 */
void clueOneRegion(ClueRun &run, const ClueChances &chances,
                   const std::vector<int> &cells, const int size,
                   const Model &model, const Colors &colors) {
  const rules::RuleMask mask = run.puzzle.ruleMask;
  const int spot =
      cells[slot(run.rng.uniform(0, static_cast<int>(cells.size()) - 1))];
  if (run.rng.uniform(0, 99) < chances.area) {
    const int value = displayedValue(run.rng, mask, size);
    run.used.set(spot);
    run.puzzle.clues.push_back(
        {.index = spot, .kind = kClueArea, .value = value});
    return;
  }
  if (run.letter < kLetterCount && run.rng.uniform(0, 99) < chances.letter) {
    run.used.set(spot);
    run.puzzle.clues.push_back(
        {.index = spot, .kind = kClueLetter, .value = run.letter});
    run.letter++;
    return;
  }
  if (chances.dart > 0 && run.rng.uniform(0, 99) < chances.dart) {
    const int direction = run.rng.uniform(0, kDirectionCount - 1);
    const int value =
        displayedValue(run.rng, mask, dartValueAt(model, colors, spot, direction));
    run.used.set(spot);
    run.puzzle.clues.push_back({.index = spot,
                                .kind = kClueDart,
                                .value = value,
                                .direction = direction});
    return;
  }
  if (chances.lotus > 0 && run.rng.uniform(0, 99) < chances.lotus) {
    const int axis = run.rng.uniform(0, kAxisCount - 1);
    if (!lotusHoldsAt(model, colors, spot, axis))
      return;
    run.used.set(spot);
    run.puzzle.clues.push_back(
        {.index = spot, .kind = kClueLotus, .direction = axis});
    return;
  }
  if (chances.viewpoint > 0 && run.rng.uniform(0, 99) < chances.viewpoint) {
    const int value =
        displayedValue(run.rng, mask, viewpointValueAt(model, colors, spot));
    run.used.set(spot);
    run.puzzle.clues.push_back(
        {.index = spot, .kind = kClueViewpoint, .value = value});
    return;
  }
  if (chances.galaxy > 0 && run.rng.uniform(0, 99) < chances.galaxy) {
    if (!galaxyHoldsAt(model, colors, spot))
      return;
    run.used.set(spot);
    run.puzzle.clues.push_back({.index = spot, .kind = kClueGalaxy});
  }
}

/// Reads clues off the colouring the board was given, so every one of them is
/// satisfiable together by construction.
void deriveClues(const Model &model, const Colors &colors, SeededRng &rng,
                 const bool sparse, const Options &options, Puzzle &puzzle) {
  Bits colored;
  for (int i = model.playable.nextSet(0); i >= 0;
       i = model.playable.nextSet(i + 1)) {
    if (colors[slot(i)] == kDark)
      colored.set(i);
  }
  const Bits light = model.playable.without(colored);

  Bits used;
  ClueRun run{.rng = rng, .puzzle = puzzle, .used = used};
  const ClueChances chances{.area = sparse ? 25 : 70,
                            .letter = sparse ? 10 : 25,
                            .dart = options.darts,
                            .lotus = options.lotus,
                            .viewpoint = options.viewpoints,
                            .galaxy = options.galaxies};

  for (const Bits &side : {colored, light}) {
    const Regions regions = labelRegions(side, model);
    for (int id = 0; id < regions.count(); id++) {
      if (const std::vector<int> cells = freeCellsOf(side, regions, used, id);
          !cells.empty())
        clueOneRegion(run, chances, cells, regions.size[slot(id)], model,
                      colors);
    }
  }
}

/// The squares a shape may grow into: on its border, unclaimed, unclued, and
/// already carrying the colour the shape holds. Draws nothing — the caller
/// picks from what this returns, which is what keeps the rng stream in
/// `fuseCells` independent of how the candidates are gathered.
std::vector<int> growthOptions(const Model &model, const Colors &colors,
                               const Bits &claimed, const Bits &clued,
                               const std::vector<int> &shape,
                               const uint8_t color) {
  Bits mask;
  for (const int square : shape)
    mask.set(square);
  const Bits room = (mask.border() & model.playable).without(claimed);
  std::vector<int> options;
  for (int i = room.nextSet(0); i >= 0; i = room.nextSet(i + 1)) {
    if (colors[slot(i)] == color && !clued.test(i))
      options.push_back(i);
  }
  return options;
}

/**
 * Fuses same-coloured neighbours into merged cells, AFTER the clues have been
 * read off the colouring.
 *
 * Doing it last is what makes it safe rather than merely convenient. The local
 * search never sees a merged cell, so `cost`, `repairClause` and `walk` are
 * untouched; and fusing a connected set that already holds ONE colour cannot
 * invalidate the solution, because the colouring, every region and every area
 * count come out exactly as they were. All that changes is which squares have
 * to move together — so the board this writes is still solvable by construction
 * and the `solution` key still verifies.
 *
 * Two things it chooses to respect: at most one clue per merged cell — the
 * MODEL now allows several (one per square), but a fused clue pair changes
 * what the clues mean against the colouring the values were read off, so the
 * generator stays single-clue — and one connected polyomino. Growing only
 * into unclued, same-coloured, not-yet-claimed neighbours gives both.
 */
void fuseCells(const Model &model, const Colors &colors, SeededRng &rng,
               const int percent, Puzzle &puzzle) {
  Bits clued;
  for (const Clue &clue : puzzle.clues)
    clued.set(clue.index);

  const int budget = model.playableCount * percent / 100;
  Bits claimed;
  int fused = 0;
  for (int seed = model.playable.nextSet(0); seed >= 0 && fused < budget;
       seed = model.playable.nextSet(seed + 1)) {
    if (claimed.test(seed) || rng.uniform(0, 99) >= percent)
      continue;

    std::vector shape{seed};
    claimed.set(seed);
    // Grown one square at a time from the cell's own border, so what comes out
    // is connected however far it runs.
    const int want = rng.uniform(2, 4);
    while (static_cast<int>(shape.size()) < want) {
      const std::vector<int> options = growthOptions(
          model, colors, claimed, clued, shape, colors[slot(seed)]);
      if (options.empty())
        break;
      const int next =
          options[slot(rng.uniform(0, static_cast<int>(options.size()) - 1))];
      claimed.set(next);
      shape.push_back(next);
    }

    if (shape.size() < 2) {
      continue;
    }
    fused += static_cast<int>(shape.size());
    puzzle.shapes.push_back(std::move(shape));
  }
}

} // namespace

int run(const Options &options) {
  SeededRng rng(options.seed);
  const bool sparse = options.kind == "underclued";

  for (int attempt = 0; attempt < 8; attempt++) {
    Puzzle puzzle = emptyBoard(rng, options);
    const Model bare = buildModel(puzzle);
    Colors colors{};
    if (!paintLegal(bare, rng, colors))
      continue;

    deriveClues(bare, colors, rng, sparse, options, puzzle);
    // Off its own stream, and only when asked, so every seed that produced a
    // board before this existed still produces exactly that board.
    if (options.shapes > 0) {
      SeededRng shapeRng(options.seed ^ kShapeSalt);
      fuseCells(bare, colors, shapeRng, options.shapes, puzzle);
    }
    if (sparse)
      puzzle.ruleMask |= rules::bit(Rule::Underclued);
    if (structureProblem(puzzle) != Problem::None)
      continue;

    if (const Model model = buildModel(puzzle);
        verify::check(model, colors) != verify::Violation::None)
      continue;

    const fixtureio::Fixture fixture{
        .puzzle = puzzle, .hasSolution = true, .solution = colors};
    fixtureio::save(options.out, fixture);
    std::cout << "Wrote " << options.out << " (" << puzzle.width << "x"
              << puzzle.height << ", " << puzzle.clues.size() << " clues)\n";
    return 0;
  }

  std::cerr << "Could not build a solvable board for seed " << options.seed
            << "\n";
  return 1;
}

} // namespace lg::generate
