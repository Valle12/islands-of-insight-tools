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
using rules::Rule;

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

TEST(Shapes, ACellMayCarryACluePerSquare) {
  // The game's harder boards put several clues on one merged cell — two darts
  // on one domino — so two clues on DIFFERENT squares of a cell are legal
  // structure. `ClueDuplicated` still guards two on the same square.
  Puzzle puzzle = test::board({"22.", "...", "..."});
  test::withShape(puzzle, {{0, 0}, {1, 0}});
  EXPECT_EQ(structureProblem(puzzle), Problem::None);
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
        ShapeGivensDisagree, AreaSmallerThanCell})
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
                              test::ruleSet({Rule::NoDark1x3}));
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
      test::board({"..", ".."}, test::ruleSet({Rule::NoCheckerboard}));
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
  Puzzle puzzle = test::board(open(), test::ruleSet({Rule::NoDark2x2}));
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

// --- Viewpoints -------------------------------------------------------------

/// The own square always counts, so there is no viewpoint of zero — unlike a
/// dart, whose count starts beyond its own cell.
TEST(Viewpoints, AValueOfZeroIsRefused) {
  Puzzle puzzle = test::board(open());
  test::withViewpoint(puzzle, 0, 0, 0);
  EXPECT_EQ(structureProblem(puzzle), Problem::ViewpointValue);
}

/// The ceiling is the whole cross — the row and the column, the own square
/// counted once — which on a 3x3 is five.
TEST(Viewpoints, ANumberBeyondTheCrossIsRefused) {
  Puzzle good = test::board(open());
  test::withViewpoint(good, 1, 1, 5);
  EXPECT_EQ(structureProblem(good), Problem::None);
  Puzzle bad = test::board(open());
  test::withViewpoint(bad, 1, 1, 6);
  EXPECT_EQ(structureProblem(bad), Problem::ViewpointValue);
}

/**
 * The board-wide bound above cannot see this one: each ray is cut short by the
 * first gap on it, so "fits the cross" and "fits what this viewpoint's sight
 * can really reach" are different questions — the second worth a name, like a
 * dart outgrowing its own line.
 */
TEST(Viewpoints, ANumberBeyondItsOwnSightIsNamed) {
  Puzzle puzzle = test::board({".#.", "###", "..."});
  test::withViewpoint(puzzle, 0, 0, 2);
  ASSERT_EQ(structureProblem(puzzle), Problem::None);
  EXPECT_EQ(contradiction(buildModel(puzzle)), Problem::ViewpointExceedsSight);
}

/// The generic net covers the new kind too: a seat belongs to a lotus alone.
TEST(Viewpoints, ASeatIsRefused) {
  Puzzle puzzle = test::board(open());
  puzzle.clues.push_back({.index = cellIndex(0, 0),
                          .kind = kClueViewpoint,
                          .value = 1,
                          .direction = kDirUp,
                          .seat = 1});
  EXPECT_EQ(structureProblem(puzzle), Problem::SeatOnWrongKind);
}

/**
 * A viewpoint carries no direction, so whatever the field holds is IGNORED
 * rather than range-checked: the C++ `Clue` default is a real direction and
 * the bridge sends -1 for an absent key, and both must mean the same clue.
 * Refusing either would trap one of the two writers.
 */
TEST(Viewpoints, ADirectionIsIgnored) {
  for (const int direction : {-1, static_cast<int>(kDirUp)}) {
    Puzzle puzzle = test::board(open());
    puzzle.clues.push_back({.index = cellIndex(0, 0),
                            .kind = kClueViewpoint,
                            .value = 1,
                            .direction = direction});
    EXPECT_EQ(structureProblem(puzzle), Problem::None) << direction;
  }
}

/// Sight stops at a gap, where a dart's line steps over one — the same board
/// gives the dart three squares and the viewpoint's ray one.
TEST(Viewpoints, TheRaysStopAtGaps) {
  Puzzle puzzle = test::board({"..#..", "....."});
  test::withViewpoint(puzzle, 0, 0, 1);
  const Model model = buildModel(puzzle);
  ASSERT_EQ(model.viewpoints.size(), 1U);
  const Viewpoint &viewpoint = model.viewpoints.front();
  ASSERT_EQ(viewpoint.rays[slot(kDirRight)].size(), 1U);
  EXPECT_EQ(viewpoint.rays[slot(kDirRight)].front(), cellIndex(1, 0));
  EXPECT_EQ(viewpoint.rays[slot(kDirDown)].size(), 1U);
  EXPECT_TRUE(viewpoint.rays[slot(kDirUp)].empty());
  EXPECT_TRUE(viewpoint.rays[slot(kDirLeft)].empty());
}

