#include "AStar.h"
#include "Types.h"

#include <gtest/gtest.h>

#include <cstdint>
#include <vector>

// ---------------------------------------------------------------------------
// Unit tests for AStar::optimizeSolution — the solution post-processor.
//
// Each test hand-builds a tiny puzzle and a deliberately suboptimal (but
// valid) solution, then checks that optimizeSolution shortens it without ever
// producing an invalid or longer result.
// ---------------------------------------------------------------------------

namespace {

constexpr int DX[4] = {0, 1, 0, -1};
constexpr int DY[4] = {-1, 0, 1, 0};

struct Puzzle {
  uint8_t gridWidth;
  uint8_t gridHeight;
  std::vector<std::vector<Position>> shapes;
  std::vector<Position> initialAnchors;
  uint8_t goalIndex;
  Position goalAnchor;
};

AStar makeSolver(const Puzzle &p) {
  return AStar(p.gridWidth, p.gridHeight, p.shapes, p.initialAnchors,
               p.goalIndex, p.goalAnchor);
}

// Independent replay validator (does not share code with AStar): every block
// stays in bounds, no two blocks ever overlap, goal block lands on goalAnchor.
bool collisionFree(const Puzzle &p, const std::vector<Position> &anchors) {
  std::vector<int> occ(static_cast<size_t>(p.gridWidth) * p.gridHeight, -1);
  for (size_t i = 0; i < anchors.size(); i++) {
    for (const auto &c : p.shapes[i]) {
      const int cx = anchors[i].x + c.x;
      const int cy = anchors[i].y + c.y;
      if (cx < 0 || cy < 0 || cx >= p.gridWidth || cy >= p.gridHeight)
        return false;
      const int idx = cx * p.gridHeight + cy;
      if (occ[idx] != -1) return false;
      occ[idx] = static_cast<int>(i);
    }
  }
  return true;
}

bool replayValid(const Puzzle &p, const std::vector<Turn> &turns) {
  std::vector<Position> anchors = p.initialAnchors;
  if (!collisionFree(p, anchors)) return false;
  for (const auto &t : turns) {
    if (t.blockId >= anchors.size()) return false;
    const int d = static_cast<int>(t.direction);
    anchors[t.blockId].x = static_cast<int8_t>(anchors[t.blockId].x + DX[d]);
    anchors[t.blockId].y = static_cast<int8_t>(anchors[t.blockId].y + DY[d]);
    if (!collisionFree(p, anchors)) return false;
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

void add(std::vector<Turn> &turns, uint8_t block, Direction dir, int count) {
  for (int i = 0; i < count; i++) turns.push_back({block, dir});
}

// Two single-cell blocks. Block 0 is the goal block at (0,0) → (3,0); block 1
// sits out of the way at (0,2). Grid 6x3.
Puzzle clearPathPuzzle() {
  return {6, 3, {{{0, 0}}, {{0, 0}}}, {{0, 0}, {0, 2}}, 0, {3, 0}};
}

// Two single-cell blocks on the same row: block 1 sits in block 0's path at
// (2,0), so it must be nudged aside. Block 0 goes (0,0) → (4,0). Grid 6x3.
Puzzle blockedPathPuzzle() {
  return {6, 3, {{{0, 0}}, {{0, 0}}}, {{0, 0}, {2, 0}}, 0, {4, 0}};
}

// Asserts an optimized solution is valid and never regressed on either metric.
void expectNoRegression(const Puzzle &p, const std::vector<Turn> &before,
                        const std::vector<Turn> &after) {
  EXPECT_TRUE(replayValid(p, after)) << "optimized solution is not valid";
  EXPECT_LE(after.size(), before.size()) << "move count increased";
  EXPECT_LE(countSteps(after), countSteps(before)) << "step count increased";
}

} // namespace

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
  const Puzzle p = clearPathPuzzle();
  std::vector<Turn> input;
  add(input, 1, Direction::RIGHT, 2); // block 1 wanders out...
  add(input, 1, Direction::LEFT, 2);  // ...and straight back — pure noise
  add(input, 0, Direction::RIGHT, 3);

  const auto out = makeSolver(p).optimizeSolution(input);

  expectNoRegression(p, input, out);
  EXPECT_EQ(out.size(), 3u);
  for (const auto &t : out) {
    EXPECT_EQ(t.blockId, 0);
    EXPECT_EQ(t.direction, Direction::RIGHT);
  }
}

TEST(Optimizer, CancelsPerpendicularOutAndBack) {
  // Single goal block at (0,1) → (3,1); a stray up/down detour mid-route.
  const Puzzle p{6, 3, {{{0, 0}}}, {{0, 1}}, 0, {3, 1}};
  std::vector<Turn> input;
  add(input, 0, Direction::RIGHT, 2);
  add(input, 0, Direction::UP, 1);
  add(input, 0, Direction::DOWN, 1);
  add(input, 0, Direction::RIGHT, 1);

  const auto out = makeSolver(p).optimizeSolution(input);

  expectNoRegression(p, input, out);
  EXPECT_EQ(out.size(), 3u);
}

TEST(Optimizer, KeepsNecessaryDodgeButDropsTheReturn) {
  // Block 1 must dodge down so block 0 can slide past — that dodge has to
  // stay. The dodge's *return* move, however, is unnecessary.
  const Puzzle p = blockedPathPuzzle();
  std::vector<Turn> input;
  add(input, 1, Direction::DOWN, 1);   // necessary: clears (2,0)
  add(input, 0, Direction::RIGHT, 3);  // block 0 slides to (3,0)
  add(input, 1, Direction::UP, 1);     // unnecessary: returns to (2,0)
  add(input, 0, Direction::RIGHT, 1);  // block 0 finishes at (4,0)

  const auto out = makeSolver(p).optimizeSolution(input);

  expectNoRegression(p, input, out);
  EXPECT_EQ(out.size(), 5u); // one move (the return) dropped
  EXPECT_LT(out.size(), input.size());
}

TEST(Optimizer, MergesSplitSlidesIntoASingleDrag) {
  // Block 0 slides, block 1 dodges, block 0 slides again the same way. The two
  // block-0 slides can be done as one drag once block 1 dodges first.
  const Puzzle p = blockedPathPuzzle();
  std::vector<Turn> input;
  add(input, 0, Direction::RIGHT, 1);
  add(input, 1, Direction::DOWN, 1);
  add(input, 0, Direction::RIGHT, 3);

  EXPECT_EQ(countSteps(input), 3u);

  const auto out = makeSolver(p).optimizeSolution(input);

  expectNoRegression(p, input, out);
  EXPECT_EQ(out.size(), 5u);          // same move count
  EXPECT_EQ(countSteps(out), 2u);     // but one fewer player drag
}

TEST(Optimizer, LeavesAnOptimalSolutionUnchanged) {
  const Puzzle p{6, 3, {{{0, 0}}}, {{0, 0}}, 0, {3, 0}};
  std::vector<Turn> input;
  add(input, 0, Direction::RIGHT, 3);

  const auto out = makeSolver(p).optimizeSolution(input);

  expectNoRegression(p, input, out);
  EXPECT_EQ(out.size(), 3u);
}

TEST(Optimizer, CrushesAHeavilyBloatedSolution) {
  // Goal block at (0,1) → (3,1); padded with two cancelling detours.
  const Puzzle p{6, 4, {{{0, 0}}, {{0, 0}}}, {{0, 1}, {0, 3}}, 0, {3, 1}};
  std::vector<Turn> input;
  add(input, 0, Direction::RIGHT, 2);
  add(input, 1, Direction::UP, 1);
  add(input, 1, Direction::DOWN, 1);
  add(input, 0, Direction::UP, 1);
  add(input, 0, Direction::DOWN, 1);
  add(input, 0, Direction::RIGHT, 1);

  ASSERT_TRUE(replayValid(p, input)); // the crafted input really is a solution

  const auto out = makeSolver(p).optimizeSolution(input);

  expectNoRegression(p, input, out);
  EXPECT_EQ(out.size(), 3u);
  EXPECT_EQ(countSteps(out), 1u);
}

TEST(Optimizer, HandlesAnEmptySolution) {
  // Goal block already on its target — the solver returns no turns.
  const Puzzle p{4, 4, {{{0, 0}}}, {{2, 2}}, 0, {2, 2}};
  const auto out = makeSolver(p).optimizeSolution({});
  EXPECT_TRUE(out.empty());
}
