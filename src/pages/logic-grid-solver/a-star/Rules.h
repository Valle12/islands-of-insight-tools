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
// The two families that carry a NUMBER — no straight run of N, every region
// of the colour has area N — are not rules in the mask at all since format
// version 2: they arrive as `SizedRule` instances in `Puzzle::areas` and
// `Puzzle::runs`, any value in bounds, several per colour. A run instance is
// pure table. An area instance is half and half: "no region larger than N" IS
// a forbidden arrangement for N = 2 (a connected set of three or more cells
// always contains a connected THREE, and the connected trominoes are exactly
// the two straight ones plus the four L-shapes), so that size compiles into
// the table — while "none smaller" cannot, because "this cell dark and all
// four neighbours light" is only forbidden where all four neighbours exist,
// and an instance touching a gap is dropped rather than shortened. That half
// is a propagator for every size; see `Propagate.cpp`.
namespace lg::rules {

/// Indices into RULES in rules.ts. That list is append-only, so these are
/// permanent: a saved puzzle stores the index of every FLAG rule it switches
/// on. The 22 sized entries — the no-1xN and regions-have-area-N families —
/// left this encoding in format version 2 and live on as v1 bit positions:
/// the name table, the CLI's `--rules` mask and the generator's rule table
/// still speak them, and `kLegacyAreas`/`kLegacyRuns` below say what each one
/// means now. Intake refuses them in a config's `rules` list by name.
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
  // The same rule at a different size. Both sizes on for one colour is NOT a
  // contradiction: every one of a colour's zero regions is both sizes at once,
  // so the pair is satisfied exactly when that colour is absent.
  AreaFourDark = 18,
  AreaFourLight = 19,
  // And at five, which sits past the table trade-off exactly as four does:
  // `regionArea` carries both halves, and the table sees only the implied
  // straight run of six.
  AreaFiveDark = 20,
  AreaFiveLight = 21,
  // The first arrangements naming BOTH colours: a line of three alternating
  // colours, in either orientation. Pure table rules like 0..10 — the
  // checkerboard already proved the table speaks mixed colours.
  NoDarkLightDark = 22,
  NoLightDarkLight = 23,
  // The T-tetromino, all four rotations, one colour each. Table rules too.
  NoDarkT = 24,
  NoLightT = 25,
  // A 2x2 holding exactly three of one colour and one of the other — the first
  // mixed-colour rule with more instances than orientations: the odd cell can
  // take any corner. Four table patterns per rule.
  NoThreeDarkOneLight = 26,
  NoThreeLightOneDark = 27,
  // No two cells of the colour touching corner to corner, even inside one
  // connected piece — an L-bend and a filled 2x2 both break it, so every
  // region of the colour is a straight bar. Two 2-cell table patterns each,
  // and the first patterns whose cells are not orthogonally contiguous.
  NoDarkDiagonal = 28,
  NoLightDiagonal = 29,
  // Region sizes again, appended like four and five: `regionArea` carries both
  // halves and the table sees only the implied straight run of FOUR.
  AreaThreeDark = 30,
  AreaThreeLight = 31,
  // Not a colouring rule: it changes what every NUMERIC clue's displayed
  // value means — the true count is the displayed value ± 1, and never the
  // displayed value itself. Letters and the valueless kinds are untouched.
  OffByOne = 32,
  // The bent tromino, any orientation — the same four shapes an area of two
  // contributes to the table, standing as their own rule.
  NoDarkElbow = 33,
  NoLightElbow = 34,
  // The L-tetromino, BOTH mirror forms: eight orientations per colour.
  NoDarkEll = 35,
  NoLightEll = 36,
  // Two squares of the colour exactly two apart in a straight line, whatever
  // lies between them — the first patterns that fire ACROSS a gap, since only
  // the two end squares are named.
  NoDarkAnyDark = 37,
  NoLightAnyLight = 38,
  // Region sizes six and seven: `regionArea` carries both halves, and the
  // table sees only the implied straight runs of seven and eight.
  AreaSixDark = 39,
  AreaSixLight = 40,
  AreaSevenDark = 41,
  AreaSevenLight = 42,
  // The T-tetromino with its CROSSING cell — the bar's middle, where the stem
  // attaches — the other colour and the three remaining cells the named one.
  NoLightCrossedDarkT = 43,
  NoDarkCrossedLightT = 44,
  // The T-pentomino: a bar of three with a stem of TWO from its middle.
  NoDarkLongT = 45,
  NoLightLongT = 46,
  // Area twenty-four sits past the table entirely: its implied run of 25
  // outgrows `kMaxPatternCells`, so `addRuns` skips the emission and
  // `regionArea` alone carries the size.
  AreaTwentyFourDark = 47,
  AreaTwentyFourLight = 48,
  // Two squares of the colour a chess knight's move apart. Positional like
  // the diagonal and distance rules: nothing between the squares is named.
  NoDarkKnight = 49,
  NoLightKnight = 50,
  // The bent tromino with its CORNER cell — the square touching both others —
  // the other colour and both ends the named one.
  NoDarkLightDarkElbow = 51,
  NoLightDarkLightElbow = 52,
};

