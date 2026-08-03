#include "TestBoards.h"

#include "Puzzle.h"
#include "Rules.h"
#include "Verify.h"

#include <gtest/gtest.h>
#include <string>
#include <utility>
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

/// The two halves of "exactly two" fail differently and the solver catches them
/// with different machinery — too big compiles into forbidden trominoes, too
/// small is a propagator — so both are pinned here, where neither exists.
TEST(Verify, CatchesARegionBiggerThanItsArea) {
  EXPECT_EQ(judge({"...", "..."}, {"DDL", "LLL"}, {Rule::AreaTwoDark}),
            Violation::None);
  EXPECT_EQ(judge({"...", "..."}, {"DDD", "LLL"}, {Rule::AreaTwoDark}),
            Violation::RegionSize);
  // The bent one, which no run rule would have caught.
  EXPECT_EQ(judge({"...", "..."}, {"DDL", "DLL"}, {Rule::AreaTwoDark}),
            Violation::RegionSize);
}

TEST(Verify, CatchesARegionSmallerThanItsArea) {
  EXPECT_EQ(judge({"...", "..."}, {"DLD", "LLL"}, {Rule::AreaTwoDark}),
            Violation::RegionSize);
}

/// All zero of an empty colour's regions are the right size, the same way an
/// empty colour is vacuously connected.
TEST(Verify, AnEmptyColourHasNoAreasToGetWrong) {
  EXPECT_EQ(judge({"..", ".."}, {"DD", "DD"}, {Rule::AreaTwoLight}),
            Violation::None);
}

TEST(Verify, TheTwoAreaRulesAreSeparateSwitches) {
  // One answer, judged twice: dark is a domino and light is a region of four.
  EXPECT_EQ(judge({"...", "..."}, {"DDL", "LLL"}, {Rule::AreaTwoDark}),
            Violation::None);
  EXPECT_EQ(judge({"...", "..."}, {"DDL", "LLL"}, {Rule::AreaTwoLight}),
            Violation::RegionSize);
}

TEST(Verify, AGapSeparatesTwoAreasRatherThanJoiningThem) {
  EXPECT_EQ(judge({"..#..", "....."}, {"DD#DD", "LLLLL"}, {Rule::AreaTwoDark}),
            Violation::None);
}

/// The area-FOUR pair. `everyRegionIs` was already generic in the number, so
/// what is really pinned here is that the family listing gained its two rows —
/// and this is the only place both halves of the size are stated outright,
/// since four's "too big" half has no forbidden shapes behind it.
TEST(Verify, CatchesAnAreaFourRegionOfTheWrongSize) {
  EXPECT_EQ(judge({"....", "...."}, {"DDDD", "LLLL"}, {Rule::AreaFourDark}),
            Violation::None);
  // The square one, which no run rule reaches.
  EXPECT_EQ(judge({"....", "...."}, {"DDLL", "DDLL"}, {Rule::AreaFourDark}),
            Violation::None);
  EXPECT_EQ(judge({"....", "...."}, {"DDDD", "DLLL"}, {Rule::AreaFourDark}),
            Violation::RegionSize);
  EXPECT_EQ(judge({"....", "...."}, {"DDDL", "LLLL"}, {Rule::AreaFourDark}),
            Violation::RegionSize);
}

/// Not a contradiction: every one of a colour's ZERO regions is both sizes at
/// once, so the pair is satisfied exactly when the colour is absent.
TEST(Verify, BothSizesOnOneColourLeaveOnlyTheEmptyColouring) {
  const std::vector both{Rule::AreaTwoDark, Rule::AreaFourDark};
  EXPECT_EQ(judge({"....", "...."}, {"LLLL", "LLLL"}, both), Violation::None);
  EXPECT_EQ(judge({"....", "...."}, {"DDLL", "DDLL"}, both),
            Violation::RegionSize);
  EXPECT_EQ(judge({"....", "...."}, {"DDLL", "LLLL"}, both),
            Violation::RegionSize);
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
  EXPECT_STRNE(verify::describe(Violation::RegionSize), "");
  EXPECT_STRNE(verify::describe(Violation::CellSplit), "");
  EXPECT_STRNE(verify::describe(Violation::DartCount), "");
}

/// A dart on `(0, 0)` aimed along the top row, and a colouring to judge.
Violation judgeDart(const std::vector<std::string> &picture,
                    const std::vector<std::string> &painted, const int value,
                    const int direction = kDirRight) {
  Puzzle puzzle = test::board(picture);
  test::withDart(puzzle, 0, 0, value, direction);
  return verify::check(buildModel(puzzle), test::colors(painted));
}

TEST(Verify, ADartCountsTheOtherColourAlongItsLine) {
  EXPECT_EQ(judgeDart({"....."}, {"DLLDD"}, 2), Violation::None);
  EXPECT_EQ(judgeDart({"....."}, {"DLLDD"}, 3), Violation::DartCount);
}

/// The two colourings differ ONLY in the dart's own square, and the same line
/// of `LLLD` reads as three lights from a dark dart and one dark from a light.
TEST(Verify, ADartTakesTheColourOfItsOwnCell) {
  EXPECT_EQ(judgeDart({"....."}, {"DLLLD"}, 3), Violation::None);
  EXPECT_EQ(judgeDart({"....."}, {"LLLLD"}, 3), Violation::DartCount);
  EXPECT_EQ(judgeDart({"....."}, {"LLLLD"}, 1), Violation::None);
}

