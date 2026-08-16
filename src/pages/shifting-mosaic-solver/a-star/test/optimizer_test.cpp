#include "AStar.h"
#include "Types.h"

#include <gtest/gtest.h>

#include <array>
#include <cstdint>
#include <utility>
#include <vector>

// ---------------------------------------------------------------------------
// Unit tests for AStar::optimizeSolution — the solution post-processor.
//
// Each test hand-builds a tiny puzzle and a deliberately suboptimal (but
// valid) solution, then checks that optimizeSolution shortens it without ever
// producing an invalid or longer result.
// ---------------------------------------------------------------------------

namespace {

constexpr std::array<int, 4> kDX = {0, 1, 0, -1};
constexpr std::array<int, 4> kDY = {-1, 0, 1, 0};

struct Puzzle {
  uint8_t gridWidth;
  uint8_t gridHeight;
  std::vector<std::vector<Position>> shapes;
  std::vector<Position> initialAnchors;
  uint8_t goalIndex;
  Position goalAnchor;
};

AStar makeSolver(const Puzzle &p) {
  return {p.gridWidth,      p.gridHeight, p.shapes,
          p.initialAnchors, p.goalIndex,  p.goalAnchor};
}

// Independent replay validator (does not share code with AStar): every block
// stays in bounds, no two blocks ever overlap, goal block lands on goalAnchor.
bool collisionFree(const Puzzle &p, const std::vector<Position> &anchors) {
  std::vector occ(static_cast<size_t>(p.gridWidth) * p.gridHeight, -1);
  for (size_t i = 0; i < anchors.size(); i++) {
    for (const auto &[dx, dy] : p.shapes[i]) {
      const int cx = anchors[i].x + dx;
      const int cy = anchors[i].y + dy;
      if (cx < 0 || cy < 0 || cx >= p.gridWidth || cy >= p.gridHeight)
        return false;
      const int idx = cx * p.gridHeight + cy;
      if (occ[idx] != -1)
        return false;
      occ[idx] = static_cast<int>(i);
    }
  }
  return true;
}

bool replayValid(const Puzzle &p, const std::vector<Turn> &turns) {
  std::vector<Position> anchors = p.initialAnchors;
  if (!collisionFree(p, anchors))
    return false;
  for (const auto &[blockId, direction] : turns) {
    if (blockId >= anchors.size())
      return false;
    const auto d = static_cast<int>(std::to_underlying(direction));
    anchors[blockId].x = static_cast<int8_t>(anchors[blockId].x + kDX[d]);
    anchors[blockId].y = static_cast<int8_t>(anchors[blockId].y + kDY[d]);
    if (!collisionFree(p, anchors))
      return false;
  }
  return anchors[p.goalIndex].x == p.goalAnchor.x &&
         anchors[p.goalIndex].y == p.goalAnchor.y;
}

// Player steps as the UI counts them: maximal same-block runs (direction
// changes fold into one polyline drag).
size_t countSteps(const std::vector<Turn> &turns) {
  size_t steps = 0;
  for (size_t i = 0; i < turns.size(); i++) {
    if (i == 0 || turns[i].blockId != turns[i - 1].blockId) {
      steps++;
    }
  }
  return steps;
}

void add(std::vector<Turn> &turns, const uint8_t block, const Direction dir,
         const int count) {
  for (int i = 0; i < count; i++)
    turns.push_back({.blockId = block, .direction = dir});
}

// Two single-cell blocks. Block 0 is the goal block at (0,0) → (3,0); block 1
// sits out of the way at (0,2). Grid 6x3.
Puzzle clearPathPuzzle() {
  return {.gridWidth = 6,
          .gridHeight = 3,
          .shapes = {{{.x = 0, .y = 0}}, {{.x = 0, .y = 0}}},
          .initialAnchors = {{.x = 0, .y = 0}, {.x = 0, .y = 2}},
          .goalIndex = 0,
          .goalAnchor = {.x = 3, .y = 0}};
}

// Two single-cell blocks on the same row: block 1 sits in block 0's path at
// (2,0), so it must be nudged aside. Block 0 goes (0,0) → (4,0). Grid 6x3.
Puzzle blockedPathPuzzle() {
  return {.gridWidth = 6,
          .gridHeight = 3,
          .shapes = {{{.x = 0, .y = 0}}, {{.x = 0, .y = 0}}},
          .initialAnchors = {{.x = 0, .y = 0}, {.x = 2, .y = 0}},
          .goalIndex = 0,
          .goalAnchor = {.x = 4, .y = 0}};
}

// Asserts an optimized solution is valid and never regressed on either metric.
void expectNoRegression(const Puzzle &p, const std::vector<Turn> &before,
                        const std::vector<Turn> &after) {
  EXPECT_TRUE(replayValid(p, after)) << "optimized solution is not valid";
  EXPECT_LE(after.size(), before.size()) << "move count increased";
  EXPECT_LE(countSteps(after), countSteps(before)) << "step count increased";
}

TEST(Optimizer, TruncatesMovesAfterGoalIsReached) {
  const Puzzle p = clearPathPuzzle();
  std::vector<Turn> input;
  add(input, 0, Direction::RIGHT, 3); // goal block reaches (3,0) here
  add(input, 1, Direction::RIGHT, 1); // pointless trailing move

  const auto out = makeSolver(p).optimizeSolution(input);

  expectNoRegression(p, input, out);
  EXPECT_EQ(out.size(), 3u);
}

TEST(Optimizer, CancelsRedundantOutAndBack) {
  using enum Direction;
  const Puzzle p = clearPathPuzzle();
  std::vector<Turn> input;
  add(input, 1, RIGHT, 2); // block 1 wanders out...
  add(input, 1, LEFT, 2);  // ...and straight back — pure noise
  add(input, 0, RIGHT, 3);

  const auto out = makeSolver(p).optimizeSolution(input);

  expectNoRegression(p, input, out);
  EXPECT_EQ(out.size(), 3u);
  for (const auto &[blockId, direction] : out) {
    EXPECT_EQ(blockId, 0);
    EXPECT_EQ(direction, Direction::RIGHT);
  }
}

TEST(Optimizer, CancelsPerpendicularOutAndBack) {
  using enum Direction;
  // Single goal block at (0,1) → (3,1); a stray up/down detour mid-route.
  const Puzzle p{.gridWidth = 6,
                 .gridHeight = 3,
                 .shapes = {{{.x = 0, .y = 0}}},
                 .initialAnchors = {{.x = 0, .y = 1}},
                 .goalIndex = 0,
                 .goalAnchor = {.x = 3, .y = 1}};
  std::vector<Turn> input;
  add(input, 0, RIGHT, 2);
  add(input, 0, UP, 1);
  add(input, 0, DOWN, 1);
  add(input, 0, RIGHT, 1);

  const auto out = makeSolver(p).optimizeSolution(input);

  expectNoRegression(p, input, out);
  EXPECT_EQ(out.size(), 3u);
}

TEST(Optimizer, KeepsNecessaryDodgeButDropsTheReturn) {
  using enum Direction;
  // Block 1 must dodge down so block 0 can slide past — that dodge has to
  // stay. The dodge's *return* move, however, is unnecessary.
  const Puzzle p = blockedPathPuzzle();
  std::vector<Turn> input;
  add(input, 1, DOWN, 1);  // necessary: clears (2,0)
  add(input, 0, RIGHT, 3); // block 0 slides to (3,0)
  add(input, 1, UP, 1);    // unnecessary: returns to (2,0)
  add(input, 0, RIGHT, 1); // block 0 finishes at (4,0)

  const auto out = makeSolver(p).optimizeSolution(input);

  expectNoRegression(p, input, out);
  EXPECT_EQ(out.size(), 5u); // one move (the return) dropped
  EXPECT_LT(out.size(), input.size());
}

TEST(Optimizer, MergesSplitSlidesIntoASingleDrag) {
  using enum Direction;
  // Block 0 slides, block 1 dodges, block 0 slides again the same way. The two
  // block-0 slides can be done as one drag once block 1 dodges first.
  const Puzzle p = blockedPathPuzzle();
  std::vector<Turn> input;
  add(input, 0, RIGHT, 1);
  add(input, 1, DOWN, 1);
  add(input, 0, RIGHT, 3);

  EXPECT_EQ(countSteps(input), 3u);

  const auto out = makeSolver(p).optimizeSolution(input);

  expectNoRegression(p, input, out);
  EXPECT_EQ(out.size(), 5u);      // same move count
  EXPECT_EQ(countSteps(out), 2u); // but one fewer player drag
}

TEST(Optimizer, LeavesAnOptimalSolutionUnchanged) {
  const Puzzle p{.gridWidth = 6,
                 .gridHeight = 3,
                 .shapes = {{{.x = 0, .y = 0}}},
                 .initialAnchors = {{.x = 0, .y = 0}},
                 .goalIndex = 0,
                 .goalAnchor = {.x = 3, .y = 0}};
  std::vector<Turn> input;
  add(input, 0, Direction::RIGHT, 3);

  const auto out = makeSolver(p).optimizeSolution(input);

  expectNoRegression(p, input, out);
  EXPECT_EQ(out.size(), 3u);
}

TEST(Optimizer, CrushesAHeavilyBloatedSolution) {
  using enum Direction;
  // Goal block at (0,1) → (3,1); padded with two cancelling detours.
  const Puzzle p{.gridWidth = 6,
                 .gridHeight = 4,
                 .shapes = {{{.x = 0, .y = 0}}, {{.x = 0, .y = 0}}},
                 .initialAnchors = {{.x = 0, .y = 1}, {.x = 0, .y = 3}},
                 .goalIndex = 0,
                 .goalAnchor = {.x = 3, .y = 1}};
  std::vector<Turn> input;
  add(input, 0, RIGHT, 2);
  add(input, 1, UP, 1);
  add(input, 1, DOWN, 1);
  add(input, 0, UP, 1);
  add(input, 0, DOWN, 1);
  add(input, 0, RIGHT, 1);

  ASSERT_TRUE(replayValid(p, input)); // the crafted input really is a solution

  const auto out = makeSolver(p).optimizeSolution(input);

  expectNoRegression(p, input, out);
  EXPECT_EQ(out.size(), 3u);
  EXPECT_EQ(countSteps(out), 1u);
}

TEST(Optimizer, HandlesAnEmptySolution) {
  // Goal block already on its target — the solver returns no turns.
  const Puzzle p{.gridWidth = 4,
                 .gridHeight = 4,
                 .shapes = {{{.x = 0, .y = 0}}},
                 .initialAnchors = {{.x = 2, .y = 2}},
                 .goalIndex = 0,
                 .goalAnchor = {.x = 2, .y = 2}};
  const auto out = makeSolver(p).optimizeSolution({});
  EXPECT_TRUE(out.empty());
}

} // namespace
