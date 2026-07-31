#ifdef __clang__
#include <yvals_core.h>
#undef __cpp_lib_is_pointer_interconvertible
#endif
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

/// Boards are written as rows top to bottom: '.' empty, '#' blocked, and a
/// letter per symbol index — the same notation the TypeScript tests use.
Board board(const std::vector<std::string> &rows) {
  Board result;
  result.height = static_cast<int>(rows.size());
  result.width = static_cast<int>(rows.front().size());
  for (int y = 0; y < result.height; y++) {
    for (int x = 0; x < result.width; x++) {
      const char glyph = rows[static_cast<size_t>(y)][static_cast<size_t>(x)];
      const size_t at = flat(result.width, x, y);
      if (glyph == '#')
        result.cells[at] = kBlocked;
      else if (glyph != '.')
        result.cells[at] = static_cast<uint8_t>(kFirstSymbol + (glyph - 'a'));
    }
  }
  return result;
}

std::vector<std::string> draw(const Board &value) {
  std::vector<std::string> rows;
  for (int y = 0; y < value.height; y++) {
    std::string row;
    for (int x = 0; x < value.width; x++) {
      const uint8_t cell = value.at(x, y);
      if (cell == kEmpty)
        row.push_back('.');
      else if (cell == kBlocked)
        row.push_back('#');
      else
        row.push_back(static_cast<char>('a' + cell - kFirstSymbol));
    }
    rows.push_back(row);
  }
  return rows;
}

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
    const rules::ApplyResult fastResult =
        rules::applyPacked(value, fast, packed, mask, nullptr);

    const int aIndex = rules::moveIndex(packed);
    const bool down = rules::moveIsDown(packed);
    const int x = aIndex % value.width;
    const int y = aIndex / value.width;
    const Move move{.ax = static_cast<uint8_t>(x),
                    .ay = static_cast<uint8_t>(y),
                    .bx = static_cast<uint8_t>(down ? x : x + 1),
                    .by = static_cast<uint8_t>(down ? y + 1 : y)};

    Board slow;
    rules::ApplyResult slowResult;
    ASSERT_TRUE(rules::applyMove(value, move, slow, mask, slowResult));
    // The targeted first-wave marking must agree with the full rescan.
    EXPECT_EQ(fastResult.cleared, slowResult.cleared);
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
