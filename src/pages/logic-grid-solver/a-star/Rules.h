#pragma once

#include "Types.h"

#include <array>
#include <cstdint>
#include <string_view>
#include <utility>
#include <vector>

// The board-wide rules, and the one mechanism most of them share.
//
// The arrangement rules all say the same kind of thing: a particular little
// arrangement of colors may not appear anywhere. They are therefore not
// written out one by one — they COMPILE into a table of forbidden patterns,
// and a single propagator drives the lot. The 1x5 pair arrived that way: one
// row in `shortestRun`, one enum entry, and no new code anywhere.
//
// Since format version 3 the player can also DRAW one, and a drawn pattern
// (`DrawnPattern`, the config's `patterns` key) compiles into that same table
// with its dihedral images. Which is what the append cycle above was really
// for: five of the arrangement controls — each named by exactly ONE captured
// board — have been retired into it, and the next unfamiliar shape the game
// produces needs no code at all.
//
// Rules 11..14 talk about whole REGIONS — that a color is all one piece, or
// that every piece of it carries exactly one clue — and each gets its own
// propagator. Rule 15 is not a coloring rule at all.
//
// The two families that carry a NUMBER — no straight run of N, every region
// of the color has area N — are not rules in the mask at all since format
// version 2: they arrive as `SizedRule` instances in `Puzzle::areas` and
// `Puzzle::runs`, any value in bounds, several per color. A run instance is
// pure table. An area instance is half and half: "no region larger than N" IS
// a forbidden arrangement for N = 2 (a connected set of three or more cells
// always contains a connected THREE, and the connected trominoes are exactly
// the two straight ones plus the four L-shapes), so that size compiles into
// the table — while "none smaller" cannot, because "this cell dark and all
// four neighbors light" is only forbidden where all four neighbors exist,
// and an instance touching a gap is dropped rather than shortened. That half
// is a propagator for every size; see `Propagate.cpp`.
namespace lg::rules {

/// Indices into RULES in rules.ts. That list is append-only, so these are
/// permanent: a saved puzzle stores the index of every FLAG rule it switches
/// on. Two batches have LEFT this encoding and live on only as historical bit
/// positions — the name table, the CLI's `--rules` mask and the generator's
/// rule table still speak them, and intake refuses each in a config's `rules`
/// list by name:
///
/// - the 22 sized entries (no-1xN, regions-have-area-N) went to `areas` and
///   `runs` in format version 2; `kLegacyAreas`/`kLegacyRuns` translate them;
/// - the 10 rarest arrangements (diagonal, L, crossed T, knight's move, mixed
///   elbow) went to the drawn `patterns` key in version 3; `kLegacyPatterns`
///   translates them. The whole captured corpus names those five controls on
///   one board each, which is what a per-rule append cycle was buying.
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
  // Not a coloring rule at all — it changes what the answer IS.
  Underclued = 15,
  // Region sizes. Appended, like everything after the one reorder, so they sit
  // past `Underclued` here while `rules.ts` draws them beside the connect rules.
  AreaTwoDark = 16,
  AreaTwoLight = 17,
  // The same rule at a different size. Both sizes on for one color is NOT a
  // contradiction: every one of a color's zero regions is both sizes at once,
  // so the pair is satisfied exactly when that color is absent.
  AreaFourDark = 18,
  AreaFourLight = 19,
  // And at five, which sits past the table trade-off exactly as four does:
  // `regionArea` carries both halves, and the table sees only the implied
  // straight run of six.
  AreaFiveDark = 20,
  AreaFiveLight = 21,
  // The first arrangements naming BOTH colors: a line of three alternating
  // colors, in either orientation. Pure table rules like 0..10 — the
  // checkerboard already proved the table speaks mixed colors.
  NoDarkLightDark = 22,
  NoLightDarkLight = 23,
  // The T-tetromino, all four rotations, one color each. Table rules too.
  NoDarkT = 24,
  NoLightT = 25,
  // A 2x2 holding exactly three of one color and one of the other — the first
  // mixed-color rule with more instances than orientations: the odd cell can
  // take any corner. Four table patterns per rule.
  NoThreeDarkOneLight = 26,
  NoThreeLightOneDark = 27,
  // No two cells of the color touching corner to corner, even inside one
  // connected piece — an L-bend and a filled 2x2 both break it, so every
  // region of the color is a straight bar. Two 2-cell table patterns each,
  // and the first patterns whose cells are not orthogonally contiguous.
  NoDarkDiagonal = 28,
  NoLightDiagonal = 29,
  // Region sizes again, appended like four and five: `regionArea` carries both
  // halves and the table sees only the implied straight run of FOUR.
  AreaThreeDark = 30,
  AreaThreeLight = 31,
  // Not a coloring rule: it changes what every NUMERIC clue's displayed
  // value means — the true count is the displayed value ± 1, and never the
  // displayed value itself. Letters and the valueless kinds are untouched.
  OffByOne = 32,
  // The bent tromino, any orientation — the same four shapes an area of two
  // contributes to the table, standing as their own rule.
  NoDarkElbow = 33,
  NoLightElbow = 34,
  // The L-tetromino, BOTH mirror forms: eight orientations per color.
  NoDarkEll = 35,
  NoLightEll = 36,
  // Two squares of the color exactly two apart in a straight line, whatever
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
  // attaches — the other color and the three remaining cells the named one.
  NoLightCrossedDarkT = 43,
  NoDarkCrossedLightT = 44,
  // The T-pentomino: a bar of three with a stem of TWO from its middle.
  NoDarkLongT = 45,
  NoLightLongT = 46,
  // Area twenty-four sits past the table entirely: its implied run of 25
  // outgrows `kMaxImpliedRun`, so `addRuns` skips the emission and
  // `regionArea` alone carries the size.
  AreaTwentyFourDark = 47,
  AreaTwentyFourLight = 48,
  // Two squares of the color a chess knight's move apart. Positional like
  // the diagonal and distance rules: nothing between the squares is named.
  NoDarkKnight = 49,
  NoLightKnight = 50,
  // The bent tromino with its CORNER cell — the square touching both others —
  // the other color and both ends the named one.
  NoDarkLightDarkElbow = 51,
  NoLightDarkLightElbow = 52,
  // The first rules about the SHAPES of whole regions, and the first family
  // since the sized ones that adds no row to `patternsFor` at all: they relate
  // regions arbitrarily far apart, and they read each region's MAXIMALITY, so
  // no fixed-size window can state them. "Same shape" is CONGRUENCE — the
  // eight dihedral images, rotations and reflections both — which also fixes
  // the cardinality, so "shape and size" is one predicate.
  DistinctShapesDark = 53,
  DistinctShapesLight = 54,
  // The opposite, and both of one color may be set at once: together they say
  // the color has AT MOST ONE region, which a board may legally be.
  SameShapeDark = 55,
  SameShapeLight = 56,
};

