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

/// The area-FIVE pair, appended after four and checked the same way. Six wide
/// on purpose: five is the first size whose implied forbidden run — SIX cells
/// — did not fit the pattern table as it stood.
TEST(Verify, CatchesAnAreaFiveRegionOfTheWrongSize) {
  EXPECT_EQ(
      judge({"......", "......"}, {"DDDDDL", "LLLLLL"}, {Rule::AreaFiveDark}),
      Violation::None);
  // The straight six an area of five implies.
  EXPECT_EQ(
      judge({"......", "......"}, {"DDDDDD", "LLLLLL"}, {Rule::AreaFiveDark}),
      Violation::RegionSize);
  EXPECT_EQ(
      judge({"......", "......"}, {"DDDDLL", "LLLLLL"}, {Rule::AreaFiveDark}),
      Violation::RegionSize);
  // The same colouring judged from the other side: light is one region of 7.
  EXPECT_EQ(
      judge({"......", "......"}, {"DDDDDL", "LLLLLL"}, {Rule::AreaFiveLight}),
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

TEST(Verify, CatchesAForbiddenTripleInEitherDirection) {
  EXPECT_EQ(judge({"...", "..."}, {"DLD", "LLL"}, {Rule::NoDarkLightDark}),
            Violation::Triple);
  // Down the first column: D over L over D.
  EXPECT_EQ(judge({"..", "..", ".."}, {"DL", "LL", "DL"},
                  {Rule::NoDarkLightDark}),
            Violation::Triple);
  EXPECT_EQ(judge({"...", "..."}, {"DDL", "LLD"}, {Rule::NoDarkLightDark}),
            Violation::None);
}

TEST(Verify, ATripleNamesTheColourAtItsEnds) {
  // The same line, judged under each rule: L-D-L is the OTHER rule's shape.
  EXPECT_EQ(judge({"...", "..."}, {"LDL", "DDD"}, {Rule::NoDarkLightDark}),
            Violation::None);
  EXPECT_EQ(judge({"...", "..."}, {"LDL", "DDD"}, {Rule::NoLightDarkLight}),
            Violation::Triple);
}

/// Two darks a gap apart are not a triple: the middle must really be light.
TEST(Verify, AGapNeverCompletesATriple) {
  EXPECT_EQ(judge({".#.", "..."}, {"D#D", "LLL"}, {Rule::NoDarkLightDark}),
            Violation::None);
}

TEST(Verify, CatchesATeeInEveryRotation) {
  EXPECT_EQ(judge({"...", "..."}, {"DDD", "LDL"}, {Rule::NoDarkT}),
            Violation::Tee);
  EXPECT_EQ(judge({"...", "..."}, {"LDL", "DDD"}, {Rule::NoDarkT}),
            Violation::Tee);
  EXPECT_EQ(judge({"..", "..", ".."}, {"DL", "DD", "DL"}, {Rule::NoDarkT}),
            Violation::Tee);
  EXPECT_EQ(judge({"..", "..", ".."}, {"LD", "DD", "LD"}, {Rule::NoDarkT}),
            Violation::Tee);
}

TEST(Verify, ABareLineIsNotATee) {
  EXPECT_EQ(judge({"...", "..."}, {"DDD", "LLL"}, {Rule::NoDarkT}),
            Violation::None);
}

TEST(Verify, APlusContainsATee) {
  EXPECT_EQ(judge({"...", "...", "..."}, {"LDL", "DDD", "LDL"},
                  {Rule::NoDarkT}),
            Violation::Tee);
}

TEST(Verify, TheTwoTeeRulesAreSeparateSwitches) {
  EXPECT_EQ(judge({"...", "..."}, {"DDD", "LDL"}, {Rule::NoLightT}),
            Violation::None);
  EXPECT_EQ(judge({"...", "..."}, {"LLL", "DLD"}, {Rule::NoLightT}),
            Violation::Tee);
}

TEST(Verify, CatchesAThreeOneSquare) {
  EXPECT_EQ(judge({"..", ".."}, {"DD", "DL"}, {Rule::NoThreeDarkOneLight}),
            Violation::ThreeOne);
  // All four of one colour is a different arrangement, and an even split too.
  EXPECT_EQ(judge({"..", ".."}, {"DD", "DD"}, {Rule::NoThreeDarkOneLight}),
            Violation::None);
  EXPECT_EQ(judge({"..", ".."}, {"DD", "LL"}, {Rule::NoThreeDarkOneLight}),
            Violation::None);
}

TEST(Verify, TheOddCellMayTakeAnyCorner) {
  EXPECT_EQ(judge({"..", ".."}, {"LD", "DD"}, {Rule::NoThreeDarkOneLight}),
            Violation::ThreeOne);
  EXPECT_EQ(judge({"..", ".."}, {"DL", "DD"}, {Rule::NoThreeDarkOneLight}),
            Violation::ThreeOne);
  EXPECT_EQ(judge({"..", ".."}, {"DD", "LD"}, {Rule::NoThreeDarkOneLight}),
            Violation::ThreeOne);
}

TEST(Verify, TheTwoThreeOneRulesAreSeparateSwitches) {
  EXPECT_EQ(judge({"..", ".."}, {"LL", "LD"}, {Rule::NoThreeDarkOneLight}),
            Violation::None);
  EXPECT_EQ(judge({"..", ".."}, {"LL", "LD"}, {Rule::NoThreeLightOneDark}),
            Violation::ThreeOne);
}

/// Three of a colour around a gap is legal: the rule wants a FULL 2x2 split
/// three and one, and a gap is neither colour.
TEST(Verify, AGapNeverCompletesAThreeOne) {
  EXPECT_EQ(judge({"..", ".#"}, {"DD", "D#"}, {Rule::NoThreeDarkOneLight}),
            Violation::None);
}

TEST(Verify, CatchesADiagonalTouchOnEitherDiagonal) {
  EXPECT_EQ(judge({"..", ".."}, {"DL", "LD"}, {Rule::NoDarkDiagonal}),
            Violation::Diagonal);
  EXPECT_EQ(judge({"..", ".."}, {"LD", "DL"}, {Rule::NoDarkDiagonal}),
            Violation::Diagonal);
  EXPECT_EQ(judge({"...", "..."}, {"DDD", "LLL"}, {Rule::NoDarkDiagonal}),
            Violation::None);
}

/// The literal reading: being joined through an orthogonal neighbour does not
/// excuse the touch, so an L-bend and a filled 2x2 both break the rule and
/// every legal region of the colour is a straight bar.
TEST(Verify, AConnectedBendStillBreaksTheDiagonalRule) {
  EXPECT_EQ(judge({"..", ".."}, {"DD", "DL"}, {Rule::NoDarkDiagonal}),
            Violation::Diagonal);
  EXPECT_EQ(judge({"..", ".."}, {"DD", "DD"}, {Rule::NoDarkDiagonal}),
            Violation::Diagonal);
}

TEST(Verify, TheTwoDiagonalRulesAreSeparateSwitches) {
  EXPECT_EQ(judge({"..", ".."}, {"DD", "LD"}, {Rule::NoLightDiagonal}),
            Violation::None);
  EXPECT_EQ(judge({"..", ".."}, {"DD", "LD"}, {Rule::NoDarkDiagonal}),
            Violation::Diagonal);
}

/// The touch is the squares' geometry, not the board's: two cells meeting only
/// across a gap's corner still meet.
TEST(Verify, ATouchAcrossAGapsCornerStillCounts) {
  EXPECT_EQ(judge({".#", "#."}, {"D#", "#D"}, {Rule::NoDarkDiagonal}),
            Violation::Diagonal);
}

/// The area-THREE pair, appended after five. `everyRegionIs` and the family
/// listing carry it, so what is pinned here is the two new rows.
TEST(Verify, CatchesAnAreaThreeRegionOfTheWrongSize) {
  EXPECT_EQ(judge({"...", "..."}, {"DDD", "LLL"}, {Rule::AreaThreeDark}),
            Violation::None);
  // The bent one, which no run rule reaches.
  EXPECT_EQ(judge({"...", "..."}, {"DDL", "DLL"}, {Rule::AreaThreeDark}),
            Violation::None);
  EXPECT_EQ(judge({"...", "..."}, {"DDL", "LLL"}, {Rule::AreaThreeDark}),
            Violation::RegionSize);
  EXPECT_EQ(judge({"....", "...."}, {"DDDD", "LLLL"}, {Rule::AreaThreeDark}),
            Violation::RegionSize);
  // The same first colouring judged from the other side: light is a three too.
  EXPECT_EQ(judge({"...", "..."}, {"DDD", "LLL"}, {Rule::AreaThreeLight}),
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
  EXPECT_STRNE(verify::describe(Violation::Triple), "");
  EXPECT_STRNE(verify::describe(Violation::Tee), "");
  EXPECT_STRNE(verify::describe(Violation::LotusAsymmetric), "");
  EXPECT_STRNE(verify::describe(Violation::ThreeOne), "");
  EXPECT_STRNE(verify::describe(Violation::Diagonal), "");
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

/// A lotus on the centre of a 3x3, and a colouring to judge.
Violation judgeLotus(const std::vector<std::string> &painted, const int axis) {
  Puzzle puzzle = test::board({"...", "...", "..."});
  test::withLotus(puzzle, 1, 1, axis);
  return verify::check(buildModel(puzzle), test::colors(painted));
}

TEST(Verify, ALotusRegionMustMirrorAcrossItsAxis) {
  EXPECT_EQ(judgeLotus({"LDL", "DDD", "LDL"}, kAxisHorizontal),
            Violation::None);
  // One extra dark corner joins the region and reflects onto a light cell.
  EXPECT_EQ(judgeLotus({"LDL", "DDD", "LDD"}, kAxisHorizontal),
            Violation::LotusAsymmetric);
}

/// The "\" axis through the centre transposes the board.
TEST(Verify, ADiagonalLotusMirrorsItsRegion) {
  EXPECT_EQ(judgeLotus({"LDL", "DDL", "LLD"}, kAxisDiagonalDown),
            Violation::None);
  EXPECT_EQ(judgeLotus({"LDL", "DDD", "LLL"}, kAxisDiagonalDown),
            Violation::LotusAsymmetric);
}

/// Only the region HOLDING the lotus is held to the mirror: the far dark pair
/// reflects clean off the board and is nobody's business.
TEST(Verify, OnlyTheRegionHoldingTheLotusIsMirrored) {
  Puzzle puzzle = test::board({"....."});
  test::withLotus(puzzle, 1, 0, kAxisVertical);
  EXPECT_EQ(verify::check(buildModel(puzzle), test::colors({"LDLDD"})),
            Violation::None);
}

TEST(Verify, ALotusRegionMayNotReflectOffTheBoard) {
  Puzzle puzzle = test::board({"..."});
  test::withLotus(puzzle, 0, 0, kAxisVertical);
  // The region's second square reflects past the board's left edge.
  EXPECT_EQ(verify::check(buildModel(puzzle), test::colors({"DDL"})),
            Violation::LotusAsymmetric);
  EXPECT_EQ(verify::check(buildModel(puzzle), test::colors({"DLL"})),
            Violation::None);
}

TEST(Verify, ALotusRegionMayNotReflectOntoAGap) {
  Puzzle puzzle = test::board({"..#"});
  test::withLotus(puzzle, 1, 0, kAxisVertical);
  EXPECT_EQ(verify::check(buildModel(puzzle), test::colors({"DD#"})),
            Violation::LotusAsymmetric);
}

/// A seat on the seam of a 1x2 cell: the axis is the grid line between its two
/// squares, so rows swap in pairs and the third row reflects off the board.
TEST(Verify, ASeamSeatMirrorsAcrossTheGridLine) {
  Puzzle puzzle = test::board({"..", "..", ".."});
  test::withShape(puzzle, {{0, 0}, {0, 1}});
  test::withLotus(puzzle, 0, 0, kAxisHorizontal, 2);
  const Model model = buildModel(puzzle);
  EXPECT_EQ(verify::check(model, test::colors({"DD", "DD", "LL"})),
            Violation::None);
  EXPECT_EQ(verify::check(model, test::colors({"DD", "DD", "DL"})),
            Violation::LotusAsymmetric);
}

/// A corner seat on a 2x2 cell carries the diagonals: the block's centre is a
/// corner point, and the "\" through it transposes the board.
TEST(Verify, ACornerSeatCarriesTheDiagonals) {
  Puzzle puzzle = test::board({"...", "...", "..."});
  test::withShape(puzzle, {{0, 0}, {1, 0}, {0, 1}, {1, 1}});
  test::withLotus(puzzle, 0, 0, kAxisDiagonalDown, 3);
  const Model model = buildModel(puzzle);
  EXPECT_EQ(verify::check(model, test::colors({"DDD", "DDL", "DLL"})),
            Violation::None);
  EXPECT_EQ(verify::check(model, test::colors({"DDD", "DDL", "LLL"})),
            Violation::LotusAsymmetric);
}

/// Two lotuses in one region each hold it to their OWN axis.
TEST(Verify, TwoLotusesEachHoldTheRegionToTheirOwnAxis) {
  Puzzle puzzle = test::board({"...", "...", "..."});
  test::withLotus(puzzle, 1, 1, kAxisHorizontal);
  test::withLotus(puzzle, 1, 0, kAxisVertical);
  const Model model = buildModel(puzzle);
  EXPECT_EQ(verify::check(model, test::colors({"LDL", "DDD", "LDL"})),
            Violation::None);
  // Still symmetric for the horizontal lotus; the vertical one is broken.
  EXPECT_EQ(verify::check(model, test::colors({"LDL", "DDL", "LDL"})),
            Violation::LotusAsymmetric);
}

/// A viewpoint on `(x, y)` holding `value`, and a colouring to judge.
Violation judgeViewpoint(const std::vector<std::string> &picture,
                         const std::vector<std::string> &painted, const int x,
                         const int y, const int value) {
  Puzzle puzzle = test::board(picture);
  test::withViewpoint(puzzle, x, y, value);
  return verify::check(buildModel(puzzle), test::colors(painted));
}

TEST(Verify, AViewpointCountsItselfAndItsLeadingRuns) {
  EXPECT_EQ(judgeViewpoint({"....."}, {"DDLDD"}, 0, 0, 2), Violation::None);
  EXPECT_EQ(judgeViewpoint({"....."}, {"DDLDD"}, 0, 0, 3),
            Violation::ViewpointCount);
}

TEST(Verify, AViewpointSeesInAllFourDirections) {
  EXPECT_EQ(judgeViewpoint({"...", "...", "..."}, {"LDL", "DDD", "LDL"}, 1, 1,
                           5),
            Violation::None);
  EXPECT_EQ(judgeViewpoint({"...", "...", "..."}, {"LDL", "DDD", "LDL"}, 1, 1,
                           4),
            Violation::ViewpointCount);
}

/// The two colourings differ ONLY in the viewpoint's own square, and the same
/// line reads as three lights from a light one and as one square from a dark.
TEST(Verify, AViewpointTakesTheColourOfItsOwnCell) {
  EXPECT_EQ(judgeViewpoint({"....."}, {"LLLDD"}, 0, 0, 3), Violation::None);
  EXPECT_EQ(judgeViewpoint({"....."}, {"DLLDD"}, 0, 0, 1), Violation::None);
  EXPECT_EQ(judgeViewpoint({"....."}, {"DLLDD"}, 0, 0, 3),
            Violation::ViewpointCount);
}

/// Sight stops at a gap — where a dart's line steps over one, a viewpoint on
/// the same board sees two squares and never the pair beyond the hole.
TEST(Verify, SightStopsAtAGap) {
  EXPECT_EQ(judgeViewpoint({"..#.."}, {"LL#LL"}, 0, 0, 2), Violation::None);
  EXPECT_EQ(judgeViewpoint({"..#.."}, {"LL#LL"}, 0, 0, 4),
            Violation::ViewpointCount);
}

/**
 * A merged cell along a ray contributes every square the sight crosses — and
 * the squares of the viewpoint's OWN cell count too, being its own colour by
 * definition, which is where it differs from a dart's line.
 */
TEST(Verify, AViewpointCountsAMergedCellOncePerSquare) {
  Puzzle over = test::board({"....."});
  test::withViewpoint(over, 0, 0, 4);
  test::withShape(over, {{1, 0}, {2, 0}, {3, 0}});
  EXPECT_EQ(verify::check(buildModel(over), test::colors({"DDDDL"})),
            Violation::None);

  Puzzle own = test::board({"....."});
  test::withViewpoint(own, 0, 0, 2);
  test::withShape(own, {{0, 0}, {1, 0}});
  const Model model = buildModel(own);
  EXPECT_EQ(verify::check(model, test::colors({"DDLLL"})), Violation::None);
  Puzzle tooFew = test::board({"....."});
  test::withViewpoint(tooFew, 0, 0, 1);
  test::withShape(tooFew, {{0, 0}, {1, 0}});
  EXPECT_EQ(verify::check(buildModel(tooFew), test::colors({"DDLLL"})),
            Violation::ViewpointCount);
}

/**
 * Pure line geometry: an own-cell square OFF the rays does not count. The
 * L-cell's third square sits diagonally from the clue, on no ray through it,
 * so the count is two — the clue's square and the cell-mate on its left ray.
 */
TEST(Verify, AnOffRaySquareOfItsOwnCellDoesNotCount) {
  Puzzle puzzle = test::board({"..", ".."});
  test::withShape(puzzle, {{0, 0}, {1, 0}, {0, 1}});
  test::withViewpoint(puzzle, 1, 0, 2);
  const Model model = buildModel(puzzle);
  EXPECT_EQ(verify::check(model, test::colors({"DD", "DL"})), Violation::None);
  Puzzle three = test::board({"..", ".."});
  test::withShape(three, {{0, 0}, {1, 0}, {0, 1}});
  test::withViewpoint(three, 1, 0, 3);
  EXPECT_EQ(verify::check(buildModel(three), test::colors({"DD", "DL"})),
            Violation::ViewpointCount);
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