inline constexpr int kRuleCount = 53;

/// The active rules as a bit per index. 64 wide because the catalogue reached
/// exactly 32 rules on a 32-bit mask — the next appended rule would have been
/// undefined behaviour in `bit()` rather than a compile error.
using RuleMask = uint64_t;

static_assert(kRuleCount <= 64,
              "RuleMask holds a bit per rule; widen it before the 65th");

constexpr RuleMask bit(const Rule rule) {
  return RuleMask{1} << std::to_underlying(rule);
}

constexpr bool has(const RuleMask mask, const Rule rule) {
  return (mask & bit(rule)) != 0;
}

/// The rule's stable id, as `rules.ts` spells it. Used by the CLI's narration
/// and by the named contradiction diagnostics — never stored anywhere.
const char *name(Rule rule);

/**
 * One sized rule instance: the colour it constrains and the number it carries
 * — an entry of the config's `areas` key (every region of the colour has
 * exactly `value` cells) or its `runs` key (no straight run of `value` cells
 * of the colour). Which FAMILY an instance belongs to is said by which of
 * `Puzzle`'s two lists holds it, never by the value.
 */
struct SizedRule {
  uint8_t color = kDark;
  int value = 0;

  bool operator==(const SizedRule &) const = default;
};

/// The canonical order both of `Puzzle`'s instance lists arrive in: dark
/// before light, then value ascending. Intake REFUSES a list that is not
/// strictly ascending under this (which also refuses duplicates) rather than
/// sorting it — see the asymmetry note on `Puzzle::areas`.
constexpr bool sizedLess(const SizedRule &a, const SizedRule &b) {
  if (a.color != b.color)
    return a.color < b.color; // kDark orders before kLight
  return a.value < b.value;
}

/// A retired sized catalogue entry: the v1 bit position, and the instance it
/// translates to.
struct LegacySizedRule {
  Rule rule = Rule::AreaTwoDark;
  SizedRule sized;
};

/**
 * The 22 rules that carried a number, LISTED with their translations rather
 * than derived — the discipline every family table here has followed, because
 * a family that computes its members quietly stops covering an appended one.
 * Since format version 2 these indices are illegal in a config's `rules` list;
 * they survive as v1 bit positions because the page's migration, the CLI's
 * `--rules` mask and the generator's rule table still speak them. Row order
 * matches the enum, which is NOT the canonical instance order —
 * `splitLegacyMask` sorts.
 */
inline constexpr auto kLegacyAreas = std::to_array<LegacySizedRule>({
    {.rule = Rule::AreaTwoDark, .sized = {.color = kDark, .value = 2}},
    {.rule = Rule::AreaTwoLight, .sized = {.color = kLight, .value = 2}},
    {.rule = Rule::AreaFourDark, .sized = {.color = kDark, .value = 4}},
    {.rule = Rule::AreaFourLight, .sized = {.color = kLight, .value = 4}},
    {.rule = Rule::AreaFiveDark, .sized = {.color = kDark, .value = 5}},
    {.rule = Rule::AreaFiveLight, .sized = {.color = kLight, .value = 5}},
    {.rule = Rule::AreaThreeDark, .sized = {.color = kDark, .value = 3}},
    {.rule = Rule::AreaThreeLight, .sized = {.color = kLight, .value = 3}},
    {.rule = Rule::AreaSixDark, .sized = {.color = kDark, .value = 6}},
    {.rule = Rule::AreaSixLight, .sized = {.color = kLight, .value = 6}},
    {.rule = Rule::AreaSevenDark, .sized = {.color = kDark, .value = 7}},
    {.rule = Rule::AreaSevenLight, .sized = {.color = kLight, .value = 7}},
    {.rule = Rule::AreaTwentyFourDark, .sized = {.color = kDark, .value = 24}},
    {.rule = Rule::AreaTwentyFourLight,
     .sized = {.color = kLight, .value = 24}},
});

inline constexpr auto kLegacyRuns = std::to_array<LegacySizedRule>({
    {.rule = Rule::NoDark1x2, .sized = {.color = kDark, .value = 2}},
    {.rule = Rule::NoLight1x2, .sized = {.color = kLight, .value = 2}},
    {.rule = Rule::NoDark1x3, .sized = {.color = kDark, .value = 3}},
    {.rule = Rule::NoLight1x3, .sized = {.color = kLight, .value = 3}},
    {.rule = Rule::NoDark1x4, .sized = {.color = kDark, .value = 4}},
    {.rule = Rule::NoLight1x4, .sized = {.color = kLight, .value = 4}},
    {.rule = Rule::NoDark1x5, .sized = {.color = kDark, .value = 5}},
    {.rule = Rule::NoLight1x5, .sized = {.color = kLight, .value = 5}},
});