/// 57 of the 64 a `RuleMask` holds — seven flag slots left before it has to
/// widen, which the assert below only reports after the fact.
inline constexpr int kRuleCount = 57;

/// The active rules as a bit per index. 64 wide because the catalog reached
/// exactly 32 rules on a 32-bit mask — the next appended rule would have been
/// undefined behavior in `bit()` rather than a compile error.
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
 * One sized rule instance: the color it constrains and the number it carries
 * — an entry of the config's `areas` key (every region of the color has
 * exactly `value` cells) or its `runs` key (no straight run of `value` cells
 * of the color). Which FAMILY an instance belongs to is said by which of
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

/**
 * A forbidden arrangement the player DREW, as the config's `patterns` key
 * carries it: a box of `width` by `height` squares, row-major, each holding
 * kUnknown for "no part of the pattern", kDark or kLight for a square that
 * must hold that color.
 *
 * The other half of what a config carries beyond its flag mask, beside
 * `SizedRule` — and the boundary form rather than the compiled one, so
 * `fixtureio::save` writes back exactly what was loaded. `patternsFor` turns
 * each of these into its dihedral images: a drawn pattern forbids its
 * rotations and reflections too, always, which is what every built-in
 * arrangement family already did.
 *
 * Always bounding-box tight — no empty edge row or column, though an INTERIOR
 * empty row is ordinary (a knight's move has one) — and never blank. Both
 * intakes refuse anything else by name rather than trimming it, the same
 * asymmetry with the page's validator that `Puzzle::areas` records.
 */
