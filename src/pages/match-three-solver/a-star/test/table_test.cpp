#ifdef __clang__
#include <yvals_core.h>
#undef __cpp_lib_is_pointer_interconvertible
#endif
#include "SeededRng.h"
#include "TransTable.h"
#include <gtest/gtest.h>

// The failed-state table. What matters is that it never claims a depth it was
// not told about: eviction merely costs re-search, but a false hit would prune
// away the answer and turn a proof into a lie.
namespace {

using namespace mt;

Board randomBoard(const int cells, SeededRng &rng) {
  Board board;
  board.width = cells;
  board.height = 1;
  for (int i = 0; i < cells; i++)
    board.cells[static_cast<size_t>(i)] =
        static_cast<uint8_t>(rng.uniform(0, 9));
  return board;
}

/// A one-row board of one repeated value: distinct keys that all land in the
/// same bucket once the table is collapsed to one.
Board uniformBoard(const int value) {
  Board board;
  board.width = 8;
  board.height = 1;
  for (int i = 0; i < 8; i++)
    board.cells[static_cast<size_t>(i)] = static_cast<uint8_t>(value);
  return board;
}

TEST(TransTable, FindsAnExactBoardAndNeverANearMiss) {
  SeededRng rng(1);
  TransTable table(207, 1024 * 1024);
  const Board board = randomBoard(207, rng);
  table.store(board, 3);

  EXPECT_TRUE(table.probe(board, 3));
  // Searched out at 3 rules out any shallower attempt too.
  EXPECT_TRUE(table.probe(board, 2));
  EXPECT_FALSE(table.probe(board, 4));

  Board other = board;
  other.cells[0] = other.cells[0] == 0 ? 1 : 0;
  EXPECT_FALSE(table.probe(other, 3));
  EXPECT_EQ(table.size(), 1U);
}

TEST(TransTable, ADeeperVerdictReplacesAShallowerOneForTheSameBoard) {
  TransTable table(8, 1024);
  const Board board = uniformBoard(2);
  table.store(board, 2);
  table.store(board, 5);
  EXPECT_TRUE(table.probe(board, 5));
  EXPECT_EQ(table.size(), 1U);
}

TEST(TransTable, AFullBucketEvictsItsShallowestEntry) {
  // One byte of budget collapses the table to a single 4-way bucket, so every
  // key collides and eviction is exercised deterministically.
  TransTable table(8, 1);
  for (int i = 0; i < 4; i++)
    table.store(uniformBoard(2 + i), 5 + i);
  for (int i = 0; i < 4; i++)
    EXPECT_TRUE(table.probe(uniformBoard(2 + i), 5 + i));
  EXPECT_EQ(table.size(), 4U);

  // A deeper newcomer replaces the shallowest entry and nothing else.
  table.store(uniformBoard(6), 9);
  EXPECT_TRUE(table.probe(uniformBoard(6), 9));
  EXPECT_FALSE(table.probe(uniformBoard(2), 5));
  EXPECT_TRUE(table.probe(uniformBoard(3), 6));

  // A shallower one is dropped instead of displacing anything.
  table.store(uniformBoard(7), 1);
  EXPECT_FALSE(table.probe(uniformBoard(7), 1));
  EXPECT_TRUE(table.probe(uniformBoard(6), 9));
  EXPECT_EQ(table.size(), 4U);
}

TEST(TransTable, MassInsertsStaySoundThroughGrowthAndEviction) {
  SeededRng rng(42);
  TransTable table(207, 8 * 1024 * 1024);
  std::vector<Board> boards;
  std::vector<int> remainings;
  boards.reserve(20000);
  remainings.reserve(20000);
  for (int i = 0; i < 20000; i++) {
    boards.push_back(randomBoard(207, rng));
    remainings.push_back(i % 9 + 1);
    table.store(boards.back(), remainings.back());
  }

  int retained = 0;
  for (size_t i = 0; i < boards.size(); i++) {
    // Soundness: nothing may ever claim a depth it was not stored at.
    ASSERT_FALSE(table.probe(boards[i], remainings[i] + 1));
    if (table.probe(boards[i], remainings[i]))
      retained++;
  }
  // A full bucket grows the table rather than evicting until the byte budget's
  // ceiling; past it an unlucky bucket can fill while the table as a whole
  // still has room. What matters is the assertion above and that the tail
  // stays a tail.
  EXPECT_GT(retained, 19000);
}

} // namespace
