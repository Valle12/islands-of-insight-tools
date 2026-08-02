#include "TestBoards.h"

#include "FixtureIo.h"
#include "Puzzle.h"
#include "Search.h"
#include "SolverArms.h"
#include "Verify.h"

#include <algorithm>
#include <filesystem>
#include <gtest/gtest.h>
#include <nlohmann/json.hpp>
#include <string>
#include <utility>
#include <vector>

// The captured corpus. Boards are discovered by listing the directory, so
// dropping a fixture in makes it run with no code change here.
namespace {

using namespace lg;

/**
 * Enough for every board that comes out at all, and not much more.
 *
 * The slowest captured board that answers needs about eight seconds
 * (`logicGridTest47`, four letter pairs on an 8x8 with no rules, so the search
 * has to guess most of it); everything else is milliseconds. The one board that
 * never answers would otherwise sit here burning whatever it is given.
 */
constexpr uint32_t kBudgetMs = 90000;

std::vector<std::string> allTestFiles() {
  std::vector<std::string> files;
  const std::filesystem::path dir{TEST_RESOURCES_DIR};
  if (!std::filesystem::is_directory(dir))
    return files;
  for (const auto &entry : std::filesystem::directory_iterator(dir)) {
    if (entry.path().extension() == ".json")
      files.push_back(entry.path().filename().string());
  }
  std::ranges::sort(files);
  return files;
}

/**
 * The corpus holds boards captured from the game and nothing else — anything
 * the tests invent lives in `reference_test.cpp` and `test/logic-grid-solver/
 * boards.ts`, so a made-up board cannot quietly pad this sweep.
 */
TEST(LogicGridCorpus, TheCorpusIsThere) {
  EXPECT_FALSE(allTestFiles().empty());
}

class LogicGridFixtureTest : public testing::TestWithParam<std::string> {};

TEST_P(LogicGridFixtureTest, SolvesAndVerifies) {
  const std::string &name = GetParam();
  const std::string path = std::string(TEST_RESOURCES_DIR) + "/" + name;

  fixtureio::Fixture fixture;
  std::string parseError;
  try {
    fixture = fixtureio::load(path);
  } catch (const fixtureio::FixtureError &error) {
    GTEST_SKIP() << error.what();
  } catch (const nlohmann::json::exception &error) {
    parseError = error.what();
  }
  ASSERT_TRUE(parseError.empty()) << parseError;
  ASSERT_EQ(structureProblem(fixture.puzzle), Problem::None)
      << describe(structureProblem(fixture.puzzle));

  const Model model = buildModel(fixture.puzzle);
  constexpr Config cfg{.maxMs = kBudgetMs};
  constexpr arms::ArmSpec spec{.engine = "cascade"};
  const Outcome outcome = arms::solve(model, spec, cfg);

  EXPECT_EQ(outcome.stats.oracleRejections, 0U);
  for (const Colors &witness : outcome.witnesses)
    EXPECT_EQ(verify::check(model, witness), verify::Violation::None);

  if (outcome.status == Status::Solved) {
    EXPECT_EQ(verify::check(model, outcome.colors), verify::Violation::None);
  }

  // The corpus is captured from a game that only ships solvable puzzles, so
  // "this board still comes out" is the sharpest thing to assert about it — and
  // the one nothing else here was checking. A plain board answers with a
  // complete colouring; an underclued one answers with the cells every solution
  // agrees on, which is a real answer only when it is PROVEN.
  //
  // There are no exceptions to this, and there should never be one. A captured
  // board that does not come out is either a mis-entry or a hole in the engine,
  // and both are worth a failing test rather than an entry on a list.
  const bool answered =
      outcome.status == Status::Solved ||
      (outcome.status == Status::Deduced && outcome.proven);
  // Through int, not straight to the underlying type: `Status` is a uint8_t,
  // and streaming one prints the CHARACTER with that code rather than a number.
  EXPECT_TRUE(answered)
      << "status " << static_cast<int>(std::to_underlying(outcome.status))
      << ", " << outcome.decided << " of " << model.playableCount
      << " cells decided";

  if (!fixture.hasSolution)
    return;

  // A generated board carries the colouring its clues were read off, which is
  // a solution by construction. Two things follow, and they are the sharpest
  // checks in the suite.
  EXPECT_EQ(verify::check(model, fixture.solution), verify::Violation::None)
      << "the fixture's own solution does not satisfy its clues";
  EXPECT_NE(outcome.status, Status::Unsolvable)
      << "a board with a witness was called unsolvable";

  if (outcome.status != Status::Deduced)
    return;
  for (int i = model.playable.nextSet(0); i >= 0;
       i = model.playable.nextSet(i + 1)) {
    if (outcome.colors[slot(i)] == kUnknown)
      continue;
    EXPECT_EQ(outcome.colors[slot(i)], fixture.solution[slot(i)])
        << "cell " << columnOf(i) << "," << rowOf(i)
        << " was reported forced against a known solution";
  }
}

INSTANTIATE_TEST_SUITE_P(
    LogicGrid, LogicGridFixtureTest, testing::ValuesIn(allTestFiles()),
    [](const testing::TestParamInfo<std::string> &info) {
      std::string name = info.param;
      name.erase(name.find(".json"));
      std::ranges::replace(name, '-', '_');
      return name;
    });

} // namespace
