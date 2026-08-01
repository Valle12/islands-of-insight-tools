#include "TestBoards.h"

#include "Replay.h"
#include "Rules.h"
#include <gtest/gtest.h>

#include <string>
#include <vector>

// The rules, checked against the same pictures test/match-three-solver's
// rules.test.ts uses. Both engines have to agree cell for cell, or a wasm
// witness will not replay on the page.
namespace {

using namespace mt;
using mt::test::board;
using mt::test::draw;

TEST(Rules, FindsHorizontalAndVerticalRuns) {
  const Board value = board({"aaa", "bcb", "bcb"});
  rules::Mask mask{};
  ASSERT_TRUE(rules::findMatchesInto(value, mask));
  EXPECT_EQ(mask[0], 1);
  EXPECT_EQ(mask[1], 1);
  EXPECT_EQ(mask[2], 1);
  // The c column is only two long, so nothing there is marked.
  EXPECT_EQ(mask[4], 0);
}

TEST(Rules, LeavesASettledBoardAlone) {
  const Board value = board({"ab", "ba"});
  rules::Mask mask{};
  EXPECT_FALSE(rules::findMatchesInto(value, mask));
  EXPECT_EQ(rules::boardProblem(value), rules::BoardProblem::None);
}

TEST(Rules, GravityStopsAtABlockade) {
  Board value = board({"a", "#", ".", "b"});
  rules::applyGravity(value);
  EXPECT_EQ(draw(value), std::vector<std::string>({"a", "#", ".", "b"}));

  Board floating = board({"a", ".", "#", "b"});
  rules::applyGravity(floating);
  EXPECT_EQ(draw(floating), std::vector<std::string>({".", "a", "#", "b"}));
}

TEST(Rules, RefusesABoardThatHasNotSettled) {
  EXPECT_EQ(rules::boardProblem(board({"a", "."})),
            rules::BoardProblem::Floating);
  EXPECT_EQ(rules::boardProblem(board({"aaa"})),
            rules::BoardProblem::Matching);
}

TEST(Rules, StrandedSymbolIsDetected) {
  // Two b blocks can never line up three.
  EXPECT_TRUE(rules::hasStrandedSymbol(board({"aab", "aab"})));
  EXPECT_FALSE(rules::hasStrandedSymbol(board({"aab", "bba"})));
}

TEST(Rules, LegalMovesOnlyIncludeSwapsThatClear) {
  const Board value = board({"aab", "bba"});
  Board probe;
  probe.width = value.width;
  probe.height = value.height;
  std::vector<rules::PackedMove> moves;
  rules::legalMovesInto(value, probe, moves);

  // Only the right-hand column pair turns both rows into lines.
  ASSERT_EQ(moves.size(), 1U);
  EXPECT_EQ(rules::moveIndex(moves[0]), 2);
  EXPECT_TRUE(rules::moveIsDown(moves[0]));
}

TEST(Rules, ASwapThatChangesNothingIsNotAMove) {
  const Board value = board({"ab", "ba"});
  Board probe;
  probe.width = value.width;
  probe.height = value.height;
  std::vector<rules::PackedMove> moves;
  rules::legalMovesInto(value, probe, moves);
  EXPECT_TRUE(moves.empty());
}

TEST(Rules, TheFastKernelMatchesTheOracleOnACascade) {
  // One swap, two waves, empty board: the swap completes a run of four a, and
  // what drops into the gap lines up as ccc over bbb.
  const Board value = board({"c..", "b..", "a..", "a..", "cac", "abb"});
  Board probe;
  probe.width = value.width;
  probe.height = value.height;
  std::vector<rules::PackedMove> moves;
  rules::legalMovesInto(value, probe, moves);
  ASSERT_FALSE(moves.empty());

  for (const rules::PackedMove packed : moves) {
    Board fast;
    fast.width = value.width;
    fast.height = value.height;
    rules::Mask mask{};
    const int fastCleared =
        rules::applyPacked(value, fast, packed, mask, nullptr).cleared;

    const Move move = rules::decodeMove(packed, value.width);

    Board slow;
    rules::ApplyResult slowResult;
    ASSERT_TRUE(rules::applyMove(value, move, slow, mask, slowResult));
    // The targeted first-wave marking must agree with the full rescan.
    EXPECT_EQ(fastCleared, slowResult.cleared);
    EXPECT_EQ(draw(fast), draw(slow));
  }
}

TEST(Rules, ReplayRefusesAMoveThatIsNotLegal) {
  const Board value = board({"aab", "bba"});
  const Moves moves{{.ax = 0, .ay = 0, .bx = 1, .by = 0}};
  const replay::Verdict verdict = replay::replayMoves(value, moves);
  EXPECT_FALSE(verdict.legal);
  EXPECT_EQ(verdict.played, 0);
}

TEST(Rules, ReplayConfirmsAClearingSequence) {
  const Board value = board({"aab", "bba"});
  const Moves moves{{.ax = 2, .ay = 0, .bx = 2, .by = 1}};
  const replay::Verdict verdict = replay::replayMoves(value, moves);
  EXPECT_TRUE(verdict.legal);
  EXPECT_TRUE(verdict.clearedAtEnd);
  EXPECT_EQ(verdict.played, 1);
}

} // namespace
