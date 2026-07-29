// Tests for the portfolio arms: the coverage cracker, the exact (weight-0)
// arm, the beam, the classifier gate and the single-threaded cascade.

#ifdef __clang__
#include <yvals_core.h>
#undef __cpp_lib_is_pointer_interconvertible
#endif
#include "FixtureIo.h"
#include "PuzzleProfile.h"
#include "Replay.h"
#include "SolverArms.h"
#include <gtest/gtest.h>

#include <filesystem>
#include <string>
#include <vector>

namespace {

replay::Puzzle loadFixture(const std::string &name,
                           std::vector<Turn> *turns = nullptr) {
  return fixtureio::load(
      (std::filesystem::path(TEST_RESOURCES_DIR) / name).string(), turns);
}

void expectValid(const replay::Puzzle &puzzle,
                 const std::vector<Turn> &turns) {
  ASSERT_FALSE(turns.empty());
  const replay::Outcome outcome = replay::replayTurns(puzzle, turns);
  EXPECT_TRUE(outcome.legal);
  EXPECT_TRUE(outcome.solvedAtEnd);
}

} // namespace

TEST(PuzzleProfile, GatesTheEndgameClass) {
  // One- and two-block endgame boards are coverage-profile (two-block ones
  // route through the split scheme); plain goal boards are not.
  for (const auto *name :
       {"rollingBlocksTest34.json", "rollingBlocksTest35.json",
        "rollingBlocksTest37.json", "rollingBlocksTest38.json",
        "rollingBlocksTest39.json"}) {
    SCOPED_TRACE(name);
    const auto features = puzzleprofile::analyze(loadFixture(name));
    EXPECT_TRUE(puzzleprofile::coverageProfile(features));
  }
  const auto goalBoard =
      puzzleprofile::analyze(loadFixture("rollingBlocksTest3.json"));
  EXPECT_FALSE(puzzleprofile::coverageProfile(goalBoard));
}

TEST(Arms, CrackerCracksTheCapturedEndgameFixtures) {
  // 34 is the two-block board: it exercises the split scheme (the joint
  // walk was measured useless there), the single-block ones the plain
  // touch-greedy walk.
  for (const auto *name :
       {"rollingBlocksTest34.json", "rollingBlocksTest35.json",
        "rollingBlocksTest37.json", "rollingBlocksTest38.json",
        "rollingBlocksTest39.json"}) {
    SCOPED_TRACE(name);
    const auto puzzle = loadFixture(name);
    arms::ArmSpec spec;
    spec.engine = "cracker";
    AStar::Config cfg;
    cfg.maxMs = 30000;
    const auto outcome = arms::solve(puzzle, spec, cfg);
    expectValid(puzzle, outcome.turns);
    // The whole point of the arm: these boards fall in a fraction of the
    // budget weighted A* burns on them.
    EXPECT_LT(outcome.stats.nodesExpanded, 500000U);
  }
}

TEST(Arms, ExactArmMatchesRecordedOptimalLengths) {
  // Single-block goal fixtures whose recorded solutions are optimal; the
  // weight-0 arm must find equal-length plans.
  for (const auto *name :
       {"rollingBlocksTest.json", "rollingBlocksTest2.json"}) {
    SCOPED_TRACE(name);
    std::vector<Turn> recorded;
    const auto puzzle = loadFixture(name, &recorded);
    if (recorded.empty()) {
      GTEST_SKIP() << name << " carries no recorded turns";
    }
    arms::ArmSpec spec;
    spec.engine = "exact";
    AStar::Config cfg;
    cfg.maxMs = 30000;
    const auto outcome = arms::solve(puzzle, spec, cfg);
    expectValid(puzzle, outcome.turns);
    EXPECT_LE(outcome.turns.size(), recorded.size());
  }
}

TEST(Arms, GatedCrackerDeclinesOffProfile) {
  const auto puzzle = loadFixture("rollingBlocksTest3.json");
  arms::ArmSpec spec;
  spec.engine = "cracker";
  spec.gated = true;
  AStar::Config cfg;
  cfg.maxMs = 5000;
  const auto outcome = arms::solve(puzzle, spec, cfg);
  EXPECT_TRUE(outcome.turns.empty());
  EXPECT_EQ(outcome.stats.nodesExpanded, 0U);
}

TEST(Arms, BeamSolvesAMidSizeBoard) {
  const auto puzzle = loadFixture("rollingBlocksTest12.json");
  arms::ArmSpec spec;
  spec.engine = "beam";
  spec.beamWidth = 20000;
  AStar::Config cfg;
  cfg.maxMs = 30000;
  const auto outcome = arms::solve(puzzle, spec, cfg);
  expectValid(puzzle, outcome.turns);
}

TEST(Arms, CascadeSolvesAcrossPuzzleClasses) {
  // One goal board, one coverage board, one mixed board — the chain must
  // route each to some arm that solves it.
  for (const auto *name :
       {"rollingBlocksTest7.json", "rollingBlocksTest34.json",
        "rollingBlocksTest18.json"}) {
    SCOPED_TRACE(name);
    const auto puzzle = loadFixture(name);
    arms::ArmSpec spec; // engine defaults to cascade
    AStar::Config cfg;
    cfg.maxMs = 60000;
    const auto outcome = arms::solve(puzzle, spec, cfg);
    expectValid(puzzle, outcome.turns);
    EXPECT_NE(outcome.arm, "none");
  }
}
