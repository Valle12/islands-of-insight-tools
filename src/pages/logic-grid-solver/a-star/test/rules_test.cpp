#include "TestBoards.h"

#include "Puzzle.h"
#include "Rules.h"

#include <gtest/gtest.h>
#include <utility>

namespace {

using namespace lg;
using rules::Rule;

TEST(Rules, IndicesMirrorTheCatalogue) {
  // These positions ARE the saved file format, so they are pinned on both sides
  // — here and in `catalog.test.ts`. The list was reordered once, before the
  // site was live and with every captured fixture rewritten in the same change;
  // after that it is append-only.
  EXPECT_EQ(std::to_underlying(Rule::NoDark2x2), 0);
  EXPECT_EQ(std::to_underlying(Rule::NoLight2x2), 1);
  EXPECT_EQ(std::to_underlying(Rule::NoDark1x2), 2);
  EXPECT_EQ(std::to_underlying(Rule::NoLight1x2), 3);
  EXPECT_EQ(std::to_underlying(Rule::NoDark1x3), 4);
  EXPECT_EQ(std::to_underlying(Rule::NoLight1x3), 5);
  EXPECT_EQ(std::to_underlying(Rule::NoDark1x4), 6);
  EXPECT_EQ(std::to_underlying(Rule::NoLight1x4), 7);
  EXPECT_EQ(std::to_underlying(Rule::NoDark1x5), 8);
  EXPECT_EQ(std::to_underlying(Rule::NoLight1x5), 9);
  EXPECT_EQ(std::to_underlying(Rule::NoCheckerboard), 10);
  EXPECT_EQ(std::to_underlying(Rule::ConnectDark), 11);
  EXPECT_EQ(std::to_underlying(Rule::ConnectLight), 12);
  EXPECT_EQ(std::to_underlying(Rule::OneSymbolDark), 13);
  EXPECT_EQ(std::to_underlying(Rule::OneSymbolLight), 14);
  EXPECT_EQ(std::to_underlying(Rule::Underclued), 15);
  EXPECT_EQ(std::to_underlying(Rule::AreaTwoDark), 16);
  EXPECT_EQ(std::to_underlying(Rule::AreaTwoLight), 17);
  EXPECT_EQ(std::to_underlying(Rule::AreaFourDark), 18);
  EXPECT_EQ(std::to_underlying(Rule::AreaFourLight), 19);
  EXPECT_EQ(std::to_underlying(Rule::AreaFiveDark), 20);
  EXPECT_EQ(std::to_underlying(Rule::AreaFiveLight), 21);
  EXPECT_EQ(std::to_underlying(Rule::NoDarkLightDark), 22);
  EXPECT_EQ(std::to_underlying(Rule::NoLightDarkLight), 23);
  EXPECT_EQ(std::to_underlying(Rule::NoDarkT), 24);
  EXPECT_EQ(std::to_underlying(Rule::NoLightT), 25);
  EXPECT_EQ(rules::kRuleCount, 26);
}

TEST(Rules, NamesAreTheIdsFromTheCatalogue) {
  EXPECT_STREQ(rules::name(Rule::NoDark2x2), "no-dark-2x2");
  EXPECT_STREQ(rules::name(Rule::NoLight1x2), "no-light-1x2");
  EXPECT_STREQ(rules::name(Rule::NoDark1x2), "no-dark-1x2");
  EXPECT_STREQ(rules::name(Rule::Underclued), "underclued");
  EXPECT_STREQ(rules::name(Rule::NoCheckerboard), "no-checkerboard");
  EXPECT_STREQ(rules::name(Rule::NoLight1x5), "no-light-1x5");
  EXPECT_STREQ(rules::name(Rule::NoDark1x5), "no-dark-1x5");
  EXPECT_STREQ(rules::name(Rule::OneSymbolDark), "one-symbol-dark");
  EXPECT_STREQ(rules::name(Rule::OneSymbolLight), "one-symbol-light");
  EXPECT_STREQ(rules::name(Rule::AreaTwoDark), "area-two-dark");
  EXPECT_STREQ(rules::name(Rule::AreaTwoLight), "area-two-light");
  EXPECT_STREQ(rules::name(Rule::AreaFourDark), "area-four-dark");
  EXPECT_STREQ(rules::name(Rule::AreaFourLight), "area-four-light");
  EXPECT_STREQ(rules::name(Rule::AreaFiveDark), "area-five-dark");
  EXPECT_STREQ(rules::name(Rule::AreaFiveLight), "area-five-light");
  EXPECT_STREQ(rules::name(Rule::NoDarkLightDark), "no-dark-light-dark");
  EXPECT_STREQ(rules::name(Rule::NoLightDarkLight), "no-light-dark-light");
  EXPECT_STREQ(rules::name(Rule::NoDarkT), "no-dark-t");
  EXPECT_STREQ(rules::name(Rule::NoLightT), "no-light-t");
}

TEST(Rules, GlobalAreaListsItsMembers) {
  using rules::smallestGlobalArea;
  EXPECT_EQ(smallestGlobalArea(rules::bit(Rule::AreaTwoDark), kDark), 2);
  EXPECT_EQ(smallestGlobalArea(rules::bit(Rule::AreaTwoDark), kLight), 0);
  EXPECT_EQ(smallestGlobalArea(rules::bit(Rule::AreaTwoLight), kLight), 2);
  EXPECT_EQ(smallestGlobalArea(rules::bit(Rule::AreaFourDark), kDark), 4);
  EXPECT_EQ(smallestGlobalArea(rules::bit(Rule::AreaFiveLight), kLight), 5);
  EXPECT_EQ(smallestGlobalArea(rules::bit(Rule::ConnectDark), kDark), 0);
}

/**
 * The min, and only for `impliedRun`, where it is sound because the rules are
 * conjunctive. What it may NOT be read as is "the size a region has to be":
 * with both sizes on for a colour the answer is that the colour is absent, and
 * a caller taking 2 from here would force exactly two cells of it instead.
 */
TEST(Rules, GlobalAreaTakesTheSmallestOfSeveral) {
  constexpr rules::RuleMask both =
      rules::bit(Rule::AreaTwoDark) | rules::bit(Rule::AreaFourDark);
  EXPECT_EQ(rules::smallestGlobalArea(both, kDark), 2);
  EXPECT_EQ(rules::smallestGlobalArea(both, kLight), 0);
}

/**
 * The asymmetry between the two sizes, stated where it can be seen. Area two
 * forbids the four bent trominoes outright; area four's equivalent would be 61
 * pentominoes, so it is `regionArea` in `Propagate.cpp` instead and contributes
 * only the run its number implies.
 */
TEST(Patterns, AnAreaOfFourAddsNoShapesBeyondItsImpliedRun) {
  const rules::Patterns patterns =
      rules::patternsFor(rules::bit(Rule::AreaFourDark));
  ASSERT_EQ(patterns.size(), 2U);
  EXPECT_EQ(patterns.front().count, 5);
  EXPECT_EQ(patterns.back().count, 5);
}

/**
 * The first six-cell pattern, which is what forced `kMaxPatternCells` to 6.
 * `runPattern` writes `cells[i]` with no assert of its own — only hand-listed
 * `fromCells` patterns are guarded — so the last cell is checked by POSITION
 * here: with the constant still at 5 this write lands out of bounds.
 */
TEST(Patterns, AnAreaOfFiveImpliesARunOfSix) {
  const rules::Patterns patterns =
      rules::patternsFor(rules::bit(Rule::AreaFiveDark));
  ASSERT_EQ(patterns.size(), 2U);
  EXPECT_EQ(patterns.front().count, 6);
  EXPECT_EQ(patterns.back().count, 6);
  EXPECT_EQ(patterns.front().cells[5].dx, 5);
  EXPECT_EQ(patterns.back().cells[5].dy, 5);
}

/// Both sizes on one colour take the shorter implied run, and nothing else.
TEST(Patterns, TheSmallerAreaWinsTheImpliedRun) {
  const rules::Patterns patterns = rules::patternsFor(
      rules::bit(Rule::AreaTwoDark) | rules::bit(Rule::AreaFourDark));
  // The two straight trominoes from area two, plus its four bent ones.
  ASSERT_EQ(patterns.size(), 6U);
  EXPECT_EQ(patterns.front().count, 3);
}

TEST(Patterns, ASquareRuleIsOneFourCellPattern) {
  const rules::Patterns patterns = rules::patternsFor(rules::bit(Rule::NoDark2x2));
  ASSERT_EQ(patterns.size(), 1U);
  EXPECT_EQ(patterns.front().count, 4);
}

TEST(Patterns, ARunRuleIsOnePatternPerDirection) {
  const rules::Patterns patterns =
      rules::patternsFor(rules::bit(Rule::NoDark1x3));
  ASSERT_EQ(patterns.size(), 2U);
  EXPECT_EQ(patterns.front().count, 3);
  EXPECT_EQ(patterns.back().count, 3);
}

TEST(Patterns, ShorterRunsSubsumeLongerOnes) {
  // Forbidding dark pairs already forbids every longer dark run, so laying the
  // 1x4 instances out as well would only add work that can never fire.
  const rules::Patterns patterns = rules::patternsFor(
      rules::bit(Rule::NoDark1x2) | rules::bit(Rule::NoDark1x4));
  ASSERT_EQ(patterns.size(), 2U);
  EXPECT_EQ(patterns.front().count, 2);
}

TEST(Patterns, TheLongestRunRuleIsFiveCellsWide) {
  // The whole extensibility claim: the 1x5 pair is a row in `shortestRun` and
  // nothing else, so it has to come out of the compiler as five-cell patterns
  // without any of the machinery downstream knowing it exists.
  const rules::Patterns patterns =
      rules::patternsFor(rules::bit(Rule::NoLight1x5));
  ASSERT_EQ(patterns.size(), 2U);
  EXPECT_EQ(patterns.front().count, 5);
  EXPECT_EQ(patterns.back().count, 5);
  EXPECT_EQ(patterns.front().cells[4].dx, 4);
  EXPECT_EQ(patterns.back().cells[4].dy, 4);
}

TEST(Patterns, AFiveRunIsSubsumedByEveryShorterRule) {
  const rules::Patterns patterns = rules::patternsFor(
      rules::bit(Rule::NoDark1x3) | rules::bit(Rule::NoDark1x5));
  ASSERT_EQ(patterns.size(), 2U);
  EXPECT_EQ(patterns.front().count, 3);
}

TEST(Patterns, AnAreaRuleIsEveryTromino) {
  // "No region bigger than two" IS a forbidden arrangement: a connected set of
  // three or more cells always contains a connected THREE, and the connected
  // trominoes are the two straight ones plus the four bent ones. That is what
  // lets half of this rule cost no new code at all.
  const rules::Patterns patterns =
      rules::patternsFor(rules::bit(Rule::AreaTwoDark));
  ASSERT_EQ(patterns.size(), 6U);
  for (const auto &[cells, count] : patterns)
    EXPECT_EQ(count, 3);
}

TEST(Patterns, AnAreaRuleDoesNotRepeatTheRunItImplies) {
  // The 1x3 rule and the area rule forbid the same two straight trominoes, and
  // a duplicate would be worse than dead weight: `GenerateCommands::cost`
  // counts violated clauses, so one broken straight would score two and bias
  // the generator's local search.
  const rules::Patterns patterns = rules::patternsFor(
      rules::bit(Rule::AreaTwoDark) | rules::bit(Rule::NoDark1x3));
  EXPECT_EQ(patterns.size(), 6U);
}

TEST(Patterns, AnAreaRuleShortensALongerRunRule) {
  const rules::Patterns patterns = rules::patternsFor(
      rules::bit(Rule::AreaTwoDark) | rules::bit(Rule::NoDark1x5));
  ASSERT_EQ(patterns.size(), 6U);
  EXPECT_EQ(patterns.front().count, 3);
}

TEST(Patterns, AForbiddenPairSubsumesEveryTromino) {
  // Every tromino contains a pair, so with dark pairs forbidden outright the
  // area rule has nothing left to add — and no dark cell can be painted.
  const rules::Patterns patterns = rules::patternsFor(
      rules::bit(Rule::AreaTwoDark) | rules::bit(Rule::NoDark1x2));
  ASSERT_EQ(patterns.size(), 2U);
  EXPECT_EQ(patterns.front().count, 2);
}

TEST(Patterns, ATripleRuleIsOneMixedPatternPerDirection) {
  const rules::Patterns patterns =
      rules::patternsFor(rules::bit(Rule::NoDarkLightDark));
  ASSERT_EQ(patterns.size(), 2U);
  for (const auto &[cells, count] : patterns) {
    EXPECT_EQ(count, 3);
    EXPECT_EQ(cells[0].color, kDark);
    EXPECT_EQ(cells[1].color, kLight);
    EXPECT_EQ(cells[2].color, kDark);
  }
}

TEST(Patterns, TheTwoTripleRulesAreMirrors) {
  const rules::Patterns patterns =
      rules::patternsFor(rules::bit(Rule::NoLightDarkLight));
  ASSERT_EQ(patterns.size(), 2U);
  EXPECT_EQ(patterns.front().cells[0].color, kLight);
  EXPECT_EQ(patterns.front().cells[1].color, kDark);
  EXPECT_EQ(patterns.front().cells[2].color, kLight);
}

TEST(Patterns, ATeeRuleIsFourRotations) {
  const rules::Patterns patterns =
      rules::patternsFor(rules::bit(Rule::NoDarkT));
  ASSERT_EQ(patterns.size(), 4U);
  for (const auto &[cells, count] : patterns)
    EXPECT_EQ(count, 4);
}

TEST(Patterns, AShortRunRuleSubsumesTheTee) {
  // Every T contains a straight three, so with dark threes already forbidden
  // the T instances could never prune anything the run clauses do not — and a
  // clause that duplicates another's work biases `GenerateCommands::cost()`,
  // which counts violations.
  const rules::Patterns patterns = rules::patternsFor(
      rules::bit(Rule::NoDarkT) | rules::bit(Rule::NoDark1x3));
  ASSERT_EQ(patterns.size(), 2U);
  EXPECT_EQ(patterns.front().count, 3);
}

TEST(Patterns, AnAreaOfTwoSubsumesTheTee) {
  // Via the implied run of three, which is the same argument one step removed.
  const rules::Patterns patterns = rules::patternsFor(
      rules::bit(Rule::NoDarkT) | rules::bit(Rule::AreaTwoDark));
  EXPECT_EQ(patterns.size(), 6U);
}

TEST(Patterns, ALongerRunRuleDoesNotSubsumeTheTee) {
  // A 1x4 rule says nothing about the T, whose longest straight is three.
  const rules::Patterns patterns = rules::patternsFor(
      rules::bit(Rule::NoDarkT) | rules::bit(Rule::NoDark1x4));
  EXPECT_EQ(patterns.size(), 6U);
}

TEST(Patterns, ARunOfOneColourDoesNotSubsumeTheOtherTee) {
  const rules::Patterns patterns = rules::patternsFor(
      rules::bit(Rule::NoLightT) | rules::bit(Rule::NoDark1x3));
  EXPECT_EQ(patterns.size(), 6U);
}

TEST(Patterns, TheTwoAreaRulesDoNotSubsumeEachOther) {
  const rules::Patterns patterns = rules::patternsFor(
      rules::bit(Rule::AreaTwoDark) | rules::bit(Rule::AreaTwoLight));
  EXPECT_EQ(patterns.size(), 12U);
}

TEST(Patterns, TheTwoColoursDoNotSubsumeEachOther) {
  const rules::Patterns patterns = rules::patternsFor(
      rules::bit(Rule::NoDark1x2) | rules::bit(Rule::NoLight1x4));
  EXPECT_EQ(patterns.size(), 4U);
}

TEST(Patterns, BothColoursConnectedImplyNoCheckerboard) {
  const rules::Patterns patterns = rules::patternsFor(
      rules::bit(Rule::ConnectDark) | rules::bit(Rule::ConnectLight));
  EXPECT_EQ(patterns.size(), 2U);
}

TEST(Patterns, OneColourConnectedImpliesNothing) {
  EXPECT_TRUE(rules::patternsFor(rules::bit(Rule::ConnectDark)).empty());
}

TEST(Patterns, UndercluedIsNotAColouringRule) {
  EXPECT_TRUE(rules::patternsFor(rules::bit(Rule::Underclued)).empty());
}

TEST(Patterns, AnInstanceTouchingAGapIsDropped) {
  // A 2x2 with a hole in it can never be "entirely one colour", so there is
  // nothing left to forbid.
  const Model model =
      buildModel(test::board({"..", ".#"}, rules::bit(Rule::NoDark2x2)));
  EXPECT_TRUE(model.clauses.empty());
}

TEST(Patterns, InstancesCoverEveryAnchorThatFits) {
  const Model model =
      buildModel(test::board({"...", "...", "..."}, rules::bit(Rule::NoDark2x2)));
  EXPECT_EQ(model.clauses.size(), 4U);
}

TEST(Patterns, ABentInstanceFitsWhereAStraightOneCannot) {
  // Two by two has no room for a straight tromino and holds all four bent ones,
  // which is exactly the half of an area rule no run rule could express.
  const Model model =
      buildModel(test::board({"..", ".."}, rules::bit(Rule::AreaTwoDark)));
  EXPECT_EQ(model.clauses.size(), 4U);
}

TEST(Patterns, EveryCellKnowsTheClausesItIsIn) {
  const Model model =
      buildModel(test::board({"..", ".."}, rules::bit(Rule::NoDark2x2)));
  ASSERT_EQ(model.clauses.size(), 1U);
  for (int y = 0; y < 2; y++) {
    for (int x = 0; x < 2; x++) {
      const int cell = cellIndex(x, y);
      EXPECT_EQ(model.clauseStart[slot(cell + 1)] -
                    model.clauseStart[slot(cell)],
                1);
    }
  }
}

} // namespace