struct DrawnPattern {
  int width = 0;
  int height = 0;
  std::vector<uint8_t> cells;

  bool operator==(const DrawnPattern &) const = default;
};

/// Whether at least one square of the box names a color. A pattern that names
/// none forbids nothing, which is not a rule anyone means.
bool namesASquare(const DrawnPattern &pattern);

/// Whether the box has no empty edge row or column — a drawn pattern is stored
/// trimmed to the squares it names, which is what makes two drawings of one
/// shape comparable. An INTERIOR empty row is ordinary: a knight's move has
/// one. Both intakes enforce this rather than trimming, so a box that is not
/// tight is refused by name.
bool isTightBox(const DrawnPattern &pattern);

/// A total order on drawn patterns — by height, then width, then the squares.
/// Only a tie-break, with no meaning of its own beyond making a list of them
/// canonical.
bool drawnLess(const DrawnPattern &a, const DrawnPattern &b);

/// The eight dihedral images of a drawn pattern — four rotations in both
/// handednesses — de-duplicated, since a symmetric shape has fewer. Each comes
/// back bounding-box tight like its source.
std::vector<DrawnPattern> dihedralImages(const DrawnPattern &pattern);

/// The smallest dihedral image under `drawnLess`: the key two drawings of the
/// SAME rule share, whichever orientation each was drawn in. Intake orders the
/// `patterns` list by it and refuses a repeat, so one rule cannot be carried
/// twice wearing two rotations.
DrawnPattern canonicalImage(const DrawnPattern &pattern);

/// `canonicalImage` on both sides of `drawnLess` — the comparison intake
/// enforces, and the one `Puzzle::patterns` is always sorted by.
bool patternLess(const DrawnPattern &a, const DrawnPattern &b);

/// A retired sized catalog entry: the v1 bit position, and the instance it
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

/**
 * A retired ARRANGEMENT catalog entry: the pre-v3 bit position and the shape
 * it translates to, as a picture. `squares` is the box row-major — '.' for a
 * square the pattern does not name, 'D' and 'L' for the two colors — written
 * across lines so the source reads as the shape it means.
 *
 * One image each, because a drawn pattern forbids its dihedral images too; the
 * closure of the shape below is exactly the family the rule used to compile
 * to, which `rules_test.cpp` asserts rather than trusts.
 */
struct LegacyPatternRule {
  Rule rule = Rule::NoDarkDiagonal;
  int width = 0;
  int height = 0;
  std::string_view squares;
};

/**
 * The ten rules that stopped being flags in format version 3: the five
 * controls the corpus names on exactly one board each, retired into the
 * `patterns` key
 * the player draws into. LISTED with their shapes rather than derived, the
 * same discipline `kLegacyAreas` follows.
 *
 * They keep their indices — the catalog is append-only and a saved file
 * stores positions — and both intakes refuse them in a `rules` list by name.
 * The enum entries stay because the page's migration, the CLI's `--rules` mask
 * and the generator's rule table all still speak v1 masks.
 */
