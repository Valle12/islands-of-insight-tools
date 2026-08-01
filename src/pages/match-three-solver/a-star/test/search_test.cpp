#ifdef __clang__
#include <yvals_core.h>
#undef __cpp_lib_is_pointer_interconvertible
#endif
#include "Replay.h"
#include "SolverArms.h"
#include <gtest/gtest.h>

#include <string>
#include <vector>

// What each arm may and may not claim. The line that matters: only the
// exhaustive search may ever set `unsolvable`, and only by searching
// maxDepth out with nothing found. No arm claims anything about LENGTH.
namespace {

using namespace mt;

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

Outcome solve(const Board &value, const char *engine,
              const uint32_t budgetMs = 30000) {
  const Config cfg{.maxMs = budgetMs};
  const arms::ArmSpec spec{.engine = engine};
  return arms::solve(value, spec, cfg);
}

/// One swap turns both rows into a line: aab/bba becomes aaa/bbb.
const std::vector<std::string> kOneMove{"aab", "bba"};
/// The same trick stacked twice over, with no swap able to reach both halves.
const std::vector<std::string> kTwoMoves{"aab", "bba", "ccd", "ddc"};
/// A diagonal weave: every symbol has nine blocks, yet no swap makes a line.
const std::vector<std::string> kNoSwaps{"abcdab", "cdabcd", "abcdab",
                                        "cdabcd", "abcdab", "cdabcd"};

TEST(Search, EveryArmSolvesTheOneMoveBoard) {
  for (const char *engine : arms::kEngines) {
    const Outcome outcome = solve(board(kOneMove), engine);
    EXPECT_EQ(outcome.moves.size(), 1U) << "engine " << engine;
    const replay::Verdict verdict =
        replay::replayMoves(board(kOneMove), outcome.moves);
    EXPECT_TRUE(verdict.clearedAtEnd) << "engine " << engine;
  }
}

TEST(Search, EveryArmAnswersATwoMoveBoard) {
  for (const char *engine : {"exhaustive", "cascade", "greedy", "beam"}) {
    const Outcome outcome = solve(board(kTwoMoves), engine);
    EXPECT_EQ(outcome.moves.size(), 2U) << "engine " << engine;
    EXPECT_FALSE(outcome.unsolvable) << "engine " << engine;
  }
}

/// Only the exhaustive search may ever say a board cannot be cleared, and the
/// cascade only because it ends on that arm.
TEST(Search, ABoardWithNoLegalSwapIsProvenUnsolvable) {
  for (const char *engine : {"exhaustive", "cascade"}) {
    const Outcome outcome = solve(board(kNoSwaps), engine);
    EXPECT_TRUE(outcome.unsolvable) << "engine " << engine;
    EXPECT_TRUE(outcome.moves.empty()) << "engine " << engine;
  }
}

TEST(Search, ABoardWhoseEveryMoveStrandsWhatIsLeftIsUnsolvable) {
  // Both legal swaps clear six of the eight cells and orphan the other two.
  const Outcome outcome = solve(board({"aabb", "bbaa"}), "cascade");
  EXPECT_TRUE(outcome.unsolvable);
}

TEST(Search, AnEmptyBoardNeedsNoMoves) {
  const Outcome outcome = solve(board({"..", "#."}), "cascade");
  EXPECT_TRUE(outcome.moves.empty());
  EXPECT_FALSE(outcome.unsolvable);
}

TEST(Search, ACascadeUnderNoBudgetReportsNothingItCannotBack) {
  // 1 ms is not enough to prove anything about a six-symbol board; whatever
  // comes back must still be honest.
  const Outcome outcome =
      solve(board({"ccbbaa", "babcbb", "ccabbc", "bccbab", "cabaca", "aacaac"}),
            "cascade", 1);
  if (!outcome.moves.empty()) {
    const replay::Verdict verdict = replay::replayMoves(
        board({"ccbbaa", "babcbb", "ccabbc", "bccbab", "cabaca", "aacaac"}),
        outcome.moves);
    EXPECT_TRUE(verdict.clearedAtEnd);
  }
  EXPECT_FALSE(outcome.unsolvable);
}

TEST(Search, AnArmsFindSettlesTheSharedBounds) {
  // What one arm finds is what stops every other one: `settled` is the whole
  // race-ending condition now that no length is proven minimal.
  Bounds bounds;
  const Board value = board(kTwoMoves);
  EXPECT_FALSE(bounds.settled());

  const Outcome greedy = arms::solve(
      value, arms::ArmSpec{.engine = "greedy"}, Config{.maxMs = 5000}, bounds);
  ASSERT_EQ(greedy.moves.size(), 2U);
  EXPECT_EQ(bounds.bestLength(), 2);
  EXPECT_TRUE(bounds.settled());
}

} // namespace
