#include "ClangdCompat.h" // must stay first; see the header

#include "BitGrid.h"
#include "DragSolver.h"
#include "DragSolverTestOracle.h"
#include "ParallelCascade.h"
#include "Types.h"

#include <gtest/gtest.h>

#include <cstdint>
#include <random>
#include <vector>

// BitGrid collision/flood-fill agreement, and the DragSolver invariants that
// must hold exactly: weight-1 optimality against the oracle, and each
// pruning filter (partial expansion, sleep sets, relevance, settled) being
// sound. The portfolio arms are exercised in dragsolver_search_test.cpp.

TEST(BitGrid, MatchesCollisionOracleOnRandomBoards) {
  std::mt19937 rng(testSeed(1234));
  for (int round = 0; round < 200; round++) {
    const Puzzle p = randomPuzzle(rng);
    BitGrid grid(p.w, p.h, p.shapes);
    grid.buildOccupancy(p.anchors);
    std::uniform_int_distribution bDist(0,
                                        static_cast<int>(p.shapes.size()) - 1);
    std::uniform_int_distribution cDist(-2, 7);
    for (int probe = 0; probe < 100; probe++) {
      const auto i = static_cast<uint8_t>(bDist(rng));
      const Position a = {.x = static_cast<int8_t>(cDist(rng)),
                          .y = static_cast<int8_t>(cDist(rng))};
      grid.removeBlock(i, p.anchors[i]);
      const bool got = grid.canPlace(i, a.x, a.y);
      grid.addBlock(i, p.anchors[i]);
      const bool want = oracleCanPlace(p, i, a, p.anchors);
      ASSERT_EQ(got, want) << "round " << round << " block "
                           << static_cast<int>(i) << " at ("
                           << static_cast<int>(a.x) << ","
                           << static_cast<int>(a.y) << ")";
    }
  }
}

TEST(BitGrid, FloodFillMatchesReferenceBfs) {
  std::mt19937 rng(testSeed(4321));
  for (int round = 0; round < 200; round++) {
    const Puzzle p = randomPuzzle(rng);
    BitGrid grid(p.w, p.h, p.shapes);
    for (size_t i = 0; i < p.shapes.size(); i++) {
      grid.buildOccupancy(p.anchors);
      grid.removeBlock(i, p.anchors[i]);
      const auto &reached = grid.floodFill(i, p.anchors[i]);
      const auto want = oracleFloodFill(p, i, p.anchors);
      ASSERT_EQ(reached.size(), want.size() - 1)
          << "round " << round << " block " << static_cast<int>(i);
      for (const uint16_t idx : reached) {
        auto it = want.find(idx);
        ASSERT_NE(it, want.end());
        ASSERT_EQ(grid.distTo(idx), it->second);
      }
    }
  }
}

TEST(DragSolver, Weight1MatchesExhaustiveDragOracle) {
  std::mt19937 rng(testSeed(99));
  int solvable = 0;
  for (int round = 0; round < 120; round++) {
    const Puzzle p = randomPuzzle(rng);
    const int want = oracleMinDrags(p);
    DragSolver::Config cfg;
    cfg.weight = 1;
    cfg.postProcess = false; // compare the raw plan
    auto solver = makeDragSolver(p, cfg);
    const auto turns = solver.search(10000, 0);
    if (want <= 0) {
      // Already solved (0) or unsolvable (-1): no turns either way.
      EXPECT_TRUE(turns.empty()) << "round " << round;
      continue;
    }
    solvable++;
    ASSERT_FALSE(turns.empty()) << "round " << round << " oracle=" << want;
    EXPECT_TRUE(replayValid(p, turns)) << "round " << round;
    // Admissible + consistent h at weight 1 ⇒ minimal drag count.
    EXPECT_EQ(countPlayerSteps(turns), static_cast<size_t>(want))
        << "round " << round;
  }
  // The generator must produce a healthy share of genuinely solvable puzzles.
  EXPECT_GT(solvable, 30);
}

