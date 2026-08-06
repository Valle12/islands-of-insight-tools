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
 *
 * The clues' candidate sets are intersected exactly, never read as an
 * interval — with everything decided at a displayed value itself, both of its
 * off-by-one candidates fail the per-candidate filter while an interval test
 * would pass, and that filter equalling the oracle at a complete assignment
 * is what keeps `oracleRejections` at zero. A `seen` flag replaces the old
 * zero sentinel for "no clue yet", because under the rule a displayed 0 is a
 * real clue whose one candidate is 1.
 */
/// The EXACT intersection of two candidate sets — a set holds at most two
/// values, so membership is a comparison against each end. This is where the
/// off-by-2 trick falls out: {a-1, a+1} ∩ {b-1, b+1} with |a - b| == 2 is the
/// single value between them.
ClueCandidates intersect(const ClueCandidates &band,
                         const ClueCandidates &candidates) {
  ClueCandidates merged;
  for (int i = 0; i < candidates.count; i++) {
    if (const int value = candidates.values[slot(i)];
        !band.empty() && (value == band.lo() || value == band.hi()))
      merged.add(value);
  }
  return merged;
}

bool cardinality(const Model &model, Domains &domains, const uint8_t color) {
  ClueCandidates band;
  bool clued = false;
  for (const int id : model.areaClues) {
    const Clue &clue = model.puzzle.clues[slot(id)];
    if (domains.colorOf(clue.index) != color)
      continue;
    const ClueCandidates candidates = model.candidatesFor(clue);
    band = clued ? intersect(band, candidates) : candidates;
    clued = true;
    if (band.empty())
      return false;
  }
  if (!clued)
    return true;

  const Bits definite = domains.definite(color);
  const Bits possible = domains.possible(color);
  const int held = definite.count();
  const int room = possible.count();
  const ClueCandidates feasible = band.feasible(held, room);
  if (feasible.empty())
    return false;
  if (held == feasible.hi())
    return excludeAll(domains, possible.without(definite), color);
  if (room == feasible.lo())
    return assignAll(domains, possible, color);
  return true;
}

/**
 * The two-arc lemma, `Model::borderCycle`'s comment carries the proof: with
 * both colours connected, the decided colours around the outer perimeter form
 * at most one arc each — more than two cyclic transitions refutes, and an
 * undecided perimeter square strictly inside one arc cannot take the other
 * colour, because transitions of a cyclic subsequence never exceed the full
 * sequence's, so any completion would carry the four arcs with it.
 *
 * `connectColor` is what equals the oracle at a complete assignment; this
 * refuses only colourings the lemma proves disconnected, so refusals stay a
 * subset of the oracle's and `oracleRejections` stays 0.
 */
