#include "AStar.h"
#include "Types.h"

#include <gtest/gtest.h>
#include <vector>

namespace {

// Test fixture that exposes a few internal methods via friend-style helpers.
// Since AStar's helpers are private we test them indirectly through search()
// for behavioral correctness, plus a handful of small constructed scenarios
// here for unit-level checks.

TEST(SearchSmall, EmptyPathWhenStartEqualsGoal) {
  AStar a(3, 3, {{{0, 0}}}, {{1, 1}}, 0, Position{1, 1});
  const auto turns = a.search();
  EXPECT_TRUE(turns.empty());
}

TEST(SearchSmall, TrivialOneStepRight) {
  AStar a(3, 3, {{{0, 0}}}, {{0, 0}}, 0, Position{1, 0});
  const auto turns = a.search();
  ASSERT_EQ(turns.size(), 1);
  EXPECT_EQ(turns[0].blockId, 0);
  EXPECT_EQ(turns[0].direction, Direction::RIGHT);
}

TEST(SearchSmall, TwoBlockDetour) {
  // Grid: . . X . (row 0) – obstacle at (2,0), goal block at (3,0)
  // goal block (id 1) must reach (0,0).
  // `anchors` doubles as the initial state and the replay accumulator, so it
  // is the one board literal that cannot be inlined into the constructor.
  std::vector<Position> anchors = {{2, 0}, {3, 0}};
  AStar a(4, 2, {{{0, 0}}, {{0, 0}}}, anchors, 1, Position{0, 0});
  const auto turns = a.search();
  ASSERT_FALSE(turns.empty());

  // Replay turns; assert goal block ends up at (0,0).
  for (const auto &[blockId, direction] : turns) {
    auto &[px, py] = anchors[blockId];
    switch (direction) {
    case Direction::UP:
      py--;
      break;
    case Direction::RIGHT:
      px++;
      break;
    case Direction::DOWN:
      py++;
      break;
    case Direction::LEFT:
      px--;
      break;
    }
  }
  EXPECT_EQ(anchors[1].x, 0);
  EXPECT_EQ(anchors[1].y, 0);
}

TEST(BoundingBox, ManhattanReturnedWhenNoBlockers) {
  // 3x3 grid, single block. Heuristic should equal Manhattan distance.
  AStar a(5, 5, {{{0, 0}}}, {{0, 0}}, 0, Position{3, 4});
  // Verify by checking that a search to that anchor takes exactly 7 moves.
  const auto turns = a.search();
  EXPECT_EQ(turns.size(), 7u);
}

TEST(Deadlock, DoesNotBlockReachableGoal) {
  // 4x2 grid so blocks can detour around each other:
  //  A . . *
  //  . . . .
  // Goal block target (0,0).
  AStar a(4, 2, {{{0, 0}}, {{0, 0}}}, {{0, 0}, {3, 0}}, 1, Position{0, 0},
          AStar::Config{});
  const auto turns = a.search();
  ASSERT_FALSE(turns.empty());
  EXPECT_GE(turns.size(), 4u); // goal block must move and block 0 displaced
}

TEST(Collision, AllowsDetourAroundOtherBlock) {
  // Two 2x1 blocks on the same row, with a second row free for detour.
  AStar a(5, 2, {{{0, 0}, {1, 0}}, {{0, 0}, {1, 0}}}, {{0, 0}, {3, 0}}, 1,
          Position{0, 0});
  const auto turns = a.search();
  EXPECT_FALSE(turns.empty());
}

} // namespace
