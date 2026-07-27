#include "BitGrid.h"
#include "DragSolver.h"
#include "ParallelCascade.h"
#include "Types.h"

#include <gtest/gtest.h>

#include <cstdint>
#include <map>
#include <queue>
#include <random>
#include <vector>

// ---------------------------------------------------------------------------
// DragSolver / BitGrid unit tests.
//
// Every check compares against a deliberately independent brute-force oracle:
// scalar cell-set collision tests, a reference anchor BFS, and an exhaustive
// drag-space BFS that yields provably minimal drag counts on tiny puzzles.
// The last one doubles as the heuristic-admissibility test: weight-1 A* with
// an admissible consistent h must return exactly the oracle's optimum.
// ---------------------------------------------------------------------------

namespace {

constexpr int DX[4] = {0, 1, 0, -1};
constexpr int DY[4] = {-1, 0, 1, 0};
constexpr Direction DIRS[4] = {Direction::UP, Direction::RIGHT,
                               Direction::DOWN, Direction::LEFT};

struct Puzzle {
  uint8_t w;
  uint8_t h;
  std::vector<std::vector<Position>> shapes;
  std::vector<Position> anchors;
  uint8_t goalIndex;
  Position goalAnchor;
};

// Brute-force placement check: block i at anchor a, all cells in-bounds by
// BOUNDING BOX (mirrors AStar::inBounds) and no overlap with other blocks.
bool oracleCanPlace(const Puzzle &p, const size_t i, const Position a,
                    const std::vector<Position> &anchors) {
  int boxW = 0;
  int boxH = 0;
  for (const auto &c : p.shapes[i]) {
    boxW = std::max(boxW, c.x + 1);
    boxH = std::max(boxH, c.y + 1);
  }
  if (a.x < 0 || a.y < 0 || a.x + boxW > p.w || a.y + boxH > p.h)
    return false;
  std::vector<int> occ(static_cast<size_t>(p.w) * p.h, -1);
  for (size_t j = 0; j < anchors.size(); j++) {
    if (j == i)
      continue;
    for (const auto &c : p.shapes[j])
      occ[(anchors[j].x + c.x) * p.h + (anchors[j].y + c.y)] =
          static_cast<int>(j);
  }
  for (const auto &c : p.shapes[i])
    if (occ[(a.x + c.x) * p.h + (a.y + c.y)] != -1)
      return false;
  return true;
}

// Reference per-block reachability BFS (a "drag"), independent of BitGrid.
std::map<uint16_t, uint16_t> oracleFloodFill(const Puzzle &p, const size_t i,
                                             const std::vector<Position> &anchors) {
  std::map<uint16_t, uint16_t> dist; // anchorIdx -> BFS distance
  std::queue<Position> q;
  dist[static_cast<uint16_t>(anchors[i].x * p.h + anchors[i].y)] = 0;
  q.push(anchors[i]);
  while (!q.empty()) {
    const Position cur = q.front();
    q.pop();
    const uint16_t curIdx = static_cast<uint16_t>(cur.x * p.h + cur.y);
    for (int d = 0; d < 4; d++) {
      const Position next = {static_cast<int8_t>(cur.x + DX[d]),
                             static_cast<int8_t>(cur.y + DY[d])};
      if (!oracleCanPlace(p, i, next, anchors))
        continue;
      const uint16_t nIdx = static_cast<uint16_t>(next.x * p.h + next.y);
      if (dist.contains(nIdx))
        continue;
      dist[nIdx] = static_cast<uint16_t>(dist[curIdx] + 1);
      q.push(next);
    }
  }
  return dist;
}

// Exhaustive drag-space BFS: minimal number of drags to bring the goal block
// onto goalAnchor, or -1 if unreachable. State = all anchors.
int oracleMinDrags(const Puzzle &p) {
  const auto key = [&](const std::vector<Position> &anchors) {
    std::string k;
    for (const auto &a : anchors) {
      k.push_back(static_cast<char>(a.x));
      k.push_back(static_cast<char>(a.y));
    }
    return k;
  };
  std::map<std::string, int> dist;
  std::queue<std::vector<Position>> q;
  dist[key(p.anchors)] = 0;
  q.push(p.anchors);
  while (!q.empty()) {
    const auto anchors = q.front();
    q.pop();
    const int d = dist[key(anchors)];
    if (anchors[p.goalIndex] == p.goalAnchor)
      return d;
    for (size_t i = 0; i < anchors.size(); i++) {
      for (const auto &[toIdx, dd] : oracleFloodFill(p, i, anchors)) {
        if (dd == 0)
          continue;
        auto next = anchors;
        next[i] = {static_cast<int8_t>(toIdx / p.h),
                   static_cast<int8_t>(toIdx % p.h)};
        if (dist.try_emplace(key(next), d + 1).second)
          q.push(next);
      }
    }
  }
  return -1;
}

bool replayValid(const Puzzle &p, const std::vector<Turn> &turns) {
  std::vector<Position> anchors = p.anchors;
  for (const auto &t : turns) {
    if (t.blockId >= anchors.size())
      return false;
    const int d = static_cast<int>(t.direction);
    const Position next = {static_cast<int8_t>(anchors[t.blockId].x + DX[d]),
                           static_cast<int8_t>(anchors[t.blockId].y + DY[d])};
    if (!oracleCanPlace(p, t.blockId, next, anchors))
      return false;
    anchors[t.blockId] = next;
  }
  return anchors[p.goalIndex] == p.goalAnchor;
}

size_t countPlayerSteps(const std::vector<Turn> &turns) {
  size_t steps = 0;
  for (size_t i = 0; i < turns.size(); i++)
    if (i == 0 || turns[i].blockId != turns[i - 1].blockId)
      steps++;
  return steps;
}

// Random small puzzle. Blocks are placed greedily; the result may be solvable
// or not — the oracle decides, and DragSolver must agree either way.
Puzzle randomPuzzle(std::mt19937 &rng) {
  const std::vector<std::vector<Position>> catalog = {
      {{0, 0}},
      {{0, 0}, {1, 0}},
      {{0, 0}, {0, 1}},
      {{0, 0}, {1, 0}, {0, 1}},
      {{0, 0}, {1, 0}, {1, 1}},
  };
  std::uniform_int_distribution<int> wDist(4, 6);
  std::uniform_int_distribution<int> hDist(3, 5);
  Puzzle p;
  p.w = static_cast<uint8_t>(wDist(rng));
  p.h = static_cast<uint8_t>(hDist(rng));
  std::uniform_int_distribution<int> nDist(2, 3);
  const int n = nDist(rng);
  std::uniform_int_distribution<int> shapeDist(0, static_cast<int>(catalog.size()) - 1);
  std::uniform_int_distribution<int> xDist(0, p.w - 1);
  std::uniform_int_distribution<int> yDist(0, p.h - 1);
  for (int i = 0; i < n; i++) {
    const auto &shape = catalog[shapeDist(rng)];
    for (int tries = 0; tries < 50; tries++) {
      const Position a = {static_cast<int8_t>(xDist(rng)),
                          static_cast<int8_t>(yDist(rng))};
      p.shapes.push_back(shape);
      p.anchors.push_back(a);
      if (oracleCanPlace(p, p.shapes.size() - 1, a, p.anchors))
        break;
      p.shapes.pop_back();
      p.anchors.pop_back();
    }
  }
  if (p.shapes.empty()) {
    p.shapes.push_back(catalog[0]);
    p.anchors.push_back({0, 0});
  }
  p.goalIndex = 0;
  for (int tries = 0; tries < 50; tries++) {
    const Position t = {static_cast<int8_t>(xDist(rng)),
                        static_cast<int8_t>(yDist(rng))};
    std::vector<Position> alone(p.anchors.size(), {127, 127});
    alone[0] = t;
    // Target just needs the goal's bbox in-grid.
    int boxW = 0, boxH = 0;
    for (const auto &c : p.shapes[0]) {
      boxW = std::max(boxW, c.x + 1);
      boxH = std::max(boxH, c.y + 1);
    }
    if (t.x + boxW <= p.w && t.y + boxH <= p.h) {
      p.goalAnchor = t;
      return p;
    }
  }
  p.goalAnchor = p.anchors[0];
  return p;
}

DragSolver makeDragSolver(const Puzzle &p, const DragSolver::Config &cfg) {
  return DragSolver(p.w, p.h, p.shapes, p.anchors, p.goalIndex, p.goalAnchor,
                    cfg);
}

} // namespace

