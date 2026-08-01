#ifdef __clang__
#include <yvals_core.h>
#undef __cpp_lib_is_pointer_interconvertible
#endif
#include "FixtureIo.h"
#include "Replay.h"
#include "Rules.h"
#include "SolverArms.h"
#include <gtest/gtest.h>

#include <filesystem>
#include <functional>
#include <nlohmann/json.hpp>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

// The captured-board corpus, swept through the production cascade. Discovered
// by listing rather than enumerated — the match-three convention, so dropping a
// captured fixture in makes it run with no code change here.
namespace {

using namespace mt;

/// Wall-clock budget per fixture. Generous enough for the slowest board that
/// finishes, short enough that the whole sweep stays inside the ctest timeout.
constexpr uint32_t kBudgetMs = 30000;

/// The boards the cheap arms cannot crack, where the answer comes from a
/// STOCHASTIC arm and so cannot be pinned. They still have to come back
/// playable if they come back at all, and they must never be called unsolvable.
bool stochastic(const std::string_view name) {
  return name == "matchThreeTest47.json" || name == "matchThreeTest50.json" ||
         name == "matchThreeTest51.json";
}

// Transparent hashing on the fixture names: a lookup by string_view needs no
// std::string temporary, and it is what Sonar asks of a string-keyed
// container. Same shape as the rolling-blocks optimizer's.
struct StringHash {
  // Read by the container, not by this TU — hence [[maybe_unused]].
  using is_transparent [[maybe_unused]] = void;
  [[nodiscard]] size_t operator()(const std::string_view key) const noexcept {
    return std::hash<std::string_view>{}(key);
  }
};

using CeilingMap =
    std::unordered_map<std::string, size_t, StringHash, std::equal_to<>>;

/// Length CEILINGS, shared with the TypeScript sweep in
/// test/match-three-solver/engine.solve.slow.test.ts.
///
/// These used to be exact proven minima, and the equality was the cross-engine
/// check. The search no longer proves anything about length — it returns the
/// first solution it finds — so the numbers are an upper bound instead: a
/// quality net that catches an arm-ordering regression which starts returning
/// fifteen-move answers where seven exist. Every value is the measured optimum
/// (which the first find still matches on all but one board) with the one
/// exception noted at its entry. A fixture with no entry skips the check.
const CeilingMap &lengthCeilings() {
  static const CeilingMap lengths{
      {"matchThreeTest.json", 1},   {"matchThreeTest1.json", 2},
      {"matchThreeTest2.json", 2},  {"matchThreeTest3.json", 2},
      {"matchThreeTest4.json", 1},  {"matchThreeTest5.json", 2},
      {"matchThreeTest6.json", 2},  {"matchThreeTest7.json", 1},
      {"matchThreeTest8.json", 7},  {"matchThreeTest9.json", 5},
      {"matchThreeTest10.json", 6}, {"matchThreeTest11.json", 7},
      {"matchThreeTest12.json", 6}, {"matchThreeTest13.json", 10},
      {"matchThreeTest14.json", 7}, {"matchThreeTest15.json", 3},
      {"matchThreeTest16.json", 2}, {"matchThreeTest17.json", 4},
      {"matchThreeTest18.json", 6}, {"matchThreeTest19.json", 4},
      {"matchThreeTest20.json", 7}, {"matchThreeTest21.json", 3},
      {"matchThreeTest22.json", 1}, {"matchThreeTest23.json", 2},
      {"matchThreeTest24.json", 3}, {"matchThreeTest25.json", 4},
      {"matchThreeTest26.json", 4}, {"matchThreeTest27.json", 6},
      {"matchThreeTest28.json", 5}, {"matchThreeTest29.json", 2},
      {"matchThreeTest30.json", 3}, {"matchThreeTest31.json", 6},
      {"matchThreeTest32.json", 5}, {"matchThreeTest33.json", 4},
      {"matchThreeTest34.json", 3}, {"matchThreeTest35.json", 8},
      {"matchThreeTest36.json", 4}, {"matchThreeTest37.json", 5},
      {"matchThreeTest38.json", 4}, {"matchThreeTest39.json", 6},
      {"matchThreeTest40.json", 3}, {"matchThreeTest41.json", 10},
      {"matchThreeTest42.json", 6}, {"matchThreeTest43.json", 8},
      {"matchThreeTest44.json", 14}, {"matchThreeTest45.json", 7},
      // The one board where the first find is not the optimum: 8, optimum 7.
      {"matchThreeTest46.json", 8}, {"matchThreeTest48.json", 7},
      {"matchThreeTest49.json", 10}};
  return lengths;
}

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

class MatchThreeFixtureTest : public testing::TestWithParam<std::string> {};

TEST(MatchThreeCorpus, TheCorpusIsThere) {
  // Guards the listing itself: an empty directory would otherwise make every
  // parameterised case below vanish and the suite pass having tested nothing.
  EXPECT_FALSE(allTestFiles().empty());
}

TEST_P(MatchThreeFixtureTest, IsSolvedAndReplayValid) {
  const std::string &name = GetParam();
  const std::string path = std::string(TEST_RESOURCES_DIR) + "/" + name;

  Board board;
  std::string parseError;
  try {
    board = fixtureio::load(path);
  } catch (const fixtureio::FixtureError &error) {
    // A missing file is a checkout problem, not a solver failure.
    GTEST_SKIP() << error.what();
  } catch (const nlohmann::json::exception &error) {
    // A malformed one is a broken fixture: skipping it would let it silently
    // stop testing anything.
    parseError = error.what();
  }
  ASSERT_TRUE(parseError.empty()) << parseError;

  // Every captured board is a legal game state — that half of the corpus's
  // assertion covers all of them, cheaply.
  ASSERT_EQ(rules::boardProblem(board), rules::BoardProblem::None)
      << rules::describe(rules::boardProblem(board));

  constexpr Config cfg{.maxMs = kBudgetMs};
  constexpr arms::ArmSpec spec{.engine = "cascade"};
  const Outcome outcome = arms::solve(board, spec, cfg);

  // Never "unsolvable" on a captured board: they come from the game.
  EXPECT_FALSE(outcome.unsolvable);

  if (stochastic(name)) {
    // Whatever came back must still be honest and playable.
    if (!outcome.moves.empty()) {
      const replay::Verdict verdict = replay::replayMoves(board, outcome.moves);
      EXPECT_TRUE(verdict.clearedAtEnd);
    }
    return;
  }

  ASSERT_FALSE(outcome.moves.empty()) << "No solution found for " << name;
  if (const auto ceiling = lengthCeilings().find(name);
      ceiling != lengthCeilings().end())
    EXPECT_LE(outcome.moves.size(), ceiling->second);

  // The move list is only an answer if it survives being replayed by the
  // oracle, which shares no code with the search that produced it.
  const replay::Verdict verdict = replay::replayMoves(board, outcome.moves);
  EXPECT_TRUE(verdict.legal);
  EXPECT_TRUE(verdict.clearedAtEnd);
}

INSTANTIATE_TEST_SUITE_P(
    MatchThree, MatchThreeFixtureTest, testing::ValuesIn(allTestFiles()),
    [](const testing::TestParamInfo<std::string> &info) {
      std::string name = info.param;
      name.erase(name.find(".json"));
      return name;
    });

} // namespace
