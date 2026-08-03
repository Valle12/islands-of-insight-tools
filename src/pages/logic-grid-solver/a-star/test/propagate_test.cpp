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
  const Puzzle puzzle =
      test::board({"DD."}, test::ruleSet({Rule::NoDark1x3}));
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
  const Puzzle puzzle =
      test::board({"D#", ".#"}, test::ruleSet({Rule::AreaTwoDark}));
  EXPECT_EQ(deduce(puzzle), Rows({"D#", "D#"}));
}

/// The case a forbidden arrangement would DROP: "dark with four light
/// neighbours" only ever has instances where all four neighbours exist, and a
/// cell walled in by gaps has none.
TEST(Propagate, ACellWithNoRoomToPairCannotTakeTheColour) {
  const Puzzle puzzle =
      test::board({".#", "##"}, test::ruleSet({Rule::AreaTwoDark}));
  EXPECT_EQ(deduce(puzzle), Rows({"L#", "##"}));
}

TEST(Propagate, ACellThatCannotPairAtAllIsRefused) {
  const Puzzle puzzle =
      test::board({"D#", "##"}, test::ruleSet({Rule::AreaTwoDark}));
  EXPECT_EQ(deduce(puzzle), Rows({"CONFLICT"}));
}

/// Both halves working together. The trominoes outline the finished pair, and
/// the cell left in the corner is then one nothing could ever pair with.
TEST(Propagate, AFinishedAreaOfTwoIsOutlined) {
  const Puzzle puzzle =
      test::board({"DD.", "..."}, test::ruleSet({Rule::AreaTwoDark}));
  EXPECT_EQ(deduce(puzzle), Rows({"DDL", "LLL"}));
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
  Puzzle puzzle = test::board({"...", "..."},
                              test::ruleSet({Rule::NoDark1x3}));
  test::withShape(puzzle, {{0, 0}, {1, 0}, {2, 0}});
  EXPECT_EQ(deduce(puzzle), Rows({"LLL", "..."}));
}

/// A merged domino IS a region of two, so the rule that forbids anything else
/// is content with it — while the square below has nothing left to pair with.
TEST(Propagate, AMergedDominoSatisfiesAnAreaOfTwoByItself) {
  Puzzle puzzle = test::board({"DD", ".#"},
                              test::ruleSet({Rule::AreaTwoDark}));
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