TEST(BitGrid, MatchesCollisionOracleOnRandomBoards) {
  std::mt19937 rng(1234);
  for (int round = 0; round < 200; round++) {
    const Puzzle p = randomPuzzle(rng);
    BitGrid grid(p.w, p.h, p.shapes);
    grid.buildOccupancy(p.anchors);
    std::uniform_int_distribution<int> bDist(0, static_cast<int>(p.shapes.size()) - 1);
    std::uniform_int_distribution<int> cDist(-2, 7);
    for (int probe = 0; probe < 100; probe++) {
      const auto i = static_cast<uint8_t>(bDist(rng));
      const Position a = {static_cast<int8_t>(cDist(rng)),
                          static_cast<int8_t>(cDist(rng))};
      grid.removeBlock(i, p.anchors[i]);
      const bool got = grid.canPlace(i, a.x, a.y);
      grid.addBlock(i, p.anchors[i]);
      const bool want = oracleCanPlace(p, i, a, p.anchors);
      ASSERT_EQ(got, want) << "round " << round << " block " << int(i)
                           << " at (" << int(a.x) << "," << int(a.y) << ")";
    }
  }
}

TEST(BitGrid, FloodFillMatchesReferenceBfs) {
  std::mt19937 rng(4321);
  for (int round = 0; round < 200; round++) {
    const Puzzle p = randomPuzzle(rng);
    BitGrid grid(p.w, p.h, p.shapes);
    for (uint8_t i = 0; i < p.shapes.size(); i++) {
      grid.buildOccupancy(p.anchors);
      grid.removeBlock(i, p.anchors[i]);
      const auto &reached = grid.floodFill(i, p.anchors[i]);
      const auto want = oracleFloodFill(p, i, p.anchors);
      ASSERT_EQ(reached.size(), want.size() - 1)
          << "round " << round << " block " << int(i);
      for (const uint16_t idx : reached) {
        auto it = want.find(idx);
        ASSERT_NE(it, want.end());
        ASSERT_EQ(grid.distTo(idx), it->second);
      }
    }
  }
}