/// Unlike a dart's line, the rays KEEP the squares of the clue's own cell: a
/// viewpoint counts its own colour, which its cell holds by definition.
TEST(Viewpoints, TheRaysKeepTheOwnCellsSquares) {
  Puzzle puzzle = test::board({"....."});
  test::withShape(puzzle, {{0, 0}, {1, 0}});
  test::withViewpoint(puzzle, 0, 0, 1);
  const Model model = buildModel(puzzle);
  ASSERT_EQ(model.viewpoints.size(), 1U);
  const std::vector<int16_t> &ray =
      model.viewpoints.front().rays[slot(kDirRight)];
  ASSERT_EQ(ray.size(), 4U);
  EXPECT_EQ(ray.front(), cellIndex(1, 0));
}

/// A viewpoint is a symbol for "one symbol per area" and nothing else: no area
/// value, no letter group, no dart line, no mirror map.
TEST(Viewpoints, AViewpointIsOnlyASymbol) {
  Puzzle puzzle = test::board(open());
  test::withViewpoint(puzzle, 1, 1, 3);
  const Model model = buildModel(puzzle);
  EXPECT_TRUE(model.areaClues.empty());
  EXPECT_TRUE(model.dartClues.empty());
  EXPECT_TRUE(model.lotusClues.empty());
  EXPECT_TRUE(model.letters.empty());
  ASSERT_EQ(model.viewpointClues.size(), 1U);
  ASSERT_EQ(model.viewpoints.size(), 1U);
  EXPECT_EQ(model.areaValueAt(cellIndex(1, 1)), 0);
  EXPECT_GE(model.clueAt[slot(cellIndex(1, 1))], 0);
}

TEST(Viewpoints, EveryProblemHasAMessage) {
  using enum Problem;
  for (const Problem problem : {ViewpointValue, ViewpointExceedsSight})
    EXPECT_STRNE(describe(problem), "")
        << static_cast<int>(std::to_underlying(problem));
}

// --- Galaxies -------------------------------------------------------------

TEST(Galaxies, AValueIsRefused) {
  Puzzle puzzle = test::board(open());
  test::withGalaxy(puzzle, 1, 1);
  puzzle.clues.back().value = 3;
  EXPECT_EQ(structureProblem(puzzle), Problem::GalaxyValue);
}

TEST(Galaxies, ASeatIsRefused) {
  // The generic net: a seat on any non-lotus kind is `SeatOnWrongKind`, and a
  // galaxy — centre-only by definition — is covered without a branch of its
  // own.
  Puzzle puzzle = test::board(open());
  test::withGalaxy(puzzle, 1, 1);
  puzzle.clues.back().seat = 1;
  EXPECT_EQ(structureProblem(puzzle), Problem::SeatOnWrongKind);
}

TEST(Galaxies, ADirectionIsIgnored) {
  // The `Clue` default is a real direction and a hand-built galaxy keeps it —
  // the viewpoint's discipline: demanding a sentinel would trap exactly this.
  Puzzle standing = test::board(open());
  test::withGalaxy(standing, 1, 1);
  EXPECT_EQ(structureProblem(standing), Problem::None);
  Puzzle sentinel = test::board(open());
  test::withGalaxy(sentinel, 1, 1);
  sentinel.clues.back().direction = -1;
  EXPECT_EQ(structureProblem(sentinel), Problem::None);
}

TEST(Galaxies, AGalaxyIsOnlyASymbol) {
  Puzzle puzzle = test::board(open());
  test::withGalaxy(puzzle, 1, 1);
  const Model model = buildModel(puzzle);
  EXPECT_TRUE(model.areaClues.empty());
  EXPECT_TRUE(model.dartClues.empty());
  EXPECT_TRUE(model.lotusClues.empty());
  EXPECT_TRUE(model.viewpointClues.empty());
  EXPECT_TRUE(model.letters.empty());
  ASSERT_EQ(model.galaxyClues.size(), 1U);
  ASSERT_EQ(model.galaxies.size(), 1U);
  EXPECT_EQ(model.clueAt[slot(cellIndex(1, 1))], 0);
}

