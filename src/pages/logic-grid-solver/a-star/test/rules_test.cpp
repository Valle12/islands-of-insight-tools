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
  EXPECT_EQ(rules::kRuleCount, 16);
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
