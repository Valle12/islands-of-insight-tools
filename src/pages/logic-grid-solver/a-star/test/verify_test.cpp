#include "TestBoards.h"

#include "Puzzle.h"
#include "Rules.h"
#include "Verify.h"

#include <gtest/gtest.h>
#include <string>
#include <vector>

namespace {

using namespace lg;
using rules::Rule;
using verify::Violation;

Violation judge(const std::vector<std::string> &picture,
                const std::vector<std::string> &painted,
                const std::vector<Rule> &active) {
  const Model model = buildModel(test::board(picture, test::ruleSet(active)));
  return verify::check(model, test::colors(painted));
}

TEST(Verify, AcceptsAnyColouringWhenNothingIsAsked) {
  EXPECT_EQ(judge({"..", ".."}, {"DD", "DD"}, {}), Violation::None);
}

TEST(Verify, RefusesAnUncolouredCell) {
  EXPECT_EQ(judge({"..", ".."}, {"D.", "DD"}, {}), Violation::Incomplete);
}

TEST(Verify, RefusesAColouredGap) {
  EXPECT_EQ(judge({".#", ".."}, {"DD", "DD"}, {}), Violation::ShapeChanged);
}

TEST(Verify, RefusesAnAnswerThatRepaintsAGivenCell) {
  EXPECT_EQ(judge({"D.", ".."}, {"LL", "LL"}, {}), Violation::GivenChanged);
}

TEST(Verify, KeepsAnAnswerThatAgreesWithTheGivens) {
  EXPECT_EQ(judge({"D.", ".."}, {"DD", "DD"}, {}), Violation::None);
}

TEST(Verify, CatchesAForbiddenSquare) {
  EXPECT_EQ(judge({"..", ".."}, {"DD", "DD"}, {Rule::NoDark2x2}),
            Violation::Square);
  EXPECT_EQ(judge({"..", ".."}, {"DD", "DL"}, {Rule::NoDark2x2}),
            Violation::None);
  EXPECT_EQ(judge({"..", ".."}, {"LL", "LL"}, {Rule::NoDark2x2}),
            Violation::None);
}

TEST(Verify, CatchesAForbiddenRunInEitherDirection) {
  EXPECT_EQ(judge({"...", "..."}, {"DDD", "LLL"}, {Rule::NoDark1x3}),
            Violation::Run);
  EXPECT_EQ(judge({"..", "..", ".."}, {"DL", "DL", "DL"}, {Rule::NoDark1x3}),
            Violation::Run);
  EXPECT_EQ(judge({"...", "..."}, {"DDL", "LLD"}, {Rule::NoDark1x3}),
            Violation::None);
}

/// Four in a row is fine under a 1x5 rule and five is not — the off-by-one the
/// oracle would get wrong if it read "1x5" as a cap of five rather than four.
TEST(Verify, AFiveRunNeedsFiveCells) {
  EXPECT_EQ(judge({"....."}, {"DDDDD"}, {Rule::NoDark1x5}), Violation::Run);
  EXPECT_EQ(judge({"....."}, {"DDDDL"}, {Rule::NoDark1x5}), Violation::None);
  EXPECT_EQ(judge({"....."}, {"LLLLL"}, {Rule::NoDark1x5}), Violation::None);
  EXPECT_EQ(judge({"....."}, {"LLLLL"}, {Rule::NoLight1x5}), Violation::Run);
}

/// "Exactly one" is two failures, and the empty half is the easy one to miss:
/// nothing points at a region that has no symbol in it.
TEST(Verify, CountsTheSymbolsInEveryArea) {
  EXPECT_EQ(judge({"a.", ".."}, {"DL", "LL"}, {Rule::OneSymbolDark}),
            Violation::None);
  EXPECT_EQ(judge({"a.", ".."}, {"LD", "DD"}, {Rule::OneSymbolDark}),
            Violation::AreaWithoutSymbol);
  // Both numbers say 4 and the region really is 4 cells, so the SIZE is fine;
  // what is wrong is that one region carries two symbols.
  EXPECT_EQ(judge({"44", ".."}, {"DD", "DD"}, {Rule::OneSymbolDark}),
            Violation::AreaWithManySymbols);
}

TEST(Verify, TheTwoSymbolCountRulesAreSeparateSwitches) {
  EXPECT_EQ(judge({"a.", ".."}, {"DL", "LL"}, {Rule::OneSymbolLight}),
            Violation::AreaWithoutSymbol);
  EXPECT_EQ(judge({"a.", ".."}, {"DL", "LL"}, {}), Violation::None);
}

TEST(Verify, AGapBreaksARun) {
  EXPECT_EQ(judge({".#.", "..."}, {"D#D", "LLL"}, {Rule::NoDark1x2}),
            Violation::None);
}

TEST(Verify, CatchesACheckerboard) {
  EXPECT_EQ(judge({"..", ".."}, {"DL", "LD"}, {Rule::NoCheckerboard}),
            Violation::Checkerboard);
  EXPECT_EQ(judge({"..", ".."}, {"DD", "LL"}, {Rule::NoCheckerboard}),
            Violation::None);
}

TEST(Verify, CatchesADisconnectedColour) {
  EXPECT_EQ(judge({"...", "..."}, {"DLD", "LLL"}, {Rule::ConnectDark}),
            Violation::Disconnected);
  EXPECT_EQ(judge({"...", "..."}, {"DDD", "LLL"}, {Rule::ConnectDark}),
            Violation::None);
}

TEST(Verify, AnEmptyColourIsConnected) {
  // Vacuously one region — which is what lets an all-dark board be legal while
  // connect-light is switched on.
  EXPECT_EQ(judge({"..", ".."}, {"DD", "DD"}, {Rule::ConnectLight}),
            Violation::None);
}

TEST(Verify, ACheckerboardBreaksConnectivityWithoutRuleEleven) {
  // The implied rule is deliberately absent from this file; the connectivity
  // test is what catches it, which is why leaving it out is safe.
  EXPECT_EQ(judge({"..", ".."}, {"DL", "LD"},
                  {Rule::ConnectDark, Rule::ConnectLight}),
            Violation::Disconnected);
}

TEST(Verify, ChecksAnAreaNumberAgainstItsRegion) {
  EXPECT_EQ(judge({"2..", "...", "..."}, {"DDL", "LLL", "LLL"}, {}),
            Violation::None);
  EXPECT_EQ(judge({"2..", "...", "..."}, {"DDD", "LLL", "LLL"}, {}),
            Violation::AreaSize);
}

TEST(Verify, AnAreaNumberTakesTheColourOfItsCell) {
  // The same clue, the same board, the other colour: still two cells.
  EXPECT_EQ(judge({"2..", "..."}, {"LLD", "DDD"}, {}), Violation::None);
}

TEST(Verify, TwoAreaNumbersMayShareARegionWhenTheyAgree) {
  EXPECT_EQ(judge({"3.3", "..."}, {"DDD", "LLL"}, {}), Violation::None);
  EXPECT_EQ(judge({"3.2", "..."}, {"DDD", "LLL"}, {}), Violation::AreaSize);
}

TEST(Verify, ChecksThatOneLetterIsOneRegion) {
  EXPECT_EQ(judge({"a.a", "..."}, {"DDD", "LLL"}, {}), Violation::None);
  EXPECT_EQ(judge({"a.a", "..."}, {"DLD", "LLL"}, {}), Violation::LetterSplit);
}

TEST(Verify, RefusesTwoLettersInOneRegion) {
  EXPECT_EQ(judge({"a.b", "..."}, {"DDD", "LLL"}, {}), Violation::LetterShared);
  EXPECT_EQ(judge({"a.b", "..."}, {"DLD", "LLL"}, {}), Violation::None);
}

TEST(Verify, DifferentLettersMayShareAColour) {
  // Two dark regions, kept apart by light: different letters, same colour.
  EXPECT_EQ(judge({"a.b", "..."}, {"DLD", "LLL"}, {}), Violation::None);
}

TEST(Verify, EveryViolationHasAMessage) {
  EXPECT_STREQ(verify::describe(Violation::None), "");
  EXPECT_STRNE(verify::describe(Violation::AreaSize), "");
  EXPECT_STRNE(verify::describe(Violation::LetterShared), "");
}

} // namespace
