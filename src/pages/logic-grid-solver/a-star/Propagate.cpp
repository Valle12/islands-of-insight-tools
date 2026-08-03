#include "Propagate.h"

#include "Bitboard.h"
#include "Domains.h"
#include "Puzzle.h"
#include "Regions.h"
#include "Rules.h"
#include "Types.h"

#include <algorithm>
#include <array>
#include <bit>
#include <cstdint>

namespace lg {
namespace {

using rules::Rule;

// ---------------------------------------------------------------- clauses --

/**
 * One forbidden arrangement, read as the clause "at least one of these cells
 * holds the other colour".
 *
 * Nothing matches -> already satisfied. One cell left undecided and every
 * other one matching -> that cell must take the other colour. Everything
 * matching -> the arrangement is on the board, which is the contradiction the
 * rule exists to forbid.
 */
bool propagateClause(Domains &domains, const Clause &clause) {
  int freeCell = -1;
  uint8_t freeColor = kUnknown;
  for (int i = 0; i < clause.count; i++) {
    const int cell = clause.cells[slot(i)];
    const uint8_t want = clause.colors[slot(i)];
    const uint8_t held = domains.colorOf(cell);
    if (held == want)
      continue;
    if (held != kUnknown)
      return true;
    if (freeCell >= 0)
      return true;
    freeCell = cell;
    freeColor = want;
  }
  // Reaching here with no free cell means every cell matched: any cell holding
  // the other colour returned above.
  if (freeCell < 0)
    return false;
  return domains.exclude(freeCell, freeColor);
}

bool propagateClausesAt(const Model &model, Domains &domains, const int cell) {
  const int from = model.clauseStart[slot(cell)];
  const int to = model.clauseStart[slot(cell + 1)];
  for (int k = from; k < to; k++) {
    if (const int id = model.clauseIndex[slot(k)];
        !propagateClause(domains, model.clauses[slot(id)]))
      return false;
  }
  return true;
}

// ----------------------------------------------------------- connectivity --

bool excludeAll(Domains &domains, const Bits &cells, const uint8_t color) {
  for (int i = cells.nextSet(0); i >= 0; i = cells.nextSet(i + 1)) {
    if (!domains.exclude(i, color))
      return false;
  }
  return true;
}

bool assignAll(Domains &domains, const Bits &cells, const uint8_t color) {
  for (int i = cells.nextSet(0); i >= 0; i = cells.nextSet(i + 1)) {
    if (!domains.assign(i, color))
      return false;
  }
  return true;
}

/**
 * With `color` required to be one region: every cell already holding it has to
 * be reachable from every other through cells that may still hold it, and any
 * cell that cannot be reached from them at all can never hold it.
 *
 * The second half is the strong one, and it needs at least one cell already
 * holding the colour — with none, an empty colour class is a legal answer and
 * nothing is unreachable.
 */
bool connectColor(Domains &domains, const uint8_t color) {
  const Bits definite = domains.definite(color);
  const int seed = definite.nextSet(0);
  if (seed < 0)
    return true;
  const Bits reach = component(seed, domains.possible(color));
  if (!definite.isSubsetOf(reach))
    return false;
  return excludeAll(domains, domains.possible(color).without(reach), color);
}

/**
 * A connected colour carrying an area number has that many cells IN TOTAL, so
 * the whole colour class is counted rather than one region.
 */
bool cardinality(const Model &model, Domains &domains, const uint8_t color) {
  int target = 0;
  for (const int id : model.areaClues) {
    const Clue &clue = model.puzzle.clues[slot(id)];
    if (domains.colorOf(clue.index) != color)
      continue;
    if (target != 0 && target != clue.value)
      return false;
    target = clue.value;
  }
  if (target == 0)
    return true;

  const Bits definite = domains.definite(color);
  const Bits possible = domains.possible(color);
  const int held = definite.count();
  const int room = possible.count();
  if (held > target || room < target)
    return false;
  if (held == target)
    return excludeAll(domains, possible.without(definite), color);
  if (room == target)
    return assignAll(domains, possible, color);
  return true;
}

bool propagateConnectivity(const Model &model, Domains &domains) {
  constexpr auto kConnect = std::to_array<std::pair<Rule, uint8_t>>(
      {{Rule::ConnectDark, kDark}, {Rule::ConnectLight, kLight}});
  for (const auto &[rule, color] : kConnect) {
    if (!model.hasRule(rule))
      continue;
    if (!connectColor(domains, color))
      return false;
    if (!cardinality(model, domains, color))
      return false;
  }
  return true;
}

// ----------------------------------------------------------- region area --

/**
 * The half of an area rule the pattern table cannot carry: no region SMALLER
 * than the number. The other half — no region bigger — compiles into forbidden
 * trominoes and needs no code at all; see `Rules.cpp`.
 *
 * "This cell dark and all four of its neighbours light" would be a forbidden
 * arrangement too, except that an instance running off the board or across a gap
 * is dropped rather than shortened, and those are exactly the cells where it has
 * something to say. So it is done here instead, in two sweeps, both written for
 * an area of two:
 *
 * - a cell that MAY hold the colour with nothing beside it that could ever join
 *   it would be a region of one, so it cannot hold the colour. Four shifts find
 *   every such cell at once, with no flood fill. Where the cell already holds
 *   the colour the exclusion fails, and that is the refutation;
 * - a cell that DOES hold the colour has exactly one same-coloured neighbour, so
 *   when one candidate is left it is forced. A cell already paired finds its own
 *   partner here and the assignment is a no-op, which is why a finished region
 *   needs no special case.
 */
bool regionAreaTwo(Domains &domains, const uint8_t color) {
  const Bits possible = domains.possible(color);
  // `shiftDown` moves the SET down, so a cell lands in it when the cell ABOVE
  // it may take the colour. Reading each shift as "the neighbour that way" is
  // backwards; the union is the same set either way.
  if (const Bits touching = possible.shiftUp() | possible.shiftDown() |
                            possible.shiftLeft() | possible.shiftRight();
      !excludeAll(domains, possible.without(touching), color))
    return false;

  const Bits definite = domains.definite(color);
  for (int i = definite.nextSet(0); i >= 0; i = definite.nextSet(i + 1)) {
    // Re-read rather than reusing `possible`: the sweep above took cells out of
    // it, and excluding one cell can orphan the next.
    const Bits ways = oneCell(i).border() & domains.possible(color);
    if (ways.none())
      return false;
    if (ways.count() == 1 && !domains.assign(ways.nextSet(0), color))
      return false;
  }
  return true;
}

bool propagateRegionAreas(const Model &model, Domains &domains) {
  constexpr auto kAreaTwo = std::to_array<std::pair<Rule, uint8_t>>(
      {{Rule::AreaTwoDark, kDark}, {Rule::AreaTwoLight, kLight}});
  for (const auto &[rule, color] : kAreaTwo) {
    if (model.hasRule(rule) && !regionAreaTwo(domains, color))
      return false;
  }
  return true;
}

// ------------------------------------------------------------ area clues --

/// The region is finished, so nothing may join it.
bool outline(Domains &domains, const Bits &region, const uint8_t color) {
  return excludeAll(domains, region.border() & domains.possible(color), color);
}

/**
 * The clue's colour is still open. Either colour that cannot reach the number
 * at all is ruled out — and when both are, the board is contradictory.
 *
 * This is the only shape a hypothesis may take here: a conclusion drawn under
 * "suppose this cell is dark" can refute that supposition, never force an
 * unrelated cell.
 */
bool areaColorChoice(Domains &domains, const Clue &clue) {
  const bool darkFits =
      component(clue.index, domains.possible(kDark)).count() >= clue.value;
  const bool lightFits =
      component(clue.index, domains.possible(kLight)).count() >= clue.value;
  if (!darkFits && !lightFits)
    return false;
  if (darkFits == lightFits)
    return true;
  return domains.assign(clue.index, darkFits ? kDark : kLight);
}

/// The one cell every square of `bits` belongs to, or -1 when they span more
/// than one. On a plain board this is exactly `bits.count() == 1`.
int soleCell(const Model &model, const Bits &bits) {
  const int first = bits.nextSet(0);
  if (first < 0)
    return -1;
  const Bits mask = model.cellMask(first);
  return bits.isSubsetOf(mask) ? first : -1;
}

bool areaKnownColor(const Model &model, Domains &domains, const Clue &clue,
                    const uint8_t color) {
  const Bits region = component(clue.index, domains.definite(color));
  const int size = region.count();
  if (size > clue.value)
    return false;

  // The closure is every cell the region could still grow into. It is an
  // OVER-approximation on purpose: too big only weakens the "cannot reach the
  // number" test, while anything that shrank it without proof would make the
  // "exactly fits" test below paint cells that are not forced.
  const Bits closure = component(clue.index, domains.possible(color));
  const int room = closure.count();
  if (room < clue.value)
    return false;
  if (size == clue.value)
    return outline(domains, region, color);
  if (room == clue.value)
    return assignAll(domains, closure, color);

  // Short of the number with only one way to grow: that way must be taken.
  // One CELL, not one square — a region whose only way out is a merged cell
  // spanning three border squares is no less forced for that, and counting
  // squares here would miss it.
  const Bits frontier = region.border() & domains.possible(color);
  if (frontier.none())
    return false;
  if (const int only = soleCell(model, frontier); only >= 0)
    return domains.assign(only, color);
  return true;
}

bool propagateAreas(const Model &model, Domains &domains) {
  for (const int id : model.areaClues) {
    const Clue &clue = model.puzzle.clues[slot(id)];
    const uint8_t color = domains.colorOf(clue.index);
    const bool ok = color == kUnknown
                        ? areaColorChoice(domains, clue)
                        : areaKnownColor(model, domains, clue, color);
    if (!ok)
      return false;
  }
  return true;
}

// ---------------------------------------------------------------- letters --

/// Whether every cell of the group could still be `color` and lie in one piece.
bool groupFits(const Domains &domains, const LetterGroup &group,
               const uint8_t color) {
  const Bits &possible = domains.possible(color);
  if (!group.mask.isSubsetOf(possible))
    return false;
  return group.mask.isSubsetOf(component(group.cells.front(), possible));
}

bool paintGroup(Domains &domains, const LetterGroup &group,
                const uint8_t color) {
  for (const int cell : group.cells) {
    if (!domains.assign(cell, color))
      return false;
  }
  return true;
}

/**
 * Every cell of one letter shares a region, so they share a colour — which is
 * the strongest letter deduction there is and needs no colour to be known
 * first. Once the colour is known they also have to be able to reach each
 * other through cells that may still hold it.
 */
bool letterGroup(Domains &domains, const LetterGroup &group) {
  uint8_t color = kUnknown;
  for (const int cell : group.cells) {
    const uint8_t held = domains.colorOf(cell);
    if (held == kUnknown)
      continue;
    if (color != kUnknown && color != held)
      return false;
    color = held;
  }

  if (color == kUnknown) {
    const bool darkFits = groupFits(domains, group, kDark);
    const bool lightFits = groupFits(domains, group, kLight);
    if (!darkFits && !lightFits)
      return false;
    if (darkFits == lightFits)
      return true;
    return paintGroup(domains, group, darkFits ? kDark : kLight);
  }

  if (!paintGroup(domains, group, color))
    return false;
  return group.mask.isSubsetOf(
      component(group.cells.front(), domains.possible(color)));
}

bool propagateLetters(Domains &domains, const Model &model) {
  for (const LetterGroup &group : model.letters) {
    if (!letterGroup(domains, group))
      return false;
  }
  return true;
}

// -------------------------------------------------- one symbol per area --

/**
 * How far a clue's region could possibly stretch through cells that may still
 * hold `color`.
 *
 * An AREA clue bounds it: its region holds exactly `value` cells, so nothing in
 * it is more than `value - 1` steps away. A letter clue bounds nothing, so its
 * reach is the whole component. Over-approximating is the safe direction —
 * every cell the region could really contain has to be in here, or the caller
 * would rule out a colour that was legal.
 */
Bits clueReach(const Domains &domains, const Clue &clue, const uint8_t color) {
  const Bits &possible = domains.possible(color);
  if (clue.kind != kClueArea)
    return component(clue.index, possible);

  Bits reach = oneCell(clue.index);
  for (int step = 1; step < clue.value; step++) {
    const Bits grown = (reach.grown() & possible) | reach;
    if (grown == reach)
      break;
    reach = grown;
  }
  return reach;
}

/**
 * Every region of `color` carries exactly one clue — which is two deductions,
 * and the game's own tips name them "exactly one means less than two" and
 * "exactly one means more than zero".
 *
 * The first is a refutation: a finished piece already holding two clues can
 * never be legal. The second is where the work is, and it is the one that
 * paints: every cell of `color` has to end up sharing a region with a clue, so
 * a cell no clue can even REACH — through cells that may still take the colour,
 * and within an area number's own span — cannot hold it.
 *
 * That second half is also "tethering" and, once the pattern clauses see the
 * cells it settles, "area reach". Neither needs its own code: they are this
 * rule met by propagation.
 */
bool oneSymbolPerArea(const Model &model, Domains &domains,
                      const uint8_t color) {
  const Bits definite = domains.definite(color);
  Bits seen;
  for (int i = definite.nextSet(0); i >= 0; i = definite.nextSet(i + 1)) {
    if (seen.test(i))
      continue;
    const Bits piece = component(i, definite);
    seen = seen | piece;
    int clues = 0;
    for (int j = piece.nextSet(0); j >= 0; j = piece.nextSet(j + 1)) {
      if (model.clueAt[slot(j)] >= 0)
        clues++;
    }
    if (clues > 1)
      return false;
  }

  Bits reachable;
  for (const Clue &clue : model.puzzle.clues) {
    // A clue whose own cell cannot take this colour anchors no region of it.
    if (!domains.mayBe(clue.index, color))
      continue;
    reachable = reachable | clueReach(domains, clue, color);
  }
  return excludeAll(domains, domains.possible(color).without(reachable), color);
}

bool propagateSymbolCounts(const Model &model, Domains &domains) {
  constexpr auto kRules = std::to_array<std::pair<Rule, uint8_t>>(
      {{Rule::OneSymbolDark, kDark}, {Rule::OneSymbolLight, kLight}});
  for (const auto &[rule, color] : kRules) {
    if (model.hasRule(rule) && !oneSymbolPerArea(model, domains, color))
      return false;
  }
  return true;
}

// ----------------------------------------------------------------- merges --

/// What colouring one cell would join together.
struct MergeInfo {
  int total = 0;
  int minArea = 0;
  uint32_t letters = 0;
  /// Clues of any kind the joined piece would end up holding.
  int clues = 0;
};

/// One stamp per region id, so a merged cell's border scan can skip a region it
/// has already absorbed with nothing to clear between cells.
struct MergeScratch {
  std::vector<int> stamp;
  int pass = 0;
};

void absorb(MergeInfo &info, const int size, const int areaValue,
            const uint32_t letters, const int clues) {
  info.total += size;
  info.letters |= letters;
  info.clues += clues;
  if (areaValue > 0 && (info.minArea == 0 || areaValue < info.minArea))
    info.minArea = areaValue;
}

/// Whatever clue one square of the cell being coloured carries.
void absorbSquare(MergeInfo &info, const Model &model, const int index) {
  absorb(info, 0, model.areaValueAt(index), 0,
         model.clueAt[slot(index)] >= 0 ? 1 : 0);
  if (const int group = model.letterAt[slot(index)]; group >= 0)
    info.letters |= uint32_t{1} << model.letters[slot(group)].letter;
}

/// The regions a PLAIN square touches: at most four, so a scalar walk and a
/// four-entry seen list, which is what keeps this hot loop cheap.
void absorbPlainNeighbours(MergeInfo &info, const Regions &regions,
                           const int cell) {
  std::array seen{-1, -1, -1, -1};
  int found = 0;
  const int x = columnOf(cell);
  const int y = rowOf(cell);
  for (const auto &[dx, dy] : kSteps) {
    const int nx = x + dx;
    const int ny = y + dy;
    if (nx < 0 || nx >= kStride || ny < 0 || ny >= kMaxSide)
      continue;
    const int id = regions.id[slot(cellIndex(nx, ny))];
    if (id < 0 || std::ranges::find(seen, id) != seen.end())
      continue;
    seen[slot(found)] = id;
    found++;
    absorb(info, regions.size[slot(id)], regions.areaValue[slot(id)],
           regions.letters[slot(id)], regions.clues[slot(id)]);
  }
}

/// The regions a MERGED cell touches. It is adjacent to whatever any of its
/// squares touches, so the count is not bounded by four and the seen list above
/// cannot be reused.
void absorbMergedNeighbours(MergeInfo &info, const Regions &regions,
                            const Bits &mask, MergeScratch &scratch) {
  scratch.pass++;
  const Bits edge = mask.border();
  for (int i = edge.nextSet(0); i >= 0; i = edge.nextSet(i + 1)) {
    const int id = regions.id[slot(i)];
    if (id < 0 || scratch.stamp[slot(id)] == scratch.pass)
      continue;
    scratch.stamp[slot(id)] = scratch.pass;
    absorb(info, regions.size[slot(id)], regions.areaValue[slot(id)],
           regions.letters[slot(id)], regions.clues[slot(id)]);
  }
}

MergeInfo mergeAround(const Model &model, const Regions &regions,
                      const int cell, MergeScratch &scratch) {
  MergeInfo info;
  // What the cell itself brings. A merged cell brings ALL of its squares —
  // this is the whole of "a merged cell still counts for every square it is
  // made of" as far as an area number is concerned.
  info.total = model.cellSize(cell);

  if (model.shapeAt[slot(cell)] < 0) {
    absorbSquare(info, model, cell);
    absorbPlainNeighbours(info, regions, cell);
    return info;
  }

  const Bits mask = model.cellMask(cell);
  // A merged cell's one clue may sit on any of its squares.
  for (int i = mask.nextSet(0); i >= 0; i = mask.nextSet(i + 1))
    absorbSquare(info, model, i);
  absorbMergedNeighbours(info, regions, mask, scratch);
  return info;
}

/// A region that already contradicts itself — two area numbers that disagree,
/// two letters, or more cells than its own number allows.
bool regionsConsistent(const Regions &regions) {
  for (int id = 0; id < regions.count(); id++) {
    if (const int value = regions.areaValue[slot(id)];
        value == kAreaConflict ||
        (value > 0 && regions.size[slot(id)] > value))
      return false;
    if (std::popcount(regions.letters[slot(id)]) > 1)
      return false;
  }
  return true;
}

/**
 * Colouring a cell joins it to every piece of that colour it touches. When the
 * result would outgrow the smallest area number among them, or would put two
 * letters in one region, the cell cannot take that colour.
 *
 * This is the "near-miss" family of hand techniques — separating different
 * areas, not overloading one, keeping different letters apart — as a single
 * rule over the labelled pieces.
 */
bool mergeLimits(const Model &model, Domains &domains, const Regions &regions,
                 const uint8_t color) {
  // "Exactly one means less than two": with the rule on, a cell that would weld
  // two clued pieces of this colour into one is a cell that cannot take it.
  const bool oneSymbol = model.hasRule(
      color == kDark ? Rule::OneSymbolDark : Rule::OneSymbolLight);
  // One candidate per CELL: every square of a merged one would give the same
  // answer, and excluding any of them excludes all of them anyway.
  const Bits candidates = domains.undecided() & model.representatives;
  MergeScratch scratch;
  if (model.hasShapes)
    scratch.stamp.assign(slot(regions.count()), 0);
  for (int cell = candidates.nextSet(0); cell >= 0;
       cell = candidates.nextSet(cell + 1)) {
    const auto [total, minArea, letters, clues] =
        mergeAround(model, regions, cell, scratch);
    const bool tooBig = minArea > 0 && total > minArea;
    const bool twoLetters = std::popcount(letters) > 1;
    if (const bool twoSymbols = oneSymbol && clues > 1;
        (tooBig || twoLetters || twoSymbols) && !domains.exclude(cell, color))
      return false;
  }
  return true;
}

bool propagateMerges(const Model &model, Domains &domains) {
  // Each pass only ever takes cells OUT of its own colour, so the labelling it
  // is reading stays true for the whole pass; the other colour is relabelled
  // when its turn comes.
  for (const uint8_t color : {kDark, kLight}) {
    const Regions regions = labelRegions(domains.definite(color), model);
    if (!regionsConsistent(regions))
      return false;
    if (!mergeLimits(model, domains, regions, color))
      return false;
  }
  return true;
}

// ----------------------------------------------------------------- driver --

bool propagateGlobal(const Model &model, Domains &domains) {
  using enum Rule;
  if ((model.hasRule(ConnectDark) || model.hasRule(ConnectLight)) &&
      !propagateConnectivity(model, domains))
    return false;
  // Outside the `clued` guard below on purpose: a board can carry this rule and
  // no clues at all, and then nothing else here would run.
  if ((model.hasRule(AreaTwoDark) || model.hasRule(AreaTwoLight)) &&
      !propagateRegionAreas(model, domains))
    return false;
  if (!model.areaClues.empty() && !propagateAreas(model, domains))
    return false;
  if (!model.letters.empty() && !propagateLetters(domains, model))
    return false;
  if ((model.hasRule(OneSymbolDark) || model.hasRule(OneSymbolLight)) &&
      !propagateSymbolCounts(model, domains))
    return false;
  const bool clued = !model.areaClues.empty() || !model.letters.empty();
  return !clued || propagateMerges(model, domains);
}

} // namespace

bool propagate(const Model &model, Domains &domains) {
  bool changed = true;
  while (changed) {
    while (domains.hasPending()) {
      if (!propagateClausesAt(model, domains, domains.nextPending()))
        return false;
    }
    if (!propagateGlobal(model, domains))
      return false;
    changed = domains.hasPending();
  }
  return true;
}

bool applyGivens(const Model &model, Domains &domains) {
  for (int i = model.playable.nextSet(0); i >= 0;
       i = model.playable.nextSet(i + 1)) {
    // A painted cell is a GIVEN, so the answer has to keep it: an assignment
    // the domains refuse means the board as entered has no solution.
    if (const uint8_t given = model.puzzle.givens[slot(i)];
        (given == kDark || given == kLight) && !domains.assign(i, given))
      return false;
  }
  // A clause of ONE literal is a fact about the board rather than a consequence
  // of something decided, and nothing else here would ever read it: clauses are
  // only rescanned off the queue of newly decided squares, and at the root that
  // queue holds the givens and nothing else.
  //
  // A plain board cannot produce one — every forbidden arrangement names at
  // least two squares. A merged cell can, and it is the sharpest thing about
  // them: a 1x3 bar that is ONE cell under "no dark 1x3" compiles to the single
  // literal "this cell is not dark", so the whole bar is settled before
  // anything has to be guessed. One linear scan, at the root only.
  for (const auto &[cells, colors, count] : model.clauses) {
    if (count == 1 && !domains.exclude(cells.front(), colors.front()))
      return false;
  }
  return propagate(model, domains);
}

} // namespace lg