TEST(DragSolver, Weight1MatchesExhaustiveDragOracle) {
  std::mt19937 rng(99);
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
  std::mt19937 rng(99); // same instances as the full-expansion oracle test
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
  std::mt19937 rng(99); // same instances as the oracle tests
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
  std::mt19937 rng(99); // same instances as the oracle tests
  int solvable = 0, solved = 0;
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
  std::mt19937 rng(7);
  int solvable = 0;
  int solved = 0;
  for (int round = 0; round < 80; round++) {
    const Puzzle p = randomPuzzle(rng);
    const int want = oracleMinDrags(p);
    if (want <= 0)
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

TEST(DragSolver, JamGuideAndJitterStayValidAndComplete) {
  // The jam guide adds an inadmissible ordering term to f and the tie seed
  // reshuffles equal-f plateaus — neither may cost completeness or validity:
  // every oracle-solvable board must still solve, every plan must replay.
  std::mt19937 rng(99); // same instances as the oracle tests
  int solvable = 0;
  for (int round = 0; round < 120; round++) {
    const Puzzle p = randomPuzzle(rng);
    const int want = oracleMinDrags(p);
    DragSolver::Config cfg;
    cfg.weight = 2;
    cfg.postProcess = false;
    cfg.jamGuideWeight = 8;
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
  std::mt19937 rng(99); // same instances as the oracle tests
  int solvable = 0, solved = 0;
  for (int round = 0; round < 60; round++) {
    const Puzzle p = randomPuzzle(rng);
    const int want = oracleMinDrags(p);
    if (want <= 0)
      continue;
    solvable++;
    DragSolver::Config cfg;
    cfg.postProcess = false;
    cfg.beamWidth = 4096;
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
  std::mt19937 rng(99);
  int solvable = 0, solved = 0;
  for (int round = 0; round < 40; round++) {
    const Puzzle p = randomPuzzle(rng);
    if (oracleMinDrags(p) <= 0)
      continue;
    solvable++;

    DragSolver::Config shaped;
    shaped.postProcess = false;
    shaped.jamRoundNodeCap = 20000;
    shaped.jamMaxElites = 32;
    auto driver = makeDragSolver(p, shaped);
    const auto turns = driver.searchJamRestarts(5000, 0);
    if (!turns.empty()) {
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
    explicitDefaults.jamRoundNodeCap = 0;
    explicitDefaults.jamMaxElites = 6;
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
  std::mt19937 rng(2024);
  int solvable = 0;
  for (int round = 0; round < 15; round++) {
    const Puzzle p = randomPuzzle(rng);
    const int want = oracleMinDrags(p);
    const auto turns =
        solveArmsParallel(p.w, p.h, p.shapes, p.anchors, p.goalIndex,
                          p.goalAnchor, 10000, 0, false, nullptr);
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
  std::mt19937 rng(55);
  for (int round = 0; round < 80; round++) {
    const Puzzle p = randomPuzzle(rng);
    const int want = oracleMinDrags(p);
    if (want <= 0)
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
