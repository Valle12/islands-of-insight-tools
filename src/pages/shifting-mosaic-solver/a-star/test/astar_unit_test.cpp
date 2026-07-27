#include "AStar.h"
#include "Node.h"
#include "Types.h"

#include <gtest/gtest.h>
#include <vector>

namespace {

// Test fixture that exposes a few internal methods via friend-style helpers.
// Since AStar's helpers are private we test them indirectly through search()
// for behavioral correctness, plus a handful of small constructed scenarios
// here for unit-level checks.

TEST(SearchSmall, EmptyPathWhenStartEqualsGoal) {
  const std::vector<std::vector<Position>> shapes = {{{0, 0}}};
  const std::vector<Position> initial = {{1, 1}};
  AStar a(3, 3, shapes, initial, 0, Position{1, 1});
  auto turns = a.search();
  EXPECT_TRUE(turns.empty());
}

TEST(SearchSmall, TrivialOneStepRight) {
  const std::vector<std::vector<Position>> shapes = {{{0, 0}}};
  const std::vector<Position> initial = {{0, 0}};
  AStar a(3, 3, shapes, initial, 0, Position{1, 0});
  auto turns = a.search();
  ASSERT_EQ(turns.size(), 1);
  EXPECT_EQ(turns[0].blockId, 0);
  EXPECT_EQ(turns[0].direction, Direction::RIGHT);
}

TEST(SearchSmall, TwoBlockDetour) {
  // Grid: . . X . (row 0) – obstacle at (2,0), goal block at (3,0)
  // goal block (id 1) must reach (0,0).
  const std::vector<std::vector<Position>> shapes = {{{0, 0}}, {{0, 0}}};
  const std::vector<Position> initial = {{2, 0}, {3, 0}};
  AStar a(4, 2, shapes, initial, 1, Position{0, 0});
  auto turns = a.search();
  ASSERT_FALSE(turns.empty());

  // Replay turns; assert goal block ends up at (0,0).
  std::vector<Position> anchors = initial;
  for (const auto &[blockId, direction] : turns) {
    auto &p = anchors[blockId];
    switch (direction) {
    case Direction::UP:
      p.y--;
      break;
    case Direction::RIGHT:
      p.x++;
      break;
    case Direction::DOWN:
      p.y++;
      break;
    case Direction::LEFT:
      p.x--;
      break;
    }
  }
  EXPECT_EQ(anchors[1].x, 0);
  EXPECT_EQ(anchors[1].y, 0);
}

TEST(BoundingBox, ManhattanReturnedWhenNoBlockers) {
  // 3x3 grid, single block. Heuristic should equal Manhattan distance.
  const std::vector<std::vector<Position>> shapes = {{{0, 0}}};
  const std::vector<Position> initial = {{0, 0}};
  AStar a(5, 5, shapes, initial, 0, Position{3, 4});
  // Verify by checking that a search to that anchor takes exactly 7 moves.
  auto turns = a.search();
  EXPECT_EQ(turns.size(), 7u);
}

TEST(Deadlock, DoesNotBlockReachableGoal) {
  // 4x2 grid so blocks can detour around each other:
  //  A . . *
  //  . . . .
  // Goal block target (0,0).
  const std::vector<std::vector<Position>> shapes = {{{0, 0}}, {{0, 0}}};
  const std::vector<Position> initial = {{0, 0}, {3, 0}};
  AStar a(4, 2, shapes, initial, 1, Position{0, 0}, AStar::Config{});
  auto turns = a.search();
  ASSERT_FALSE(turns.empty());
  EXPECT_GE(turns.size(), 4u); // goal block must move and block 0 displaced
}

TEST(Collision, AllowsDetourAroundOtherBlock) {
  // Two 2x1 blocks on the same row, with a second row free for detour.
  const std::vector<std::vector<Position>> shapes = {{{0, 0}, {1, 0}}, {{0, 0}, {1, 0}}};
  const std::vector<Position> initial = {{0, 0}, {3, 0}};
  AStar a(5, 2, shapes, initial, 1, Position{0, 0});
  auto turns = a.search();
  EXPECT_FALSE(turns.empty());
}

} // namespace