TEST(Galaxies, TheMirrorMapPointReflectsAboutTheOwnSquare) {
  Puzzle puzzle = test::board(open());
  test::withGalaxy(puzzle, 1, 1);
  const Model model = buildModel(puzzle);
  const Galaxy &galaxy = model.galaxies.front();
  EXPECT_EQ(galaxy.mirror[slot(cellIndex(0, 0))], cellIndex(2, 2));
  EXPECT_EQ(galaxy.mirror[slot(cellIndex(2, 0))], cellIndex(0, 2));
  EXPECT_EQ(galaxy.mirror[slot(cellIndex(1, 1))], cellIndex(1, 1));

  Puzzle corner = test::board(open());
  test::withGalaxy(corner, 0, 0);
  const Model cornered = buildModel(corner);
  EXPECT_EQ(cornered.galaxies.front().mirror[slot(cellIndex(1, 1))], -1);
  EXPECT_EQ(cornered.galaxies.front().mirror[slot(cellIndex(0, 0))],
            cellIndex(0, 0));
}

TEST(Galaxies, AnOwnCellMirrorOffTheBoardIsNamed) {
  // A PLAIN square always turns onto itself, so only a merged cell can put a
  // galaxy's own cell off the board: about the LEFT square of a 1x2 cell the
  // cell-mate lands past the edge, about the right one it stays on.
  Puzzle off = test::board({"..."});
  test::withShape(off, {{0, 0}, {1, 0}});
  test::withGalaxy(off, 0, 0);
  EXPECT_EQ(contradiction(buildModel(off)),
            Problem::GalaxyMirrorLeavesBoard);

  Puzzle fits = test::board({"..."});
  test::withShape(fits, {{0, 0}, {1, 0}});
  test::withGalaxy(fits, 1, 0);
  EXPECT_EQ(contradiction(buildModel(fits)), Problem::None);
}

// --- Off by one -----------------------------------------------------------

/// A displayed value's candidate TRUE counts: the value alone with the rules
/// as they stand, the value ± 1 — floored per kind — under `off-by-one`.
TEST(OffByOne, CandidatesAreTheDisplayedValuePlusMinusOne) {
  Puzzle puzzle = test::board({"...."}, rules::bit(Rule::OffByOne));
  test::withClue(puzzle, 0, 0, 2);
  const Model model = buildModel(puzzle);
  const ClueCandidates pair = model.candidatesFor(model.puzzle.clues.front());
  ASSERT_EQ(pair.count, 2);
  EXPECT_EQ(pair.lo(), 1);
  EXPECT_EQ(pair.hi(), 3);

  Puzzle exact = test::board({"...."});
  test::withClue(exact, 0, 0, 2);
  const Model bare = buildModel(exact);
  const ClueCandidates one = bare.candidatesFor(bare.puzzle.clues.front());
  ASSERT_EQ(one.count, 1);
  EXPECT_EQ(one.lo(), 2);
}

/// The "one true value" collapses: a displayed 0 can only mean 1, and a
/// displayed area 1 can only mean 2 — a region of zero cannot hold its clue.
TEST(OffByOne, TheFloorCollapsesTheSmallDisplays) {
  Puzzle zero = test::board({"...."}, rules::bit(Rule::OffByOne));
  test::withClue(zero, 0, 0, 0);
  const Model zeroModel = buildModel(zero);
  const ClueCandidates fromZero =
      zeroModel.candidatesFor(zeroModel.puzzle.clues.front());
  ASSERT_EQ(fromZero.count, 1);
  EXPECT_EQ(fromZero.lo(), 1);

  Puzzle one = test::board({"...."}, rules::bit(Rule::OffByOne));
  test::withClue(one, 0, 0, 1);
  const Model oneModel = buildModel(one);
  const ClueCandidates fromOne =
      oneModel.candidatesFor(oneModel.puzzle.clues.front());
  ASSERT_EQ(fromOne.count, 1);
  EXPECT_EQ(fromOne.lo(), 2);
}