inline constexpr auto kLegacyPatterns = std::to_array<LegacyPatternRule>({
    {.rule = Rule::NoDarkDiagonal,
     .width = 2,
     .height = 2,
     .squares = "D."
                ".D"},
    {.rule = Rule::NoLightDiagonal,
     .width = 2,
     .height = 2,
     .squares = "L."
                ".L"},
    {.rule = Rule::NoDarkEll,
     .width = 2,
     .height = 3,
     .squares = "D."
                "D."
                "DD"},
    {.rule = Rule::NoLightEll,
     .width = 2,
     .height = 3,
     .squares = "L."
                "L."
                "LL"},
    // The arms are dark and the crossing light, which is what the id says
    // last-color-first: "no light-crossed DARK T".
    {.rule = Rule::NoLightCrossedDarkT,
     .width = 3,
     .height = 2,
     .squares = "DLD"
                ".D."},
    {.rule = Rule::NoDarkCrossedLightT,
     .width = 3,
     .height = 2,
     .squares = "LDL"
                ".L."},
    // The middle row names nothing at all. An INTERIOR empty row is fine —
    // only an empty EDGE row or column would mean the box is not tight.
    {.rule = Rule::NoDarkKnight,
     .width = 2,
     .height = 3,
     .squares = "D."
                ".."
                ".D"},
    {.rule = Rule::NoLightKnight,
     .width = 2,
     .height = 3,
     .squares = "L."
                ".."
                ".L"},
    // The corner is the other color, both ends the one the id names.
    {.rule = Rule::NoDarkLightDarkElbow,
     .width = 2,
     .height = 2,
     .squares = "LD"
                "D."},
    {.rule = Rule::NoLightDarkLightElbow,
     .width = 2,
     .height = 2,
     .squares = "DL"
                "L."},
});

/// The ten retired arrangement bits as one mask — what intake refuses in a
/// `rules` list by name, and what `splitLegacyMask` translates into patterns.
inline constexpr RuleMask kDrawnRuleBits = [] {
  RuleMask mask = 0;
  for (const auto &entry : kLegacyPatterns)
    mask |= bit(entry.rule);
  return mask;
}();

static_assert((kSizedRuleBits & kDrawnRuleBits) == 0,
              "a rule retires into one list or the other, never both");

/// The shape a retired entry's picture spells, as a drawn pattern.
DrawnPattern drawnFromLegacy(const LegacyPatternRule &entry);

/// A v1-style mask torn into the modern shape: the surviving flag bits, every
/// sized bit as its instance, and every retired arrangement bit as its drawn
/// pattern. All three lists canonical.
struct SplitRules {
  RuleMask flags = 0;
  std::vector<SizedRule> areas;
  std::vector<SizedRule> runs;
  std::vector<DrawnPattern> patterns;
};

/// The one translator for the places that still speak v1 masks — the CLI's
/// `--rules` and the generator's rule table. Draws nothing and never reorders
/// its input mask's meaning, which is what keeps generator seeds byte-stable.
SplitRules splitLegacyMask(RuleMask mask);

/**
 * The SMALLEST area any instance holds `color` to, or 0 when none does.
 *
 * Sound only where a lower bound on "how large may a piece of the color
 * grow" is wanted — `impliedRun` and `mergeLimits` — because the instances
 * are conjunctive, so the smallest cap binds. Anywhere that wants "the size a
 * region has to be" must walk the instances instead: with two sizes on for
 * one color the answer is that the color is absent, which no single number
 * can say.
 */
int smallestArea(const std::vector<SizedRule> &areas, uint8_t color);

/// One cell of a forbidden pattern: an offset from the pattern's anchor, and
/// the color that cell must hold for the pattern to be present.
struct PatternCell {
  int8_t dx = 0;
  int8_t dy = 0;
  uint8_t color = kDark;

  bool operator==(const PatternCell &) const = default;
};

