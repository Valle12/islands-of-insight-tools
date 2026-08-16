// ClangdCompat.h first: the clang+MSVC-STL workaround it carries has to
// precede any standard-library header.
#include "ClangdCompat.h"
#include "AStar.h"
#include "FixtureIo.h"
#include "Node.h"
#include "Replay.h"
#include <gtest/gtest.h>

#include <filesystem>
#include <format>
#include <nlohmann/json.hpp>
#include <string>
#include <vector>

namespace {

// Fixture loading and the replay validity oracle live in FixtureIo/Replay,
// shared with the native CLI and the wasm bindings' post-processing.

class RollingBlocksSearchTest : public testing::TestWithParam<std::string> {};

std::vector<std::string> allTestFiles() {
  std::vector<std::string> files;
  files.emplace_back("rollingBlocksTest.json");
  for (int i = 1; i <= 48; i++) {
    files.push_back(std::format("rollingBlocksTest{}.json", i));
  }
  return files;
}

INSTANTIATE_TEST_SUITE_P(RollingBlocks, RollingBlocksSearchTest,
                         ::testing::ValuesIn(allTestFiles()),
                         [](const auto &info) {
                           std::string name = info.param;
                           // Remove .json extension for test name
                           if (name.size() > 5)
                             name = name.substr(0, name.size() - 5);
                           return name;
                         });

TEST_P(RollingBlocksSearchTest, ShouldFindValidSolution) {
  const auto &filename = GetParam();
  replay::Puzzle puzzle;
  // Two failure modes, two verdicts. A fixture that is not THERE is a
  // checkout problem, not a solver regression, so it skips. One that will
  // not PARSE is a broken checked-in file: that fails, because skipping it
  // would let a malformed fixture silently stop testing anything.
  std::string readError;
  std::string parseError;
  try {
    puzzle = fixtureio::load(
        (std::filesystem::path(TEST_RESOURCES_DIR) / filename).string());
  } catch (const fixtureio::FixtureError &e) {
    readError = e.what();
  } catch (const nlohmann::json::exception &e) {
    parseError = e.what();
  }
  ASSERT_TRUE(parseError.empty())
      << "Malformed fixture " << filename << ": " << parseError;
  if (!readError.empty()) {
    GTEST_SKIP() << "Cannot read " << filename << ": " << readError;
  }

  AStar solver(puzzle.gridWidth, puzzle.gridHeight, puzzle.cells);
  Node const root(puzzle.blocks);
  const auto turns = solver.search(root);

  ASSERT_FALSE(turns.empty()) << "No solution found for " << filename;
  const replay::Outcome outcome = replay::replayTurns(puzzle, turns);
  EXPECT_TRUE(outcome.legal) << "Illegal move in solution for " << filename;
  EXPECT_TRUE(outcome.solvedAtEnd)
      << "Solution does not solve " << filename;
}

} // namespace
