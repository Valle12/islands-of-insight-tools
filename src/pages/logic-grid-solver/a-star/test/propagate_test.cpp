#include "TestBoards.h"

#include "Budget.h"
#include "Domains.h"
#include "Probe.h"
#include "Propagate.h"
#include "Puzzle.h"
#include "Rules.h"
#include "Search.h"

#include <gtest/gtest.h>
#include <string>
#include <utility>
#include <vector>

namespace {

using namespace lg;
using rules::Rule;

/// What deduction alone makes of a board. "CONFLICT" when the board cannot be
/// completed at all.
std::vector<std::string> deduce(const Puzzle &puzzle) {
  const Model model = buildModel(puzzle);
  Domains domains(model);
  if (!applyGivens(model, domains))
    return {"CONFLICT"};
  return test::draw(model, domains.toColors());
}

/// The same, with singleton look-ahead on top.
std::vector<std::string> lookAhead(const Puzzle &puzzle) {
  const Model model = buildModel(puzzle);
  Domains domains(model);
  SearchStats stats;
  constexpr Config cfg{.maxMs = 20000};
  Budget budget(cfg, "test", stats);
  if (!applyGivens(model, domains))
    return {"CONFLICT"};
  if (probeToFixpoint(model, domains, budget) == ProbeResult::Conflict)
    return {"CONFLICT"};
  return test::draw(model, domains.toColors());
}

using Rows = std::vector<std::string>;

TEST(Propagate, AForbiddenSquareForcesItsLastCell) {
  const Puzzle puzzle =
      test::board({"DD", "D."}, test::ruleSet({Rule::NoDark2x2}));
  EXPECT_EQ(deduce(puzzle), Rows({"DD", "DL"}));
}

TEST(Propagate, AForbiddenRunForcesTheCellPastIt) {
  Puzzle puzzle = test::board({"DD."});
  test::withRunRule(puzzle, kDark, 3);
  EXPECT_EQ(deduce(puzzle), Rows({"DDL"}));
}

TEST(Propagate, ContradictoryGivensAreRefused) {
  const Puzzle puzzle =
      test::board({"DD", "DD"}, test::ruleSet({Rule::NoDark2x2}));
  EXPECT_EQ(deduce(puzzle), Rows({"CONFLICT"}));
}

/// One cell wide below the given, so the only way its region reaches two is
/// downwards. This is the half of an area rule the pattern table cannot state.
TEST(Propagate, AnAreaOfTwoForcesItsOnlyPartner) {
  Puzzle puzzle = test::board({"D#", ".#"});
  test::withAreaRule(puzzle, kDark, 2);
  EXPECT_EQ(deduce(puzzle), Rows({"D#", "D#"}));
}

/// The case a forbidden arrangement would DROP: "dark with four light
/// neighbours" only ever has instances where all four neighbours exist, and a
/// cell walled in by gaps has none.
TEST(Propagate, ACellWithNoRoomToPairCannotTakeTheColour) {
  Puzzle puzzle = test::board({".#", "##"});
  test::withAreaRule(puzzle, kDark, 2);
  EXPECT_EQ(deduce(puzzle), Rows({"L#", "##"}));
}

TEST(Propagate, ACellThatCannotPairAtAllIsRefused) {
  Puzzle puzzle = test::board({"D#", "##"});
  test::withAreaRule(puzzle, kDark, 2);
  EXPECT_EQ(deduce(puzzle), Rows({"CONFLICT"}));
}

/// Both halves working together. The trominoes outline the finished pair, and
/// the cell left in the corner is then one nothing could ever pair with.
TEST(Propagate, AFinishedAreaOfTwoIsOutlined) {
  Puzzle puzzle = test::board({"DD.", "..."});
  test::withAreaRule(puzzle, kDark, 2);
  EXPECT_EQ(deduce(puzzle), Rows({"DDL", "LLL"}));
}

/// The same propagator at a different size. Four is the case with NO forbidden
/// shapes behind it — 61 pentominoes was the wrong trade — so both halves of
/// "exactly four" are this one function's work.
TEST(Propagate, AnAreaOfFourFillsItsOnlyRoom) {
  Puzzle puzzle = test::board({"D...", "####"});
  test::withAreaRule(puzzle, kDark, 4);
  EXPECT_EQ(deduce(puzzle), Rows({"DDDD", "####"}));
}

TEST(Propagate, ARegionWithNoRoomToReachFourIsRefused) {
  Puzzle puzzle = test::board({"D..#", "####"});
  test::withAreaRule(puzzle, kDark, 4);
  EXPECT_EQ(deduce(puzzle), Rows({"CONFLICT"}));
}

/// The "too big" half, which for four exists only here.
TEST(Propagate, ARegionAlreadyBiggerThanFourIsRefused) {
  Puzzle puzzle = test::board({"DDDDD", "#####"});
  test::withAreaRule(puzzle, kDark, 4);
  EXPECT_EQ(deduce(puzzle), Rows({"CONFLICT"}));
}

/// A finished region of four is outlined, so nothing may join it.
TEST(Propagate, AFinishedAreaOfFourIsOutlined) {
  Puzzle puzzle = test::board({"DDDD.", "#####"});
  test::withAreaRule(puzzle, kDark, 4);
  EXPECT_EQ(deduce(puzzle), Rows({"DDDDL", "#####"}));
}

/// And at FIVE, enforced by the same walk — the only thing the pattern table
/// sees of this size is the straight run of six.
TEST(Propagate, AnAreaOfFiveFillsItsOnlyRoom) {
  Puzzle puzzle = test::board({"D....", "#####"});
  test::withAreaRule(puzzle, kDark, 5);
  EXPECT_EQ(deduce(puzzle), Rows({"DDDDD", "#####"}));
}

TEST(Propagate, ARegionWithNoRoomToReachFiveIsRefused) {
  Puzzle puzzle = test::board({"D...#", "#####"});
  test::withAreaRule(puzzle, kDark, 5);
  EXPECT_EQ(deduce(puzzle), Rows({"CONFLICT"}));
}

TEST(Propagate, AFinishedAreaOfFiveIsOutlined) {
  Puzzle puzzle = test::board({"DDDDD.", "######"});
  test::withAreaRule(puzzle, kDark, 5);
  EXPECT_EQ(deduce(puzzle), Rows({"DDDDDL", "######"}));
}

/**
 * Both sizes on one colour is not a contradiction — it is satisfied exactly
 * where that colour is absent — and propagation reaches that as soon as there
 * is anywhere for it to bite. A space two wide can never hold a region of four,
 * so nothing in it may be dark; and a dark cell already in one is refused,
 * because the pair rule fills the space and the four rule then finds no room.
 */
TEST(Propagate, BothAreaSizesOnOneColourEmptyTheSpaceTheyShare) {
  Puzzle open = test::board({"..#"});
  test::withAreaRule(open, kDark, 2);
  test::withAreaRule(open, kDark, 4);
  EXPECT_EQ(deduce(open), Rows({"LL#"}));
  Puzzle given = test::board({"D.#"});
  test::withAreaRule(given, kDark, 2);
  test::withAreaRule(given, kDark, 4);
  EXPECT_EQ(deduce(given), Rows({"CONFLICT"}));
}

/**
 * Area ONE, the size whose isolated-singleton sweep must NOT run. A decided
 * singleton outlines exactly as any finished region does — the given forces
 * its neighbour light — while a merely POSSIBLE isolated cell stays open,
 * because the singleton is the very shape the rule wants: `L.L`'s middle can
 * still go dark, and excluding it would poison underclued's forced set.
 */
TEST(Propagate, AnAreaOfOneOutlinesItsSingletons) {
  Puzzle puzzle = test::board({"D."});
  test::withAreaRule(puzzle, kDark, 1);
  EXPECT_EQ(deduce(puzzle), Rows({"DL"}));
}

TEST(Propagate, AnAreaOfOneLeavesAnIsolatedPossibleCellOpen) {
  Puzzle puzzle = test::board({"L.L"});
  test::withAreaRule(puzzle, kDark, 1);
  EXPECT_EQ(deduce(puzzle), Rows({"L.L"}));
}

TEST(Propagate, ADominoUnderAreaOneIsRefused) {
  Puzzle puzzle = test::board({"DD"});
  test::withAreaRule(puzzle, kDark, 1);
  EXPECT_EQ(deduce(puzzle), Rows({"CONFLICT"}));
}

/// An area far past the board is enforceable and simply unsatisfiable the
/// moment the colour appears — the honesty rule's engine half: the file
/// loads, and the root refutes it.
TEST(Propagate, AnAreaLargerThanTheBoardRefusesTheColour) {
  Puzzle puzzle = test::board({"D.", ".."});
  test::withAreaRule(puzzle, kDark, 9999);
  EXPECT_EQ(deduce(puzzle), Rows({"CONFLICT"}));
}

// --- Darts ----------------------------------------------------------------

/// Zero: the whole line takes the dart's own colour. Half of what the game
/// calls dart minimax, and the half that needs no counting at all.
TEST(Propagate, ADartOfZeroPaintsItsLine) {
  Puzzle puzzle = test::board({"....."});
  test::withGiven(puzzle, 0, 0, kDark);
  test::withDart(puzzle, 0, 0, 0, kDirRight);
  EXPECT_EQ(deduce(puzzle), Rows({"DDDDD"}));
}

/// The other half: a line exactly as long as the number is entirely the other
/// colour. The gap is stepped over, so the line is three squares and not two.
TEST(Propagate, AFullDartLinePaintsTheOtherColour) {
  Puzzle puzzle = test::board({"..#.."});
  test::withGiven(puzzle, 0, 0, kDark);
  test::withDart(puzzle, 0, 0, 3, kDirRight);
  EXPECT_EQ(deduce(puzzle), Rows({"DL#LL"}));
}

/// Neither extreme, so nothing is forced — and saying so matters, because a
/// propagator that painted here would be painting cells that are free.
TEST(Propagate, ADartInBetweenForcesNothing) {
  Puzzle puzzle = test::board({"....."});
  test::withGiven(puzzle, 0, 0, kDark);
  test::withDart(puzzle, 0, 0, 2, kDirRight);
  EXPECT_EQ(deduce(puzzle), Rows({"D...."}));
}

/// Its own colour is still open, so it does not yet say which colour it counts.
/// Only one assumption fits a line of two: light would need four of them.
TEST(Propagate, ADartThatOnlyOneColourFitsSettlesItsOwnCell) {
  Puzzle puzzle = test::board({"...", "###"});
  test::withDart(puzzle, 0, 0, 2, kDirRight);
  test::withGiven(puzzle, 1, 0, kLight);
  test::withGiven(puzzle, 2, 0, kLight);
  EXPECT_EQ(deduce(puzzle), Rows({"DLL", "###"}));
}

TEST(Propagate, ADartNoColourFitsIsRefused) {
  Puzzle puzzle = test::board({"...", "###"});
  test::withDart(puzzle, 0, 0, 1, kDirRight);
  test::withGiven(puzzle, 1, 0, kLight);
  test::withGiven(puzzle, 2, 0, kLight);
  EXPECT_EQ(deduce(puzzle), Rows({"CONFLICT"}));
}

/**
 * A merged cell on the line is taken or left WHOLE, which is what makes the
 * game's "forced multitiles" fall out of the counting rather than needing a
 * look-ahead: three of the line's four squares are one cell, so asking for
 * three of the other colour can only mean that cell and not the loose square.
 */
TEST(Propagate, ADartForcesAMergedCellOnItsLine) {
  Puzzle puzzle = test::board({"....."});
  test::withGiven(puzzle, 0, 0, kDark);
  test::withDart(puzzle, 0, 0, 3, kDirRight);
  test::withShape(puzzle, {{1, 0}, {2, 0}, {3, 0}});
  EXPECT_EQ(deduce(puzzle), Rows({"DLLLD"}));
}

/// The dart's own cell is off its own line, so a merged dart cannot refute
/// itself by counting its own squares as the colour it is looking for.
TEST(Propagate, AMergedDartDoesNotCountItself) {
  Puzzle puzzle = test::board({"....."});
  // Both squares of the cell, since a merged cell has to agree with itself.
  test::withGiven(puzzle, 0, 0, kDark);
  test::withGiven(puzzle, 1, 0, kDark);
  test::withShape(puzzle, {{0, 0}, {1, 0}});
  // Three squares left on the line past its own cell, and all must be light.
  test::withDart(puzzle, 0, 0, 3, kDirRight);
  EXPECT_EQ(deduce(puzzle), Rows({"DDLLL"}));
}

// --- Lotuses --------------------------------------------------------------

/// The core deduction: a square connected to the lotus through decided cells
/// is certainly in its region, so its mirror must take the same colour.
TEST(Propagate, ALotusForcesTheMirrorOfItsRegion) {
  Puzzle puzzle = test::board({".D.", ".D.", "..."});
  test::withLotus(puzzle, 1, 1, kAxisHorizontal);
  EXPECT_EQ(deduce(puzzle), Rows({".D.", ".D.", ".D."}));
}

TEST(Propagate, ALotusAxisAimsWhereItSays) {
  Puzzle puzzle = test::board({"...", "DD.", "..."});
  test::withLotus(puzzle, 1, 1, kAxisVertical);
  EXPECT_EQ(deduce(puzzle), Rows({"...", "DDD", "..."}));
}

/// The "\" axis through the centre swaps above with left.
TEST(Propagate, ADiagonalLotusSwapsAboveAndLeft) {
  Puzzle puzzle = test::board({".D.", ".D.", "..."});
  test::withLotus(puzzle, 1, 1, kAxisDiagonalDown);
  EXPECT_EQ(deduce(puzzle), Rows({".D.", "DD.", "..."}));
}

/// "Lotus opposing nulls": a cell whose reflection leaves the board would
/// break the symmetry the moment it joined, so it cannot take the colour.
TEST(Propagate, ACellWhoseMirrorLeavesTheBoardCannotJoin) {
  Puzzle puzzle = test::board({"D..", "..."});
  test::withLotus(puzzle, 0, 0, kAxisHorizontal);
  EXPECT_EQ(deduce(puzzle), Rows({"D..", "L.."}));
}

TEST(Propagate, ACellMirroredOntoAGapCannotJoin) {
  Puzzle puzzle = test::board({".D#"});
  test::withLotus(puzzle, 1, 0, kAxisVertical);
  EXPECT_EQ(deduce(puzzle), Rows({"LD#"}));
}

/// "Lotus opposing cells": the reflection is already the other colour.
TEST(Propagate, ACellMirroredOntoTheOtherColourCannotJoin) {
  Puzzle puzzle = test::board({".DL"});
  test::withLotus(puzzle, 1, 0, kAxisVertical);
  EXPECT_EQ(deduce(puzzle), Rows({"LDL"}));
}

/// A lotus on the seam of its own 1x2 cell: the axis is the grid line between
/// its two squares, so the column beside it swaps top for bottom.
TEST(Propagate, ASeatedLotusMirrorsAcrossItsCellsSeam) {
  Puzzle puzzle = test::board({"DD", ".."});
  test::withGiven(puzzle, 0, 1, kDark);
  test::withShape(puzzle, {{0, 0}, {0, 1}});
  test::withLotus(puzzle, 0, 0, kAxisHorizontal, 2);
  EXPECT_EQ(deduce(puzzle), Rows({"DD", "DD"}));
}

/**
 * One symmetry clue plus the colour's CONNECT rule folds the whole board:
 * connectivity makes the lotus's region every cell of its colour, so a
 * decided square ANYWHERE mirrors — not just the decided-connected core — and
 * the fold reaches the other colour too: the dark corner's mirror cannot take
 * light without dragging the corner into the light region, so it goes dark
 * from clear across the board.
 */
TEST(Propagate, AConnectedLotusFoldsTheWholeBoard) {
  Puzzle puzzle = test::board({"D....", ".....", "....."},
                              test::ruleSet({Rule::ConnectLight}));
  test::withGiven(puzzle, 2, 0, kLight);
  test::withLotus(puzzle, 2, 0, kAxisVertical);
  EXPECT_EQ(deduce(puzzle), Rows({"D.L.D", ".....", "....."}));

  // Without the rule only the decided-connected core is provably in the
  // region, and the far corner's mirror stays free — which pins that the fold
  // really is the coupling, not a wider lotus.
  Puzzle loose = test::board({"D....", ".....", "....."});
  test::withGiven(loose, 2, 0, kLight);
  test::withLotus(loose, 2, 0, kAxisVertical);
  EXPECT_EQ(deduce(loose)[0][4], '.');
}

/**
 * The game's "uncoloured symmetry": a lotus with its own colour still open
 * already reflects a decided neighbour, whatever the lotus turns out to be.
 * Plain propagation cannot say so — the propagator skips an undecided lotus on
 * purpose — but the probe tries both colours and keeps what they agree on.
 */
TEST(Propagate, UncolouredSymmetryFallsOutOfTheProbe) {
  Puzzle puzzle = test::board({".D.", "...", "..."});
  test::withLotus(puzzle, 1, 1, kAxisHorizontal);
  const Rows plain = deduce(puzzle);
  const Rows probed = lookAhead(puzzle);
  ASSERT_EQ(probed.size(), 3U);
  EXPECT_EQ(probed[2][1], 'D');
  EXPECT_NE(plain, probed);
}

// --- Viewpoints -----------------------------------------------------------

/// A viewpoint of one already sees its fill, so every ray is capped: the four
/// squares beside it lose its colour, and the corners stay free.
TEST(Propagate, AViewpointOfOneCapsEveryRay) {
  Puzzle puzzle = test::board({"...", "...", "..."});
  test::withGiven(puzzle, 1, 1, kDark);
  test::withViewpoint(puzzle, 1, 1, 1);
  EXPECT_EQ(deduce(puzzle), Rows({".L.", "LDL", ".L."}));
}

/// The other extreme, the game's "maximal viewpoint": a number equal to the
/// whole cross means every ray is seen out to its end.
TEST(Propagate, AMaximalViewpointPaintsItsWholeCross) {
  Puzzle puzzle = test::board({"...", "...", "..."});
  test::withGiven(puzzle, 1, 1, kDark);
  test::withViewpoint(puzzle, 1, 1, 5);
  EXPECT_EQ(deduce(puzzle), Rows({".D.", "DDD", ".D."}));
}

/**
 * The game's "viewpoint expansion", and the corridor example it is usually
 * told with: a three at the closed end of a corridor must see two more
 * squares, so both take its colour — and the run must stop there, so the
 * square after them takes the other. The square beyond THAT is invisible
 * behind the stop and stays free.
 */
TEST(Propagate, AViewpointExpandsWhatEveryCompletionMustSee) {
  Puzzle puzzle = test::board({"....."});
  test::withGiven(puzzle, 0, 0, kDark);
  test::withViewpoint(puzzle, 0, 0, 3);
  EXPECT_EQ(deduce(puzzle), Rows({"DDDL."}));
}

/// A run already as long as the number allows must stop where it stands.
TEST(Propagate, AViewpointAlreadyFullStopsTheRunBeyondIt) {
  Puzzle puzzle = test::board({"....."});
  test::withGiven(puzzle, 0, 0, kDark);
  test::withGiven(puzzle, 1, 0, kDark);
  test::withViewpoint(puzzle, 0, 0, 2);
  EXPECT_EQ(deduce(puzzle), Rows({"DDL.."}));
}

/// Sight stops at the gap, so this board has two visible squares at most and a
/// three can never be satisfied — by either colour.
TEST(Propagate, AViewpointNoColourFitsIsRefused) {
  Puzzle puzzle = test::board({"..#"});
  test::withGiven(puzzle, 0, 0, kDark);
  test::withViewpoint(puzzle, 0, 0, 3);
  EXPECT_EQ(deduce(puzzle), Rows({"CONFLICT"}));
}

/// Its own colour is still open, so it does not yet say which colour it
/// counts. Only light fits a one beside a decided dark: dark would see it.
TEST(Propagate, AViewpointOnlyOneColourFitsSettlesItsOwnCell) {
  Puzzle puzzle = test::board({"..."});
  test::withGiven(puzzle, 1, 0, kDark);
  test::withViewpoint(puzzle, 0, 0, 1);
  EXPECT_EQ(deduce(puzzle), Rows({"LD."}));
}

/// A forced ray square paints its whole merged cell — `Domains::exclude`'s
/// fan-out, with the counting none the wiser — and the run then stops beyond.
TEST(Propagate, AViewpointForcesAMergedCellOnItsRay) {
  Puzzle puzzle = test::board({"....."});
  test::withGiven(puzzle, 0, 0, kDark);
  test::withShape(puzzle, {{1, 0}, {2, 0}, {3, 0}});
  test::withViewpoint(puzzle, 0, 0, 4);
  EXPECT_EQ(deduce(puzzle), Rows({"DDDDL"}));
}

/**
 * An uncoloured viewpoint reasons through the probe, like an uncoloured
 * lotus: a two here cannot be dark — the decided dark two squares along would
 * pull the forced first square into a run of two and overload the count — so
 * the probe settles it light, and the count then paints its one visible
 * square. Plain propagation says nothing, on purpose: the shallow colour
 * choice only refutes what no completion could satisfy at all.
 */
TEST(Propagate, AnUncolouredViewpointFallsOutOfTheProbe) {
  Puzzle puzzle = test::board({"..D."});
  test::withViewpoint(puzzle, 0, 0, 2);
  const Rows plain = deduce(puzzle);
  const Rows probed = lookAhead(puzzle);
  EXPECT_EQ(plain, Rows({"..D."}));
  EXPECT_EQ(probed, Rows({"LLD."}));
}

// --- Merged cells ---------------------------------------------------------

TEST(Domains, DecidingOneSquareOfAMergedCellDecidesThemAll) {
  Puzzle puzzle = test::board({"...", "..."});
  test::withShape(puzzle, {{0, 0}, {1, 0}, {1, 1}});
  const Model model = buildModel(puzzle);
  Domains domains(model);

  ASSERT_TRUE(domains.assign(cellIndex(1, 1), kDark));
  for (const auto &[x, y] :
       {std::pair{0, 0}, std::pair{1, 0}, std::pair{1, 1}}) {
    EXPECT_EQ(domains.colorOf(cellIndex(x, y)), kDark);
    EXPECT_TRUE(domains.isDecided(cellIndex(x, y)));
  }
  // Squares stay the unit of the count, so a three-square cell moves it by
  // three — which is what keeps `complete()` comparable to `playableCount`.
  EXPECT_EQ(domains.decidedCount(), 3);
  EXPECT_EQ(domains.colorOf(cellIndex(2, 0)), kUnknown);
}

TEST(Domains, RestoringUndoesAWholeMergedCell) {
  Puzzle puzzle = test::board({"..", ".."});
  test::withShape(puzzle, {{0, 0}, {1, 0}});
  const Model model = buildModel(puzzle);
  Domains domains(model);

  const Domains::Snapshot mark = domains.snapshot();
  ASSERT_TRUE(domains.assign(cellIndex(0, 0), kLight));
  domains.restore(mark);

  EXPECT_EQ(domains.decidedCount(), 0);
  EXPECT_EQ(domains.colorOf(cellIndex(0, 0)), kUnknown);
  EXPECT_EQ(domains.colorOf(cellIndex(1, 0)), kUnknown);
  EXPECT_TRUE(domains.mayBe(cellIndex(1, 0), kDark));
  EXPECT_TRUE(domains.mayBe(cellIndex(1, 0), kLight));
}

/// The collapsed clause firing: one literal, so unit propagation settles the
/// whole cell before anything has to guess.
TEST(Propagate, AMergedBarLongerThanARunRuleIsForcedTheOtherColour) {
  Puzzle puzzle = test::board({"...", "..."});
  test::withRunRule(puzzle, kDark, 3);
  test::withShape(puzzle, {{0, 0}, {1, 0}, {2, 0}});
  EXPECT_EQ(deduce(puzzle), Rows({"LLL", "..."}));
}

/// A merged domino IS a region of two, so the rule that forbids anything else
/// is content with it — while the square below has nothing left to pair with.
TEST(Propagate, AMergedDominoSatisfiesAnAreaOfTwoByItself) {
  Puzzle puzzle = test::board({"DD", ".#"});
  test::withAreaRule(puzzle, kDark, 2);
  test::withShape(puzzle, {{0, 0}, {1, 0}});
  EXPECT_EQ(deduce(puzzle), Rows({"DD", "L#"}));
}

/// `mergeAround` counting the whole cell: colouring the bar dark would put
/// three squares into a region the clue says holds two, so the bar is light.
/// The area clue then finishes the row on its own — the region's only way to
/// grow is (1,0), and once it is two the rest is outlined.
TEST(Propagate, AMergedCellCannotJoinARegionSmallerThanItself) {
  Puzzle puzzle = test::board({"2..", "..."});
  test::withGiven(puzzle, 0, 0, kDark);
  test::withShape(puzzle, {{0, 1}, {1, 1}, {2, 1}});
  EXPECT_EQ(deduce(puzzle), Rows({"DDL", "LLL"}));
}

/// `soleCell`: the region is short of its number and the only way out is a
/// merged cell spanning THREE border squares. Counting squares would read that
/// as three ways and miss it; counting cells sees the one way there is.
TEST(Propagate, AMergedCellIsOneWayOutHoweverManySquaresItSpans) {
  Puzzle puzzle = test::board({"4##", "...", "###"});
  test::withGiven(puzzle, 0, 0, kDark);
  test::withShape(puzzle, {{0, 1}, {1, 1}, {2, 1}});
  EXPECT_EQ(deduce(puzzle), Rows({"D##", "DDD", "###"}));
}

TEST(Propagate, ACompletedAreaIsOutlined) {
  Puzzle puzzle = test::board({"1.", ".."});
  test::withGiven(puzzle, 0, 0, kDark);
  EXPECT_EQ(deduce(puzzle), Rows({"DL", "L."}));
}

TEST(Propagate, AnAreaWithOneWayOutMustTakeIt) {
  Puzzle puzzle = test::board({"2.", "##"});
  test::withGiven(puzzle, 0, 0, kDark);
  EXPECT_EQ(deduce(puzzle), Rows({"DD", "##"}));
}

TEST(Propagate, AnAreaThatExactlyFillsItsRoomTakesAllOfIt) {
  // Three cells of room, an area of three: every one of them is in the region.
  Puzzle puzzle = test::board({"3.#", "L.#"});
  test::withGiven(puzzle, 0, 0, kDark);
  EXPECT_EQ(deduce(puzzle), Rows({"DD#", "LD#"}));
}

TEST(Propagate, AnAreaBiggerThanItsRoomIsRefused) {
  Puzzle puzzle = test::board({"3.", "##"});
  test::withGiven(puzzle, 0, 0, kDark);
  EXPECT_EQ(deduce(puzzle), Rows({"CONFLICT"}));
}

TEST(Propagate, AnAreaTakesTheOnlyColourThatFits) {
  // The clue's own colour is still open, and dark cannot reach three cells
  // from that corner while light can — so the clue is light.
  EXPECT_EQ(deduce(test::board({"3L", "L#"})), Rows({"LL", "L#"}));
}

TEST(Propagate, AnAreaGrowsThenOutlinesItself) {
  Puzzle puzzle = test::board({"2.."});
  test::withGiven(puzzle, 0, 0, kDark);
  EXPECT_EQ(deduce(puzzle), Rows({"DDL"}));
}

TEST(Propagate, JoiningTwoAreasThatDisagreeIsRefused) {
  Puzzle puzzle = test::board({"1.1"});
  test::withGiven(puzzle, 0, 0, kDark);
  test::withGiven(puzzle, 2, 0, kDark);
  // The middle cell would merge two ones into a three.
  EXPECT_EQ(deduce(puzzle), Rows({"DLD"}));
}

TEST(Propagate, OneLetterIsOneColour) {
  Puzzle puzzle = test::board({"a.a"});
  test::withGiven(puzzle, 0, 0, kDark);
  const Rows found = deduce(puzzle);
  ASSERT_EQ(found.size(), 1U);
  EXPECT_EQ(found.front()[2], 'D');
}

TEST(Propagate, ACellBetweenTwoLettersSeparatesThem) {
  Puzzle puzzle = test::board({"a.b"});
  test::withGiven(puzzle, 0, 0, kDark);
  test::withGiven(puzzle, 2, 0, kDark);
  EXPECT_EQ(deduce(puzzle), Rows({"DLD"}));
}

TEST(Propagate, ALetterCutInTwoIsRefused) {
  Puzzle puzzle = test::board({"a#a"});
  test::withGiven(puzzle, 0, 0, kDark);
  EXPECT_EQ(deduce(puzzle), Rows({"CONFLICT"}));
}

TEST(Propagate, ACellAConnectedColourCannotReachIsRuledOut) {
  // Dark has to be one region, and the far cell cannot join the one that
  // exists, so it can only be light.
  const Puzzle puzzle =
      test::board({"D#."}, test::ruleSet({Rule::ConnectDark}));
  EXPECT_EQ(deduce(puzzle), Rows({"D#L"}));
}

TEST(Propagate, AConnectedColourWithAnAreaNumberCountsTheWholeBoard) {
  // connect-dark means every dark cell is in ONE region, so an area of one on
  // a dark cell says the whole board holds exactly one dark cell — which
  // settles every other cell at once, not just the clue's neighbours.
  Puzzle puzzle =
      test::board({"1..", "..."}, test::ruleSet({Rule::ConnectDark}));
  test::withGiven(puzzle, 0, 0, kDark);
  EXPECT_EQ(deduce(puzzle), Rows({"DLL", "LLL"}));
}

TEST(Propagate, LookAheadFindsWhatPlainDeductionCannot) {
  // Neither cell of the pair is forced by any single rule, but colouring the
  // corner dark strands the area clue, so look-ahead settles it.
  Puzzle puzzle = test::board({"1.", ".."},
                              test::ruleSet({Rule::ConnectLight}));
  test::withGiven(puzzle, 0, 0, kDark);
  const Rows plain = deduce(puzzle);
  const Rows probed = lookAhead(puzzle);
  EXPECT_EQ(probed, Rows({"DL", "LL"}));
  EXPECT_NE(plain, probed);
}

TEST(Propagate, AConnectedElbowFreeColourRulesOutOffAxisCells) {
  // The collinearity lemma at the root: every dark pair shares a row or
  // column, so one given rules out everything off its cross — the compiled
  // off-axis pairs firing as plain unit-ish propagation, no probe needed.
  Puzzle puzzle = test::board(
      {"...", "...", "..."},
      test::ruleSet({Rule::ConnectDark, Rule::NoDarkElbow}));
  test::withGiven(puzzle, 1, 1, kDark);
  EXPECT_EQ(deduce(puzzle), Rows({"L.L", ".D.", "L.L"}));
}

TEST(Propagate, TwoOffAxisCellsOfAConnectedElbowFreeColourAreRefused) {
  Puzzle puzzle = test::board(
      {"...", "...", "..."},
      test::ruleSet({Rule::ConnectDark, Rule::NoDarkElbow}));
  test::withGiven(puzzle, 0, 0, kDark);
  test::withGiven(puzzle, 1, 1, kDark);
  EXPECT_EQ(deduce(puzzle), Rows({"CONFLICT"}));
}

TEST(Propagate, FourAlternatingBorderArcsAreRefused) {
  // The two-arc lemma: D,L,D,L around the perimeter forces a dark and a light
  // path between interleaved endpoints, which would have to cross. Plain
  // `connectColor` cannot see it — every colour still reaches everything
  // through the open middle — so this is `borderArcs`' own refutation.
  Puzzle puzzle = test::board(
      {"...", "...", "..."},
      test::ruleSet({Rule::ConnectDark, Rule::ConnectLight}));
  test::withGiven(puzzle, 0, 0, kDark);
  test::withGiven(puzzle, 2, 0, kLight);
  test::withGiven(puzzle, 2, 2, kDark);
  test::withGiven(puzzle, 0, 2, kLight);
  EXPECT_EQ(deduce(puzzle), Rows({"CONFLICT"}));
}

TEST(Propagate, ABorderCellInsideAnArcTakesTheArcsColour) {
  // Two arcs stand — dark down the left edge, light down the right — and the
  // open square BETWEEN two light cells cannot go dark: a cyclic subsequence
  // never has more transitions than the full cycle, so any completion would
  // carry four arcs. The boundary squares between the arcs stay free.
  Puzzle puzzle = test::board(
      {"...", "...", "..."},
      test::ruleSet({Rule::ConnectDark, Rule::ConnectLight}));
  test::withGiven(puzzle, 0, 0, kDark);
  test::withGiven(puzzle, 0, 1, kDark);
  test::withGiven(puzzle, 2, 0, kLight);
  test::withGiven(puzzle, 2, 2, kLight);
  EXPECT_EQ(deduce(puzzle), Rows({"D.L", "D.L", "..L"}));
}

TEST(Propagate, AGapOnThePerimeterDoesNotBreakTheArcCount) {
  // Gaps are skipped, not counted: the endpoints stay on the outer face, so
  // two arcs across a gap are still two arcs and the inside-an-arc forcing
  // works right through it.
  const Puzzle puzzle = test::board(
      {"D#L", "...", "..L"},
      test::ruleSet({Rule::ConnectDark, Rule::ConnectLight}));
  EXPECT_EQ(deduce(puzzle), Rows({"D#L", "..L", "..L"}));
}

/// The half turn moves BOTH offsets at once, which no single lotus axis
/// reproduces: the bar's arm left of the centre forces the arm right of it
/// one row the other way.
TEST(Propagate, AGalaxyForcesThePointMirrorOfItsRegion) {
  Puzzle puzzle = test::board({".D.", "DD.", "..."});
  test::withGalaxy(puzzle, 1, 1);
  EXPECT_EQ(deduce(puzzle), Rows({".D.", "DDD", ".D."}));
}

TEST(Propagate, ACellWhoseMirrorLeavesTheBoardCannotJoinAGalaxy) {
  Puzzle puzzle = test::board({"D..", "..."});
  test::withGalaxy(puzzle, 0, 0);
  EXPECT_EQ(deduce(puzzle), Rows({"DL.", "L.."}));
}

TEST(Propagate, ACellMirroredOntoTheOtherColourCannotJoinAGalaxy) {
  Puzzle puzzle = test::board({".DL"});
  test::withGalaxy(puzzle, 1, 0);
  EXPECT_EQ(deduce(puzzle), Rows({"LDL"}));
}

TEST(Propagate, ACellMirroredOntoAGapCannotJoinAGalaxy) {
  Puzzle puzzle = test::board({".D#"});
  test::withGalaxy(puzzle, 1, 0);
  EXPECT_EQ(deduce(puzzle), Rows({"LD#"}));
}

/// The connect fold, shared with the lotus: with dark connected, its one
/// region provably holds the galaxy, so a decided dark square ANYWHERE
/// mirrors — and every cell whose mirror leaves the board folds away.
TEST(Propagate, AConnectedGalaxyFoldsTheWholeBoard) {
  Puzzle puzzle = test::board({"D....", ".....", "....."},
                              test::ruleSet({Rule::ConnectDark}));
  test::withGalaxy(puzzle, 2, 0);
  test::withGiven(puzzle, 2, 0, kDark);
  EXPECT_EQ(deduce(puzzle), Rows({"D.D.D", "LLLLL", "LLLLL"}));
}

/// The mirror is taken about the galaxy's own SQUARE, never its cell's
/// middle: on the right square of a 1x2 cell the cell-mate turns two columns
/// over, and the whole row below turns off the board.
TEST(Propagate, AGalaxyOnAMergedCellMirrorsAboutItsOwnSquare) {
  Puzzle puzzle = test::board({"...", "..."});
  test::withShape(puzzle, {{0, 0}, {1, 0}});
  test::withGalaxy(puzzle, 1, 0);
  test::withGiven(puzzle, 0, 0, kDark);
  test::withGiven(puzzle, 1, 0, kDark);
  EXPECT_EQ(deduce(puzzle), Rows({"DDD", "LLL"}));
}

/// An uncoloured galaxy reasons through the probe, the lotus's own story:
/// under DARK the given above it mirrors below; under LIGHT the given is the
/// other colour at the mirror, so the cell below cannot take light either.
TEST(Propagate, AnUncolouredGalaxyFallsOutOfTheProbe) {
  Puzzle puzzle = test::board({".D.", "...", "..."});
  test::withGalaxy(puzzle, 1, 1);
  EXPECT_EQ(lookAhead(puzzle), Rows({".D.", "...", ".D."}));
}

/// Two galaxies can never share a region, and NO code names the case: the
/// cell that would weld them mirrors off the board about the nearer centre,
/// so the shared fold refuses it on its own.
TEST(Propagate, TwoGalaxiesCannotBeWeldedTogether) {
  Puzzle puzzle = test::board({"D.D"});
  test::withGalaxy(puzzle, 0, 0);
  test::withGalaxy(puzzle, 2, 0);
  EXPECT_EQ(deduce(puzzle), Rows({"DLD"}));
}

/// A displayed 0 under `off-by-one` is a real dart whose one candidate is 1:
/// its one-square line must hold the other colour.
TEST(Propagate, OffByOneReadsADisplayedZeroDartAsOne) {
  Puzzle puzzle = test::board({"D."}, test::ruleSet({Rule::OffByOne}));
  test::withDart(puzzle, 0, 0, 0, kDirRight);
  EXPECT_EQ(deduce(puzzle), Rows({"DL"}));
}

/// A displayed area 1 collapses to a true 2 — a region of zero cannot hold
/// its own clue — while the same clue without the rule means exactly one.
TEST(Propagate, OffByOneReadsADisplayedAreaOneAsTwo) {
  Puzzle pair = test::board({"1."}, test::ruleSet({Rule::OffByOne}));
  test::withGiven(pair, 0, 0, kDark);
  EXPECT_EQ(deduce(pair), Rows({"DD"}));

  Puzzle lone = test::board({"1."});
  test::withGiven(lone, 0, 0, kDark);
  EXPECT_EQ(deduce(lone), Rows({"DL"}));
}

/// With both candidates open nothing is forced: a displayed 2 could mean one
/// or three, and a single given decides between them for no cell.
TEST(Propagate, OffByOneWithBothCandidatesOpenForcesNothing) {
  Puzzle puzzle = test::board({"2..."}, test::ruleSet({Rule::OffByOne}));
  test::withGiven(puzzle, 0, 0, kDark);
  EXPECT_EQ(deduce(puzzle), Rows({"D..."}));
}

/// The middle gap: a region walled in at exactly the displayed value
/// satisfies NEITHER candidate — the case an interval reading would wave
/// through, and the exact case the oracle refuses at a complete assignment.
TEST(Propagate, OffByOneRefusesARegionClosedAtTheDisplayedValue) {
  Puzzle closed = test::board({"2.#"}, test::ruleSet({Rule::OffByOne}));
  test::withGiven(closed, 0, 0, kDark);
  test::withGiven(closed, 1, 0, kDark);
  EXPECT_EQ(deduce(closed), Rows({"CONFLICT"}));

  Puzzle honest = test::board({"2.#"});
  test::withGiven(honest, 0, 0, kDark);
  test::withGiven(honest, 1, 0, kDark);
  EXPECT_EQ(deduce(honest), Rows({"DD#"}));
}

/// The off-by-2 trick as set intersection: displayed 1 and 3 share the middle
/// value and may share a region, 1 and 5 share nothing and cannot — on this
/// board, cannot even coexist — while equal clues keep both candidates open.
TEST(Propagate, TheOffByTwoTrickIntersectsCandidateSets) {
  using enum Rule;
  const Puzzle both = test::board({"13"}, test::ruleSet({OffByOne}));
  EXPECT_NE(lookAhead(both), Rows({"CONFLICT"}));
  const Puzzle apart = test::board({"15"}, test::ruleSet({OffByOne}));
  EXPECT_EQ(lookAhead(apart), Rows({"CONFLICT"}));
  const Puzzle equal = test::board({"22"}, test::ruleSet({OffByOne}));
  EXPECT_NE(lookAhead(equal), Rows({"CONFLICT"}));
}

/// A displayed-0 viewpoint sees exactly itself, so every ray is capped at
/// once — the bracket working from candidate counts rather than the value.
TEST(Propagate, OffByOneReadsADisplayedZeroViewpointAsOne) {
  Puzzle puzzle =
      test::board({"...", "...", "..."}, test::ruleSet({Rule::OffByOne}));
  test::withViewpoint(puzzle, 1, 1, 0);
  test::withGiven(puzzle, 1, 1, kDark);
  EXPECT_EQ(deduce(puzzle), Rows({".L.", "LDL", ".L."}));
}

/// At a complete assignment the per-candidate filter IS the oracle: an honest
/// count refutes, either neighbour passes.
TEST(Propagate, OffByOneMatchesTheOracleOnACompleteBoard) {
  Puzzle honest = test::board({"DLLDD"}, test::ruleSet({Rule::OffByOne}));
  test::withDart(honest, 0, 0, 2, kDirRight);
  EXPECT_EQ(deduce(honest), Rows({"CONFLICT"}));

  Puzzle offByOne = test::board({"DLDDD"}, test::ruleSet({Rule::OffByOne}));
  test::withDart(offByOne, 0, 0, 2, kDirRight);
  EXPECT_EQ(deduce(offByOne), Rows({"DLDDD"}));
}

/// The whole-colour cardinality under connect reads a displayed 0 as one dark
/// cell in total — the old zero-means-no-clue sentinel would have read it as
/// no constraint at all.
TEST(Propagate, OffByOneCardinalityReadsADisplayedZero) {
  Puzzle puzzle = test::board(
      {"...."}, test::ruleSet({Rule::OffByOne, Rule::ConnectDark}));
  test::withClue(puzzle, 0, 0, 0);
  test::withGiven(puzzle, 0, 0, kDark);
  EXPECT_EQ(deduce(puzzle), Rows({"DLLL"}));
}

TEST(Propagate, LookAheadThatRunsOutOfTimeProvesNothing) {
  const Model model = buildModel(test::board({"...", "...", "..."}));
  Domains domains(model);
  SearchStats stats;
  // A budget of one millisecond that has already been spent.
  constexpr Config cfg{.maxMs = 1};
  Budget budget(cfg, "test", stats);
  while (!budget.exhaustedNow()) {
    // Burn the budget; the loop ends the moment the deadline passes.
  }
  EXPECT_EQ(probeToFixpoint(model, domains, budget), ProbeResult::Aborted);
}

} // namespace
