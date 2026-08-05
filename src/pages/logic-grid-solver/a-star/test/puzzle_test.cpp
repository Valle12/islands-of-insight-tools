#include "TestBoards.h"

#include "Bitboard.h"
#include "Puzzle.h"
#include "Rules.h"
#include "Types.h"

#include <algorithm>
#include <gtest/gtest.h>
#include <string>
#include <utility>
#include <vector>

namespace {

using namespace lg;

/// The plain 3x3 every shape case here is cut out of.
std::vector<std::string> open() { return {"...", "...", "..."}; }

// --- Structural validation ------------------------------------------------

TEST(Shapes, AWellFormedShapeIsAccepted) {
  Puzzle puzzle = test::board(open());
  test::withShape(puzzle, {{0, 0}, {1, 0}, {1, 1}});
  EXPECT_EQ(structureProblem(puzzle), Problem::None);
}

TEST(Shapes, ASquareOutsideTheBoardIsRejected) {
  Puzzle puzzle = test::board(open());
  test::withShape(puzzle, {{0, 0}, {3, 0}});
  EXPECT_EQ(structureProblem(puzzle), Problem::ShapeOffBoard);
}

TEST(Shapes, AGapCannotBePartOfAMergedCell) {
  Puzzle puzzle = test::board({"#..", "...", "..."});
  test::withShape(puzzle, {{0, 0}, {1, 0}});
  EXPECT_EQ(structureProblem(puzzle), Problem::ShapeOnGap);
}

TEST(Shapes, TwoMergedCellsCannotShareASquare) {
  Puzzle puzzle = test::board(open());
  test::withShape(puzzle, {{0, 0}, {1, 0}});
  test::withShape(puzzle, {{1, 0}, {2, 0}});
  EXPECT_EQ(structureProblem(puzzle), Problem::ShapeOverlaps);
}

TEST(Shapes, ASquareListedTwiceInOneCellIsRejected) {
  // The same check catches it, which is why the overlap test above is not the
  // only one that can: a shape of {a, a} would otherwise pass the size test and
  // then build a one-square mask.
  Puzzle puzzle = test::board(open());
  test::withShape(puzzle, {{0, 0}, {0, 0}});
  EXPECT_EQ(structureProblem(puzzle), Problem::ShapeOverlaps);
}

TEST(Shapes, ACellOfOneSquareIsRejected) {
  // A cell of one square is a PLAIN cell. Two spellings for one thing would
  // give `representatives` and `cellMask` two ways to say it.
  Puzzle puzzle = test::board(open());
  test::withShape(puzzle, {{0, 0}});
  EXPECT_EQ(structureProblem(puzzle), Problem::ShapeTooSmall);
}

TEST(Shapes, ADisconnectedCellIsRejected) {
  Puzzle puzzle = test::board(open());
  test::withShape(puzzle, {{0, 0}, {2, 0}});
  EXPECT_EQ(structureProblem(puzzle), Problem::ShapeSplit);
}

TEST(Shapes, ACellCarriesAtMostOneClue) {
  Puzzle puzzle = test::board({"22.", "...", "..."});
  test::withShape(puzzle, {{0, 0}, {1, 0}});
  EXPECT_EQ(structureProblem(puzzle), Problem::ShapeCluesDisagree);
}

TEST(Shapes, ACellPaintedInTwoColoursIsRejected) {
  // `applyGivens` would assign both and come back "unsolvable" with nothing
  // pointing at why, so this is named rather than merely refuted.
  Puzzle puzzle = test::board({"DL.", "...", "..."});
  test::withShape(puzzle, {{0, 0}, {1, 0}});
  EXPECT_EQ(structureProblem(puzzle), Problem::ShapeGivensDisagree);
}

TEST(Shapes, EveryProblemHasAMessage) {
  using enum Problem;
  for (const Problem problem :
       {ShapeOffBoard, ShapeOnGap, ShapeOverlaps, ShapeTooSmall, ShapeSplit,
        ShapeCluesDisagree, ShapeGivensDisagree, AreaSmallerThanCell})
    EXPECT_STRNE(describe(problem), "")
        << static_cast<int>(std::to_underlying(problem));
}

TEST(Shapes, AnAreaNumberSmallerThanItsOwnCellIsRefuted) {
  Puzzle puzzle = test::board({"2..", "...", "..."});
  test::withShape(puzzle, {{0, 0}, {1, 0}, {2, 0}});
  ASSERT_EQ(structureProblem(puzzle), Problem::None);
  EXPECT_EQ(contradiction(buildModel(puzzle)), Problem::AreaSmallerThanCell);
}

// --- The compiled model ---------------------------------------------------

TEST(Shapes, TheModelCarriesOneMaskAndOneRepresentativePerCell) {
  Puzzle puzzle = test::board(open());
  test::withShape(puzzle, {{1, 0}, {1, 1}, {2, 1}});
  const Model model = buildModel(puzzle);

  ASSERT_TRUE(model.hasShapes);
  ASSERT_EQ(model.shapes.size(), 1U);
  EXPECT_EQ(model.shapes.front().count(), 3);

  // Every square of the cell answers with the whole cell, whichever one is
  // asked — that is what lets the propagators keep speaking about squares.
  for (const auto &[x, y] : {std::pair{1, 0}, std::pair{1, 1}, std::pair{2, 1}}) {
    const int index = cellIndex(x, y);
    EXPECT_EQ(model.cellMask(index), model.shapes.front());
    EXPECT_EQ(model.representativeOf(index), cellIndex(1, 0));
    EXPECT_EQ(model.cellSize(index), 3);
  }

  // A plain square is its own cell of one.
  EXPECT_EQ(model.cellMask(cellIndex(0, 0)), oneCell(cellIndex(0, 0)));
  EXPECT_EQ(model.representativeOf(cellIndex(0, 0)), cellIndex(0, 0));
  EXPECT_EQ(model.cellSize(cellIndex(0, 0)), 1);

  // Squares stay the unit of `playableCount`; cells are counted separately.
  EXPECT_EQ(model.playableCount, 9);
  EXPECT_EQ(model.cellCount, 7);
  EXPECT_TRUE(model.representatives.isSubsetOf(model.playable));
}

// --- Clause construction over merged cells --------------------------------

/// How many clauses mention this square at all.
int clausesOver(const Model &model, const int index) {
  const int start = model.clauseStart[slot(index)];
  return model.clauseStart[slot(index + 1)] - start;
}

TEST(Shapes, TwoSquaresOfOneCellCollapseToOneLiteral) {
  // A merged 1x3 bar under "no dark 1x3" is a clause in ONE variable: the whole
  // cell is dark or it is not. Left as three literals it could never fire as a
  // unit, because the second and third copies read as more free cells.
  Puzzle puzzle = test::board({"...", "..."},
                              test::ruleSet({rules::Rule::NoDark1x3}));
  test::withShape(puzzle, {{0, 0}, {1, 0}, {2, 0}});
  const Model model = buildModel(puzzle);

  const auto &clauses = model.clauses;
  const auto collapsed = std::ranges::find_if(
      clauses, [](const Clause &clause) { return clause.count == 1; });
  ASSERT_NE(collapsed, clauses.end());
  EXPECT_EQ(collapsed->cells[0], cellIndex(0, 0));
  EXPECT_EQ(collapsed->colors[0], kDark);

  // And the plain row below it still compiles to the full three literals.
  EXPECT_TRUE(std::ranges::any_of(
      clauses, [](const Clause &clause) { return clause.count == 3; }));
}

TEST(Shapes, ACellSpanningBothColoursOfAPatternDropsTheInstance) {
  // The checkerboard pattern wants (0,0) and (1,1) one colour and (1,0), (0,1)
  // the other. A cell holding (0,0) and (1,0) would have to be both, so that
  // arrangement cannot occur and there is nothing to forbid.
  const Puzzle plain =
      test::board({"..", ".."}, test::ruleSet({rules::Rule::NoCheckerboard}));
  const Model before = buildModel(plain);
  ASSERT_FALSE(before.clauses.empty());

  Puzzle merged = plain;
  test::withShape(merged, {{0, 0}, {1, 0}});
  EXPECT_TRUE(buildModel(merged).clauses.empty());
}

TEST(Shapes, AClauseReachesAMergedCellThroughOneSquareOnly) {
  // The occurrence lists stay keyed by square, but a collapsed literal keeps
  // only the FIRST square of the cell the pattern reached — so a clause covering
  // both squares of this domino is listed under (1,1) and not under (1,2).
  //
  // Propagation is still complete, and that is the thing to hold on to:
  // `exclude` fans out over the cell, so deciding EITHER square queues both, and
  // between them every clause mentioning the cell gets rescanned.
  Puzzle puzzle = test::board(open(), test::ruleSet({rules::Rule::NoDark2x2}));
  test::withShape(puzzle, {{1, 1}, {1, 2}});
  const Model model = buildModel(puzzle);

  for (const Clause &clause : model.clauses) {
    int mentions = 0;
    for (int i = 0; i < clause.count; i++) {
      if (model.shapeAt[slot(clause.cells[slot(i)])] >= 0)
        mentions++;
    }
    EXPECT_LE(mentions, 1);
  }
  EXPECT_GT(clausesOver(model, cellIndex(1, 1)), 0);
  // And nothing under the second square: a duplicate entry there would satisfy
  // the loop above while breaking the occurrence contract it describes.
  EXPECT_EQ(clausesOver(model, cellIndex(1, 2)), 0);
}

TEST(Shapes, APlainBoardKnowsItHasNone) {
  const Model model = buildModel(test::board(open()));
  EXPECT_FALSE(model.hasShapes);
  EXPECT_EQ(model.representatives, model.playable);
  EXPECT_EQ(model.cellCount, model.playableCount);
  EXPECT_EQ(model.shapeAt[slot(cellIndex(0, 0))], -1);
}

// --- Darts ----------------------------------------------------------------

TEST(Darts, AKindWithNoDirectionIsRefused) {
  Puzzle puzzle = test::board(open());
  // What a fixture or a bridge sends for a clue carrying no direction at all.
  puzzle.clues.push_back(
      {.index = cellIndex(0, 0), .kind = kClueDart, .value = 1, .direction = -1});
  EXPECT_EQ(structureProblem(puzzle), Problem::DartDirection);
}

TEST(Darts, ADirectionOutsideTheFourIsRefused) {
  Puzzle puzzle = test::board(open());
  test::withDart(puzzle, 0, 0, 1, kDirectionCount);
  EXPECT_EQ(structureProblem(puzzle), Problem::DartDirection);
}

/// Zero is a real dart, unlike an area of zero — it says the whole line holds
/// the dart's own colour, which is one of the two that fill in immediately.
TEST(Darts, ZeroIsAValidNumber) {
  Puzzle puzzle = test::board(open());
  test::withDart(puzzle, 0, 0, 0, kDirRight);
  EXPECT_EQ(structureProblem(puzzle), Problem::None);
}

TEST(Darts, ANumberBeyondTheBoardsLongestLineIsRefused) {
  Puzzle puzzle = test::board(open());
  test::withDart(puzzle, 0, 0, 3, kDirRight);
  EXPECT_EQ(structureProblem(puzzle), Problem::DartValue);
}

/**
 * The board-wide bound above cannot see this one. A line is shortened by every
 * gap on it and by the dart's own merged cell, so "fits the longest line the
 * board has" and "fits the line this dart really sits on" are different
 * questions — and the second is worth a name rather than a bare "unsolvable".
 */
TEST(Darts, ANumberBeyondItsOwnLineIsNamed) {
  Puzzle puzzle = test::board({".#."});
  test::withDart(puzzle, 0, 0, 2, kDirRight);
  ASSERT_EQ(structureProblem(puzzle), Problem::None);
  EXPECT_EQ(contradiction(buildModel(puzzle)), Problem::DartExceedsLine);
}

TEST(Darts, TheLineRunsToTheEdgeAndStepsOverGaps) {
  Puzzle puzzle = test::board({"..#..", "....."});
  test::withDart(puzzle, 0, 0, 0, kDirRight);
  const Model model = buildModel(puzzle);
  ASSERT_EQ(model.darts.size(), 1U);
  // Three squares, not two: the gap is neither counted nor a wall.
  const Bits &ray = model.darts.front().ray;
  EXPECT_EQ(ray.count(), 3);
  EXPECT_TRUE(ray.test(cellIndex(1, 0)));
  EXPECT_FALSE(ray.test(cellIndex(2, 0)));
  EXPECT_TRUE(ray.test(cellIndex(4, 0)));
  // And it stays on its own row.
  EXPECT_FALSE(ray.test(cellIndex(1, 1)));
}

/**
 * The dart's own cell is taken out of its line, and that is a correctness
 * requirement rather than a tightening: left in, "the line is exactly full"
 * would assign the other colour to one of the dart's own squares, `Domains::
 * exclude` would fan that over the whole cell, and the dart would refute
 * itself. Out, the line's length is also exactly the largest legal number.
 */
TEST(Darts, TheLineExcludesTheDartsOwnCell) {
  Puzzle puzzle = test::board({"....."});
  test::withShape(puzzle, {{0, 0}, {1, 0}});
  test::withDart(puzzle, 0, 0, 0, kDirRight);
  const Model model = buildModel(puzzle);
  ASSERT_EQ(model.darts.size(), 1U);
  const Bits &ray = model.darts.front().ray;
  EXPECT_EQ(ray.count(), 3);
  EXPECT_FALSE(ray.test(cellIndex(1, 0)));
  EXPECT_TRUE(ray.test(cellIndex(2, 0)));
}

/// A dart is a symbol like any other for "one symbol per area", but it says
/// nothing about the SIZE of the region it sits in — so it must never reach
/// the table that reads a clue's number as its region's area.
TEST(Darts, ADartIsNotAnAreaClue) {
  Puzzle puzzle = test::board(open());
  test::withDart(puzzle, 0, 0, 1, kDirRight);
  const Model model = buildModel(puzzle);
  EXPECT_TRUE(model.areaClues.empty());
  EXPECT_TRUE(model.letters.empty());
  EXPECT_EQ(model.dartClues.size(), 1U);
  EXPECT_EQ(model.areaValueAt(cellIndex(0, 0)), 0);
  EXPECT_GE(model.clueAt[slot(cellIndex(0, 0))], 0);
}

// --- Lotuses --------------------------------------------------------------

TEST(Lotuses, AKindWithNoAxisIsRefused) {
  Puzzle puzzle = test::board(open());
  // What a fixture or a bridge sends for a clue carrying no direction at all.
  puzzle.clues.push_back(
      {.index = cellIndex(1, 1), .kind = kClueLotus, .direction = -1});
  EXPECT_EQ(structureProblem(puzzle), Problem::LotusAxis);
}

TEST(Lotuses, AnAxisOutsideTheFourIsRefused) {
  Puzzle puzzle = test::board(open());
  test::withLotus(puzzle, 1, 1, kAxisCount);
  EXPECT_EQ(structureProblem(puzzle), Problem::LotusAxis);
}

/// The first VALUELESS kind: a number on it would look like part of the puzzle
/// and mean nothing, which is the same reason a stray direction is refused.
TEST(Lotuses, AValueIsRefused) {
  Puzzle puzzle = test::board(open());
  puzzle.clues.push_back({.index = cellIndex(1, 1),
                          .kind = kClueLotus,
                          .value = 2,
                          .direction = kAxisHorizontal});
  EXPECT_EQ(structureProblem(puzzle), Problem::LotusValue);
}

TEST(Lotuses, ASeatOutsideTheFourIsRefused) {
  Puzzle puzzle = test::board(open());
  test::withLotus(puzzle, 1, 1, kAxisHorizontal, kSeatCount);
  EXPECT_EQ(structureProblem(puzzle), Problem::LotusSeat);
}

/// A plain cell has nothing between squares to sit on.
TEST(Lotuses, ASeatOffTheCentreNeedsAMergedCell) {
  Puzzle puzzle = test::board(open());
  test::withLotus(puzzle, 1, 1, kAxisHorizontal, 2);
  EXPECT_EQ(structureProblem(puzzle), Problem::LotusSeat);
}

TEST(Lotuses, ASeamSeatNeedsBothItsSquaresInOneCell) {
  Puzzle good = test::board(open());
  test::withShape(good, {{1, 1}, {1, 2}});
  test::withLotus(good, 1, 1, kAxisHorizontal, 2);
  EXPECT_EQ(structureProblem(good), Problem::None);

  // The same seat with the cell lying the OTHER way: the square below the
  // seam is not a shape-mate, so there is no seam to sit on.
  Puzzle bad = test::board(open());
  test::withShape(bad, {{1, 1}, {2, 1}});
  test::withLotus(bad, 1, 1, kAxisHorizontal, 2);
  EXPECT_EQ(structureProblem(bad), Problem::LotusSeat);
}

/// Three of the corner's four squares is enough — a 2x2 block's centre has
/// four, and an L-tromino's natural middle is the corner it wraps.
TEST(Lotuses, ACornerSeatNeedsThreeOfItsFourSquares) {
  Puzzle ell = test::board(open());
  test::withShape(ell, {{0, 0}, {1, 0}, {1, 1}});
  test::withLotus(ell, 0, 0, kAxisVertical, 3);
  EXPECT_EQ(structureProblem(ell), Problem::None);

  Puzzle domino = test::board(open());
  test::withShape(domino, {{0, 0}, {1, 0}});
  test::withLotus(domino, 0, 0, kAxisVertical, 3);
  EXPECT_EQ(structureProblem(domino), Problem::LotusSeat);
}

/// A diagonal axis through an edge midpoint would map square centres onto
/// square CORNERS: there is no reflection on the grid, so the combination is
/// refused rather than defined. The centre and the corner both carry it.
TEST(Lotuses, ADiagonalAxisRefusesASeamSeat) {
  Puzzle seam = test::board(open());
  test::withShape(seam, {{1, 1}, {2, 1}});
  test::withLotus(seam, 1, 1, kAxisDiagonalDown, 1);
  EXPECT_EQ(structureProblem(seam), Problem::LotusDiagonalSeat);

  Puzzle corner = test::board(open());
  test::withShape(corner, {{0, 0}, {1, 0}, {0, 1}, {1, 1}});
  test::withLotus(corner, 0, 0, kAxisDiagonalUp, 3);
  EXPECT_EQ(structureProblem(corner), Problem::None);
}

TEST(Lotuses, ASeatOnAnyOtherKindIsRefused) {
  Puzzle puzzle = test::board(open());
  puzzle.clues.push_back({.index = cellIndex(0, 0),
                          .kind = kClueDart,
                          .value = 1,
                          .direction = kDirRight,
                          .seat = 1});
  EXPECT_EQ(structureProblem(puzzle), Problem::SeatOnWrongKind);
}

/// Every square of the lotus's own cell is in its region whatever the colours,
/// so a member reflecting off the board is unsolvable before any colouring —
/// named, like a dart outgrowing its own line.
TEST(Lotuses, AnOwnCellMirrorOffTheBoardIsNamed) {
  Puzzle puzzle = test::board({"..", ".."});
  test::withShape(puzzle, {{0, 0}, {0, 1}});
  // The axis runs through the TOP square's centre, so the cell's own lower
  // square reflects above the board.
  test::withLotus(puzzle, 0, 0, kAxisHorizontal);
  ASSERT_EQ(structureProblem(puzzle), Problem::None);
  EXPECT_EQ(contradiction(buildModel(puzzle)), Problem::LotusMirrorLeavesBoard);
}

/// A lotus is a symbol for "one symbol per area" and nothing else: no area
/// value, no letter group, no dart line.
TEST(Lotuses, ALotusIsOnlyASymbol) {
  Puzzle puzzle = test::board(open());
  test::withLotus(puzzle, 1, 1, kAxisHorizontal);
  const Model model = buildModel(puzzle);
  EXPECT_TRUE(model.areaClues.empty());
  EXPECT_TRUE(model.dartClues.empty());
  EXPECT_TRUE(model.letters.empty());
  ASSERT_EQ(model.lotusClues.size(), 1U);
  ASSERT_EQ(model.lotuses.size(), 1U);
  EXPECT_EQ(model.areaValueAt(cellIndex(1, 1)), 0);
  EXPECT_GE(model.clueAt[slot(cellIndex(1, 1))], 0);
}

/// The precomputed map is pure geometry: the centre square of a 3x3 under a
/// horizontal axis swaps the rows above and below and keeps its own.
TEST(Lotuses, TheMirrorMapReflectsAcrossTheAxis) {
  Puzzle puzzle = test::board(open());
  test::withLotus(puzzle, 1, 1, kAxisHorizontal);
  const Model model = buildModel(puzzle);
  ASSERT_EQ(model.lotuses.size(), 1U);
  const Lotus &lotus = model.lotuses.front();
  EXPECT_EQ(lotus.mirror[slot(cellIndex(0, 0))], cellIndex(0, 2));
  EXPECT_EQ(lotus.mirror[slot(cellIndex(1, 1))], cellIndex(1, 1));
  EXPECT_EQ(lotus.mirror[slot(cellIndex(2, 2))], cellIndex(2, 0));
}

} // namespace
