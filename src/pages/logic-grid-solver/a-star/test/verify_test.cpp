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

/**
 * The board a rule list describes. The cases below predate format version 2
 * and still SAY rule names, sized ones included; those become `areas`/`runs`
 * instances through the same translation the CLI's `--rules` speaks, so every
 * historical pin keeps exercising exactly the constraint it always did —
 * through the intake path a legacy mask really takes — rather than a bit the
 * oracle no longer reads. The same now goes for the ten arrangements retired
 * in version 3, which become drawn `patterns`. Cases about the NEW sizes build
 * their instances directly with `withAreaRule`/`withRunRule`.
 */
/**
 * What a shape retired into `patterns` is NAMED by now.
 *
 * The five controls that left the catalog in format version 3 — diagonal,
 * L, crossed T, knight's move, mixed elbow — arrive as drawings, and the
 * oracle checks a drawing as a drawing: one violation for all of them, since
 * what a board broke is a shape the config carries and no enumerator could
 * spell. The cases below still SAY the rule they were written for, so what
 * they assert is unchanged — the oracle catches the shape — only its report
 * has one name.
 */
constexpr auto kDrawn = Violation::CustomPattern;

Puzzle boardWithRules(const std::vector<std::string> &picture,
                      const std::vector<Rule> &active) {
  rules::RuleMask legacy = 0;
  for (const Rule rule : active)
    legacy |= rules::bit(rule);
  auto [flags, areas, runs, patterns] = rules::splitLegacyMask(legacy);
  Puzzle puzzle = test::board(picture, flags);
  puzzle.areas = std::move(areas);
  puzzle.runs = std::move(runs);
  puzzle.patterns = std::move(patterns);
  return puzzle;
}

Violation judge(const std::vector<std::string> &picture,
                const std::vector<std::string> &painted,
                const std::vector<Rule> &active) {
  const Model model = buildModel(boardWithRules(picture, active));
  return verify::check(model, test::colors(painted));
}

TEST(Verify, AcceptsAnyColoringWhenNothingIsAsked) {
  EXPECT_EQ(judge({"..", ".."}, {"DD", "DD"}, {}), Violation::None);
}

TEST(Verify, RefusesAnUncoloredCell) {
  EXPECT_EQ(judge({"..", ".."}, {"D.", "DD"}, {}), Violation::Incomplete);
}