/// The longest run this table lays out, and a tuning bound rather than a
/// capacity one: patterns are variable length now, so nothing here would
/// truncate. A run instance of eight is the longest the format admits, and an
/// AREA whose implied run outgrows that (area twenty-four's 25) is SKIPPED in
/// `addRuns` rather than written, leaving `regionArea` to carry the size
/// alone. Emitting it would be sound but pointless: a 25-literal clause
/// deduces almost nothing and `regionArea` already enforces the size whole.
inline constexpr int kMaxImpliedRun = 8;

/**
 * The bounds intake enforces on a sized rule's value. The floors are load
 * bearing beyond validation: 0 is the reducers' "no rule of this color"
 * answer (`smallestArea` here, `shortestRun` in Rules.cpp), so a stored 0
 * would read as absence rather than as a rule. The area cap is a FORMAT limit
 * shared with the page's validator — an area larger than the board is still
 * enforceable, so it is NOT capped by board size: it forces the color to be
 * ABSENT (all zero of its regions are the right size), and refutes only a
 * board whose givens or clues demand that color anyway.
 * The run cap was this ENGINE's while the pattern table had a fixed width; it
 * is a FORMAT limit now, shared with the page's validator, and the engine
 * would happily lay out a longer one. It stays at eight because a run instance
 * is enforced only by its compiled pattern and `kMaxImpliedRun` is where
 * `addRuns` stops emitting — moving one without the other would accept a run
 * intake nothing enforces, which has to be refused by name rather than
 * silently ignored. (An AREA whose implied run outgrows that is fine —
 * `regionArea` enforces every area size whole, patterns or not.)
 */
inline constexpr int kMinAreaSize = 1;
inline constexpr int kMaxAreaSize = 9999;
inline constexpr int kMinRunLength = 2;
inline constexpr int kMaxRunLength = kMaxImpliedRun;

/**
 * One forbidden arrangement as a list of offsets and the colors they must
 * hold. Variable length: a custom pattern may be as large as the board, so
 * there is no longest and nothing to size an array by.
 */
struct Pattern {
  std::vector<PatternCell> cells;

  [[nodiscard]] int count() const { return static_cast<int>(cells.size()); }

  bool operator==(const Pattern &) const = default;
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
 *   shortest active run instance per color survives.
 * - **Both colors connected implies no checkerboard**, whether or not rule 11
 *   is switched on. In a checkerboard the two dark corners can only be joined
 *   by a path that separates the two light ones and vice versa, so one of the
 *   two connectivity rules would have to break. This is the "checkerboard
 *   lemma" the game's own solving guide names, and it is free pruning.
 * - **An area instance contributes its trominoes.** "Every dark region has
 *   area 2" forbids every connected three, which is the two straight trominoes
 *   and the four bent ones. The straight pair is left to the run reducer — an
 *   area of two forbids a run of three like a run instance of 3 does — so only
 *   the bent four are added here, and they are dropped in turn when pairs of
 *   that color are already forbidden. What this table cannot say is the OTHER
 *   half of the rule, that no region is smaller than two; see `Propagate.cpp`.
 * - **A drawn pattern contributes its dihedral images.** One that is a shape
 *   this file already knows — any of the ten arrangements retired in format
 *   version 3 — is RECOGNIZED and laid out by that rule's own builder instead,
 *   with every subsumption gate it always had. That is compiled-only: the
 *   puzzle's `ruleMask` never gains the bit, `Verify` still checks the drawing
 *   as a drawing, and nothing the player sees acquires a name. It is what
 *   makes a v1-style mask compile to exactly the table it always did, which in
 *   turn is what keeps every generator seed stable across the retirement.
 *   Any OTHER drawing gets no gate in either direction, so one that repeats
 *   what the board already forbids lays its clauses twice — sound, and a
 *   little wasteful.
 */
Patterns patternsFor(RuleMask flags, const std::vector<SizedRule> &areas,
                     const std::vector<SizedRule> &runs,
                     const std::vector<DrawnPattern> &drawn);

} // namespace lg::rules