/// The 22 retired bit positions as one mask — what intake refuses in a
/// `rules` list by name, and what `splitLegacyMask` translates.
inline constexpr RuleMask kSizedRuleBits = [] {
  RuleMask mask = 0;
  for (const auto &[rule, sized] : kLegacyAreas)
    mask |= bit(rule);
  for (const auto &[rule, sized] : kLegacyRuns)
    mask |= bit(rule);
  return mask;
}();

/// A v1-style mask torn into the modern shape: the surviving flag bits, and
/// every sized bit as its instance, both lists canonical.
struct SplitRules {
  RuleMask flags = 0;
  std::vector<SizedRule> areas;
  std::vector<SizedRule> runs;
};

/// The one translator for the places that still speak v1 masks — the CLI's
/// `--rules` and the generator's rule table. Draws nothing and never reorders
/// its input mask's meaning, which is what keeps generator seeds byte-stable.
SplitRules splitLegacyMask(RuleMask mask);

/**
 * The SMALLEST area any instance holds `color` to, or 0 when none does.
 *
 * Sound only where a lower bound on "how large may a piece of the colour
 * grow" is wanted — `impliedRun` and `mergeLimits` — because the instances
 * are conjunctive, so the smallest cap binds. Anywhere that wants "the size a
 * region has to be" must walk the instances instead: with two sizes on for
 * one colour the answer is that the colour is absent, which no single number
 * can say.
 */
int smallestArea(const std::vector<SizedRule> &areas, uint8_t color);

/// One cell of a forbidden pattern: an offset from the pattern's anchor, and
/// the colour that cell must hold for the pattern to be present.
struct PatternCell {
  int8_t dx = 0;
  int8_t dy = 0;
  uint8_t color = kDark;
};

/// The most cells any pattern here needs: the run of EIGHT an area-seven rule
/// implies. It sizes `Clause`, so raising it costs a little memory per clause
/// and nothing else — every loop over a pattern or a clause is driven by its
/// own `count`. `runPattern` writes `cells[i]` with no assert of its own, so
/// this must never lag the longest `impliedRun` `addRuns` will lay out — and
/// that is enforced in code now, not prose: a run the table cannot hold (area
/// twenty-four's 25) is SKIPPED there rather than written, leaving
/// `regionArea` to carry the size alone.
inline constexpr int kMaxPatternCells = 8;

/**
 * The bounds intake enforces on a sized rule's value. The floors are load
 * bearing beyond validation: 0 is the reducers' "no rule of this colour"
 * answer (`smallestArea` here, `shortestRun` in Rules.cpp), so a stored 0
 * would read as absence rather than as a rule. The area cap is a FORMAT limit
 * shared with the page's validator — an area larger than the board is still
 * enforceable and merely unsatisfiable, so it is NOT capped by board size.
 * The run cap is this ENGINE's: a forbidden run is enforced only by its
 * compiled pattern, a pattern holds at most `kMaxPatternCells` cells, and a
 * run intake cannot enforce must be refused by name rather than accepted and
 * silently ignored. (An AREA whose implied run outgrows the table is fine —
 * `regionArea` enforces every area size whole, patterns or not.)
 */
inline constexpr int kMinAreaSize = 1;
inline constexpr int kMaxAreaSize = 9999;
inline constexpr int kMinRunLength = 2;
inline constexpr int kMaxRunLength = kMaxPatternCells;

struct Pattern {
  std::array<PatternCell, kMaxPatternCells> cells{};
  int count = 0;
};

using Patterns = std::vector<Pattern>;

/**
 * Every arrangement the active rules forbid — the flag mask plus the two
 * sized instance lists, which are where the run and area families live now.
 *
 * Two things happen here beyond the obvious translation:
 *
 * - **Shorter runs subsume longer ones.** A dark run instance of 2 already
 *   forbids every dark 1x3 and 1x4, so generating those as well would only add
 *   instances that can never fire — work with no pruning behind it. Only the
 *   shortest active run instance per colour survives.
 * - **Both colours connected implies no checkerboard**, whether or not rule 11
 *   is switched on. In a checkerboard the two dark corners can only be joined
 *   by a path that separates the two light ones and vice versa, so one of the
 *   two connectivity rules would have to break. This is the "checkerboard
 *   lemma" the game's own solving guide names, and it is free pruning.
 * - **An area instance contributes its trominoes.** "Every dark region has
 *   area 2" forbids every connected three, which is the two straight trominoes
 *   and the four bent ones. The straight pair is left to the run reducer — an
 *   area of two forbids a run of three like a run instance of 3 does — so only
 *   the bent four are added here, and they are dropped in turn when pairs of
 *   that colour are already forbidden. What this table cannot say is the OTHER
 *   half of the rule, that no region is smaller than two; see `Propagate.cpp`.
 */
Patterns patternsFor(RuleMask mask, const std::vector<SizedRule> &areas,
                     const std::vector<SizedRule> &runs);

} // namespace lg::rules
