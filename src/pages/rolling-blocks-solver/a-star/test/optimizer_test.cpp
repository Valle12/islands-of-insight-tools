// Tests for the replay-validated solution optimizer.

#ifdef __clang__
#include <yvals_core.h>
#undef __cpp_lib_is_pointer_interconvertible
#endif
#include "AStarOptimizer.h"
#include "FixtureIo.h"
#include "Replay.h"
#include "Types.h"
#include <gtest/gtest.h>

#include <filesystem>
#include <nlohmann/json.hpp>
#include <string>
#include <vector>

namespace {

replay::Puzzle corridorPuzzle() {
  // 5x1 corridor, a unit cube at (0,0), the goal at (2,0).
  replay::Puzzle puzzle;
  puzzle.gridWidth = 5;
  puzzle.gridHeight = 1;
  puzzle.cells.assign(5, Tile::Regular);
  puzzle.cells[2] = Tile::Goal;
  puzzle.blocks = {{1, 0, 0, 1, 1, 1}};
  return puzzle;
}

replay::Puzzle openBoardPuzzle() {
  // 5x5 open board, a unit cube at (0,0), the goal at (4,0).
  replay::Puzzle puzzle;
  puzzle.gridWidth = 5;
  puzzle.gridHeight = 5;
  puzzle.cells.assign(25, Tile::Regular);
  puzzle.cells[4] = Tile::Goal;
  puzzle.blocks = {{1, 0, 0, 1, 1, 1}};
  return puzzle;
}

void expectValid(const replay::Puzzle &puzzle,
                 const std::vector<Turn> &turns) {
  const replay::Outcome outcome = replay::replayTurns(puzzle, turns);
  EXPECT_TRUE(outcome.legal);
  EXPECT_TRUE(outcome.solvedAtEnd);
}

} // namespace

TEST(Optimizer, TruncatesPastTheSolvingPrefix) {
  const auto puzzle = corridorPuzzle();
  using enum Direction;
  // Solves after two rolls, then wanders on and comes back.
  const std::vector<Turn> turns = {
      {.blockId = 1, .direction = RIGHT},
      {.blockId = 1, .direction = RIGHT},
      {.blockId = 1, .direction = RIGHT},
      {.blockId = 1, .direction = LEFT}};
  const auto optimized = optimizer::optimize(puzzle, turns, 5000);
  EXPECT_EQ(optimized.size(), 2u);
  expectValid(puzzle, optimized);
}

TEST(Optimizer, CutsOutAndBackLoops) {
  const auto puzzle = openBoardPuzzle();
  using enum Direction;
  const std::vector<Turn> turns = {{.blockId = 1, .direction = DOWN},
                                   {.blockId = 1, .direction = UP},
                                   {.blockId = 1, .direction = RIGHT},
                                   {.blockId = 1, .direction = RIGHT},
                                   {.blockId = 1, .direction = RIGHT},
                                   {.blockId = 1, .direction = RIGHT}};
  const auto optimized = optimizer::optimize(puzzle, turns, 5000);
  EXPECT_EQ(optimized.size(), 4u);
  expectValid(puzzle, optimized);
}

TEST(Optimizer, WindowReSolveStraightensADetour) {
  const auto puzzle = openBoardPuzzle();
  using enum Direction;
  // A 6-move staircase detour to (4,0); the direct route is 4 rolls. No move
  // is individually removable and no state repeats, so only the windowed
  // exact re-solve can shorten it.
  const std::vector<Turn> turns = {{.blockId = 1, .direction = DOWN},
                                   {.blockId = 1, .direction = RIGHT},
                                   {.blockId = 1, .direction = RIGHT},
                                   {.blockId = 1, .direction = RIGHT},
                                   {.blockId = 1, .direction = RIGHT},
                                   {.blockId = 1, .direction = UP}};
  const auto optimized = optimizer::optimize(puzzle, turns, 5000);
  EXPECT_EQ(optimized.size(), 4u);
  expectValid(puzzle, optimized);
}

TEST(Optimizer, LeavesAnInvalidSolutionUntouched) {
  const auto puzzle = corridorPuzzle();
  using enum Direction;
  // Rolls off the board.
  const std::vector<Turn> turns = {{.blockId = 1, .direction = LEFT}};
  const auto optimized = optimizer::optimize(puzzle, turns, 5000);
  EXPECT_EQ(optimized, turns);
}

TEST(Optimizer, NeverLengthensRecordedFixtureSolutions) {
  for (const auto *name :
       {"rollingBlocksTest9.json", "rollingBlocksTest12.json",
        "rollingBlocksTest25.json"}) {
    std::vector<Turn> turns;
    replay::Puzzle puzzle;
    // Both of load()'s failure modes are caught by name: FixtureError for a
    // fixture that is not there, nlohmann's for one that will not parse.
    // Either way the test skips rather than fails — a missing fixture is a
    // checkout problem, not an optimizer regression.
    std::string loadError;
    try {
      puzzle = fixtureio::load(
          (std::filesystem::path(TEST_RESOURCES_DIR) / name).string(),
          &turns);
    } catch (const fixtureio::FixtureError &e) {
      loadError = e.what();
    } catch (const nlohmann::json::exception &e) {
      loadError = e.what();
    }
    if (!loadError.empty()) {
      GTEST_SKIP() << "Cannot load " << name << ": " << loadError;
    }
    if (turns.empty()) {
      GTEST_SKIP() << name << " carries no recorded turns";
    }
    const auto optimized = optimizer::optimize(puzzle, turns, 10000);
    EXPECT_LE(optimized.size(), turns.size()) << name;
    expectValid(puzzle, optimized);
  }
}
