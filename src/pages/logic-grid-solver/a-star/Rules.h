#pragma once

#include "Types.h"

#include <array>
#include <cstdint>
#include <utility>
#include <vector>

// The board-wide rules, and the one mechanism most of them share.
//
// Rules 0..10 all say the same kind of thing: a particular little arrangement
// of colours may not appear anywhere. They are therefore not written out one by
// one — they COMPILE into a table of forbidden patterns, and a single
// propagator drives the lot. The 1x5 pair arrived that way: one row in
// `shortestRun`, one enum entry, and no new code anywhere. An L-tromino would
// be the same, and it would slot in beside its neighbours rather than on the
// end, because this list is grouped by family.
//
// Rules 11..14 talk about whole REGIONS — that a colour is all one piece, or
// that every piece of it carries exactly one clue — and each gets its own
// propagator. Rule 15 is not a colouring rule at all.
//
// Rules 16..17 are half and half, and are the second time the table above has
// been cashed in. "Every dark region has area 2" is two statements: no region
// larger than two, and none smaller. The first one IS a forbidden arrangement —
// a connected set of three or more cells always contains a connected THREE, and
// the connected trominoes are exactly the two straight ones plus the four
// L-shapes — so it compiles into the table and costs no new code. The second
// cannot: "this cell dark and all four neighbours light" is only forbidden where
// all four neighbours exist, and an instance touching a gap is dropped rather
// than shortened. That half is a propagator; see `Propagate.cpp`.
namespace lg::rules {

/// Indices into RULES in rules.ts. That list is append-only, so these are
/// permanent: a saved puzzle stores the index of every rule it switches on.
enum class Rule : uint8_t {
  // The forbidden arrangements, 0..10, dark before light in every pair.
  NoDark2x2 = 0,
  NoLight2x2 = 1,
  NoDark1x2 = 2,
  NoLight1x2 = 3,
  NoDark1x3 = 4,
  NoLight1x3 = 5,
  NoDark1x4 = 6,
  NoLight1x4 = 7,
  NoDark1x5 = 8,
  NoLight1x5 = 9,
  NoCheckerboard = 10,
  // The ones that talk about whole regions.
  ConnectDark = 11,
  ConnectLight = 12,
  OneSymbolDark = 13,
  OneSymbolLight = 14,
  // Not a colouring rule at all — it changes what the answer IS.
  Underclued = 15,
  // Region sizes. Appended, like everything after the one reorder, so they sit
  // past `Underclued` here while `rules.ts` draws them beside the connect rules.
  AreaTwoDark = 16,
  AreaTwoLight = 17,
};

inline constexpr int kRuleCount = 18;

/// The active rules as a bit per index.
using RuleMask = uint32_t;

constexpr RuleMask bit(const Rule rule) {
  return RuleMask{1} << std::to_underlying(rule);
}

constexpr bool has(const RuleMask mask, const Rule rule) {
  return (mask & bit(rule)) != 0;
}

/// The rule's stable id, as `rules.ts` spells it. Used by the CLI's narration
/// and by the named contradiction diagnostics — never stored anywhere.
const char *name(Rule rule);

/// The area EVERY region of `color` must have, or 0 when region size is
/// unconstrained — the global form of an area number, which names one region.
///
/// The members are listed rather than derived, the same discipline `shortestRun`
/// follows: a family that computes itself quietly stops covering the next rule
/// appended to the catalogue. An "area 3" rule would be one more row here, one
/// more set of forbidden shapes, and nothing else.
int globalArea(RuleMask mask, uint8_t color);

/// One cell of a forbidden pattern: an offset from the pattern's anchor, and
/// the colour that cell must hold for the pattern to be present.
struct PatternCell {
  int8_t dx = 0;
  int8_t dy = 0;
  uint8_t color = kDark;
};

/// The most cells any pattern here needs: a run of five. It sizes `Clause`, so
/// raising it costs a little memory per clause and nothing else — every loop
/// over a pattern or a clause is driven by its own `count`.
inline constexpr int kMaxPatternCells = 5;

struct Pattern {
  std::array<PatternCell, kMaxPatternCells> cells{};
  int count = 0;
};

using Patterns = std::vector<Pattern>;

/**
 * Every arrangement the active rules forbid.
 *
 * Two things happen here beyond the obvious translation:
 *
 * - **Shorter runs subsume longer ones.** "No dark 1x2" already forbids every
 *   dark 1x3 and 1x4, so generating those as well would only add instances
 *   that can never fire — work with no pruning behind it. Only the shortest
 *   active run rule per colour survives.
 * - **Both colours connected implies no checkerboard**, whether or not rule 11
 *   is switched on. In a checkerboard the two dark corners can only be joined
 *   by a path that separates the two light ones and vice versa, so one of the
 *   two connectivity rules would have to break. This is the "checkerboard
 *   lemma" the game's own solving guide names, and it is free pruning.
 * - **An area rule contributes its trominoes.** "Every dark region has area 2"
 *   forbids every connected three, which is the two straight trominoes and the
 *   four bent ones. The straight pair is left to `shortestRun` — an area of two
 *   forbids a run of three like the 1x3 rule does — so only the bent four are
 *   added here, and they are dropped in turn when pairs of that colour are
 *   already forbidden. What this table cannot say is the OTHER half of the rule,
 *   that no region is smaller than two; see `Propagate.cpp`.
 */
Patterns patternsFor(RuleMask mask);

} // namespace lg::rules