TEST(DragSolver, PartialExpansionPreservesOptimality) {
  // PEA* with a brutal batch width of 2 must still return minimal drag
  // counts at weight 1 — children are emitted in f order and the parent is
  // requeued at the next child's f, so nothing is lost.
  std::mt19937 rng(
      testSeed(99)); // same instances as the full-expansion oracle test
  for (int round = 0; round < 120; round++) {
    const Puzzle p = randomPuzzle(rng);
    const int want = oracleMinDrags(p);
    DragSolver::Config cfg;
    cfg.weight = 1;
    cfg.postProcess = false;
    cfg.partialExpansionWidth = 2;
    auto solver = makeDragSolver(p, cfg);
    const auto turns = solver.search(10000, 0);
    if (want <= 0) {
      EXPECT_TRUE(turns.empty()) << "round " << round;
      continue;
    }
    ASSERT_FALSE(turns.empty()) << "round " << round << " oracle=" << want;
    EXPECT_TRUE(replayValid(p, turns)) << "round " << round;
    EXPECT_EQ(countPlayerSteps(turns), static_cast<size_t>(want))
        << "round " << round;
  }
}

TEST(DragSolver, SleepSetsPreserveOptimality) {
  // One-step commutativity pruning may only skip (i, j) drag orders whose
  // (j, i) twin exists move-for-move, so weight-1 must still return exactly
  // the oracle's optimal counts on every board.
  std::mt19937 rng(testSeed(99)); // same instances as the oracle tests
  for (int round = 0; round < 120; round++) {
    const Puzzle p = randomPuzzle(rng);
    const int want = oracleMinDrags(p);
    DragSolver::Config cfg;
    cfg.weight = 1;
    cfg.postProcess = false;
    cfg.sleepSets = true;
    auto solver = makeDragSolver(p, cfg);
    const auto turns = solver.search(10000, 0);
    if (want <= 0) {
      EXPECT_TRUE(turns.empty()) << "round " << round;
      continue;
    }
    ASSERT_FALSE(turns.empty()) << "round " << round << " oracle=" << want;
    EXPECT_TRUE(replayValid(p, turns)) << "round " << round;
    EXPECT_EQ(countPlayerSteps(turns), static_cast<size_t>(want))
        << "round " << round;
  }
}

TEST(DragSolver, RelevantOnlySoundAndMostlyComplete) {
  // The relevance filter is incomplete by design (like settledOnly): every
  // returned plan must replay-validate, and it must still solve a healthy
  // majority of oracle-solvable boards.
  std::mt19937 rng(testSeed(99)); // same instances as the oracle tests
  int solvable = 0;
  int solved = 0;
  for (int round = 0; round < 120; round++) {
    const Puzzle p = randomPuzzle(rng);
    const int want = oracleMinDrags(p);
    DragSolver::Config cfg;
    cfg.weight = 2;
    cfg.postProcess = false;
    cfg.relevantOnly = true;
    auto solver = makeDragSolver(p, cfg);
    const auto turns = solver.search(10000, 0);
    if (want <= 0)
      continue;
    solvable++;
    if (!turns.empty()) {
      solved++;
      EXPECT_TRUE(replayValid(p, turns)) << "round " << round;
    }
  }
  EXPECT_GT(solvable, 30);
  EXPECT_GE(solved * 4, solvable * 3) // at least 75%
      << "solved " << solved << " of " << solvable;
}

TEST(DragSolver, SettledFilterIsSoundAndSolvesMostBoards) {
  // The settled filter is knowingly INCOMPLETE (some boards need a floating
  // intermediate parking spot — the full-expansion portfolio arm covers
  // those). This asserts what it must guarantee: solutions it does find are
  // valid, and it solves the large majority of solvable boards.
  std::mt19937 rng(testSeed(7));
  int solvable = 0;
  int solved = 0;
  for (int round = 0; round < 80; round++) {
    const Puzzle p = randomPuzzle(rng);
    if (const int want = oracleMinDrags(p); want <= 0)
      continue;
    solvable++;
    DragSolver::Config cfg;
    cfg.weight = 2;
    cfg.postProcess = false;
    cfg.settledOnly = true;
    auto solver = makeDragSolver(p, cfg);
    const auto turns = solver.search(10000, 0);
    if (turns.empty())
      continue;
    solved++;
    EXPECT_TRUE(replayValid(p, turns)) << "round " << round;
  }
  EXPECT_GT(solvable, 20);
  EXPECT_GE(solved * 10, solvable * 8)
      << "settled filter solved only " << solved << "/" << solvable;
}