bool borderArcs(const Model &model, Domains &domains) {
  const std::vector<int16_t> &cycle = model.borderCycle;
  const auto n = static_cast<int>(cycle.size());
  if (n == 0)
    return true;

  // The decided colour per cycle slot, kUnknown where the square is open.
  std::array<uint8_t, 4 * kMaxSide> state{};
  int decided = 0;
  int transitions = 0;
  int previous = -1;
  int first = -1;
  for (int i = 0; i < n; i++) {
    const uint8_t color = domains.colorOf(cycle[slot(i)]);
    state[slot(i)] = color;
    if (color == kUnknown)
      continue;
    decided++;
    if (previous >= 0 && state[slot(previous)] != color)
      transitions++;
    if (first < 0)
      first = i;
    previous = i;
  }
  if (decided >= 2 && state[slot(first)] != state[slot(previous)])
    transitions++;
  if (transitions > 2)
    return false;
  if (transitions < 2)
    return true;

  // Exactly two arcs: an open square whose decided neighbours (cyclically)
  // agree sits inside one of them, and taking the other colour would start a
  // third. Both directions' nearest decided colour, then one pass.
  std::array<uint8_t, 4 * kMaxSide> before{};
  std::array<uint8_t, 4 * kMaxSide> after{};
  uint8_t running = state[slot(previous)];
  for (int i = 0; i < n; i++) {
    before[slot(i)] = running;
    if (state[slot(i)] != kUnknown)
      running = state[slot(i)];
  }
  running = state[slot(first)];
  for (int i = n - 1; i >= 0; i--) {
    after[slot(i)] = running;
    if (state[slot(i)] != kUnknown)
      running = state[slot(i)];
  }
  for (int i = 0; i < n; i++) {
    if (state[slot(i)] != kUnknown || before[slot(i)] != after[slot(i)])
      continue;
    if (!domains.exclude(cycle[slot(i)], opposite(before[slot(i)])))
      return false;
  }
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
  return borderArcs(model, domains);
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
bool areaColorChoice(const Model &model, Domains &domains, const Clue &clue) {
  const ClueCandidates candidates = model.candidatesFor(clue);
  if (candidates.empty())
    return false;
  // A colour fits when the region could reach the SMALLEST candidate at all;
  // whether it lands on a candidate exactly is `areaKnownColor`'s question
  // once the colour is settled.
  const int least = candidates.lo();
  const bool darkFits =
      component(clue.index, domains.possible(kDark)).count() >= least;
  const bool lightFits =
      component(clue.index, domains.possible(kLight)).count() >= least;
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

  // The closure is every cell the region could still grow into. It is an
  // OVER-approximation on purpose: too big only weakens the "cannot reach the
  // number" test, while anything that shrank it without proof would make the
  // "exactly fits" test below paint cells that are not forced.
  const Bits closure = component(clue.index, domains.possible(color));
  const int room = closure.count();

  // Filtered PER CANDIDATE — a region walled in at exactly the displayed
  // value satisfies neither of its off-by-one candidates, which an interval
  // test would miss. With the rule off this is exactly the old pair of
  // bounds, `size > value` and `room < value`, in one step.
  const ClueCandidates feasible =
      model.candidatesFor(clue).feasible(size, room);
  if (feasible.empty())
    return false;
  if (size == feasible.hi())
    return outline(domains, region, color);
  if (room == feasible.lo())
    return assignAll(domains, closure, color);

  // Short of EVERY candidate with only one way to grow: that way must be
  // taken. One CELL, not one square — a region whose only way out is a merged
  // cell spanning three border squares is no less forced for that, and
  // counting squares here would miss it.
  if (size < feasible.lo()) {
    const Bits frontier = region.border() & domains.possible(color);
    if (frontier.none())
      return false;
    if (const int only = soleCell(model, frontier); only >= 0)
      return domains.assign(only, color);
  }
  return true;
}

bool propagateAreas(const Model &model, Domains &domains) {
  for (const int id : model.areaClues) {
    const Clue &clue = model.puzzle.clues[slot(id)];
    const uint8_t color = domains.colorOf(clue.index);
    const bool ok = color == kUnknown
                        ? areaColorChoice(model, domains, clue)
                        : areaKnownColor(model, domains, clue, color);
    if (!ok)
      return false;
  }
  return true;
}

// ----------------------------------------------------------- region area --

/**
 * Anything that may hold `color` but could never gather `area` of it. Subsumes
 * `regionArea`'s shift sweep for larger areas, and catches the cells no
 * definite region reaches.
 *
 * `open` is snapshotted, so a piece excluded below stays in it — which is why
 * every piece is marked visited whatever happens to it, rather than only the
 * ones that survive. Reading a stale `open` can only make a piece look BIGGER
 * than it still is, so it under-deduces and never over-deduces, and the
 * fixpoint picks up whatever this pass left.
 */
bool pruneSmallPieces(Domains &domains, const uint8_t color, const int area) {
  Bits visited;
  const Bits open = domains.possible(color);
  for (int i = open.nextSet(0); i >= 0; i = open.nextSet(i + 1)) {
    if (visited.test(i))
      continue;
    const Bits piece = component(i, open);
    visited = visited | piece;
    if (piece.count() < area && !excludeAll(domains, piece, color))
      return false;
  }
  return true;
}

/**
 * "Every region of `color` has exactly `area` cells", enforced whole.
 *
 * An area CLUE names one region and knows where it is; this names all of them
 * and nothing points at any, so it is the same reasoning walked region by
 * region — which is why the body below is `areaKnownColor` applied to each
 * piece of the colour rather than to one clue's.
 *
 * Half of an area-TWO rule also compiles into forbidden trominoes, and this
 * still runs beside them: the clauses are cheaper per firing, and duplicating
 * a deduction costs nothing but a little time. Area FOUR has no clauses at all
 * — the same argument there asks for 61 pentominoes — so for that size this is
 * the whole of the rule. Either way it is not an optimisation: with a complete
 * colouring `possible` and `definite` agree, so an oversized region hits `size
 * > area` and an undersized one hits `room < area`, which is what keeps
 * `oracleRejections` at zero.
 */
bool regionArea(const Model &model, Domains &domains, const uint8_t color,
                const int area) {
  // A cell that MAY hold the colour with nothing beside it that could ever
  // join it is a region of one. Four shifts find every such cell at once, so
  // the common case never reaches a flood fill below. Sound for any area of
  // two or more, which is every area rule there is.
  const Bits possible = domains.possible(color);
  if (const Bits touching = possible.shiftUp() | possible.shiftDown() |
                            possible.shiftLeft() | possible.shiftRight();
      !excludeAll(domains, possible.without(touching), color))
    return false;

  Bits seen;
  const Bits definite = domains.definite(color);
  for (int i = definite.nextSet(0); i >= 0; i = definite.nextSet(i + 1)) {
    if (seen.test(i))
      continue;
    const Bits region = component(i, definite);
    seen = seen | region;
    if (region.count() > area)
      return false;

    // Re-read `possible` per region rather than hoisting it: excluding a cell
    // for one region can orphan a cell the next one was counting on.
    const Bits closure = component(i, domains.possible(color));
    const int room = closure.count();
    if (room < area)
      return false;
    if (region.count() == area) {
      if (!outline(domains, region, color))
        return false;
      continue;
    }
    if (room == area) {
      if (!assignAll(domains, closure, color))
        return false;
      continue;
    }
    // Short of the number with one way to grow: that way must be taken. One
    // CELL, not one square — a region whose only way out is a merged cell
    // spanning three border squares is no less forced for that.
    const Bits frontier = region.border() & domains.possible(color);
    if (const int only = soleCell(model, frontier);
        only >= 0 && !domains.assign(only, color))
      return false;
  }

  return pruneSmallPieces(domains, color, area);
}

bool propagateRegionAreas(const Model &model, Domains &domains) {
  // Walked as a family, so BOTH sizes on for one colour run both — which is
  // right: the only colourings that survive are the ones with none of that
  // colour at all, and a single "the area is N" number could not say that.
  for (const auto &[rule, color, area] : rules::kAreaFamily) {
    if (model.hasRule(rule) && !regionArea(model, domains, color, area))
      return false;
  }
  return true;
}

// ------------------------------------------------------------------ darts --

/**
 * A dart counts the squares of the other colour along its own line, and once
 * its own colour is settled that is an exact cardinality constraint: `value` of
 * the line's squares hold `other` and the rest hold the dart's colour.
 *
 * Walked one CELL at a time rather than one square at a time, which costs the
 * same and says more. A merged cell puts `w` squares on the line at once, so
 * it is excluded as soon as `w` would overshoot and forced as soon as leaving
 * it out would undershoot — the game's "forced multitiles", falling out of the
 * counting rather than needing a look-ahead to find. At `w == 1` this is the
 * ordinary "the line is exactly full / exactly empty" pair.
 */
bool dartCardinality(const Model &model, Domains &domains, const Dart &dart,
                     const uint8_t color) {
  const uint8_t other = opposite(color);
  const int held = (domains.definite(other) & dart.ray).count();
  const int room = (domains.possible(other) & dart.ray).count();
  // Per-candidate feasibility, not an interval: a line settled at exactly the
  // displayed value satisfies neither off-by-one candidate. At a complete
  // assignment held == room == the real count, so this equals the oracle.
  const Clue &clue = model.puzzle.clues[slot(dart.clueId)];
  const ClueCandidates feasible =
      model.candidatesFor(clue).feasible(held, room);
  if (feasible.empty())
    return false;

  // Walked by the ray's own squares, taking each cell the FIRST time one of its
  // squares turns up. Intersecting with `representatives` instead would drop a
  // merged cell whose lowest-indexed square happens to lie off the line — which
  // is most of them, since the line is one row or column wide.
  //
  // `held` and `room` are not refreshed as cells are decided below. Staleness
  // can only weaken these two tests, never fire one wrongly, and `propagate`
  // re-runs this to a fixpoint, so anything missed is picked up next round.
  Bits seen;
  const Bits open = domains.undecided() & dart.ray;
  for (int i = open.nextSet(0); i >= 0; i = open.nextSet(i + 1)) {
    if (seen.test(i))
      continue;
    const Bits mask = model.cellMask(i);
    seen = seen | mask;
    const int weight = (mask & dart.ray).count();
    // Taking this cell overshoots every candidate still open; leaving it out
    // undershoots them all. Both at once is a contradiction, and it reports
    // itself: the exclusion leaves the cell holding one colour and the
    // assignment then asks for the other, which empties the domain.
    if (held + weight > feasible.hi() && !domains.exclude(i, other))
      return false;
    if (room - weight < feasible.lo() && !domains.assign(i, other))
      return false;
  }
  return true;
}

/**
 * The dart's own colour is still open, so it does not yet say which colour it
 * counts. Either assumption that cannot be satisfied at all is ruled out.
 *
 * Same shape and same discipline as `areaColorChoice`: a conclusion drawn under
 * "suppose this cell is dark" may refute that supposition and nothing else.
 */
bool dartColorChoice(const Model &model, Domains &domains, const Dart &dart) {
  const Clue &clue = model.puzzle.clues[slot(dart.clueId)];
  const ClueCandidates candidates = model.candidatesFor(clue);
  const auto fits = [&domains, &dart, &candidates](const uint8_t color) {
    const uint8_t other = opposite(color);
    const int held = (domains.definite(other) & dart.ray).count();
    const int room = (domains.possible(other) & dart.ray).count();
    return !candidates.feasible(held, room).empty();
  };
  const bool darkFits = fits(kDark);
  const bool lightFits = fits(kLight);
  if (!darkFits && !lightFits)
    return false;
  if (darkFits == lightFits)
    return true;
  return domains.assign(dart.index, darkFits ? kDark : kLight);
}

bool propagateDarts(const Model &model, Domains &domains) {
  for (const Dart &dart : model.darts) {
    const uint8_t color = domains.colorOf(dart.index);
    const bool ok = color == kUnknown
                        ? dartColorChoice(model, domains, dart)
                        : dartCardinality(model, domains, dart, color);
    if (!ok)
      return false;
  }
  return true;
}

// ---------------------------------------------------------------- lotuses --

/**
 * The shared engine of the two SYMMETRY clues — the lotus's mirror across an
 * axis and the galaxy's half turn about its own square. Both require the
 * connected same-colour region holding the clue to map to itself under the
 * clue's mirror map, and the whole fold below reads nothing but that map:
 * which geometry built it stays with the owner.
 *
 * With the clue's own colour decided this propagates in both directions at
 * once. Every square already connected to the clue through DECIDED cells is
 * certainly in the region whatever happens next, so its mirror must take the
 * same colour — the game's "opposing cells", with "opposing nulls" as the
 * refutation when the mirror leaves the board. And a cell beside that core
 * would JOIN the region the moment it took the colour, so one of its squares
 * reflecting somewhere the colour can never be keeps the whole cell out.
 *
 * With the colour's CONNECT rule on, both nets widen to the whole board: every
 * solution holds the colour in ONE region, and the clue's own cell is in it,
 * so the region is provably the entire colour. A decided square then mirrors
 * wherever it lies, connected to the clue or not, and EVERY undecided cell is
 * fringe — including one whose mirror is already the other colour, which is
 * how the fold reaches the opposite colour too: the mirror of a decided dark
 * square cannot take light, so it goes dark. One symmetry clue plus one
 * connectivity rule folds the board in half, which is the coupling the
 * viewpoint-era boards lean on hardest.
 *
 * At a complete assignment the core IS the whole region — under the connect
 * rule because `propagateConnectivity` has already refused any split — and the
 * first loop checks exactly what `verify::lotusProblem` and
 * `verify::galaxyProblem` check, which is what keeps `oracleRejections` at
 * zero.
 */
bool mirrorSymmetry(const Model &model, Domains &domains,
                    const std::array<int16_t, kMaxCells> &mirror,
                    const int index, const uint8_t color) {
  const uint8_t other = opposite(color);
  const bool wholeColor = model.hasRule(color == kDark ? Rule::ConnectDark
                                                       : Rule::ConnectLight);
  const Bits core = wholeColor ? domains.definite(color)
                               : component(index, domains.definite(color));
  for (int i = core.nextSet(0); i >= 0; i = core.nextSet(i + 1)) {
    const int reflected = mirror[slot(i)];
    if (reflected < 0 || !model.playable.test(reflected))
      return false;
    if (!domains.exclude(reflected, other))
      return false;
  }

  // Whole CELLS on the fringe, because a merged cell joins with every square
  // it has. `colorOf(reflected) == other` is a DECIDED other only — an open
  // mirror may yet take the colour, so it restricts nothing.
  Bits seen;
  const Bits fringe = wholeColor ? domains.undecided()
                                 : core.grown() & domains.undecided();
  for (int i = fringe.nextSet(0); i >= 0; i = fringe.nextSet(i + 1)) {
    if (seen.test(i))
      continue;
    const Bits mask = model.cellMask(i);
    seen = seen | mask;
    for (int j = mask.nextSet(0); j >= 0; j = mask.nextSet(j + 1)) {
      if (const int reflected = mirror[slot(j)];
          reflected >= 0 && model.playable.test(reflected) &&
          domains.colorOf(reflected) != other)
        continue;
      if (!domains.exclude(i, color))
        return false;
      break;
    }
  }
  return true;
}

/**
 * With the lotus's cell still open nothing fires, on purpose: which colour its
 * region even is is unknown. The probe cascade covers that case — trying both
 * colours of the lotus's cell runs this propagator under each hypothesis and
 * keeps what both agree on, which is exactly the game's "uncoloured symmetry"
 * technique falling out of machinery that already existed.
 */
bool propagateLotuses(const Model &model, Domains &domains) {
  for (const Lotus &lotus : model.lotuses) {
    const uint8_t color = domains.colorOf(lotus.index);
    if (color == kUnknown)
      continue;
    if (!mirrorSymmetry(model, domains, lotus.mirror, lotus.index, color))
      return false;
  }
  return true;
}

/// The galaxy's dispatch, the lotus's twice over: skip while its cell's colour
/// is open — the probe cascade is the game's "uncoloured symmetry" for the
/// half turn too — and hand the decided case to the shared fold. That two
/// galaxies can never share a region is deliberately CODED NOWHERE: two half
/// turns compose to a translation no finite region survives, so it emerges
/// from this propagator meeting the probe, and the reference sweep referees.
bool propagateGalaxies(const Model &model, Domains &domains) {
  for (const Galaxy &galaxy : model.galaxies) {
    const uint8_t color = domains.colorOf(galaxy.index);
    if (color == kUnknown)
      continue;
    if (!mirrorSymmetry(model, domains, galaxy.mirror, galaxy.index, color))
      return false;
  }
  return true;
}

// ------------------------------------------------------------- viewpoints --

/// One ray's leading runs from the clue outward: how many squares are already
/// decided `color` before anything else appears (`held`), and how many could
/// still be `color` before something never can (`room`). The ray's final
/// visible run always lies between the two.
struct RayReach {
  int held = 0;
  int room = 0;
};

RayReach rayReach(const Domains &domains, const std::vector<int16_t> &ray,
                  const uint8_t color) {
  RayReach reach;
  const Bits &possible = domains.possible(color);
  bool leading = true;
  for (const int16_t square : ray) {
    if (!possible.test(square))
      break;
    reach.room++;
    if (leading && domains.colorOf(square) == color)
      reach.held++;
    else
      leading = false;
  }
  return reach;
}

/**
 * A viewpoint's count with its own colour settled: one for its own square plus
 * the leading same-colour run along each ray. Each run is bracketed between
 * its `held` and its `room`, so the total is too, and the two bounds prune in
 * both directions — "too few squares left to see" is the game's viewpoint
 * expansion, and "already seeing every one of them" is what caps a ray.
 *
 * Beyond the refutation, each ray is bracketed AGAINST the other three: it
 * must supply at least what the others cannot (`lo`) and at most what they can
 * spare (`hi`). The first `lo` squares are then visible in every completion
 * and take the colour; and a ray already decided out to its cap must stop
 * there, so the square beyond loses it. Both forces fan over a merged cell
 * through `Domains::exclude`, and a cell straddling a boundary reports the
 * contradiction itself, exactly as in `dartCardinality`.
 *
 * `held`/`room` go stale as forces land, which can only weaken later tests —
 * `propagate` re-runs this to a fixpoint, the dart's discipline again. At a
 * complete assignment held == room == the real run on every ray, so the
 * refutation is exactly `verify::viewpointProblem`'s equality — which is what
 * keeps `oracleRejections` at zero.
 */
bool viewpointSight(const Model &model, Domains &domains,
                    const Viewpoint &viewpoint, const uint8_t color) {
  std::array<RayReach, kDirectionCount> reaches;
  int heldTotal = 0;
  int roomTotal = 0;
  for (int direction = 0; direction < kDirectionCount; direction++) {
    reaches[slot(direction)] =
        rayReach(domains, viewpoint.rays[slot(direction)], color);
    heldTotal += reaches[slot(direction)].held;
    roomTotal += reaches[slot(direction)].room;
  }
  // A candidate COUNT of c needs c - 1 visible squares beyond the clue's own,
  // so a count is feasible when the rays' totals bracket c - 1 — filtered per
  // candidate, since a sight settled at exactly the displayed value satisfies
  // neither off-by-one candidate. At a complete assignment held == room ==
  // the real run on every ray, so the refutation equals the oracle.
  const Clue &clue = model.puzzle.clues[slot(viewpoint.clueId)];
  const ClueCandidates counts =
      model.candidatesFor(clue).feasible(heldTotal + 1, roomTotal + 1);
  if (counts.empty())
    return false;
  const int needLo = counts.lo() - 1;
  const int needHi = counts.hi() - 1;

  for (int direction = 0; direction < kDirectionCount; direction++) {
    const auto &[held, room] = reaches[slot(direction)];
    const std::vector<int16_t> &ray = viewpoint.rays[slot(direction)];
    // A ray must supply at least what the others cannot under EVERY candidate
    // (`needLo` against their total room) and may supply at most what they
    // can spare under SOME (`needHi` against their total held). `lo <= hi`
    // needs no guard: it rearranges to facts the feasibility filter above
    // already established, and held <= room per ray by construction.
    const int lo = std::max(held, needLo - (roomTotal - room));
    const int hi = std::min(room, needHi - (heldTotal - held));
    for (int i = held; i < lo; i++) {
      if (!domains.assign(ray[slot(i)], color))
        return false;
    }
    if (held == hi && hi < static_cast<int>(ray.size()) &&
        !domains.exclude(ray[slot(hi)], color))
      return false;
  }
  return true;
}

/**
 * The viewpoint's own colour is still open, so it does not yet say which
 * colour it counts. Either assumption that cannot be satisfied at all is ruled
 * out — the refute-only-yourself shape of `dartColorChoice`, and the probe
 * cascade does the rest, exactly as it does for an uncoloured lotus.
 */
bool viewpointColorChoice(const Model &model, Domains &domains,
                          const Viewpoint &viewpoint) {
  const Clue &clue = model.puzzle.clues[slot(viewpoint.clueId)];
  const ClueCandidates candidates = model.candidatesFor(clue);
  const auto fits = [&domains, &viewpoint, &candidates](const uint8_t color) {
    int held = 0;
    int room = 0;
    for (const std::vector<int16_t> &ray : viewpoint.rays) {
      const auto [rayHeld, rayRoom] = rayReach(domains, ray, color);
      held += rayHeld;
      room += rayRoom;
    }
    return !candidates.feasible(held + 1, room + 1).empty();
  };
  const bool darkFits = fits(kDark);
  const bool lightFits = fits(kLight);
  if (!darkFits && !lightFits)
    return false;
  if (darkFits == lightFits)
    return true;
  return domains.assign(viewpoint.index, darkFits ? kDark : kLight);
}

bool propagateViewpoints(const Model &model, Domains &domains) {
  for (const Viewpoint &viewpoint : model.viewpoints) {
    const uint8_t color = domains.colorOf(viewpoint.index);
    const bool ok = color == kUnknown
                        ? viewpointColorChoice(model, domains, viewpoint)
                        : viewpointSight(model, domains, viewpoint, color);
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
Bits clueReach(const Model &model, const Domains &domains, const Clue &clue,
               const uint8_t color) {
  const Bits &possible = domains.possible(color);
  if (clue.kind != kClueArea)
    return component(clue.index, possible);

  // The LARGEST candidate bounds the span — over-approximating is the safe
  // direction here, and a clue whose candidate set is empty is a structural
  // contradiction someone else names, so it falls back to the whole component
  // rather than shrinking the reach without proof.
  const ClueCandidates candidates = model.candidatesFor(clue);
  if (candidates.empty())
    return component(clue.index, possible);
  Bits reach = oneCell(clue.index);
  for (int step = 1; step < candidates.hi(); step++) {
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
    reachable = reachable | clueReach(model, domains, clue, color);
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

void absorb(MergeInfo &info, const int size, const int areaHi,
            const uint32_t letters, const int clues) {
  info.total += size;
  info.letters |= letters;
  info.clues += clues;
  // The LARGEST candidate each source allows, min-tracked across sources:
  // the weakest bound every clue in the weld can live with.
  if (areaHi > 0 && (info.minArea == 0 || areaHi < info.minArea))
    info.minArea = areaHi;
}

/// Whatever clue one square of the cell being coloured carries. An area clue
/// contributes its LARGEST candidate count — the weakest sound bound for the
/// too-big test, and the reason this no longer reads `areaValueAt`: under
/// `off-by-one` a displayed 0 is a real clue whose one candidate is 1, which
/// that accessor's zero-means-none sentinel would swallow.
void absorbSquare(MergeInfo &info, const Model &model, const int index) {
  int areaHi = 0;
  if (const int clueId = model.clueAt[slot(index)]; clueId >= 0) {
    if (const Clue &clue = model.puzzle.clues[slot(clueId)];
        clue.kind == kClueArea) {
      const ClueCandidates candidates = model.candidatesFor(clue);
      areaHi = candidates.empty() ? 0 : candidates.hi();
    }
  }
  absorb(info, 0, areaHi, 0, model.clueAt[slot(index)] >= 0 ? 1 : 0);
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
    absorb(info, regions.size[slot(id)], regions.areaHi[slot(id)],
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
    absorb(info, regions.size[slot(id)], regions.areaHi[slot(id)],
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
  // A merged cell may carry a clue on any of its squares — several, even.
  for (int i = mask.nextSet(0); i >= 0; i = mask.nextSet(i + 1))
    absorbSquare(info, model, i);
  absorbMergedNeighbours(info, regions, mask, scratch);
  return info;
}

/// A region that already contradicts itself — area numbers whose candidate
/// sets share nothing, two letters, or more cells than even the LARGEST
/// candidate allows. Only the upper end binds a DEFINITE region: it can still
/// grow, so falling short of the lower one proves nothing yet.
bool regionsConsistent(const Regions &regions) {
  for (int id = 0; id < regions.count(); id++) {
    if (const int hi = regions.areaHi[slot(id)];
        hi == kAreaConflict || (hi > 0 && regions.size[slot(id)] > hi))
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
 *
 * A global area RULE is one more source of that same number, and cheaply worth
 * having: `regionArea` walks whole components, so it cannot see that colouring
 * one particular cell is what would weld two legal pieces into an illegal one.
 * The smallest active area is the binding bound, since the rules are
 * conjunctive.
 */
bool mergeLimits(const Model &model, Domains &domains, const Regions &regions,
                 const uint8_t color) {
  // "Exactly one means less than two": with the rule on, a cell that would weld
  // two clued pieces of this colour into one is a cell that cannot take it.
  const bool oneSymbol = model.hasRule(
      color == kDark ? Rule::OneSymbolDark : Rule::OneSymbolLight);
  const int ruleArea =
      rules::smallestGlobalArea(model.puzzle.ruleMask, color);
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
    const int limit = minArea > 0 && (ruleArea == 0 || minArea < ruleArea)
                          ? minArea
                          : ruleArea;
    const bool tooBig = limit > 0 && total > limit;
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

/// Whether any area rule at all is on. Asked as a family, so an area rule
/// appended to the catalogue cannot go unpropagated because this line was not
/// updated with it.
bool hasAreaRule(const Model &model) {
  return std::ranges::any_of(rules::kAreaFamily, [&model](const auto &row) {
    return model.hasRule(row.rule);
  });
}

bool propagateGlobal(const Model &model, Domains &domains) {
  using enum Rule;
  if ((model.hasRule(ConnectDark) || model.hasRule(ConnectLight)) &&
      !propagateConnectivity(model, domains))
    return false;
  // Outside the `clued` guard below on purpose: a board can carry this rule and
  // no clues at all, and then nothing else here would run.
  if (hasAreaRule(model) && !propagateRegionAreas(model, domains))
    return false;
  if (!model.areaClues.empty() && !propagateAreas(model, domains))
    return false;
  if (!model.darts.empty() && !propagateDarts(model, domains))
    return false;
  if (!model.lotuses.empty() && !propagateLotuses(model, domains))
    return false;
  if (!model.viewpoints.empty() && !propagateViewpoints(model, domains))
    return false;
  if (!model.galaxies.empty() && !propagateGalaxies(model, domains))
    return false;
  if (!model.letters.empty() && !propagateLetters(domains, model))
    return false;
  if ((model.hasRule(OneSymbolDark) || model.hasRule(OneSymbolLight)) &&
      !propagateSymbolCounts(model, domains))
    return false;
  // Exactly what `propagateMerges` can say something about: how big a region
  // may be, from a clue OR from a rule, and how many clues or letters it may
  // hold. A dart is a symbol for "one symbol per area" — which is why the rule
  // is asked about rather than the clue list, since a board can carry the rule
  // with nothing but darts on it — but it says nothing about a region's size,
  // so a dart-only board with none of these must not pay for the pass.
  const bool merges = !model.areaClues.empty() || !model.letters.empty() ||
                      model.hasRule(OneSymbolDark) ||
                      model.hasRule(OneSymbolLight) || hasAreaRule(model);
  return !merges || propagateMerges(model, domains);
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
