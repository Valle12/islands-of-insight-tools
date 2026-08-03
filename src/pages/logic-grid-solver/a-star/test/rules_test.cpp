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
  EXPECT_EQ(rules::kRuleCount, 18);
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
}

TEST(Rules, GlobalAreaListsItsMembers) {
  using rules::globalArea;
  EXPECT_EQ(globalArea(rules::bit(Rule::AreaTwoDark), kDark), 2);
  EXPECT_EQ(globalArea(rules::bit(Rule::AreaTwoDark), kLight), 0);
  EXPECT_EQ(globalArea(rules::bit(Rule::AreaTwoLight), kLight), 2);
  EXPECT_EQ(globalArea(rules::bit(Rule::ConnectDark), kDark), 0);
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