TEST(Verify, ADartOfZeroPaintsItsWholeLineItsOwnColour) {
  EXPECT_EQ(judgeDart({"....."}, {"DDDDD"}, 0), Violation::None);
  EXPECT_EQ(judgeDart({"....."}, {"DDDDL"}, 0), Violation::DartCount);
}

/// A gap is stepped over: neither counted, nor a wall the line stops at.
TEST(Verify, ADartLooksStraightThroughAGap) {
  EXPECT_EQ(judgeDart({"..#.."}, {"DL#LD"}, 2), Violation::None);
  EXPECT_EQ(judgeDart({"..#.."}, {"DL#LD"}, 1), Violation::DartCount);
}

TEST(Verify, ADartAimsWhereItSaysItDoes) {
  EXPECT_EQ(judgeDart({".....", "....."}, {"DLLLL", "LLLLL"}, 1, kDirDown),
            Violation::None);
  EXPECT_EQ(judgeDart({".....", "....."}, {"DLLLL", "DLLLL"}, 1, kDirDown),
            Violation::DartCount);
}

/**
 * A merged cell lying along the line contributes every square of itself the
 * line crosses. Three, here — a count a dart reading CELLS could never reach
 * on a line four squares long with three of them fused.
 */
TEST(Verify, ADartCountsAMergedCellOncePerSquare) {
  Puzzle puzzle = test::board({"....."});
  test::withDart(puzzle, 0, 0, 3, kDirRight);
  test::withShape(puzzle, {{1, 0}, {2, 0}, {3, 0}});
  const Model model = buildModel(puzzle);
  EXPECT_EQ(verify::check(model, test::colors({"DLLLD"})), Violation::None);
  EXPECT_EQ(verify::check(model, test::colors({"DDDDL"})),
            Violation::DartCount);
}

/// The same, for a board carrying one merged cell the picture cannot draw.
Violation judgeMerged(const std::vector<std::string> &picture,
                      const std::vector<std::pair<int, int>> &squares,
                      const std::vector<std::string> &painted,
                      const std::vector<Rule> &active) {
  Puzzle puzzle = test::board(picture, test::ruleSet(active));
  test::withShape(puzzle, squares);
  return verify::check(buildModel(puzzle), test::colors(painted));
}

TEST(Verify, RefusesAMergedCellInTwoColours) {
  EXPECT_EQ(judgeMerged({"..", ".."}, {{0, 0}, {1, 0}}, {"DL", "LL"}, {}),
            Violation::CellSplit);
  EXPECT_EQ(judgeMerged({"..", ".."}, {{0, 0}, {1, 0}}, {"DD", "LL"}, {}),
            Violation::None);
}

TEST(Verify, ArrangementRulesCountSquaresRatherThanCells) {
  // A merged dark 1x2 IS a dark 1x2 — the run rules scan the square grid, and
  // fusing two squares does not hide the run they make. Same for a 2x2 that a
  // merged cell happens to be part of.
  EXPECT_EQ(judgeMerged({"..", ".."}, {{0, 0}, {1, 0}}, {"DD", "LL"},
                        {Rule::NoDark1x2}),
            Violation::Run);
  EXPECT_EQ(judgeMerged({"..", ".."}, {{0, 0}, {1, 0}}, {"DD", "DD"},
                        {Rule::NoDark2x2}),
            Violation::Square);
}

TEST(Verify, AnAreaRuleCountsAMergedCellAsItsSquares) {
  // A merged domino is a legal region of two on its own...
  EXPECT_EQ(judgeMerged({"..", ".."}, {{0, 0}, {1, 0}}, {"DD", "LL"},
                        {Rule::AreaTwoDark}),
            Violation::None);
  // ...and a merged 1x3 is a region of three, which that rule forbids.
  EXPECT_EQ(judgeMerged({"...", "..."}, {{0, 0}, {1, 0}, {2, 0}},
                        {"DDD", "LLL"}, {Rule::AreaTwoDark}),
            Violation::RegionSize);
}

TEST(Verify, AnAreaClueCountsTheSquaresOfTheCellsInItsRegion) {
  // The clue sits on one square of a 1x3 bar and names three, because the bar
  // contributes all three of its squares to the region it is in.
  EXPECT_EQ(judgeMerged({"3..", "..."}, {{0, 0}, {1, 0}, {2, 0}},
                        {"DDD", "LLL"}, {}),
            Violation::None);
  EXPECT_EQ(judgeMerged({"2..", "..."}, {{0, 0}, {1, 0}, {2, 0}},
                        {"DDD", "LLL"}, {}),
            Violation::AreaSize);
}

TEST(Verify, AMergedCellIsAdjacentToWhateverAnyOfItsSquaresTouches) {
  // The merged cell is the left column; its lower square at (0,1) touches the
  // plain dark square at (1,1), so all the dark is one region and "connect all
  // dark" holds. A plain board with the same colouring would come out the same,
  // which is the point: fusing changes the VARIABLES, not the geometry the
  // rules read.
  EXPECT_EQ(judgeMerged({"..", ".."}, {{0, 0}, {0, 1}}, {"DL", "DD"},
                        {Rule::ConnectDark}),
            Violation::None);
}

} // namespace
