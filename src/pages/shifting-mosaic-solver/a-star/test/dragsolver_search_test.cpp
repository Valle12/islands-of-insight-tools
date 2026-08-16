#include "ClangdCompat.h" // must stay first; see the header

#include "BitGrid.h"
#include "DragSolver.h"
#include "DragSolverTestOracle.h"
#include "ParallelCascade.h"

#include <gtest/gtest.h>

#include <cstdint>
#include <random>
#include <vector>

// The portfolio search arms: jam guide and jitter, jam restarts, the guided
// beam, the Luby restart sequence, jam round shaping, the parallel cascade
// and the hierarchical driver. Each is incomplete by design, so these assert
// validity and a success RATE rather than exactness — the exactness tests
// live in dragsolver_unit_test.cpp.

TEST(DragSolver, JamGuideAndJitterStayValidAndComplete) {
  // The jam guide adds an inadmissible ordering term to f and the tie seed
  // reshuffles equal-f plateaus — neither may cost completeness or validity:
  // every oracle-solvable board must still solve, every plan must replay.
  SeededRng rng(testSeed(99)); // same instances as the oracle tests
  int solvable = 0;
  for (int round = 0; round < 120; round++) {
    const Puzzle p = randomPuzzle(rng);
    const int want = oracleMinDrags(p);
    DragSolver::Config cfg;
    cfg.weight = 2;
    cfg.postProcess = false;
    cfg.jam.guideWeight = 8;
    cfg.tieBreakSeed = 1000 + round;
    auto solver = makeDragSolver(p, cfg);
    const auto turns = solver.search(10000, 0);
    if (want <= 0) {
      EXPECT_TRUE(turns.empty()) << "round " << round;
      continue;
    }
    solvable++;
    ASSERT_FALSE(turns.empty()) << "round " << round << " oracle=" << want;
    EXPECT_TRUE(replayValid(p, turns)) << "round " << round;
  }
  EXPECT_GT(solvable, 30);
}

TEST(DragSolver, JamRestartsAndBeamStayValid) {
  // Both jam-portfolio drivers are incomplete by design; what they must
  // guarantee is that any returned plan replays, and that between them they
  // solve a healthy majority of solvable boards within a generous budget.
  SeededRng rng(testSeed(99)); // same instances as the oracle tests
  int solvable = 0;
  int solved = 0;
  for (int round = 0; round < 60; round++) {
    const Puzzle p = randomPuzzle(rng);
    if (const int want = oracleMinDrags(p); want <= 0)
      continue;
    solvable++;
    DragSolver::Config cfg;
    cfg.postProcess = false;
    cfg.jam.beamWidth = 4096;
    auto restarts = makeDragSolver(p, cfg);
    auto turnsR = restarts.searchJamRestarts(5000, 0);
    auto beam = makeDragSolver(p, cfg);
    auto turnsB = beam.searchBeamJam(5000, 0);
    if (!turnsR.empty())
      EXPECT_TRUE(replayValid(p, turnsR)) << "restarts round " << round;
    if (!turnsB.empty())
      EXPECT_TRUE(replayValid(p, turnsB)) << "beam round " << round;
    if (!turnsR.empty() || !turnsB.empty())
      solved++;
  }
  EXPECT_GT(solvable, 15);
  EXPECT_GE(solved * 10, solvable * 9)
      << "jam drivers solved only " << solved << "/" << solvable;
}

TEST(DragSolver, LubyUnitMatchesTheClassicSequence) {
  // 1,1,2,1,1,2,4,1,1,2,1,1,2,4,8,... — a fixed small round cap starves the
  // boards needing one deep round, so the restart driver rides this instead.
  const std::vector<uint64_t> want = {1, 1, 2, 1, 1, 2, 4, 1,
                                      1, 2, 1, 1, 2, 4, 8};
  for (size_t i = 0; i < want.size(); i++)
    EXPECT_EQ(DragSolver::lubyUnit(static_cast<uint32_t>(i + 1)), want[i])
        << "luby index " << i + 1;
  // Powers of two appear exactly at i = 2^k - 1.
  EXPECT_EQ(DragSolver::lubyUnit(31), 16u);
  EXPECT_EQ(DragSolver::lubyUnit(63), 32u);
}

