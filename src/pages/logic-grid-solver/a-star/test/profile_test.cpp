#include "TestBoards.h"

#include "Profile.h"
#include "Puzzle.h"
#include "Rules.h"
#include "Search.h"
#include "Verify.h"

#include <gtest/gtest.h>
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
  // The pattern rules each need their own extra state; see Profile.h.
  EXPECT_FALSE(takes({"a..", "...", "..a"}, {Rule::NoDark2x2}));
  EXPECT_FALSE(takes({"a..", "...", "..a"}, {Rule::NoDark1x3}));
  EXPECT_FALSE(takes({"a..", "...", "..a"}, {Rule::NoCheckerboard}));
  // An area RULE needs the same state an area clue would — the frontier carries
  // each open class's colour and letter, never its size. Declining is a
  // correctness requirement here rather than a tidiness one: `runProfileForced`
  // sets `proven` with no oracle gate on its forced set, so a sweep blind to a
  // rule would enumerate a superset of the solutions and then claim the cells
  // they disagree about were proved to go either way.
  EXPECT_FALSE(takes({"a..", "...", "..a"}, {Rule::AreaTwoDark}));
  EXPECT_FALSE(takes({"a..", "...", "..a"}, {Rule::AreaTwoLight}));
  EXPECT_FALSE(takes({"a..", "...", "..a"}, {Rule::AreaFourDark}));
  EXPECT_FALSE(takes({"a..", "...", "..a"}, {Rule::AreaFourLight}));
}

/**
 * A dart, which the sweep cannot express for a reason of its own: its line
 * crosses the sweep rather than following it, so a running count of what the
 * line holds would have to survive in the frontier from one end of the board to
 * the other.
 *
 * This is the case the gate got wrong when it was a denylist. A dart-only board
 * names no area clue and no listed rule, so it was ACCEPTED, and `planOf` reads
 * letters only — the dart was then silently ignored and the forced set claimed
 * as proved. Whitelisted, anything unrecognised declines by default.
 */
TEST(Profile, DeclinesDarts) {
  const Puzzle plain = test::board({"a..", "...", "..a"});
  ASSERT_TRUE(profile::applicable(buildModel(plain)));

  Puzzle darted = plain;
  test::withDart(darted, 1, 1, 1, kDirRight);
  EXPECT_FALSE(profile::applicable(buildModel(darted)));
}

/**
 * And the whitelist itself: every rule the sweep does not name is refused,
 * whatever it is. Without this a rule appended to the catalogue tomorrow would
 * be accepted by default, exactly as `area-four-*` and darts would have been.
 */
TEST(Profile, DeclinesEveryRuleItDoesNotName) {
  for (int index = 0; index < rules::kRuleCount; index++) {
    const auto rule = static_cast<Rule>(index);
    const bool supported = rule == Rule::ConnectDark ||
                           rule == Rule::ConnectLight ||
                           rule == Rule::Underclued;
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
