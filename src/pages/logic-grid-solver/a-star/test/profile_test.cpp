#include "TestBoards.h"

#include "Profile.h"
#include "Puzzle.h"
#include "Rules.h"
#include "Search.h"
#include "Verify.h"

#include <gtest/gtest.h>
#include <algorithm>
#include <string>
#include <vector>

// The frontier sweep. `reference_test.cpp` is what proves it agrees with brute
// force; these are the pieces that would be hard to read out of a disagreement.
namespace {

using namespace lg;
using rules::Rule;

Outcome sweep(const std::vector<std::string> &picture,
              const std::vector<Rule> &ruleList = {}) {
  const Model model = buildModel(test::board(picture, test::ruleSet(ruleList)));
  constexpr Config cfg{.maxMs = 30000};
  return profile::runProfile(model, cfg);
}

bool takes(const std::vector<std::string> &picture,
           const std::vector<Rule> &ruleList = {}) {
  const Model model = buildModel(test::board(picture, test::ruleSet(ruleList)));
  return profile::applicable(model);
}

TEST(Profile, SolvesAPairOfLettersThatHaveToReachEachOther) {
  const Outcome outcome = sweep({"a..", "...", "..a"});
  EXPECT_EQ(outcome.status, Status::Solved);
  const Model model = buildModel(test::board({"a..", "...", "..a"}));
  EXPECT_EQ(verify::check(model, outcome.colors), verify::Violation::None);
}

/// The two cells of one letter are walled apart by gaps, so nothing joins them.
TEST(Profile, ProvesAnImpossibleBoardImpossible) {
  EXPECT_EQ(sweep({"a#b", "###", "b#a"}).status, Status::Unsolvable);
}

/// Two letters may share a COLOUR, but never a region.
TEST(Profile, KeepsTwoLettersInDifferentRegions) {
  const std::vector<std::string> picture = {"a.b", "...", "a.b"};
  const Outcome outcome = sweep(picture);
  ASSERT_EQ(outcome.status, Status::Solved);
  const Model model = buildModel(test::board(picture));
  EXPECT_EQ(verify::check(model, outcome.colors), verify::Violation::None);
}

/**
 * Two letter pairs whose ends alternate around the edge of the board, with
 * nowhere to go around: A must join corner to opposite corner and so must B, and
 * on a plane those two paths have to cross. Brute force agrees — this 3x3 has
 * ZERO solutions.
 *
 * Worth pinning because the same shape with room to spare is perfectly solvable:
 * `logicGridTest67` interleaves the same way on a 15x15 and its answer is four
 * nested spiral arms. What makes this one impossible is the lack of space, not
 * the interleaving, and a sweep that "proved" the 15x15 impossible on the
 * strength of this one would be confidently wrong.
 */
TEST(Profile, InterleavedPairsWithNoRoomAreImpossible) {
  EXPECT_EQ(sweep({"a.b", "...", "b.a"}).status, Status::Unsolvable);
}

TEST(Profile, RespectsAPaintedCellAsAGiven) {
  const std::vector<std::string> picture = {"D..", "...", "..L"};
  const Outcome outcome = sweep(picture);
  ASSERT_EQ(outcome.status, Status::Solved);
  const Model model = buildModel(test::board(picture));
  // GivenChanged is what `Verify` reports when an answer repaints a given.
  EXPECT_EQ(verify::check(model, outcome.colors), verify::Violation::None);
}

TEST(Profile, HandlesTheConnectivityRules) {
  using enum Rule;
  const std::vector<std::string> picture = {"a..", "...", "..a"};
  const Outcome outcome = sweep(picture, {ConnectDark, ConnectLight});
  ASSERT_EQ(outcome.status, Status::Solved);
  const Model model = buildModel(
      test::board(picture, test::ruleSet({ConnectDark, ConnectLight})));
  EXPECT_EQ(verify::check(model, outcome.colors), verify::Violation::None);
}

/**
 * The gate, in both directions. A permissive one here IS a wrong answer:
 * `runProfileForced` sets `proven` with no oracle behind its forced set, so a
 * sweep blind to part of the puzzle enumerates a superset of the solutions and
 * then reports the cells they disagree about as proved to go either way.
 */
TEST(Profile, DeclinesWhatItCannotExpress) {
  EXPECT_TRUE(takes({"a..", "...", "..a"}));
  EXPECT_TRUE(takes({"a..", "...", "..a"}, {Rule::ConnectDark}));
  // An area clue would have to carry its region's size in the state.
  EXPECT_FALSE(takes({"3..", "...", "..a"}));
  // A rule whose whole content is a forbidden arrangement IS expressible: the
  // frontier's slots are the last `width` cells in scan order, so a few bits
  // of history beside them are enough to read one off.
  EXPECT_TRUE(takes({"a..", "...", "..a"}, {Rule::NoDark2x2}));
  EXPECT_TRUE(takes({"a..", "...", "..a"}, {Rule::NoCheckerboard}));
  EXPECT_TRUE(takes({"a..", "...", "..a"}, {Rule::NoDarkT}));
  // The sized rule instances live OUTSIDE the mask, so the whitelist loop
  // cannot see them and their decline is its own explicit check: a run
  // instance would need a running length along rows the sweep crosses, an
  // area instance each open class's size — the state an area clue would need.
  // Declining is a correctness requirement rather than a tidiness one:
  // `runProfileForced` sets `proven` with no oracle gate on its forced set,
  // so a sweep blind to an instance would enumerate a superset of the
  // solutions and then claim the cells they disagree about were proved free.
  Puzzle run = test::board({"a..", "...", "..a"});
  test::withRunRule(run, kDark, 3);
  EXPECT_FALSE(profile::applicable(buildModel(run)));
  Puzzle darkArea = test::board({"a..", "...", "..a"});
  test::withAreaRule(darkArea, kDark, 2);
  EXPECT_FALSE(profile::applicable(buildModel(darkArea)));
  Puzzle lightArea = test::board({"a..", "...", "..a"});
  test::withAreaRule(lightArea, kLight, 4);
  EXPECT_FALSE(profile::applicable(buildModel(lightArea)));
}

/// The gate is a WHITELIST, so a rule it has never heard of declines itself —
/// but the file's own warning is that a denylist looked right until the
/// catalogue grew, so the newest family is pinned rather than assumed.
TEST(Profile, DeclinesTheRegionShapeRules) {
  EXPECT_FALSE(takes({"a..", "...", "..a"}, {Rule::DistinctShapesDark}));
  EXPECT_FALSE(takes({"a..", "...", "..a"}, {Rule::DistinctShapesLight}));
  EXPECT_FALSE(takes({"a..", "...", "..a"}, {Rule::SameShapeDark}));
  EXPECT_FALSE(takes({"a..", "...", "..a"}, {Rule::SameShapeLight}));
}

/**
 * A dart on a square the board does not paint, which the sweep still cannot
 * express: what a dart counts is the OPPOSITE of its own square's colour, so an
 * unpainted one would need that colour carried in the state long after the
 * square has left the frontier.
 *
 * This is the case the gate got wrong when it was a denylist. A dart-only board
 * names no area clue and no listed rule, so it was ACCEPTED, and `planOf` read
 * letters only — the dart was then silently ignored and the forced set claimed
 * as proved. Whitelisted, anything unrecognised declines by default.
 */
TEST(Profile, DeclinesADartOnAnUnpaintedSquare) {
  const Puzzle plain = test::board({"a..", "...", "..a"});
  ASSERT_TRUE(profile::applicable(buildModel(plain)));

  Puzzle darted = plain;
  test::withDart(darted, 1, 1, 1, kDirRight);
  EXPECT_FALSE(profile::applicable(buildModel(darted)));
}

/// A dart the board DOES paint has a fixed target colour, so one counter per
/// ray expresses it, and the sweep takes the board.
TEST(Profile, SweepsADartOnAPaintedSquare) {
  Puzzle puzzle = test::board({"...", "...", "..."});
  test::withGiven(puzzle, 0, 0, kLight);
  test::withDart(puzzle, 0, 0, 2, kDirRight);
  const Model model = buildModel(puzzle);
  ASSERT_TRUE(profile::applicable(model));
  constexpr Config cfg{.maxMs = 30000};
  const Outcome outcome = profile::runProfile(model, cfg);
  ASSERT_EQ(outcome.status, Status::Solved);
  EXPECT_EQ(verify::check(model, outcome.colors), verify::Violation::None);
}

/// A dart whose count no colouring can meet: its ray holds two squares and it
/// asks for three, which the sweep proves impossible rather than declining.
TEST(Profile, ProvesADartThatCannotBeSatisfiedImpossible) {
  Puzzle puzzle = test::board({"...", "...", "..."});
  test::withGiven(puzzle, 0, 0, kLight);
  test::withDart(puzzle, 0, 0, 3, kDirRight);
  const Model model = buildModel(puzzle);
  ASSERT_TRUE(profile::applicable(model));
  constexpr Config cfg{.maxMs = 30000};
  EXPECT_EQ(profile::runProfile(model, cfg).status, Status::Unsolvable);
}

/// An arrangement rule the sweep now reads off its own recent colour. The board
/// is every 2x2 of a 2x3, so a wrong history would show up as a colouring the
/// oracle refuses rather than as a slower run.
TEST(Profile, SweepsAnArrangementRule) {
  using enum Rule;
  const std::vector<std::string> picture = {"..", "..", ".."};
  const Outcome outcome = sweep(picture, {NoDark2x2, NoLight2x2});
  ASSERT_EQ(outcome.status, Status::Solved);
  const Model model =
      buildModel(test::board(picture, test::ruleSet({NoDark2x2, NoLight2x2})));
  EXPECT_EQ(verify::check(model, outcome.colors), verify::Violation::None);
}

/// Same refusal for the lotus, whose mirror crosses the sweep in BOTH
/// directions — the whitelist declines it with no code knowing it exists.
TEST(Profile, DeclinesLotuses) {
  const Puzzle plain = test::board({"a..", "...", "..a"});
  ASSERT_TRUE(profile::applicable(buildModel(plain)));

  Puzzle lotused = plain;
  test::withLotus(lotused, 1, 1, kAxisHorizontal);
  EXPECT_FALSE(profile::applicable(buildModel(lotused)));
}

/// And for the viewpoint, whose vertical rays reach across every row the
/// frontier has already forgotten — declined like every non-letter kind.
TEST(Profile, DeclinesViewpoints) {
  const Puzzle plain = test::board({"a..", "...", "..a"});
  ASSERT_TRUE(profile::applicable(buildModel(plain)));

  Puzzle viewed = plain;
  test::withViewpoint(viewed, 1, 1, 3);
  EXPECT_FALSE(profile::applicable(buildModel(viewed)));
}

/// And for the galaxy, whose half turn mirrors rows the frontier has long
/// dropped — the whitelist declines it with no code knowing it exists.
TEST(Profile, DeclinesGalaxies) {
  const Puzzle plain = test::board({"a..", "...", "..a"});
  ASSERT_TRUE(profile::applicable(buildModel(plain)));

  Puzzle galaxied = plain;
  test::withGalaxy(galaxied, 1, 1);
  EXPECT_FALSE(profile::applicable(buildModel(galaxied)));
}

/**
 * And the whitelist itself: every rule the sweep does not name is refused,
 * whatever it is. Without this a rule appended to the catalogue tomorrow would
 * be accepted by default, exactly as `area-four-*` and darts would have been.
 *
 * The list is every rule that is a CONTAINMENT rule and nothing else — "this
 * arrangement never occurs" — because `patternsFor` is then the whole of what
 * the board forbids. A rule with any region-level content belongs on the other
 * side of this list however local it looks.
 */
TEST(Profile, DeclinesEveryRuleItDoesNotName) {
  using enum Rule;
  const std::vector<Rule> supportedRules = {
      ConnectDark,          ConnectLight,        Underclued,
      NoDark2x2,            NoLight2x2,          NoCheckerboard,
      NoDarkLightDark,      NoLightDarkLight,    NoDarkT,
      NoLightT,             NoThreeDarkOneLight, NoThreeLightOneDark,
      NoDarkDiagonal,       NoLightDiagonal,     NoDarkElbow,
      NoLightElbow,         NoDarkEll,           NoLightEll,
      NoDarkAnyDark,        NoLightAnyLight,     NoLightCrossedDarkT,
      NoDarkCrossedLightT,  NoDarkLongT,         NoLightLongT,
      NoDarkKnight,         NoLightKnight,       NoDarkLightDarkElbow,
      NoLightDarkLightElbow};
  for (int index = 0; index < rules::kRuleCount; index++) {
    const auto rule = static_cast<Rule>(index);
    // The 22 sized indices have no mask bit any more — their families arrive
    // as instances, and the explicit instance check is pinned above. What
    // this sweep keeps guarding is every FLAG, present and future.
    if (rules::has(rules::kSizedRuleBits, rule))
      continue;
    const bool supported =
        std::ranges::find(supportedRules, rule) != supportedRules.end();
    EXPECT_EQ(takes({"a..", "...", "..a"}, {rule}), supported)
        << "rule " << rules::name(rule);
  }
}

/**
 * A merged cell, for the same reason again — and asserted here rather than left
 * to `reference_test`'s `applicable` guard silently skipping those cases.
 *
 * The sweep carries one class slot per COLUMN and joins only leftwards and
 * upwards, so nothing in its state can say "this square takes the colour a
 * square two rows back already took". A sweep blind to that would enumerate
 * colourings that split a cell in half.
 */
TEST(Profile, DeclinesMergedCells) {
  const Puzzle plain = test::board({"a..", "...", "..a"});
  ASSERT_TRUE(profile::applicable(buildModel(plain)));

  Puzzle merged = plain;
  test::withShape(merged, {{0, 1}, {1, 1}});
  EXPECT_FALSE(profile::applicable(buildModel(merged)));
}

/// A declined board comes back as "nothing to say", never as a negative.
TEST(Profile, ADeclinedBoardClaimsNothing) {
  const Outcome outcome = sweep({"3..", "...", "..a"});
  EXPECT_EQ(outcome.status, Status::Unsolved);
  EXPECT_EQ(outcome.decided, 0);
  EXPECT_TRUE(outcome.witnesses.empty());
}

/**
 * Running out of room is not a proof either. The cap is expressed through
 * `maxHeapBytes`, so one byte of budget is enough to hit it immediately.
 */
TEST(Profile, RunningOutOfRoomIsNotAProof) {
  const Model model = buildModel(test::board({"a....", ".....", "....a"}));
  constexpr Config cfg{.maxMs = 30000, .maxHeapBytes = 1};
  const Outcome outcome = profile::runProfile(model, cfg);
  EXPECT_EQ(outcome.status, Status::Unsolved);
  EXPECT_TRUE(outcome.stats.stoppedOnMemory);
}

/**
 * A board wider than it is tall must be swept across the short side: the state
 * count grows with the frontier's width, so the difference is not a constant.
 * Both orientations have to answer, which is the cheap way to say the transpose
 * is wired up consistently.
 */
TEST(Profile, SweepsEitherOrientation) {
  EXPECT_EQ(sweep({"a....", "....a"}).status, Status::Solved);
  EXPECT_EQ(sweep({"a.", "..", "..", "..", ".a"}).status, Status::Solved);
}

} // namespace