TEST(OffByOne, WidensTheDisplayedAreaBounds) {
  using enum Problem;
  using enum Rule;
  Puzzle zero = test::board({"..", ".."}, rules::bit(OffByOne));
  test::withClue(zero, 0, 0, 0);
  EXPECT_EQ(structureProblem(zero), None);
  Puzzle bare = test::board({"..", ".."});
  test::withClue(bare, 0, 0, 0);
  EXPECT_EQ(structureProblem(bare), AreaValue);
  Puzzle top = test::board({"..", ".."}, rules::bit(OffByOne));
  test::withClue(top, 0, 0, 5);
  EXPECT_EQ(structureProblem(top), None);
  Puzzle over = test::board({"..", ".."}, rules::bit(OffByOne));
  test::withClue(over, 0, 0, 6);
  EXPECT_EQ(structureProblem(over), AreaValue);
}

TEST(OffByOne, WidensTheDartAndViewpointBounds) {
  using enum Problem;
  using enum Rule;
  // 3x2: the longest line is two squares, the cross is four.
  Puzzle dart = test::board({"...", "..."}, rules::bit(OffByOne));
  test::withDart(dart, 0, 0, 3, kDirRight);
  EXPECT_EQ(structureProblem(dart), None);
  Puzzle dartOver = test::board({"...", "..."}, rules::bit(OffByOne));
  test::withDart(dartOver, 0, 0, 4, kDirRight);
  EXPECT_EQ(structureProblem(dartOver), DartValue);

  Puzzle viewpoint = test::board({"...", "..."}, rules::bit(OffByOne));
  test::withViewpoint(viewpoint, 0, 0, 0);
  EXPECT_EQ(structureProblem(viewpoint), None);
  Puzzle bare = test::board({"...", "..."});
  test::withViewpoint(bare, 0, 0, 0);
  EXPECT_EQ(structureProblem(bare), ViewpointValue);
  Puzzle high = test::board({"...", "..."}, rules::bit(OffByOne));
  test::withViewpoint(high, 0, 0, 5);
  EXPECT_EQ(structureProblem(high), None);
  Puzzle over = test::board({"...", "..."}, rules::bit(OffByOne));
  test::withViewpoint(over, 0, 0, 6);
  EXPECT_EQ(structureProblem(over), ViewpointValue);
}

/// The contradiction checks read the WEAKEST candidate — and a displayed 0
/// means a true 1, so such a dart on an empty line is unsolvable by name.
TEST(OffByOne, ADisplayedZeroDartNeedsALine) {
  Puzzle puzzle = test::board({"."}, rules::bit(Rule::OffByOne));
  test::withDart(puzzle, 0, 0, 0, kDirRight);
  EXPECT_EQ(contradiction(buildModel(puzzle)), Problem::DartExceedsLine);
}

/// A merged cell floors an area clue's candidates: displayed 1 on a 1x3 cell
/// leaves nothing at all, while displayed 2 collapses to exactly 3.
TEST(OffByOne, TheMergedCellFloorEmptiesOrCollapses) {
  Puzzle empty = test::board({"..."}, rules::bit(Rule::OffByOne));
  test::withShape(empty, {{0, 0}, {1, 0}, {2, 0}});
  test::withClue(empty, 0, 0, 1);
  EXPECT_EQ(contradiction(buildModel(empty)), Problem::AreaSmallerThanCell);

  Puzzle fits = test::board({"..."}, rules::bit(Rule::OffByOne));
  test::withShape(fits, {{0, 0}, {1, 0}, {2, 0}});
  test::withClue(fits, 0, 0, 2);
  const Model model = buildModel(fits);
  EXPECT_EQ(contradiction(model), Problem::None);
  const ClueCandidates candidates =
      model.candidatesFor(model.puzzle.clues.front());
  ASSERT_EQ(candidates.count, 1);
  EXPECT_EQ(candidates.lo(), 3);
}

TEST(OffByOne, AViewpointBeyondItsOwnSightIsNamed) {
  // Sight is two — itself plus the one square before the gap — so a displayed
  // 4 (candidates 3 and 5) cannot fit while a displayed 3 (candidates 2 and
  // 4) still can.
  Puzzle over = test::board({"..#"}, rules::bit(Rule::OffByOne));
  test::withViewpoint(over, 0, 0, 4);
  EXPECT_EQ(contradiction(buildModel(over)), Problem::ViewpointExceedsSight);
  Puzzle fits = test::board({"..#"}, rules::bit(Rule::OffByOne));
  test::withViewpoint(fits, 0, 0, 3);
  EXPECT_EQ(contradiction(buildModel(fits)), Problem::None);
}

} // namespace
