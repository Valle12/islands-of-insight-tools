#include "TestBoards.h"

#include "Puzzle.h"
#include "Rules.h"

#include <algorithm>
#include <gtest/gtest.h>
#include <utility>

namespace {

using namespace lg;
using rules::Rule;

/**
 * The patterns a v1-style mask compiles to, through the same translation the
 * CLI's `--rules` speaks (`splitLegacyMask`). Most cases in this file predate
 * format version 2 and still SAY masks; routing them through the real
 * translator keeps them exercising a production path rather than a private
 * re-encoding — and keeps every historical pin meaning what it always meant.
 */
rules::Patterns patternsForMask(const rules::RuleMask mask) {
  const auto [flags, areas, runs, patterns] = rules::splitLegacyMask(mask);
  return rules::patternsFor(flags, areas, runs, patterns);
}

/// Two patterns naming the same squares in the same colors, whatever order
/// their cells were laid out in — which the builders and `addDrawn` do
/// differently.
bool sameCells(const rules::Pattern &a, const rules::Pattern &b) {
  return a.count() == b.count() &&
         std::ranges::all_of(a.cells, [&b](const rules::PatternCell &cell) {
           return std::ranges::contains(b.cells, cell);
         });
}

TEST(Rules, IndicesMirrorTheCatalog) {
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
  EXPECT_EQ(std::to_underlying(Rule::NoThreeDarkOneLight), 26);
  EXPECT_EQ(std::to_underlying(Rule::NoThreeLightOneDark), 27);
  EXPECT_EQ(std::to_underlying(Rule::NoDarkDiagonal), 28);
  EXPECT_EQ(std::to_underlying(Rule::NoLightDiagonal), 29);
  EXPECT_EQ(std::to_underlying(Rule::AreaThreeDark), 30);
  EXPECT_EQ(std::to_underlying(Rule::AreaThreeLight), 31);
  EXPECT_EQ(std::to_underlying(Rule::OffByOne), 32);
  EXPECT_EQ(std::to_underlying(Rule::NoDarkElbow), 33);
  EXPECT_EQ(std::to_underlying(Rule::NoLightElbow), 34);
  EXPECT_EQ(std::to_underlying(Rule::NoDarkEll), 35);
  EXPECT_EQ(std::to_underlying(Rule::NoLightEll), 36);
  EXPECT_EQ(std::to_underlying(Rule::NoDarkAnyDark), 37);
  EXPECT_EQ(std::to_underlying(Rule::NoLightAnyLight), 38);
  EXPECT_EQ(std::to_underlying(Rule::AreaSixDark), 39);
  EXPECT_EQ(std::to_underlying(Rule::AreaSixLight), 40);
  EXPECT_EQ(std::to_underlying(Rule::AreaSevenDark), 41);
  EXPECT_EQ(std::to_underlying(Rule::AreaSevenLight), 42);
  EXPECT_EQ(std::to_underlying(Rule::NoLightCrossedDarkT), 43);
  EXPECT_EQ(std::to_underlying(Rule::NoDarkCrossedLightT), 44);
  EXPECT_EQ(std::to_underlying(Rule::NoDarkLongT), 45);
  EXPECT_EQ(std::to_underlying(Rule::NoLightLongT), 46);
  EXPECT_EQ(std::to_underlying(Rule::AreaTwentyFourDark), 47);
  EXPECT_EQ(std::to_underlying(Rule::AreaTwentyFourLight), 48);
  EXPECT_EQ(std::to_underlying(Rule::NoDarkKnight), 49);
  EXPECT_EQ(std::to_underlying(Rule::NoLightKnight), 50);
  EXPECT_EQ(std::to_underlying(Rule::NoDarkLightDarkElbow), 51);
  EXPECT_EQ(std::to_underlying(Rule::NoLightDarkLightElbow), 52);
  EXPECT_EQ(std::to_underlying(Rule::DistinctShapesDark), 53);
  EXPECT_EQ(std::to_underlying(Rule::DistinctShapesLight), 54);
  EXPECT_EQ(std::to_underlying(Rule::SameShapeDark), 55);
  EXPECT_EQ(std::to_underlying(Rule::SameShapeLight), 56);
  EXPECT_EQ(rules::kRuleCount, 57);
}

TEST(Rules, NamesAreTheIdsFromTheCatalog) {
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
  EXPECT_STREQ(rules::name(Rule::NoThreeDarkOneLight),
               "no-three-dark-one-light");
  EXPECT_STREQ(rules::name(Rule::NoThreeLightOneDark),
               "no-three-light-one-dark");
  EXPECT_STREQ(rules::name(Rule::NoDarkDiagonal), "no-dark-diagonal");
  EXPECT_STREQ(rules::name(Rule::NoLightDiagonal), "no-light-diagonal");
  EXPECT_STREQ(rules::name(Rule::AreaThreeDark), "area-three-dark");
  EXPECT_STREQ(rules::name(Rule::AreaThreeLight), "area-three-light");
  EXPECT_STREQ(rules::name(Rule::OffByOne), "off-by-one");
  EXPECT_STREQ(rules::name(Rule::NoDarkElbow), "no-dark-elbow");
  EXPECT_STREQ(rules::name(Rule::NoLightElbow), "no-light-elbow");
  EXPECT_STREQ(rules::name(Rule::NoDarkEll), "no-dark-l");
  EXPECT_STREQ(rules::name(Rule::NoLightEll), "no-light-l");
  EXPECT_STREQ(rules::name(Rule::NoDarkAnyDark), "no-dark-any-dark");
  EXPECT_STREQ(rules::name(Rule::NoLightAnyLight), "no-light-any-light");
  EXPECT_STREQ(rules::name(Rule::AreaSixDark), "area-six-dark");
  EXPECT_STREQ(rules::name(Rule::AreaSixLight), "area-six-light");
  EXPECT_STREQ(rules::name(Rule::AreaSevenDark), "area-seven-dark");
  EXPECT_STREQ(rules::name(Rule::AreaSevenLight), "area-seven-light");
  EXPECT_STREQ(rules::name(Rule::NoLightCrossedDarkT),
               "no-light-crossed-dark-t");
  EXPECT_STREQ(rules::name(Rule::NoDarkCrossedLightT),
               "no-dark-crossed-light-t");
  EXPECT_STREQ(rules::name(Rule::NoDarkLongT), "no-dark-long-t");
  EXPECT_STREQ(rules::name(Rule::NoLightLongT), "no-light-long-t");
  EXPECT_STREQ(rules::name(Rule::AreaTwentyFourDark), "area-twenty-four-dark");
  EXPECT_STREQ(rules::name(Rule::AreaTwentyFourLight),
               "area-twenty-four-light");
  EXPECT_STREQ(rules::name(Rule::NoDarkKnight), "no-dark-knight");
  EXPECT_STREQ(rules::name(Rule::NoLightKnight), "no-light-knight");
  EXPECT_STREQ(rules::name(Rule::NoDarkLightDarkElbow),
               "no-dark-light-dark-elbow");
  EXPECT_STREQ(rules::name(Rule::NoLightDarkLightElbow),
               "no-light-dark-light-elbow");
  EXPECT_STREQ(rules::name(Rule::DistinctShapesDark), "distinct-shapes-dark");
  EXPECT_STREQ(rules::name(Rule::DistinctShapesLight), "distinct-shapes-light");
  EXPECT_STREQ(rules::name(Rule::SameShapeDark), "same-shape-dark");
  EXPECT_STREQ(rules::name(Rule::SameShapeLight), "same-shape-light");
}

/// The shape family compiles into NO forbidden arrangements, and that is a
/// decision rather than an omission: the table may only hold rules a bounded
/// window can state, and these relate regions arbitrarily far apart and read
/// each region's maximality.
TEST(Rules, TheShapeRulesAreNotTableRules) {
  using enum Rule;
  EXPECT_TRUE(patternsForMask(rules::bit(DistinctShapesDark) |
                              rules::bit(DistinctShapesLight) |
                              rules::bit(SameShapeDark) |
                              rules::bit(SameShapeLight))
                  .empty());
}

TEST(Rules, SmallestAreaReadsOnlyItsColor) {
  using rules::smallestArea;
  EXPECT_EQ(smallestArea({{.color = kDark, .value = 2}}, kDark), 2);
  EXPECT_EQ(smallestArea({{.color = kDark, .value = 2}}, kLight), 0);
  EXPECT_EQ(smallestArea({{.color = kLight, .value = 2}}, kLight), 2);
  EXPECT_EQ(smallestArea({{.color = kDark, .value = 24}}, kDark), 24);
  EXPECT_EQ(smallestArea({}, kDark), 0);
}

/**
 * The min, and only for `impliedRun` and `mergeLimits`, where it is sound
 * because the instances are conjunctive. What it may NOT be read as is "the
 * size a region has to be": with both sizes on for a color the answer is
 * that the color is absent, and a caller taking 2 from here would force
 * exactly two cells of it instead.
 */
TEST(Rules, SmallestAreaTakesTheSmallestOfSeveral) {
  const std::vector<rules::SizedRule> both{{.color = kDark, .value = 2},
                                           {.color = kDark, .value = 4}};
  EXPECT_EQ(rules::smallestArea(both, kDark), 2);
  EXPECT_EQ(rules::smallestArea(both, kLight), 0);
}

TEST(Rules, SizedLessOrdersDarkFirstThenAscending) {
  using rules::sizedLess;
  EXPECT_TRUE(
      sizedLess({.color = kDark, .value = 9}, {.color = kLight, .value = 2}));
  EXPECT_TRUE(
      sizedLess({.color = kDark, .value = 2}, {.color = kDark, .value = 3}));
  EXPECT_FALSE(
      sizedLess({.color = kLight, .value = 2}, {.color = kDark, .value = 9}));
  EXPECT_FALSE(
      sizedLess({.color = kDark, .value = 2}, {.color = kDark, .value = 2}));
}

TEST(Rules, SizedRuleBitsNameExactlyTheRetiredIndices) {
  // The 22 v1 positions, spelled as literals on purpose: this is the set the
  // intakes refuse by name and the migration rewrites, pinned independently
  // of the tables that derive it.
  rules::RuleMask expected = 0;
  for (const int index : {2, 3, 4, 5, 6, 7, 8, 9, 16, 17, 18, 19, 20, 21, 30,
                          31, 39, 40, 41, 42, 47, 48})
    expected |= rules::RuleMask{1} << index;
  EXPECT_EQ(rules::kSizedRuleBits, expected);
}

TEST(Rules, SplitLegacyMaskTranslatesAndCanonicalizes) {
  using enum Rule;
  // Sized bits chosen so a straight table walk comes out UNsorted: area three
  // sits at a higher index than area four, and the light run's bit below the
  // dark one's.
  constexpr rules::RuleMask mask =
      rules::bit(ConnectDark) | rules::bit(AreaFourDark) |
      rules::bit(AreaThreeDark) | rules::bit(AreaTwoLight) |
      rules::bit(NoLight1x2) | rules::bit(NoDark1x4);
  const auto [flags, areas, runs, patterns] = rules::splitLegacyMask(mask);
  EXPECT_EQ(flags, rules::bit(ConnectDark));
  EXPECT_EQ(areas,
            (std::vector<rules::SizedRule>{{.color = kDark, .value = 3},
                                           {.color = kDark, .value = 4},
                                           {.color = kLight, .value = 2}}));
  EXPECT_EQ(runs,
            (std::vector<rules::SizedRule>{{.color = kDark, .value = 4},
                                           {.color = kLight, .value = 2}}));
  EXPECT_TRUE(patterns.empty());
}

TEST(Rules, DrawnRuleBitsNameExactlyTheRetiredArrangements) {
  // The ten v2 positions, spelled as literals for the same reason the sized
  // set above is: this is what the intakes refuse by name and what the v3
  // migration rewrites, pinned independently of the table that derives it.
  rules::RuleMask expected = 0;
  for (const int index : {28, 29, 35, 36, 43, 44, 49, 50, 51, 52})
    expected |= rules::RuleMask{1} << index;
  EXPECT_EQ(rules::kDrawnRuleBits, expected);
}

TEST(Rules, SplitLegacyMaskTurnsRetiredArrangementsIntoPatterns) {
  using enum Rule;
  const auto [flags, areas, runs, patterns] = rules::splitLegacyMask(
      rules::bit(ConnectDark) | rules::bit(NoDarkKnight) |
      rules::bit(NoDarkDiagonal));
  // The retired bits leave the mask ENTIRELY, unlike a sized bit's family:
  // `patternsFor`'s gates read rule bits and a drawn pattern has none.
  EXPECT_EQ(flags, rules::bit(ConnectDark));
  EXPECT_TRUE(areas.empty());
  EXPECT_TRUE(runs.empty());
  ASSERT_EQ(patterns.size(), 2U);
  // Ordered by `patternLess`, so the 2x2 diagonal comes before the 2x3
  // knight's move whatever order the enum lists them in.
  EXPECT_EQ(patterns.front().height, 2);
  EXPECT_EQ(patterns.back().height, 3);
}

/**
 * The claim the whole format bump rests on: retiring the ten changed nothing
 * about what any mask compiles to.
 *
 * The left side is the path a v1 mask, a fuzz seed and every historical pin in
 * this file really take — torn apart by `splitLegacyMask`, with the shapes put
 * back by `patternsFor`'s recognizer. The right side is the raw mask, which is
 * what those rules compiled to while they were still bits. Swept over every
 * retired rule against every surviving flag, because that is where the
 * subsumption gates live: miss one and a broken shape starts scoring twice in
 * `GenerateCommands::cost()`, which moves every generated board.
 *
 * Compared as SETS — `addDrawn` and the builders walk their shapes in
 * different orders, and only membership is the claim.
 */
TEST(Patterns, RetirementLeftEveryMaskCompilingTheSame) {
  const auto agree = [](const rules::RuleMask mask) {
    const rules::Patterns viaPatterns = patternsForMask(mask);
    const rules::Patterns viaMask = rules::patternsFor(mask, {}, {}, {});
    if (viaPatterns.size() != viaMask.size())
      return false;
    return std::ranges::all_of(viaMask, [&viaPatterns](
                                            const rules::Pattern &pattern) {
      return std::ranges::any_of(viaPatterns,
                                 [&pattern](const rules::Pattern &other) {
                                   return sameCells(pattern, other);
                                 });
    });
  };
  for (const auto &entry : rules::kLegacyPatterns) {
    const rules::RuleMask retired = rules::bit(entry.rule);
    EXPECT_TRUE(agree(retired)) << rules::name(entry.rule);
    for (int index = 0; index < rules::kRuleCount; index++) {
      const auto other = static_cast<Rule>(index);
      // The sized indices have no bit to pair with any more.
      if (rules::has(rules::kSizedRuleBits, other))
        continue;
      EXPECT_TRUE(agree(retired | rules::bit(other)))
          << rules::name(entry.rule) << " with " << rules::name(other);
    }
  }
}

/**
 * And the recognizer does not overreach: a drawing that is NOT one of the ten
 * stays out of the mask, so it neither subsumes nor is subsumed.
 *
 * The T is the case to state — it is a shape this file knows perfectly well,
 * with a builder and a bit of its own, and it is deliberately not recognized.
 * Drawing one beside `NoDark2x2` therefore lays both clause sets, where
 * switching the T's own chip on would leave the 2x2 alone.
 */
TEST(Patterns, ADrawnShapeThatIsNotRetiredIsNotRecognized) {
  const rules::DrawnPattern tee = test::pattern({"DDD", ".D."});
  const rules::Patterns drawn =
      rules::patternsFor(rules::bit(Rule::NoDark2x2), {}, {}, {tee});
  // The 2x2's one pattern, plus the T's four rotations.
  EXPECT_EQ(drawn.size(), 5U);
}

TEST(Patterns, EveryRetiredPictureFillsItsOwnBox) {
  for (const auto &entry : rules::kLegacyPatterns) {
    const rules::DrawnPattern drawn = rules::drawnFromLegacy(entry);
    EXPECT_EQ(drawn.cells.size(),
              static_cast<std::size_t>(entry.width) * entry.height)
        << rules::name(entry.rule);
    // Tight and non-blank, which is what both intakes demand of any pattern.
    EXPECT_TRUE(rules::isTightBox(drawn)) << rules::name(entry.rule);
  }
}

/**
 * The asymmetry between the two sizes, stated where it can be seen. Area two
 * forbids the four bent trominoes outright; area four's equivalent would be 61
 * pentominoes, so it is `regionArea` in `Propagate.cpp` instead and contributes
 * only the run its number implies.
 */
TEST(Patterns, AnAreaOfFourAddsNoShapesBeyondItsImpliedRun) {
  const rules::Patterns patterns =
      patternsForMask(rules::bit(Rule::AreaFourDark));
  ASSERT_EQ(patterns.size(), 2U);
  EXPECT_EQ(patterns.front().count(), 5);
  EXPECT_EQ(patterns.back().count(), 5);
}

/**
 * The first six-cell pattern, which is what forced `kMaxPatternCells` to 6.
 * `runPattern` writes `cells[i]` with no assert of its own — only hand-listed
 * `fromCells` patterns are guarded — so the last cell is checked by POSITION
 * here: with the constant still at 5 this write lands out of bounds.
 */
TEST(Patterns, AnAreaOfFiveImpliesARunOfSix) {
  const rules::Patterns patterns =
      patternsForMask(rules::bit(Rule::AreaFiveDark));
  ASSERT_EQ(patterns.size(), 2U);
  EXPECT_EQ(patterns.front().count(), 6);
  EXPECT_EQ(patterns.back().count(), 6);
  EXPECT_EQ(patterns.front().cells[5].dx, 5);
  EXPECT_EQ(patterns.back().cells[5].dy, 5);
}

/// Area THREE sits on four and five's side of the table trade: `regionArea`
/// carries both halves, and the table sees only the implied straight run of
/// FOUR — well inside `kMaxPatternCells`, so the constant did not move.
TEST(Patterns, AnAreaOfThreeAddsNoShapesBeyondItsImpliedRun) {
  const rules::Patterns patterns =
      patternsForMask(rules::bit(Rule::AreaThreeDark));
  ASSERT_EQ(patterns.size(), 2U);
  EXPECT_EQ(patterns.front().count(), 4);
  EXPECT_EQ(patterns.back().count(), 4);
  EXPECT_EQ(patterns.front().cells[3].dx, 3);
  EXPECT_EQ(patterns.back().cells[3].dy, 3);
}

/// Both sizes on one color take the shorter implied run, and nothing else.
TEST(Patterns, TheSmallerAreaWinsTheImpliedRun) {
  const rules::Patterns patterns = patternsForMask(
      rules::bit(Rule::AreaTwoDark) | rules::bit(Rule::AreaFourDark));
  // The two straight trominoes from area two, plus its four bent ones.
  ASSERT_EQ(patterns.size(), 6U);
  EXPECT_EQ(patterns.front().count(), 3);
}

TEST(Patterns, ASquareRuleIsOneFourCellPattern) {
  const rules::Patterns patterns = patternsForMask(rules::bit(Rule::NoDark2x2));
  ASSERT_EQ(patterns.size(), 1U);
  EXPECT_EQ(patterns.front().count(), 4);
}

TEST(Patterns, ARunRuleIsOnePatternPerDirection) {
  const rules::Patterns patterns =
      patternsForMask(rules::bit(Rule::NoDark1x3));
  ASSERT_EQ(patterns.size(), 2U);
  EXPECT_EQ(patterns.front().count(), 3);
  EXPECT_EQ(patterns.back().count(), 3);
}

TEST(Patterns, ShorterRunsSubsumeLongerOnes) {
  // Forbidding dark pairs already forbids every longer dark run, so laying the
  // 1x4 instances out as well would only add work that can never fire.
  const rules::Patterns patterns = patternsForMask(
      rules::bit(Rule::NoDark1x2) | rules::bit(Rule::NoDark1x4));
  ASSERT_EQ(patterns.size(), 2U);
  EXPECT_EQ(patterns.front().count(), 2);
}

TEST(Patterns, TheLongestRunRuleIsFiveCellsWide) {
  // The extensibility claim, v1 edition: the 1x5 pair was one legacy-table row
  // and nothing else, so it has to come out of the compiler as five-cell
  // patterns without any of the machinery downstream knowing it exists. (The
  // claim's v2 form — any length up to eight with no table at all — is
  // ARunOfEightFillsThePattern below.)
  const rules::Patterns patterns =
      patternsForMask(rules::bit(Rule::NoLight1x5));
  ASSERT_EQ(patterns.size(), 2U);
  EXPECT_EQ(patterns.front().count(), 5);
  EXPECT_EQ(patterns.back().count(), 5);
  EXPECT_EQ(patterns.front().cells[4].dx, 4);
  EXPECT_EQ(patterns.back().cells[4].dy, 4);
}

TEST(Patterns, AFiveRunIsSubsumedByEveryShorterRule) {
  const rules::Patterns patterns = patternsForMask(
      rules::bit(Rule::NoDark1x3) | rules::bit(Rule::NoDark1x5));
  ASSERT_EQ(patterns.size(), 2U);
  EXPECT_EQ(patterns.front().count(), 3);
}

TEST(Patterns, AnAreaRuleIsEveryTromino) {
  // "No region bigger than two" IS a forbidden arrangement: a connected set of
  // three or more cells always contains a connected THREE, and the connected
  // trominoes are the two straight ones plus the four bent ones. That is what
  // lets half of this rule cost no new code at all.
  const rules::Patterns patterns =
      patternsForMask(rules::bit(Rule::AreaTwoDark));
  ASSERT_EQ(patterns.size(), 6U);
  for (const rules::Pattern &pattern : patterns)
    EXPECT_EQ(pattern.count(), 3);
}

TEST(Patterns, AnAreaRuleDoesNotRepeatTheRunItImplies) {
  // The 1x3 rule and the area rule forbid the same two straight trominoes, and
  // a duplicate would be worse than dead weight: `GenerateCommands::cost`
  // counts violated clauses, so one broken straight would score two and bias
  // the generator's local search.
  const rules::Patterns patterns = patternsForMask(
      rules::bit(Rule::AreaTwoDark) | rules::bit(Rule::NoDark1x3));
  EXPECT_EQ(patterns.size(), 6U);
}

TEST(Patterns, AnAreaRuleShortensALongerRunRule) {
  const rules::Patterns patterns = patternsForMask(
      rules::bit(Rule::AreaTwoDark) | rules::bit(Rule::NoDark1x5));
  ASSERT_EQ(patterns.size(), 6U);
  EXPECT_EQ(patterns.front().count(), 3);
}

TEST(Patterns, AForbiddenPairSubsumesEveryTromino) {
  // Every tromino contains a pair, so with dark pairs forbidden outright the
  // area rule has nothing left to add — and no dark cell can be painted.
  const rules::Patterns patterns = patternsForMask(
      rules::bit(Rule::AreaTwoDark) | rules::bit(Rule::NoDark1x2));
  ASSERT_EQ(patterns.size(), 2U);
  EXPECT_EQ(patterns.front().count(), 2);
}

/**
 * A run instance of EIGHT — past the old catalog, and exactly where
 * `addRuns` stops emitting. Patterns are variable length now, so nothing here
 * could truncate; what this pins is that the intake cap `kMaxRunLength` and
 * the emission cap `kMaxImpliedRun` still agree, which is what makes accepting
 * eight sound at all. Move one without the other and a run intake accepts
 * lands with nothing enforcing it.
 */
TEST(Patterns, ARunOfEightFillsThePattern) {
  const rules::Patterns patterns =
      rules::patternsFor(0, {}, {{.color = kDark, .value = 8}}, {});
  ASSERT_EQ(patterns.size(), 2U);
  EXPECT_EQ(patterns.front().count(), 8);
  EXPECT_EQ(patterns.back().count(), 8);
  EXPECT_EQ(patterns.front().cells[7].dx, 7);
  EXPECT_EQ(patterns.back().cells[7].dy, 7);
}

/// Any area of eight or more implies a run past `kMaxImpliedRun`, so it emits
/// nothing and `regionArea` carries the size alone — the path area twenty-four
/// has always taken, now reachable at every size from eight up.
TEST(Patterns, AnAreaOfEightEmitsNoPatterns) {
  EXPECT_TRUE(
      rules::patternsFor(0, {{.color = kDark, .value = 8}}, {}, {}).empty());
}

/**
 * The size the old catalog never had: an area of ONE forbids any two
 * adjacent cells of the color — its implied run of two — and adds nothing
 * else to the table (no trominoes: the pair subsumes them). The other half of
 * the rule, that an isolated possible cell must NOT be excluded, is
 * `regionArea`'s area-one gate, pinned in propagate_test.
 */
TEST(Patterns, AnAreaOfOneImpliesARunOfTwo) {
  const rules::Patterns patterns =
      rules::patternsFor(0, {{.color = kDark, .value = 1}}, {}, {});
  ASSERT_EQ(patterns.size(), 2U);
  EXPECT_EQ(patterns.front().count(), 2);
  EXPECT_EQ(patterns.back().count(), 2);
}

/// Two run instances of one color keep only the shortest — conjunctive, so
/// the shorter subsumes — exactly as the v1 rule pair did across bits.
TEST(Patterns, TwoRunInstancesKeepTheShortest) {
  const rules::Patterns patterns = rules::patternsFor(
      0, {}, {{.color = kDark, .value = 3}, {.color = kDark, .value = 5}}, {});
  ASSERT_EQ(patterns.size(), 2U);
  EXPECT_EQ(patterns.front().count(), 3);
}

TEST(Patterns, ATripleRuleIsOneMixedPatternPerDirection) {
  const rules::Patterns patterns =
      patternsForMask(rules::bit(Rule::NoDarkLightDark));
  ASSERT_EQ(patterns.size(), 2U);
  for (const rules::Pattern &pattern : patterns) {
    EXPECT_EQ(pattern.count(), 3);
    EXPECT_EQ(pattern.cells[0].color, kDark);
    EXPECT_EQ(pattern.cells[1].color, kLight);
    EXPECT_EQ(pattern.cells[2].color, kDark);
  }
}

TEST(Patterns, TheTwoTripleRulesAreMirrors) {
  const rules::Patterns patterns =
      patternsForMask(rules::bit(Rule::NoLightDarkLight));
  ASSERT_EQ(patterns.size(), 2U);
  EXPECT_EQ(patterns.front().cells[0].color, kLight);
  EXPECT_EQ(patterns.front().cells[1].color, kDark);
  EXPECT_EQ(patterns.front().cells[2].color, kLight);
}

TEST(Patterns, ATeeRuleIsFourRotations) {
  const rules::Patterns patterns =
      patternsForMask(rules::bit(Rule::NoDarkT));
  ASSERT_EQ(patterns.size(), 4U);
  for (const rules::Pattern &pattern : patterns)
    EXPECT_EQ(pattern.count(), 4);
}

TEST(Patterns, AShortRunRuleSubsumesTheTee) {
  // Every T contains a straight three, so with dark threes already forbidden
  // the T instances could never prune anything the run clauses do not — and a
  // clause that duplicates another's work biases `GenerateCommands::cost()`,
  // which counts violations.
  const rules::Patterns patterns = patternsForMask(
      rules::bit(Rule::NoDarkT) | rules::bit(Rule::NoDark1x3));
  ASSERT_EQ(patterns.size(), 2U);
  EXPECT_EQ(patterns.front().count(), 3);
}

TEST(Patterns, AnAreaOfTwoSubsumesTheTee) {
  // Via the implied run of three, which is the same argument one step removed.
  const rules::Patterns patterns = patternsForMask(
      rules::bit(Rule::NoDarkT) | rules::bit(Rule::AreaTwoDark));
  EXPECT_EQ(patterns.size(), 6U);
}

TEST(Patterns, ALongerRunRuleDoesNotSubsumeTheTee) {
  // A 1x4 rule says nothing about the T, whose longest straight is three.
  const rules::Patterns patterns = patternsForMask(
      rules::bit(Rule::NoDarkT) | rules::bit(Rule::NoDark1x4));
  EXPECT_EQ(patterns.size(), 6U);
}

TEST(Patterns, ARunOfOneColorDoesNotSubsumeTheOtherTee) {
  const rules::Patterns patterns = patternsForMask(
      rules::bit(Rule::NoLightT) | rules::bit(Rule::NoDark1x3));
  EXPECT_EQ(patterns.size(), 6U);
}

TEST(Patterns, AThreeOneRuleIsFourMixedPatterns) {
  // One per corner the odd cell can take, three of the color and one of the
  // other in each.
  const rules::Patterns patterns =
      patternsForMask(rules::bit(Rule::NoThreeDarkOneLight));
  ASSERT_EQ(patterns.size(), 4U);
  for (const rules::Pattern &pattern : patterns) {
    ASSERT_EQ(pattern.count(), 4);
    EXPECT_EQ(std::ranges::count_if(pattern.cells,
                                    [](const rules::PatternCell &cell) {
                                      return cell.color == kDark;
                                    }),
              3);
  }
}

TEST(Patterns, TheTwoThreeOneRulesAreMirrors) {
  const rules::Patterns patterns =
      patternsForMask(rules::bit(Rule::NoThreeLightOneDark));
  ASSERT_EQ(patterns.size(), 4U);
  // The first pattern's odd cell is its first corner.
  EXPECT_EQ(patterns.front().cells[0].color, kDark);
  EXPECT_EQ(patterns.front().cells[1].color, kLight);
  EXPECT_EQ(patterns.front().cells[2].color, kLight);
  EXPECT_EQ(patterns.front().cells[3].color, kLight);
}

TEST(Patterns, APairRuleSubsumesTheThreeOne) {
  // Three cells of a 2x2 always contain an orthogonal pair, so the pair
  // clause fires first on every instance.
  const rules::Patterns patterns = patternsForMask(
      rules::bit(Rule::NoThreeDarkOneLight) | rules::bit(Rule::NoDark1x2));
  ASSERT_EQ(patterns.size(), 2U);
  EXPECT_EQ(patterns.front().count(), 2);
}

TEST(Patterns, AnAreaOfTwoSubsumesTheThreeOne) {
  // The three majority cells ARE a bent tromino, which the area rule lays out.
  const rules::Patterns patterns = patternsForMask(
      rules::bit(Rule::NoThreeDarkOneLight) | rules::bit(Rule::AreaTwoDark));
  EXPECT_EQ(patterns.size(), 6U);
}

TEST(Patterns, AnAreaOfThreeDoesNotSubsumeTheThreeOne) {
  // The near-miss the `== 2` gate exists for: an area of THREE lays out no
  // trominoes, and a bent dark tromino with the odd corner light is a complete
  // legal region of three — which only the 3+1 clause forbids. Dropping it
  // here would silently weaken the rule.
  const rules::Patterns patterns = patternsForMask(
      rules::bit(Rule::NoThreeDarkOneLight) | rules::bit(Rule::AreaThreeDark));
  ASSERT_EQ(patterns.size(), 6U);
  const auto mixed = [](const rules::Pattern &pattern) {
    return std::ranges::any_of(pattern.cells, [](const auto &cell) {
      return cell.color == kLight;
    });
  };
  EXPECT_EQ(std::ranges::count_if(patterns, mixed), 4);
}

TEST(Patterns, ADiagonalRuleSubsumesTheThreeOne) {
  const rules::Patterns patterns = patternsForMask(
      rules::bit(Rule::NoThreeDarkOneLight) | rules::bit(Rule::NoDarkDiagonal));
  ASSERT_EQ(patterns.size(), 2U);
  EXPECT_EQ(patterns.front().count(), 2);
}

TEST(Patterns, ADiagonalRuleIsTwoPatterns) {
  // The falling diagonal of a 2x2 and the rising one — the first patterns
  // whose cells are not orthogonally contiguous.
  const rules::Patterns patterns =
      patternsForMask(rules::bit(Rule::NoDarkDiagonal));
  ASSERT_EQ(patterns.size(), 2U);
  EXPECT_EQ(patterns.front().count(), 2);
  EXPECT_EQ(patterns.front().cells[1].dx, 1);
  EXPECT_EQ(patterns.front().cells[1].dy, 1);
  EXPECT_EQ(patterns.back().count(), 2);
  EXPECT_EQ(patterns.back().cells[0].dx, 1);
  EXPECT_EQ(patterns.back().cells[1].dy, 1);
}

TEST(Patterns, TheTwoDiagonalRulesAreMirrors) {
  const rules::Patterns patterns =
      patternsForMask(rules::bit(Rule::NoLightDiagonal));
  ASSERT_EQ(patterns.size(), 2U);
  EXPECT_EQ(patterns.front().cells[0].color, kLight);
  EXPECT_EQ(patterns.front().cells[1].color, kLight);
}

TEST(Patterns, ADiagonalRuleSubsumesTheSquare) {
  // A monochrome 2x2 contains a corner touch of its own color.
  const rules::Patterns patterns = patternsForMask(
      rules::bit(Rule::NoDark2x2) | rules::bit(Rule::NoDarkDiagonal));
  ASSERT_EQ(patterns.size(), 2U);
  EXPECT_EQ(patterns.front().count(), 2);
}

TEST(Patterns, ADiagonalRuleOfOneColorKeepsTheOtherSquare) {
  const rules::Patterns patterns = patternsForMask(
      rules::bit(Rule::NoLight2x2) | rules::bit(Rule::NoDarkDiagonal));
  EXPECT_EQ(patterns.size(), 3U);
}

TEST(Patterns, ADiagonalRuleSubsumesTheTee) {
  // A T's stem touches both of the bar's ends corner to corner.
  const rules::Patterns patterns = patternsForMask(
      rules::bit(Rule::NoDarkT) | rules::bit(Rule::NoDarkDiagonal));
  EXPECT_EQ(patterns.size(), 2U);
}

TEST(Patterns, ADiagonalRuleSubsumesTheTrominoes) {
  // The bent four contain a corner touch; the straight pair from the implied
  // run does not, and stays.
  const rules::Patterns patterns = patternsForMask(
      rules::bit(Rule::AreaTwoDark) | rules::bit(Rule::NoDarkDiagonal));
  ASSERT_EQ(patterns.size(), 4U);
  EXPECT_EQ(patterns[0].count(), 3);
  EXPECT_EQ(patterns[1].count(), 3);
  EXPECT_EQ(patterns[2].count(), 2);
  EXPECT_EQ(patterns[3].count(), 2);
}

TEST(Patterns, ADiagonalRuleSubsumesBothCheckerboards) {
  using enum Rule;
  // A checkerboard is a dark corner touch AND a light one in the same 2x2, so
  // whichever color's rule is on fires first on every instance.
  const rules::Patterns explicitRule = patternsForMask(
      rules::bit(NoCheckerboard) | rules::bit(NoDarkDiagonal));
  ASSERT_EQ(explicitRule.size(), 2U);
  EXPECT_EQ(explicitRule.front().count(), 2);
  const rules::Patterns implied = patternsForMask(
      rules::bit(ConnectDark) | rules::bit(ConnectLight) |
      rules::bit(NoLightDiagonal));
  ASSERT_EQ(implied.size(), 2U);
  EXPECT_EQ(implied.front().count(), 2);
}

TEST(Patterns, ADiagonalRuleDoesNotSubsumeTheRuns) {
  // A straight bar has no corner touch, so the run clauses keep their work.
  const rules::Patterns patterns = patternsForMask(
      rules::bit(Rule::NoDark1x3) | rules::bit(Rule::NoDarkDiagonal));
  EXPECT_EQ(patterns.size(), 4U);
}

TEST(Patterns, ADiagonalRuleDoesNotSubsumeTheTriples) {
  const rules::Patterns patterns = patternsForMask(
      rules::bit(Rule::NoDarkLightDark) | rules::bit(Rule::NoDarkDiagonal));
  EXPECT_EQ(patterns.size(), 4U);
}

TEST(Patterns, TheTwoAreaRulesDoNotSubsumeEachOther) {
  const rules::Patterns patterns = patternsForMask(
      rules::bit(Rule::AreaTwoDark) | rules::bit(Rule::AreaTwoLight));
  EXPECT_EQ(patterns.size(), 12U);
}

TEST(Patterns, TheTwoColorsDoNotSubsumeEachOther) {
  const rules::Patterns patterns = patternsForMask(
      rules::bit(Rule::NoDark1x2) | rules::bit(Rule::NoLight1x4));
  EXPECT_EQ(patterns.size(), 4U);
}

TEST(Patterns, BothColorsConnectedImplyNoCheckerboard) {
  const rules::Patterns patterns = patternsForMask(
      rules::bit(Rule::ConnectDark) | rules::bit(Rule::ConnectLight));
  EXPECT_EQ(patterns.size(), 2U);
}

TEST(Patterns, OneColorConnectedImpliesNothing) {
  EXPECT_TRUE(patternsForMask(rules::bit(Rule::ConnectDark)).empty());
}

TEST(Patterns, UndercluedIsNotAColoringRule) {
  EXPECT_TRUE(patternsForMask(rules::bit(Rule::Underclued)).empty());
}

TEST(Patterns, AnInstanceTouchingAGapIsDropped) {
  // A 2x2 with a hole in it can never be "entirely one color", so there is
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

TEST(Patterns, ADiagonalPairInsideOneMergedCellIsAUnitClause) {
  // An L-cell holds both squares of the falling pair, so its two literals
  // collapse to one: the cell can never be dark at all. The rising pair keeps
  // its squares in different cells and stays a two-literal clause.
  //
  // Drawn rather than named — the diagonal rule retired into `patterns` in
  // format version 3 — which also makes this the merged-cell case for a
  // DRAWING, since `instantiate` is the same code either way.
  Puzzle puzzle = test::board({"..", ".."});
  test::withPattern(puzzle, test::pattern({"D.", ".D"}));
  test::withShape(puzzle, {{0, 0}, {1, 0}, {1, 1}});
  const Model model = buildModel(puzzle);
  ASSERT_EQ(model.clauses.size(), 2U);
  const auto unit = [](const Clause &clause) { return clause.count == 1; };
  EXPECT_EQ(std::ranges::count_if(model.clauses, unit), 1);
}

TEST(Patterns, ABentInstanceFitsWhereAStraightOneCannot) {
  // Two by two has no room for a straight tromino and holds all four bent ones,
  // which is exactly the half of an area rule no run instance could express.
  Puzzle puzzle = test::board({"..", ".."});
  test::withAreaRule(puzzle, kDark, 2);
  const Model model = buildModel(puzzle);
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

TEST(Patterns, AnElbowRuleIsFourPatterns) {
  // The four bent trominoes standing alone — the same shapes an area of two
  // contributes, now switchable on their own.
  const rules::Patterns patterns =
      patternsForMask(rules::bit(Rule::NoDarkElbow));
  ASSERT_EQ(patterns.size(), 4U);
  for (const rules::Pattern &pattern : patterns)
    EXPECT_EQ(pattern.count(), 3);
}

TEST(Patterns, TheTwoElbowRulesAreMirrors) {
  const rules::Patterns patterns =
      patternsForMask(rules::bit(Rule::NoLightElbow));
  ASSERT_EQ(patterns.size(), 4U);
  EXPECT_EQ(patterns.front().cells[0].color, kLight);
}

TEST(Patterns, AnEllRuleIsEightPatterns) {
  // Four rotations in BOTH handednesses — one pattern per chirality is pinned
  // by its foot, so "four rotations only" fails loudly.
  const rules::Patterns patterns =
      patternsForMask(rules::bit(Rule::NoDarkEll));
  ASSERT_EQ(patterns.size(), 8U);
  for (const rules::Pattern &pattern : patterns)
    EXPECT_EQ(pattern.count(), 4);
  EXPECT_EQ(patterns[0].cells[3].dx, 1);
  EXPECT_EQ(patterns[0].cells[3].dy, 2);
  EXPECT_EQ(patterns[1].cells[3].dx, 0);
  EXPECT_EQ(patterns[1].cells[3].dy, 2);
}

TEST(Patterns, ADistancePairIsTwoPatterns) {
  // Two cells with a HOLE between them: the middle square is deliberately not
  // named, which is what lets the clause fire across a gap — the pinned
  // offsets are the semantics.
  const rules::Patterns patterns =
      patternsForMask(rules::bit(Rule::NoDarkAnyDark));
  ASSERT_EQ(patterns.size(), 2U);
  EXPECT_EQ(patterns.front().count(), 2);
  EXPECT_EQ(patterns.front().cells[1].dx, 2);
  EXPECT_EQ(patterns.front().cells[1].dy, 0);
  EXPECT_EQ(patterns.back().count(), 2);
  EXPECT_EQ(patterns.back().cells[1].dx, 0);
  EXPECT_EQ(patterns.back().cells[1].dy, 2);
}

TEST(Patterns, ALongTeeRuleIsFourRotations) {
  const rules::Patterns patterns =
      patternsForMask(rules::bit(Rule::NoDarkLongT));
  ASSERT_EQ(patterns.size(), 4U);
  for (const rules::Pattern &pattern : patterns)
    EXPECT_EQ(pattern.count(), 5);
}

TEST(Patterns, AKnightRuleIsFourPatterns) {
  // Four unordered patterns cover all eight directions, the diagonal pair's
  // trick. Two anchor with their FIRST cell off the bounding box's top-left —
  // pinned here against a normalizing refactor, since `instantiate` supports
  // arbitrary non-negative offsets and these depend on it.
  const rules::Patterns patterns =
      patternsForMask(rules::bit(Rule::NoDarkKnight));
  ASSERT_EQ(patterns.size(), 4U);
  for (const rules::Pattern &pattern : patterns)
    EXPECT_EQ(pattern.count(), 2);
  EXPECT_EQ(patterns[1].cells[0].dx, 1);
  EXPECT_EQ(patterns[1].cells[1].dx, 0);
  EXPECT_EQ(patterns[1].cells[1].dy, 2);
  EXPECT_EQ(patterns[3].cells[0].dx, 2);
  EXPECT_EQ(patterns[3].cells[1].dx, 0);
  EXPECT_EQ(patterns[3].cells[1].dy, 1);
}

TEST(Patterns, AMixedTeeRuleIsFourRotations) {
  // The T's cells with exactly ONE flipped: the crossing.
  const rules::Patterns patterns =
      patternsForMask(rules::bit(Rule::NoLightCrossedDarkT));
  ASSERT_EQ(patterns.size(), 4U);
  for (const rules::Pattern &pattern : patterns) {
    ASSERT_EQ(pattern.count(), 4);
    EXPECT_EQ(std::ranges::count_if(pattern.cells,
                                    [](const rules::PatternCell &cell) {
                                      return cell.color == kLight;
                                    }),
              1);
  }
}

TEST(Patterns, TheTwoMixedTeeRulesAreMirrors) {
  const rules::Patterns patterns =
      patternsForMask(rules::bit(Rule::NoDarkCrossedLightT));
  ASSERT_EQ(patterns.size(), 4U);
  EXPECT_EQ(std::count_if(patterns.front().cells.begin(),
                          patterns.front().cells.begin() +
                              patterns.front().count(),
                          [](const auto &cell) {
                            return cell.color == kDark;
                          }),
            1);
}

TEST(Patterns, AMixedElbowRuleIsFourPatterns) {
  // A bent tromino with its corner flipped: three cells, exactly one of them
  // the other color.
  const rules::Patterns patterns =
      patternsForMask(rules::bit(Rule::NoDarkLightDarkElbow));
  ASSERT_EQ(patterns.size(), 4U);
  for (const rules::Pattern &pattern : patterns) {
    ASSERT_EQ(pattern.count(), 3);
    EXPECT_EQ(std::ranges::count_if(pattern.cells,
                                    [](const rules::PatternCell &cell) {
                                      return cell.color == kLight;
                                    }),
              1);
  }
}

TEST(Patterns, TheTwoMixedElbowRulesAreMirrors) {
  const rules::Patterns patterns =
      patternsForMask(rules::bit(Rule::NoLightDarkLightElbow));
  ASSERT_EQ(patterns.size(), 4U);
  EXPECT_EQ(std::count_if(patterns.front().cells.begin(),
                          patterns.front().cells.begin() +
                              patterns.front().count(),
                          [](const auto &cell) {
                            return cell.color == kDark;
                          }),
            1);
}

/**
 * The first seven- and eight-cell patterns, which is what moved
 * `kMaxPatternCells` to 8. `runPattern` writes `cells[i]` with no assert of
 * its own, so the last cell is checked by POSITION — with the constant still
 * at 6 these writes land out of bounds.
 */
TEST(Patterns, AnAreaOfSixImpliesARunOfSeven) {
  const rules::Patterns patterns =
      patternsForMask(rules::bit(Rule::AreaSixDark));
  ASSERT_EQ(patterns.size(), 2U);
  EXPECT_EQ(patterns.front().count(), 7);
  EXPECT_EQ(patterns.back().count(), 7);
  EXPECT_EQ(patterns.front().cells[6].dx, 6);
  EXPECT_EQ(patterns.back().cells[6].dy, 6);
}

TEST(Patterns, AnAreaOfSevenImpliesARunOfEight) {
  const rules::Patterns patterns =
      patternsForMask(rules::bit(Rule::AreaSevenLight));
  ASSERT_EQ(patterns.size(), 2U);
  EXPECT_EQ(patterns.front().count(), 8);
  EXPECT_EQ(patterns.back().count(), 8);
  EXPECT_EQ(patterns.front().cells[7].dx, 7);
  EXPECT_EQ(patterns.back().cells[7].dy, 7);
}

/// The cap in `addRuns`, exercised: an implied run of 25 outgrows the table,
/// so the rule compiles to NO patterns at all and rides `regionArea` alone.
TEST(Patterns, AnAreaOfTwentyFourEmitsNoRunPattern) {
  EXPECT_TRUE(
      patternsForMask(rules::bit(Rule::AreaTwentyFourDark)).empty());
}

TEST(Patterns, AnElbowRuleSubsumesTheSquare) {
  // Any three squares of a 2x2 are a bent tromino.
  const rules::Patterns patterns = patternsForMask(
      rules::bit(Rule::NoDark2x2) | rules::bit(Rule::NoDarkElbow));
  ASSERT_EQ(patterns.size(), 4U);
  EXPECT_EQ(patterns.front().count(), 3);
}

TEST(Patterns, AnElbowRuleSubsumesTheTee) {
  // A bar end, the middle and the stem are a bent tromino.
  const rules::Patterns patterns = patternsForMask(
      rules::bit(Rule::NoDarkT) | rules::bit(Rule::NoDarkElbow));
  ASSERT_EQ(patterns.size(), 4U);
  EXPECT_EQ(patterns.front().count(), 3);
}

TEST(Patterns, AnElbowRuleSubsumesTheEllAndTheLongTee) {
  using enum Rule;
  const rules::Patterns ells =
      patternsForMask(rules::bit(NoDarkEll) | rules::bit(NoDarkElbow));
  EXPECT_EQ(ells.size(), 4U);
  const rules::Patterns longTees =
      patternsForMask(rules::bit(NoDarkLongT) | rules::bit(NoDarkElbow));
  EXPECT_EQ(longTees.size(), 4U);
}

TEST(Patterns, AnElbowRuleSubsumesTheThreeOne) {
  // The three majority cells ARE a bent tromino.
  const rules::Patterns patterns = patternsForMask(
      rules::bit(Rule::NoThreeDarkOneLight) | rules::bit(Rule::NoDarkElbow));
  ASSERT_EQ(patterns.size(), 4U);
  EXPECT_EQ(patterns.front().count(), 3);
}

TEST(Patterns, AnAreaOfTwoDoesNotDuplicateTheElbow) {
  // At a smallest area of exactly two `addAreaShapes` lays these four out, so
  // the elbow builder stands down — six patterns, not ten.
  const rules::Patterns patterns = patternsForMask(
      rules::bit(Rule::NoDarkElbow) | rules::bit(Rule::AreaTwoDark));
  EXPECT_EQ(patterns.size(), 6U);
}

TEST(Patterns, AnAreaOfThreeDoesNotSubsumeTheElbow) {
  // The `== 2` gate's near-miss again: an area of three lays out no trominoes,
  // and a bent region of exactly three is legal under it — only the elbow rule
  // forbids the shape, so its four patterns must survive beside the implied
  // run of four.
  const rules::Patterns patterns = patternsForMask(
      rules::bit(Rule::NoDarkElbow) | rules::bit(Rule::AreaThreeDark));
  ASSERT_EQ(patterns.size(), 6U);
  const auto bent = [](const rules::Pattern &pattern) {
    return pattern.count() == 3;
  };
  EXPECT_EQ(std::ranges::count_if(patterns, bent), 4);
}

TEST(Patterns, ARunOfThreeDoesNotSubsumeTheElbow) {
  // A bent tromino's longest straight is two.
  const rules::Patterns patterns = patternsForMask(
      rules::bit(Rule::NoDarkElbow) | rules::bit(Rule::NoDark1x3));
  EXPECT_EQ(patterns.size(), 6U);
}

TEST(Patterns, ADiagonalRuleSubsumesTheElbow) {
  const rules::Patterns patterns = patternsForMask(
      rules::bit(Rule::NoDarkElbow) | rules::bit(Rule::NoDarkDiagonal));
  ASSERT_EQ(patterns.size(), 2U);
  EXPECT_EQ(patterns.front().count(), 2);
}

TEST(Patterns, AForbiddenPairSubsumesTheElbow) {
  const rules::Patterns patterns = patternsForMask(
      rules::bit(Rule::NoDarkElbow) | rules::bit(Rule::NoDark1x2));
  ASSERT_EQ(patterns.size(), 2U);
  EXPECT_EQ(patterns.front().count(), 2);
}

TEST(Patterns, AShortRunRuleSubsumesTheEll) {
  // Every L contains a straight three, its bar.
  const rules::Patterns patterns = patternsForMask(
      rules::bit(Rule::NoDarkEll) | rules::bit(Rule::NoDark1x3));
  ASSERT_EQ(patterns.size(), 2U);
  EXPECT_EQ(patterns.front().count(), 3);
}

TEST(Patterns, ALongerRunRuleDoesNotSubsumeTheEll) {
  const rules::Patterns patterns = patternsForMask(
      rules::bit(Rule::NoDarkEll) | rules::bit(Rule::NoDark1x4));
  EXPECT_EQ(patterns.size(), 10U);
}

TEST(Patterns, ADistancePairSubsumesTheEll) {
  // The bar's ends sit two apart.
  const rules::Patterns patterns = patternsForMask(
      rules::bit(Rule::NoDarkEll) | rules::bit(Rule::NoDarkAnyDark));
  ASSERT_EQ(patterns.size(), 2U);
  EXPECT_EQ(patterns.front().count(), 2);
}

TEST(Patterns, AKnightRuleSubsumesTheEll) {
  // The foot is a knight's move from the bar's far end.
  const rules::Patterns patterns = patternsForMask(
      rules::bit(Rule::NoDarkEll) | rules::bit(Rule::NoDarkKnight));
  ASSERT_EQ(patterns.size(), 4U);
  EXPECT_EQ(patterns.front().count(), 2);
}

TEST(Patterns, AnAreaOfThreeSubsumesTheEll) {
  // An L is a connected FOUR, which a smallest area of three refuses at every
  // complete assignment through `regionArea`.
  const rules::Patterns patterns = patternsForMask(
      rules::bit(Rule::NoDarkEll) | rules::bit(Rule::AreaThreeDark));
  EXPECT_EQ(patterns.size(), 2U);
}

TEST(Patterns, AnAreaOfFourDoesNotSubsumeTheEll) {
  // The near-miss the `<= 3` bound exists for: an L-shaped region of exactly
  // four is perfectly legal under area four, and only this rule forbids it.
  const rules::Patterns patterns = patternsForMask(
      rules::bit(Rule::NoDarkEll) | rules::bit(Rule::AreaFourDark));
  EXPECT_EQ(patterns.size(), 10U);
}

TEST(Patterns, ATeeRuleAndAnEllRuleDoNotSubsumeEachOther) {
  // A T contains no L — its foot is at the middle — and an L contains no T.
  const rules::Patterns patterns = patternsForMask(
      rules::bit(Rule::NoDarkEll) | rules::bit(Rule::NoDarkT));
  EXPECT_EQ(patterns.size(), 12U);
}

TEST(Patterns, ADistancePairSubsumesTheLongRunsButNotTheDomino) {
  using enum Rule;
  // A run of three's ends are two apart; a domino's are adjacent.
  const rules::Patterns threes =
      patternsForMask(rules::bit(NoDark1x3) | rules::bit(NoDarkAnyDark));
  ASSERT_EQ(threes.size(), 2U);
  EXPECT_EQ(threes.front().cells[1].dx, 2);
  const rules::Patterns pairs =
      patternsForMask(rules::bit(NoDark1x2) | rules::bit(NoDarkAnyDark));
  EXPECT_EQ(pairs.size(), 4U);
}

TEST(Patterns, ADistancePairSubsumesTheTriple) {
  // The triple's ends are its color, two apart — the first subsumer the
  // triples ever had, since nothing else names both colors.
  const rules::Patterns patterns = patternsForMask(
      rules::bit(Rule::NoDarkLightDark) | rules::bit(Rule::NoDarkAnyDark));
  ASSERT_EQ(patterns.size(), 2U);
  EXPECT_EQ(patterns.front().count(), 2);
}

TEST(Patterns, TheOtherDistanceRuleKeepsTheTriple) {
  const rules::Patterns patterns = patternsForMask(
      rules::bit(Rule::NoDarkLightDark) | rules::bit(Rule::NoLightAnyLight));
  EXPECT_EQ(patterns.size(), 4U);
}

TEST(Patterns, ADistancePairSubsumesTheTee) {
  const rules::Patterns patterns = patternsForMask(
      rules::bit(Rule::NoDarkT) | rules::bit(Rule::NoDarkAnyDark));
  ASSERT_EQ(patterns.size(), 2U);
  EXPECT_EQ(patterns.front().count(), 2);
}

TEST(Patterns, ATeeRuleSubsumesTheLongTee) {
  // The bar plus the stem's first cell is a plain T.
  const rules::Patterns patterns = patternsForMask(
      rules::bit(Rule::NoDarkLongT) | rules::bit(Rule::NoDarkT));
  ASSERT_EQ(patterns.size(), 4U);
  EXPECT_EQ(patterns.front().count(), 4);
}

TEST(Patterns, AnEllRuleSubsumesTheLongTee) {
  // The stem's line plus one bar end is an L.
  const rules::Patterns patterns = patternsForMask(
      rules::bit(Rule::NoDarkLongT) | rules::bit(Rule::NoDarkEll));
  ASSERT_EQ(patterns.size(), 8U);
  EXPECT_EQ(patterns.front().count(), 4);
}

TEST(Patterns, AKnightRuleSubsumesTheLongTee) {
  // A bar end is a knight's move from the stem's tip.
  const rules::Patterns patterns = patternsForMask(
      rules::bit(Rule::NoDarkLongT) | rules::bit(Rule::NoDarkKnight));
  ASSERT_EQ(patterns.size(), 4U);
  EXPECT_EQ(patterns.front().count(), 2);
}

TEST(Patterns, ARunOfFourDoesNotSubsumeTheLongTee) {
  // A long T's longest straight is three.
  const rules::Patterns patterns = patternsForMask(
      rules::bit(Rule::NoDarkLongT) | rules::bit(Rule::NoDark1x4));
  EXPECT_EQ(patterns.size(), 6U);
}

TEST(Patterns, AnAreaOfFourSubsumesTheLongTee) {
  // A long T is a connected FIVE, which a smallest area of four refuses at
  // every complete assignment through `regionArea`.
  const rules::Patterns patterns = patternsForMask(
      rules::bit(Rule::NoDarkLongT) | rules::bit(Rule::AreaFourDark));
  EXPECT_EQ(patterns.size(), 2U);
}

TEST(Patterns, AnAreaOfFiveDoesNotSubsumeTheLongTee) {
  // The near-miss the `<= 4` bound exists for: a long-T region of exactly five
  // is legal under area five, and only this rule forbids the shape.
  const rules::Patterns patterns = patternsForMask(
      rules::bit(Rule::NoDarkLongT) | rules::bit(Rule::AreaFiveDark));
  EXPECT_EQ(patterns.size(), 6U);
}

TEST(Patterns, NothingSubsumesTheKnight) {
  using enum Rule;
  // No other pattern names two cells a knight's move apart.
  const rules::Patterns diagonals =
      patternsForMask(rules::bit(NoDarkKnight) | rules::bit(NoDarkDiagonal));
  EXPECT_EQ(diagonals.size(), 6U);
  const rules::Patterns pairs =
      patternsForMask(rules::bit(NoDarkKnight) | rules::bit(NoDark1x2));
  EXPECT_EQ(pairs.size(), 6U);
}

TEST(Patterns, AKnightRuleDoesNotSubsumeTheTee) {
  // No two cells of a T sit a knight's move apart.
  const rules::Patterns patterns = patternsForMask(
      rules::bit(Rule::NoDarkT) | rules::bit(Rule::NoDarkKnight));
  EXPECT_EQ(patterns.size(), 8U);
}

/**
 * The collinearity lemma: connect(color) + the color's elbow ban pin every
 * pair of the color to one row or column, compiled as every off-axis pair —
 * 2 orientations x 31 x 31 offsets. The first two, at offset (1,1), are the
 * diagonal patterns, pinned by position; and no three-cell pattern survives,
 * because the family subsumes the elbow's own trominoes.
 */
TEST(Patterns, ConnectAndElbowCompileToCollinearPairs) {
  const rules::Patterns patterns = patternsForMask(
      rules::bit(Rule::ConnectDark) | rules::bit(Rule::NoDarkElbow));
  ASSERT_EQ(patterns.size(), 1922U);
  EXPECT_EQ(patterns.front().count(), 2);
  EXPECT_EQ(patterns.front().cells[1].dx, 1);
  EXPECT_EQ(patterns.front().cells[1].dy, 1);
  EXPECT_TRUE(std::ranges::all_of(
      patterns, [](const rules::Pattern &one) { return one.count() == 2; }));
}

TEST(Patterns, AnElbowWithoutConnectKeepsItsShapes) {
  // The near-miss: the lemma needs BOTH rules. Alone, the elbow lays its four
  // bent trominoes and nothing else.
  const rules::Patterns patterns =
      patternsForMask(rules::bit(Rule::NoDarkElbow));
  ASSERT_EQ(patterns.size(), 4U);
  EXPECT_EQ(patterns.front().count(), 3);
}

TEST(Patterns, TheDiagonalAndKnightMembersAreNotLaidTwice) {
  using enum Rule;
  // With the diagonal and knight rules on beside the family, their builders
  // lay the (1,1) and knight-offset pairs and the family skips them — laid
  // twice they would double-score one broken pair in the generator's cost.
  const rules::Patterns patterns = patternsForMask(
      rules::bit(ConnectDark) | rules::bit(NoDarkElbow) |
      rules::bit(NoDarkDiagonal) | rules::bit(NoDarkKnight));
  EXPECT_EQ(patterns.size(), 1922U);
}

TEST(Patterns, ATripleRuleSubsumesTheMixedTee) {
  // The mixed T's bar IS dark-light-dark.
  const rules::Patterns patterns = patternsForMask(
      rules::bit(Rule::NoLightCrossedDarkT) |
      rules::bit(Rule::NoDarkLightDark));
  ASSERT_EQ(patterns.size(), 2U);
  EXPECT_EQ(patterns.front().count(), 3);
}

TEST(Patterns, TheOtherTripleKeepsTheMixedTee) {
  const rules::Patterns patterns = patternsForMask(
      rules::bit(Rule::NoLightCrossedDarkT) |
      rules::bit(Rule::NoLightDarkLight));
  EXPECT_EQ(patterns.size(), 6U);
}

TEST(Patterns, ADiagonalRuleSubsumesTheMixedTee) {
  // The stem touches both bar ends corner to corner, all three the arms'
  // color.
  const rules::Patterns patterns = patternsForMask(
      rules::bit(Rule::NoLightCrossedDarkT) |
      rules::bit(Rule::NoDarkDiagonal));
  EXPECT_EQ(patterns.size(), 2U);
}

TEST(Patterns, AMixedElbowSubsumesTheMixedTee) {
  // One bar end, the crossing and the stem are exactly a dark-light-dark
  // elbow.
  const rules::Patterns patterns = patternsForMask(
      rules::bit(Rule::NoLightCrossedDarkT) |
      rules::bit(Rule::NoDarkLightDarkElbow));
  ASSERT_EQ(patterns.size(), 4U);
  EXPECT_EQ(patterns.front().count(), 3);
}

TEST(Patterns, ADiagonalRuleSubsumesTheMixedElbow) {
  // Its two ends ARE a diagonal pair.
  const rules::Patterns patterns = patternsForMask(
      rules::bit(Rule::NoDarkLightDarkElbow) |
      rules::bit(Rule::NoDarkDiagonal));
  ASSERT_EQ(patterns.size(), 2U);
  EXPECT_EQ(patterns.front().count(), 2);
}

TEST(Patterns, TheOtherDiagonalKeepsTheMixedElbow) {
  const rules::Patterns patterns = patternsForMask(
      rules::bit(Rule::NoDarkLightDarkElbow) |
      rules::bit(Rule::NoLightDiagonal));
  EXPECT_EQ(patterns.size(), 6U);
}

TEST(Patterns, AMixedElbowSubsumesTheThreeOne) {
  // The odd cell is the corner of a majority-other-majority elbow.
  const rules::Patterns patterns = patternsForMask(
      rules::bit(Rule::NoThreeDarkOneLight) |
      rules::bit(Rule::NoDarkLightDarkElbow));
  ASSERT_EQ(patterns.size(), 4U);
  EXPECT_EQ(patterns.front().count(), 3);
}

TEST(Patterns, TheOtherMixedElbowKeepsTheThreeOne) {
  // The near-miss: the OTHER mixed elbow's ends would be the odd color, of
  // which a 3+1 holds only one.
  const rules::Patterns patterns = patternsForMask(
      rules::bit(Rule::NoThreeDarkOneLight) |
      rules::bit(Rule::NoLightDarkLightElbow));
  EXPECT_EQ(patterns.size(), 8U);
}

TEST(Patterns, AMixedElbowSubsumesBothCheckerboards) {
  using enum Rule;
  // A checkerboard's 2x2 holds both mixed elbows, whichever diagonal carries
  // the ends — the diagonal rules' argument one color over.
  const rules::Patterns explicitRule = patternsForMask(
      rules::bit(NoCheckerboard) | rules::bit(NoDarkLightDarkElbow));
  ASSERT_EQ(explicitRule.size(), 4U);
  EXPECT_EQ(explicitRule.front().count(), 3);
  const rules::Patterns implied = patternsForMask(
      rules::bit(ConnectDark) | rules::bit(ConnectLight) |
      rules::bit(NoLightDarkLightElbow));
  ASSERT_EQ(implied.size(), 4U);
  EXPECT_EQ(implied.front().count(), 3);
}

TEST(Patterns, OffByOneIsNotAColoringRule) {
  EXPECT_TRUE(patternsForMask(rules::bit(Rule::OffByOne)).empty());
}

TEST(Patterns, ADistancePairInsideOneMergedBarIsAUnitClause) {
  // A 1x3 bar cell holds both ends of the horizontal pair, so its two literals
  // collapse to one: the cell can never be dark at all.
  Puzzle puzzle = test::board({"..."}, rules::bit(Rule::NoDarkAnyDark));
  test::withShape(puzzle, {{0, 0}, {1, 0}, {2, 0}});
  const Model model = buildModel(puzzle);
  ASSERT_EQ(model.clauses.size(), 1U);
  EXPECT_EQ(model.clauses.front().count, 1);
}

TEST(Patterns, AKnightPairInsideOneMergedCellIsAUnitClause) {
  // An S-cell holds both squares of one knight pattern — a unit clause — while
  // the other pattern that fits keeps its squares in different cells. Drawn
  // rather than named, like the diagonal pair above.
  Puzzle puzzle = test::board({"...", "..."});
  test::withPattern(puzzle, test::pattern({"D.", "..", ".D"}));
  test::withShape(puzzle, {{0, 0}, {1, 0}, {1, 1}, {2, 1}});
  const Model model = buildModel(puzzle);
  ASSERT_EQ(model.clauses.size(), 2U);
  const auto unit = [](const Clause &clause) { return clause.count == 1; };
  EXPECT_EQ(std::ranges::count_if(model.clauses, unit), 1);
}

} // namespace