TEST(Verify, RefusesAColoredGap) {
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

/// All zero of an empty color's regions are the right size, the same way an
/// empty color is vacuously connected.
TEST(Verify, AnEmptyColorHasNoAreasToGetWrong) {
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
  // The same coloring judged from the other side: light is one region of 7.
  EXPECT_EQ(
      judge({"......", "......"}, {"DDDDDL", "LLLLLL"}, {Rule::AreaFiveLight}),
      Violation::RegionSize);
}

/// Not a contradiction: every one of a color's ZERO regions is both sizes at
/// once, so the pair is satisfied exactly when the color is absent.
TEST(Verify, BothSizesOnOneColorLeaveOnlyTheEmptyColoring) {
  const std::vector both{Rule::AreaTwoDark, Rule::AreaFourDark};
  EXPECT_EQ(judge({"....", "...."}, {"LLLL", "LLLL"}, both), Violation::None);
  EXPECT_EQ(judge({"....", "...."}, {"DDLL", "DDLL"}, both),
            Violation::RegionSize);
  EXPECT_EQ(judge({"....", "...."}, {"DDLL", "LLLL"}, both),
            Violation::RegionSize);
}

/// A run instance of SIX — the first length past the v1 catalog. The oracle
/// walks the instance list, so a new length is a new value, not a new row.
TEST(Verify, CatchesARunOfSixByInstance) {
  Puzzle six = test::board({"......", "......"});
  test::withRunRule(six, kDark, 6);
  EXPECT_EQ(verify::check(buildModel(six), test::colors({"DDDDDD", "LLLLLL"})),
            Violation::Run);
  Puzzle five = test::board({"......", "......"});
  test::withRunRule(five, kDark, 6);
  EXPECT_EQ(
      verify::check(buildModel(five), test::colors({"DDDDDL", "LLLLLL"})),
      Violation::None);
}

/// And of EIGHT, the intake cap: seven in a row survives, eight does not.
TEST(Verify, CatchesARunOfEightByInstance) {
  Puzzle eight = test::board({".........", "........."});
  test::withRunRule(eight, kDark, 8);
  EXPECT_EQ(verify::check(buildModel(eight),
                          test::colors({"DDDDDDDDL", "LLLLLLLLL"})),
            Violation::Run);
  Puzzle seven = test::board({".........", "........."});
  test::withRunRule(seven, kDark, 8);
  EXPECT_EQ(verify::check(buildModel(seven),
                          test::colors({"DDDDDDDLL", "LLLLLLLLL"})),
            Violation::None);
}

/// An area of ONE: singletons are the legal shape, a domino is the violation
/// — the polarity a "no region smaller than" reading would get exactly wrong.
TEST(Verify, AnAreaOfOneWantsSingletons) {
  Puzzle singles = test::board({"..."});
  test::withAreaRule(singles, kDark, 1);
  EXPECT_EQ(verify::check(buildModel(singles), test::colors({"DLD"})),
            Violation::None);
  Puzzle domino = test::board({"..."});
  test::withAreaRule(domino, kDark, 1);
  EXPECT_EQ(verify::check(buildModel(domino), test::colors({"DDL"})),
            Violation::RegionSize);
}

/// An area of EIGHT — past the pattern table's reach, so the oracle and
/// `regionArea` are the whole of the rule at this size.
TEST(Verify, CatchesAnAreaEightRegionOfTheWrongSize) {
  Puzzle right = test::board({"........", "........"});
  test::withAreaRule(right, kDark, 8);
  EXPECT_EQ(verify::check(buildModel(right),
                          test::colors({"DDDDLLLL", "DDDDLLLL"})),
            Violation::None);
  Puzzle wrong = test::board({"........", "........"});
  test::withAreaRule(wrong, kDark, 8);
  EXPECT_EQ(verify::check(buildModel(wrong),
                          test::colors({"DDDDLLLL", "DDDLLLLL"})),
            Violation::RegionSize);
}

/// Two DIRECT instances on one color — the legacy pair above spelled as
/// values. Every instance runs: a domino satisfies area two and still breaks
/// area three.
TEST(Verify, TwoAreaInstancesOnOneColorBothRun) {
  Puzzle domino = test::board({"...."});
  test::withAreaRule(domino, kDark, 2);
  test::withAreaRule(domino, kDark, 3);
  EXPECT_EQ(verify::check(buildModel(domino), test::colors({"DDLL"})),
            Violation::RegionSize);
  Puzzle empty = test::board({"...."});
  test::withAreaRule(empty, kDark, 2);
  test::withAreaRule(empty, kDark, 3);
  EXPECT_EQ(verify::check(buildModel(empty), test::colors({"LLLL"})),
            Violation::None);
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

TEST(Verify, ATripleNamesTheColorAtItsEnds) {
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
  // All four of one color is a different arrangement, and an even split too.
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

/// Three of a color around a gap is legal: the rule wants a FULL 2x2 split
/// three and one, and a gap is neither color.
TEST(Verify, AGapNeverCompletesAThreeOne) {
  EXPECT_EQ(judge({"..", ".#"}, {"DD", "D#"}, {Rule::NoThreeDarkOneLight}),
            Violation::None);
}

TEST(Verify, CatchesADiagonalTouchOnEitherDiagonal) {
  EXPECT_EQ(judge({"..", ".."}, {"DL", "LD"}, {Rule::NoDarkDiagonal}),
            kDrawn);
  EXPECT_EQ(judge({"..", ".."}, {"LD", "DL"}, {Rule::NoDarkDiagonal}),
            kDrawn);
  EXPECT_EQ(judge({"...", "..."}, {"DDD", "LLL"}, {Rule::NoDarkDiagonal}),
            Violation::None);
}

/// The literal reading: being joined through an orthogonal neighbor does not
/// excuse the touch, so an L-bend and a filled 2x2 both break the rule and
/// every legal region of the color is a straight bar.
TEST(Verify, AConnectedBendStillBreaksTheDiagonalRule) {
  EXPECT_EQ(judge({"..", ".."}, {"DD", "DL"}, {Rule::NoDarkDiagonal}),
            kDrawn);
  EXPECT_EQ(judge({"..", ".."}, {"DD", "DD"}, {Rule::NoDarkDiagonal}),
            kDrawn);
}

TEST(Verify, TheTwoDiagonalRulesAreSeparateSwitches) {
  EXPECT_EQ(judge({"..", ".."}, {"DD", "LD"}, {Rule::NoLightDiagonal}),
            Violation::None);
  EXPECT_EQ(judge({"..", ".."}, {"DD", "LD"}, {Rule::NoDarkDiagonal}),
            kDrawn);
}

/// The touch is the squares' geometry, not the board's: two cells meeting only
/// across a gap's corner still meet.
TEST(Verify, ATouchAcrossAGapsCornerStillCounts) {
  EXPECT_EQ(judge({".#", "#."}, {"D#", "#D"}, {Rule::NoDarkDiagonal}),
            kDrawn);
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
  // The same first coloring judged from the other side: light is a three too.
  EXPECT_EQ(judge({"...", "..."}, {"DDD", "LLL"}, {Rule::AreaThreeLight}),
            Violation::None);
}

TEST(Verify, CatchesADisconnectedColor) {
  EXPECT_EQ(judge({"...", "..."}, {"DLD", "LLL"}, {Rule::ConnectDark}),
            Violation::Disconnected);
  EXPECT_EQ(judge({"...", "..."}, {"DDD", "LLL"}, {Rule::ConnectDark}),
            Violation::None);
}

TEST(Verify, AnEmptyColorIsConnected) {
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

TEST(Verify, AnAreaNumberTakesTheColorOfItsCell) {
  // The same clue, the same board, the other color: still two cells.
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

TEST(Verify, DifferentLettersMayShareAColor) {
  // Two dark regions, kept apart by light: different letters, same color.
  EXPECT_EQ(judge({"a.b", "..."}, {"DLD", "LLL"}, {}), Violation::None);
}

/**
 * Every violation is worded, and EXHAUSTIVELY — a loop to `Count` rather than a
 * hand-kept roster, which is what the `switch` this replaced used to guarantee.
 * `describe`'s own `static_assert` only counts its rows, so a table with one
 * enumerator written twice and another missed would still be the right SIZE
 * and the missed one would describe itself as "Unknown violation".
 */
TEST(Verify, EveryViolationHasAMessage) {
  using enum Violation;
  EXPECT_STREQ(verify::describe(None), "");
  for (int index = 1; index < std::to_underlying(Count); index++) {
    const auto violation = static_cast<Violation>(index);
    EXPECT_STRNE(verify::describe(violation), "") << index;
    EXPECT_STRNE(verify::describe(violation), "Unknown violation") << index;
  }
}

/// A dart on `(0, 0)` aimed along the top row, and a coloring to judge.
Violation judgeDart(const std::vector<std::string> &picture,
                    const std::vector<std::string> &painted, const int value,
                    const int direction = kDirRight) {
  Puzzle puzzle = test::board(picture);
  test::withDart(puzzle, 0, 0, value, direction);
  return verify::check(buildModel(puzzle), test::colors(painted));
}

TEST(Verify, ADartCountsTheOtherColorAlongItsLine) {
  EXPECT_EQ(judgeDart({"....."}, {"DLLDD"}, 2), Violation::None);
  EXPECT_EQ(judgeDart({"....."}, {"DLLDD"}, 3), Violation::DartCount);
}

/// The two colorings differ ONLY in the dart's own square, and the same line
/// of `LLLD` reads as three lights from a dark dart and one dark from a light.
TEST(Verify, ADartTakesTheColorOfItsOwnCell) {
  EXPECT_EQ(judgeDart({"....."}, {"DLLLD"}, 3), Violation::None);
  EXPECT_EQ(judgeDart({"....."}, {"LLLLD"}, 3), Violation::DartCount);
  EXPECT_EQ(judgeDart({"....."}, {"LLLLD"}, 1), Violation::None);
}

TEST(Verify, ADartOfZeroPaintsItsWholeLineItsOwnColor) {
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

/// A lotus on the center of a 3x3, and a coloring to judge.
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

/// The "\" axis through the center transposes the board.
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

/// A corner seat on a 2x2 cell carries the diagonals: the block's center is a
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

/// A viewpoint on `(x, y)` holding `value`, and a coloring to judge.
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

/// The two colorings differ ONLY in the viewpoint's own square, and the same
/// line reads as three lights from a light one and as one square from a dark.
TEST(Verify, AViewpointTakesTheColorOfItsOwnCell) {
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
 * the squares of the viewpoint's OWN cell count too, being its own color by
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
  Puzzle puzzle = boardWithRules(picture, active);
  test::withShape(puzzle, squares);
  return verify::check(buildModel(puzzle), test::colors(painted));
}

TEST(Verify, RefusesAMergedCellInTwoColors) {
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
  // dark" holds. A plain board with the same coloring would come out the same,
  // which is the point: fusing changes the VARIABLES, not the geometry the
  // rules read.
  EXPECT_EQ(judgeMerged({"..", ".."}, {{0, 0}, {0, 1}}, {"DL", "DD"},
                        {Rule::ConnectDark}),
            Violation::None);
}

TEST(Verify, CatchesAForbiddenElbow) {
  // All four orientations: a 2x2 with one square the other color.
  EXPECT_EQ(judge({"..", ".."}, {"DD", "DL"}, {Rule::NoDarkElbow}),
            Violation::Elbow);
  EXPECT_EQ(judge({"..", ".."}, {"DD", "LD"}, {Rule::NoDarkElbow}),
            Violation::Elbow);
  EXPECT_EQ(judge({"..", ".."}, {"DL", "DD"}, {Rule::NoDarkElbow}),
            Violation::Elbow);
  EXPECT_EQ(judge({"..", ".."}, {"LD", "DD"}, {Rule::NoDarkElbow}),
            Violation::Elbow);
  // A full square contains one; a domino and a corner touch do not.
  EXPECT_EQ(judge({"..", ".."}, {"DD", "DD"}, {Rule::NoDarkElbow}),
            Violation::Elbow);
  EXPECT_EQ(judge({"..", ".."}, {"DD", "LL"}, {Rule::NoDarkElbow}),
            Violation::None);
  EXPECT_EQ(judge({"..", ".."}, {"DL", "LD"}, {Rule::NoDarkElbow}),
            Violation::None);
  // Separate switches per color.
  EXPECT_EQ(judge({"..", ".."}, {"DD", "DL"}, {Rule::NoLightElbow}),
            Violation::None);
  EXPECT_EQ(judge({"..", ".."}, {"LL", "LD"}, {Rule::NoLightElbow}),
            Violation::Elbow);
}

/// The elbow is its three cells; a gap can never be one of them, while a gap
/// in the 2x2's UNUSED corner changes nothing.
TEST(Verify, AGapNeverStandsInForAnElbowCell) {
  EXPECT_EQ(judge({"..", ".#"}, {"DD", "L#"}, {Rule::NoDarkElbow}),
            Violation::None);
  EXPECT_EQ(judge({"..", ".#"}, {"DD", "D#"}, {Rule::NoDarkElbow}),
            Violation::Elbow);
}

TEST(Verify, CatchesAForbiddenEllInEitherHandedness) {
  // A vertical bar with a foot at its lower end, and the mirrored form.
  EXPECT_EQ(judge({"...", "...", "..."}, {"DLL", "DLL", "DDL"},
                  {Rule::NoDarkEll}),
            kDrawn);
  EXPECT_EQ(judge({"...", "...", "..."}, {"LLD", "LLD", "LDD"},
                  {Rule::NoDarkEll}),
            kDrawn);
  // A horizontal bar with a foot at its left end.
  EXPECT_EQ(judge({"...", "...", "..."}, {"DDD", "DLL", "LLL"},
                  {Rule::NoDarkEll}),
            kDrawn);
  EXPECT_EQ(judge({"...", "...", "..."}, {"DLL", "DDD", "LLL"},
                  {Rule::NoDarkEll}),
            kDrawn);
  // Separate switches per color — on a board whose LIGHT cells hold no L of
  // their own, since a 3x3 complement of an L contains one.
  EXPECT_EQ(judge({"....", "...."}, {"DDDL", "LLDL"}, {Rule::NoDarkEll}),
            kDrawn);
  EXPECT_EQ(judge({"....", "...."}, {"DDDL", "LLDL"}, {Rule::NoLightEll}),
            Violation::None);
}

/// The near shapes: a bare bar has no foot, a T's foot is at the MIDDLE, and a
/// plus is two bars crossing — none of them is an L.
TEST(Verify, TheNearShapesAreNotAnEll) {
  EXPECT_EQ(judge({"...", "..."}, {"DDD", "LLL"}, {Rule::NoDarkEll}),
            Violation::None);
  EXPECT_EQ(judge({"...", "...", "..."}, {"LDL", "DDD", "LLL"},
                  {Rule::NoDarkEll}),
            Violation::None);
  EXPECT_EQ(judge({"...", "...", "..."}, {"LDL", "DDD", "LDL"},
                  {Rule::NoDarkEll}),
            Violation::None);
}

TEST(Verify, CatchesAPairTwoApartWhateverLiesBetween) {
  EXPECT_EQ(judge({"..."}, {"DLD"}, {Rule::NoDarkAnyDark}),
            Violation::DistancePair);
  // The middle being the SAME color does not excuse the ends: the ban is
  // positional, so a straight three breaks it too.
  EXPECT_EQ(judge({"..."}, {"DDD"}, {Rule::NoDarkAnyDark}),
            Violation::DistancePair);
  EXPECT_EQ(judge({".", ".", "."}, {"D", "L", "D"}, {Rule::NoDarkAnyDark}),
            Violation::DistancePair);
  // Adjacent is distance one, and a knight's offset is not a straight line.
  EXPECT_EQ(judge({"..."}, {"DDL"}, {Rule::NoDarkAnyDark}), Violation::None);
  EXPECT_EQ(judge({"...", "..."}, {"DLL", "LLD"}, {Rule::NoDarkAnyDark}),
            Violation::None);
  // Separate switches per color.
  EXPECT_EQ(judge({"..."}, {"LDL"}, {Rule::NoDarkAnyDark}), Violation::None);
  EXPECT_EQ(judge({"..."}, {"LDL"}, {Rule::NoLightAnyLight}),
            Violation::DistancePair);
}

/// The user-confirmed semantics, pinned in both oracles: the two end squares
/// alone matter, so even a GAP between them does not lift the ban.
TEST(Verify, AGapBetweenDoesNotLiftTheBan) {
  EXPECT_EQ(judge({".#."}, {"D#D"}, {Rule::NoDarkAnyDark}),
            Violation::DistancePair);
  EXPECT_EQ(judge({".#."}, {"D#L"}, {Rule::NoDarkAnyDark}), Violation::None);
}

TEST(Verify, CatchesALightCrossedDarkT) {
  // Dark bar ends and stem around a light crossing, and its rotation.
  EXPECT_EQ(judge({"...", "..."}, {"DLD", "LDL"}, {Rule::NoLightCrossedDarkT}),
            kDrawn);
  EXPECT_EQ(judge({"..", "..", ".."}, {"DL", "LD", "DL"},
                  {Rule::NoLightCrossedDarkT}),
            kDrawn);
  // A monochrome T is not a mixed one, and a gap never stands in for the
  // crossing — every cell of the shape is named outright.
  EXPECT_EQ(judge({"...", "..."}, {"DDD", "LDL"}, {Rule::NoLightCrossedDarkT}),
            Violation::None);
  EXPECT_EQ(judge({".#.", "..."}, {"D#D", "LDL"}, {Rule::NoLightCrossedDarkT}),
            Violation::None);
}

TEST(Verify, TheTwoMixedTeeRulesAreSeparateSwitches) {
  // Dark arms around a light crossing, with no light T anywhere.
  EXPECT_EQ(judge({"...", "..."}, {"DLD", "DDL"}, {Rule::NoLightCrossedDarkT}),
            kDrawn);
  EXPECT_EQ(judge({"...", "..."}, {"DLD", "DDL"}, {Rule::NoDarkCrossedLightT}),
            Violation::None);
  // And the mirrored shape under the mirrored rule.
  EXPECT_EQ(judge({"...", "..."}, {"LDL", "LLD"}, {Rule::NoDarkCrossedLightT}),
            kDrawn);
}

TEST(Verify, CatchesALongTee) {
  // A bar of three with a stem of two from its middle, twice rotated.
  EXPECT_EQ(judge({"...", "...", "..."}, {"DDD", "LDL", "LDL"},
                  {Rule::NoDarkLongT}),
            Violation::LongTee);
  EXPECT_EQ(judge({"...", "...", "..."}, {"DLL", "DDD", "DLL"},
                  {Rule::NoDarkLongT}),
            Violation::LongTee);
  // Separate switches per color.
  EXPECT_EQ(judge({"...", "...", "..."}, {"DDD", "LDL", "LDL"},
                  {Rule::NoLightLongT}),
            Violation::None);
}

/// A plain T's stem is one square short, and a plus splits its stem across the
/// bar — neither reaches two deep on one side.
TEST(Verify, TheNearShapesAreNotALongTee) {
  EXPECT_EQ(judge({"...", "...", "..."}, {"DDD", "LDL", "LLL"},
                  {Rule::NoDarkLongT}),
            Violation::None);
  EXPECT_EQ(judge({"...", "...", "..."}, {"LDL", "DDD", "LDL"},
                  {Rule::NoDarkLongT}),
            Violation::None);
}

TEST(Verify, CatchesAKnightsMovePair) {
  // All four geometries: two down one across, and two across one down.
  EXPECT_EQ(judge({"...", "...", "..."}, {"DLL", "LLL", "LDL"},
                  {Rule::NoDarkKnight}),
            kDrawn);
  EXPECT_EQ(judge({"...", "...", "..."}, {"LLD", "LLL", "LDL"},
                  {Rule::NoDarkKnight}),
            kDrawn);
  EXPECT_EQ(judge({"...", "...", "..."}, {"DLL", "LLD", "LLL"},
                  {Rule::NoDarkKnight}),
            kDrawn);
  EXPECT_EQ(judge({"...", "...", "..."}, {"LLD", "DLL", "LLL"},
                  {Rule::NoDarkKnight}),
            kDrawn);
  // A diagonal touch is not a knight's move.
  EXPECT_EQ(judge({"...", "...", "..."}, {"DLL", "LDL", "LLL"},
                  {Rule::NoDarkKnight}),
            Violation::None);
  // Separate switches per color — with a gap thinning the board so the LIGHT
  // cells hold no knight pair of their own, which on a full 3x3 they would.
  EXPECT_EQ(judge({"..", "..", ".#"}, {"LD", "LL", "D#"},
                  {Rule::NoDarkKnight}),
            kDrawn);
  EXPECT_EQ(judge({"..", "..", ".#"}, {"LD", "LL", "D#"},
                  {Rule::NoLightKnight}),
            Violation::None);
}

/// Nothing between the two squares is read, so a gap on the way changes
/// nothing — the same positional reading the distance pair has.
TEST(Verify, AKnightPairAcrossAGapStillCounts) {
  EXPECT_EQ(judge({".#.", "...", "..."}, {"D#L", "LLL", "LDL"},
                  {Rule::NoDarkKnight}),
            kDrawn);
}

TEST(Verify, CatchesAMixedElbow) {
  // Two dark ends at a right angle around a light corner, twice oriented.
  EXPECT_EQ(judge({"..", ".."}, {"DL", "LD"}, {Rule::NoDarkLightDarkElbow}),
            kDrawn);
  EXPECT_EQ(judge({"..", ".."}, {"LD", "DL"}, {Rule::NoDarkLightDarkElbow}),
            kDrawn);
  // A STRAIGHT dark-light-dark is the triple rule's shape, not this one's.
  EXPECT_EQ(judge({"..."}, {"DLD"}, {Rule::NoDarkLightDarkElbow}),
            Violation::None);
  // A 2x2 checkerboard contains BOTH mixed elbows, so either rule fires on it.
  EXPECT_EQ(judge({"..", ".."}, {"DL", "LD"}, {Rule::NoLightDarkLightElbow}),
            kDrawn);
}

TEST(Verify, TheTwoMixedElbowRulesAreSeparateSwitches) {
  // Dark ends around a light corner, with no light-ended elbow anywhere: the
  // rest of the board is solid dark, so no dark corner has two light sides.
  EXPECT_EQ(judge({"...", "..."}, {"DLD", "DDD"},
                  {Rule::NoDarkLightDarkElbow}),
            kDrawn);
  EXPECT_EQ(judge({"...", "..."}, {"DLD", "DDD"},
                  {Rule::NoLightDarkLightElbow}),
            Violation::None);
}

TEST(Verify, AGapNeverStandsInForAMixedElbowCorner) {
  // The only corner position between the two dark squares is the gap itself.
  EXPECT_EQ(judge({".#", ".."}, {"D#", "DL"}, {Rule::NoDarkLightDarkElbow}),
            Violation::None);
}

/// The area-SIX pair: the first size past five, checked exactly as four and
/// five are — the family tables gained rows, not code.
TEST(Verify, CatchesAnAreaSixRegionOfTheWrongSize) {
  EXPECT_EQ(judge({".......", "......."}, {"DDDDDDL", "LLLLLLL"},
                  {Rule::AreaSixDark}),
            Violation::None);
  // The straight seven an area of six implies.
  EXPECT_EQ(judge({".......", "......."}, {"DDDDDDD", "LLLLLLL"},
                  {Rule::AreaSixDark}),
            Violation::RegionSize);
  EXPECT_EQ(judge({".......", "......."}, {"DDDDDLL", "LLLLLLL"},
                  {Rule::AreaSixDark}),
            Violation::RegionSize);
}

TEST(Verify, CatchesAnAreaSevenRegionOfTheWrongSize) {
  EXPECT_EQ(judge({"........", "........"}, {"DDDDDDDL", "LLLLLLLL"},
                  {Rule::AreaSevenDark}),
            Violation::None);
  // The straight eight an area of seven implies.
  EXPECT_EQ(judge({"........", "........"}, {"DDDDDDDD", "LLLLLLLL"},
                  {Rule::AreaSevenDark}),
            Violation::RegionSize);
}

/// Area twenty-four — far past anything the pattern table lays out, so the
/// whole rule rides `regionArea` and this family row.
TEST(Verify, CatchesAnAreaTwentyFourRegionOfTheWrongSize) {
  EXPECT_EQ(judge({".....", ".....", ".....", ".....", "....."},
                  {"DDDDD", "DDDDD", "DDLDD", "DDDDD", "DDDDD"},
                  {Rule::AreaTwentyFourDark}),
            Violation::None);
  EXPECT_EQ(judge({".....", ".....", ".....", ".....", "....."},
                  {"DDDDD", "DDDDD", "DDDDD", "DDDDD", "DDDDD"},
                  {Rule::AreaTwentyFourDark}),
            Violation::RegionSize);
}

/// Under off-by-one a displayed number is satisfied at exact distance ONE from
/// the true count — and never at zero, which would be the honest value.
TEST(Verify, OffByOneAcceptsOneOffAndRefusesTheHonestCount) {
  EXPECT_EQ(judge({"3...", "...."}, {"DDLL", "LLLL"}, {Rule::OffByOne}),
            Violation::None);
  EXPECT_EQ(judge({"3...", "...."}, {"DDDD", "LLLL"}, {Rule::OffByOne}),
            Violation::None);
  EXPECT_EQ(judge({"3...", "...."}, {"DDDL", "LLLL"}, {Rule::OffByOne}),
            Violation::AreaSize);
  EXPECT_EQ(judge({"3...", "...."}, {"DLLL", "LLLL"}, {Rule::OffByOne}),
            Violation::AreaSize);
  // Rule off, the honest three is exactly right.
  EXPECT_EQ(judge({"3...", "...."}, {"DDDL", "LLLL"}, {}), Violation::None);
}

TEST(Verify, OffByOneBendsTheDartCount) {
  Puzzle puzzle = test::board({"....."}, rules::bit(Rule::OffByOne));
  test::withDart(puzzle, 0, 0, 2, kDirRight);
  const Model model = buildModel(puzzle);
  EXPECT_EQ(verify::check(model, test::colors({"DLLDD"})),
            Violation::DartCount);
  EXPECT_EQ(verify::check(model, test::colors({"DLDDD"})), Violation::None);
  EXPECT_EQ(verify::check(model, test::colors({"DLLLD"})), Violation::None);
  EXPECT_EQ(verify::check(model, test::colors({"DLLLL"})),
            Violation::DartCount);
}

TEST(Verify, OffByOneBendsTheViewpointCount) {
  Puzzle puzzle = test::board({"....."}, rules::bit(Rule::OffByOne));
  test::withViewpoint(puzzle, 0, 0, 2);
  const Model model = buildModel(puzzle);
  EXPECT_EQ(verify::check(model, test::colors({"DDLLL"})),
            Violation::ViewpointCount);
  EXPECT_EQ(verify::check(model, test::colors({"DLLLL"})), Violation::None);
  EXPECT_EQ(verify::check(model, test::colors({"DDDLL"})), Violation::None);
}

/// Zero is displayable under the rule, and its one legal true count is 1 —
/// minus one being no count at all.
TEST(Verify, OffByOneReadsADisplayedZeroAsOne) {
  Puzzle dart = test::board({"..."}, rules::bit(Rule::OffByOne));
  test::withDart(dart, 0, 0, 0, kDirRight);
  const Model dartModel = buildModel(dart);
  EXPECT_EQ(verify::check(dartModel, test::colors({"DLD"})), Violation::None);
  EXPECT_EQ(verify::check(dartModel, test::colors({"DDD"})),
            Violation::DartCount);

  Puzzle area = test::board({"..."}, rules::bit(Rule::OffByOne));
  test::withClue(area, 0, 0, 0);
  const Model areaModel = buildModel(area);
  EXPECT_EQ(verify::check(areaModel, test::colors({"DLL"})), Violation::None);
  EXPECT_EQ(verify::check(areaModel, test::colors({"DDL"})),
            Violation::AreaSize);
}

/// Letters carry no number, so the rule has nothing to bend on them.
TEST(Verify, OffByOneLeavesLettersAlone) {
  EXPECT_EQ(judge({"a.a", "..."}, {"DDD", "LLL"}, {Rule::OffByOne}),
            Violation::None);
  EXPECT_EQ(judge({"a.a", "..."}, {"DLD", "LLL"}, {Rule::OffByOne}),
            Violation::LetterSplit);
}

/// A galaxy on the center of a 3x3, and a coloring to judge.
Violation judgeGalaxy(const std::vector<std::string> &painted) {
  Puzzle puzzle = test::board({"...", "...", "..."});
  test::withGalaxy(puzzle, 1, 1);
  return verify::check(buildModel(puzzle), test::colors(painted));
}

/// The accepted coloring is 180-degree symmetric but symmetric across NO
/// single axis — the shape that tells a half turn apart from every mirror a
/// lotus could ask for.
TEST(Verify, AGalaxyRegionMustMapToItselfTurnedHalfway) {
  EXPECT_EQ(judgeGalaxy({"DLL", "DDD", "LLD"}), Violation::None);
  EXPECT_EQ(judgeGalaxy({"DLL", "DDD", "LLL"}), Violation::GalaxyAsymmetric);
}

/// Only the region HOLDING the galaxy is held to the half turn: the far dark
/// pair reflects off the board and is nobody's business.
TEST(Verify, OnlyTheRegionHoldingTheGalaxyIsMirrored) {
  Puzzle puzzle = test::board({"....."});
  test::withGalaxy(puzzle, 1, 0);
  EXPECT_EQ(verify::check(buildModel(puzzle), test::colors({"LDLDD"})),
            Violation::None);
}

TEST(Verify, AGalaxyRegionMayNotReflectOffTheBoard) {
  Puzzle puzzle = test::board({"..."});
  test::withGalaxy(puzzle, 0, 0);
  // The region's second square turns past the board's left edge.
  EXPECT_EQ(verify::check(buildModel(puzzle), test::colors({"DDL"})),
            Violation::GalaxyAsymmetric);
  EXPECT_EQ(verify::check(buildModel(puzzle), test::colors({"DLL"})),
            Violation::None);
}

TEST(Verify, AGalaxyRegionMayNotReflectOntoAGap) {
  Puzzle puzzle = test::board({"..#"});
  test::withGalaxy(puzzle, 1, 0);
  EXPECT_EQ(verify::check(buildModel(puzzle), test::colors({"DD#"})),
            Violation::GalaxyAsymmetric);
  EXPECT_EQ(verify::check(buildModel(puzzle), test::colors({"LD#"})),
            Violation::None);
}

/// Two galaxies in one region: the region would need to map to itself about
/// both centers, which only an infinite region could — the composition of two
/// half turns is a translation. The oracle needs no code for that: the far
/// galaxy's square turns off the board about the near one's center.
TEST(Verify, TwoGalaxiesCannotShareARegion) {
  Puzzle puzzle = test::board({"...", "...", "..."});
  test::withGalaxy(puzzle, 1, 0);
  test::withGalaxy(puzzle, 1, 2);
  const Model model = buildModel(puzzle);
  EXPECT_EQ(verify::check(model, test::colors({"DDD", "LLL", "DDD"})),
            Violation::None);
  EXPECT_EQ(verify::check(model, test::colors({"DDD", "LDL", "DDD"})),
            Violation::GalaxyAsymmetric);
}

// ------------------------------------------------------------ seated galaxies --
//
// A galaxy's center may sit on a grid line or a corner, and the turn then
// carries a SIGN: with different colors across the center it INVERTS, so the
// dark region and the light region touching it are each other's image.
// Mirrors the seated cases in `test/logic-grid-solver/verify.test.ts`.

TEST(Verify, ASeatedGalaxyTurnsAboutTheGridLine) {
  // Center on the seam between the two middle columns of a 4x2. The dark
  // domino on the left turns onto the dark domino on the right.
  Puzzle puzzle = test::board({"....", "...."});
  test::withGalaxy(puzzle, 1, 0, 1);
  const Model model = buildModel(puzzle);
  EXPECT_EQ(verify::check(model, test::colors({"DDDD", "LLLL"})),
            Violation::None);
  EXPECT_EQ(verify::check(model, test::colors({"DDDL", "LLLL"})),
            Violation::GalaxyAsymmetric);
}

/// The color-INVERTING case: dark above the seam and light below it, so every
/// square's image holds the opposite color.
TEST(Verify, AnInvertingGalaxyTurnsOntoTheOtherColor) {
  // Center on the seam under (1,1) of a 3x4, so the turn maps the board onto
  // itself.
  Puzzle puzzle = test::board({"...", "...", "...", "..."});
  test::withGalaxy(puzzle, 1, 1, 2);
  const Model model = buildModel(puzzle);
  EXPECT_EQ(verify::check(model, test::colors({"DDD", "DDD", "LLL", "LLL"})),
            Violation::None);
  // The dark half's image has to be light throughout: one square that is not
  // refuses the whole turn.
  EXPECT_EQ(verify::check(model, test::colors({"DDD", "DDD", "LLL", "LLD"})),
            Violation::GalaxyAsymmetric);
}

/// Walking EVERY region touching the center is load-bearing, not thorough. The
/// turn is an involution, so one region's image lies IN the other — but the
/// other may reach further, and only its own walk says so.
TEST(Verify, BothRegionsAtAnInvertingSeatAreWalked) {
  Puzzle puzzle = test::board({"....", "...."});
  test::withGalaxy(puzzle, 1, 0, 3);
  const Model model = buildModel(puzzle);
  EXPECT_EQ(verify::check(model, test::colors({"DDLL", "DDLL"})),
            Violation::None);
  // Every DARK square still turns onto a light one here — it is the light
  // region, reaching further than the dark one's image, that breaks.
  EXPECT_EQ(verify::check(model, test::colors({"DDLL", "DLLL"})),
            Violation::GalaxyAsymmetric);
}

/// Seat 0 is the special case rather than the rule: a square is its own image,
/// so the sign can only preserve color, and the check is what it always was.
TEST(Verify, ACenteredGalaxyCanOnlyPreserveColor) {
  Puzzle puzzle = test::board({"...", "...", "..."});
  test::withGalaxy(puzzle, 1, 1);
  const Model model = buildModel(puzzle);
  EXPECT_EQ(verify::check(model, test::colors({"DLD", "LDL", "DLD"})),
            Violation::None);
}

/// At a CORNER seat both pairs are in scope, so two pairs that disagree about
/// the sign refuse each other with no check of their own.
TEST(Verify, AnInconsistentCornerIsRefused) {
  Puzzle puzzle = test::board({"..", ".."});
  test::withGalaxy(puzzle, 0, 0, 3);
  const Model model = buildModel(puzzle);
  // Preserving on both diagonals, and inverting on both: each is consistent.
  EXPECT_EQ(verify::check(model, test::colors({"DL", "LD"})), Violation::None);
  EXPECT_EQ(verify::check(model, test::colors({"DD", "LL"})), Violation::None);
  // One pair agrees while the other does not.
  EXPECT_EQ(verify::check(model, test::colors({"DD", "DL"})),
            Violation::GalaxyAsymmetric);
}

// ----------------------------------------------------------- region shapes --
//
// "Same shape" is CONGRUENCE — the eight dihedral images, rotations and
// reflections both — so most of what is worth pinning is which pairs of
// polyominoes count as one shape. Mirrors the `region shapes` block in
// `test/logic-grid-solver/verify.test.ts`.

TEST(Verify, CatchesTwoRegionsOfTheSameShape) {
  EXPECT_EQ(judge({"....", "...."}, {"DLDL", "DLDL"},
                  {Rule::DistinctShapesDark}),
            Violation::RegionShapeRepeat);
  // A vertical domino and a lone square are different shapes.
  EXPECT_EQ(judge({"....", "...."}, {"DLDL", "DLLL"},
                  {Rule::DistinctShapesDark}),
            Violation::None);
}

TEST(Verify, ARotationIsTheSameShape) {
  EXPECT_EQ(judge({"....", "....", "...."}, {"DDLL", "LLLD", "LLLD"},
                  {Rule::DistinctShapesDark}),
            Violation::RegionShapeRepeat);
}

/// The decided semantics, and what a rotations-only key would miss.
TEST(Verify, AReflectionIsTheSameShapeToo) {
  EXPECT_EQ(judge({"......", "......", "......"},
                  {"DDLLLL", "LDLLDD", "LLLLDL"}, {Rule::DistinctShapesDark}),
            Violation::RegionShapeRepeat);
}

TEST(Verify, TheShapeRulesAreVacuousBelowTwoRegions) {
  for (const Rule rule : {Rule::DistinctShapesDark, Rule::SameShapeDark}) {
    // No dark at all, and then exactly one dark region.
    EXPECT_EQ(judge({"..", ".."}, {"LL", "LL"}, {rule}), Violation::None);
    EXPECT_EQ(judge({"..", ".."}, {"DD", "DD"}, {rule}), Violation::None);
  }
}

TEST(Verify, AShapeRuleReadsOnlyItsOwnColor) {
  // Two congruent LIGHT dominoes; the dark regions differ.
  EXPECT_EQ(judge({".....", "....."}, {"LDLDD", "LDLDL"},
                  {Rule::DistinctShapesDark}),
            Violation::None);
  EXPECT_EQ(judge({".....", "....."}, {"LDLDD", "LDLDL"},
                  {Rule::DistinctShapesLight}),
            Violation::RegionShapeRepeat);
}

TEST(Verify, AllRegionsAlikeWantsEveryShapeEqual) {
  EXPECT_EQ(judge({"....", "...."}, {"DLDL", "DLLL"}, {Rule::SameShapeDark}),
            Violation::RegionShapeMismatch);
  EXPECT_EQ(judge({"....", "...."}, {"DLDL", "DLDL"}, {Rule::SameShapeDark}),
            Violation::None);
}

/// Both rules of one color together say it has AT MOST ONE region, which a
/// board may legally be — so they are two independent flags, not a switch.
TEST(Verify, BothShapeRulesTogetherAllowOneRegion) {
  const std::vector both{Rule::DistinctShapesDark, Rule::SameShapeDark};
  EXPECT_EQ(judge({"....", "...."}, {"DLLL", "DLLL"}, both), Violation::None);
  EXPECT_EQ(judge({"....", "...."}, {"DLDL", "DLDL"}, both),
            Violation::RegionShapeRepeat);
}

/// A shape is its SQUARES: two regions with the same footprint are the same
/// shape however the merges beneath them differ.
TEST(Verify, AMergedCellDoesNotChangeARegionsShape) {
  Puzzle puzzle = boardWithRules({"....", "...."}, {Rule::DistinctShapesDark});
  test::withShape(puzzle, {{0, 0}, {0, 1}});
  EXPECT_EQ(verify::check(buildModel(puzzle),
                          test::colors({"DLDL", "DLDL"})),
            Violation::RegionShapeRepeat);
}

/// Region size is asked first, so a board breaking both is named for it — the
/// order `REGION_CHECKS` in `verifyRegions.ts` keeps too.
TEST(Verify, ARegionSizeBreakIsReportedAheadOfAShapeBreak) {
  Puzzle puzzle = boardWithRules({"....", "...."}, {Rule::SameShapeDark});
  test::withAreaRule(puzzle, kDark, 3);
  EXPECT_EQ(verify::check(buildModel(puzzle),
                          test::colors({"DLDL", "DLLL"})),
            Violation::RegionSize);
}

} // namespace