TEST(DragSolver, JamRoundShapingStaysValidAndDefaultsUnchanged) {
  // jamRoundNodeCap trades depth-per-round for MORE restart rounds and
  // jamMaxElites widens the retained pool. Both only reshape the restart
  // driver's lottery, so plans must stay replay-valid and the defaults must
  // stay bit-identical to the unshaped driver.
  SeededRng rng(testSeed(99));
  int solvable = 0;
  int solved = 0;
  for (int round = 0; round < 40; round++) {
    const Puzzle p = randomPuzzle(rng);
    if (oracleMinDrags(p) <= 0)
      continue;
    solvable++;

    DragSolver::Config shaped;
    shaped.postProcess = false;
    shaped.jam.roundNodeCap = 20000;
    shaped.jam.maxElites = 32;
    auto driver = makeDragSolver(p, shaped);
    if (const auto turns = driver.searchJamRestarts(5000, 0); !turns.empty()) {
      EXPECT_TRUE(replayValid(p, turns)) << "shaped round " << round;
      solved++;
    }

    // Defaults (cap 0 = per-round default, 6 elites) must not change search.
    // Bounded by NODES ONLY (maxMs = 0): searchJamRestarts loops restart rounds
    // until its budget expires, so a wall-clock budget makes the round count —
    // and therefore nodesExpanded — a function of machine speed. Asserting
    // bit-identical output under a 2000ms cap was flaky on a loaded CI box and
    // vacuous on a fast one.
    DragSolver::Config base;
    base.postProcess = false;
    auto a = makeDragSolver(p, base);
    const auto ta = a.searchJamRestarts(0, 200000);
    DragSolver::Config explicitDefaults = base;
    explicitDefaults.jam.roundNodeCap = 0;
    explicitDefaults.jam.maxElites = 6;
    auto b = makeDragSolver(p, explicitDefaults);
    const auto tb = b.searchJamRestarts(0, 200000);
    EXPECT_EQ(a.lastStats().nodesExpanded, b.lastStats().nodesExpanded)
        << "zero-touch round " << round;
    EXPECT_EQ(ta, tb) << "zero-touch plan round " << round;
  }
  EXPECT_GT(solvable, 10);
  EXPECT_GE(solved * 2, solvable)
      << "shaped driver solved only " << solved << "/" << solvable;
}

TEST(ParallelCascade, RacesArmsAndReturnsValidPlans) {
  SeededRng rng(testSeed(2024));
  int solvable = 0;
  for (int round = 0; round < 15; round++) {
    const Puzzle p = randomPuzzle(rng);
    const int want = oracleMinDrags(p);
    const cascade::Board board{.gridWidth = p.w,
                               .gridHeight = p.h,
                               .shapes = p.shapes,
                               .initialAnchors = p.anchors,
                               .goalIndex = p.goalIndex,
                               .goalAnchor = p.goalAnchor};
    const auto turns = solveArmsParallel(
        board, {.maxMs = 10000, .maxNodes = 0, .postProcess = false}, nullptr);
    if (want <= 0) {
      EXPECT_TRUE(turns.empty()) << "round " << round;
      continue;
    }
    solvable++;
    ASSERT_FALSE(turns.empty()) << "round " << round;
    EXPECT_TRUE(replayValid(p, turns)) << "round " << round;
  }
  EXPECT_GT(solvable, 4);
}

TEST(DragSolver, HierarchicalSolvesSolvableBoards) {
  SeededRng rng(testSeed(55));
  for (int round = 0; round < 80; round++) {
    const Puzzle p = randomPuzzle(rng);
    if (const int want = oracleMinDrags(p); want <= 0)
      continue;
    DragSolver::Config cfg;
    cfg.weight = 2;
    cfg.postProcess = false;
    auto solver = makeDragSolver(p, cfg);
    const auto turns = solver.searchHierarchical(10000, 0);
    ASSERT_FALSE(turns.empty()) << "round " << round;
    EXPECT_TRUE(replayValid(p, turns)) << "round " << round;
  }
}
