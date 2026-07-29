#include "SolverArms.h"

#include "Node.h"
#include "PuzzleProfile.h"
#include "SolverClock.h"

#include <algorithm>
#include <array>
#include <string_view>

#ifdef __EMSCRIPTEN_PTHREADS__
// Heap ceilings only matter for the in-module thread race.
#include "MemoryProbe.h"
#include <atomic>
#include <chrono>
#include <thread>
#endif

namespace {

struct SingleArm {
  std::string_view engine;
  bool gated = false;
  uint32_t beamWidth = 0;
  uint32_t seed = 0;
  uint8_t weight = 2;
  bool overrideWeight = false;
};

// --- Two-block coverage split helpers -------------------------------------

std::vector<uint16_t> blockFootprint(const Block &b, const uint8_t gridWidth) {
  std::vector<uint16_t> cells;
  cells.reserve(static_cast<size_t>(b.width) * b.depth);
  for (int8_t cx = b.x; cx < b.x + static_cast<int8_t>(b.width); cx++) {
    for (int8_t cy = b.y; cy < b.y + static_cast<int8_t>(b.depth); cy++) {
      cells.push_back(positionToIndex(cx, cy, gridWidth));
    }
  }
  return cells;
}

// Multi-source BFS over playable cells. extraWalls (satisfied cells, the
// parked block) block expansion, but seeds may sit on them — a block stands
// on the cells it just satisfied until it rolls off.
std::vector<uint16_t> nearestField(const replay::Puzzle &puzzle,
                                   const std::vector<uint16_t> &seeds,
                                   const boost::dynamic_bitset<> *extraWalls) {
  std::vector<uint16_t> dist(puzzle.cells.size(), UINT16_MAX);
  std::vector<uint16_t> frontier;
  frontier.reserve(seeds.size());
  for (const uint16_t idx : seeds) {
    dist[idx] = 0;
    frontier.push_back(idx);
  }
  std::vector<uint16_t> next;
  uint16_t depth = 0;
  while (!frontier.empty()) {
    next.clear();
    depth++;
    for (const uint16_t idx : frontier) {
      const int cx = idx % puzzle.gridWidth;
      const int cy = idx / puzzle.gridWidth;
      constexpr std::array kSteps = {std::pair{1, 0}, std::pair{-1, 0},
                                     std::pair{0, 1}, std::pair{0, -1}};
      for (const auto &[dx, dy] : kSteps) {
        const int nx = cx + dx;
        const int ny = cy + dy;
        if (nx < 0 || nx >= puzzle.gridWidth || ny < 0 ||
            ny >= puzzle.gridHeight) {
          continue;
        }
        const auto nidx = static_cast<uint16_t>(nx + ny * puzzle.gridWidth);
        if (dist[nidx] != UINT16_MAX ||
            puzzle.cells[nidx] == Tile::Unplayable ||
            (extraWalls != nullptr && extraWalls->test(nidx))) {
          continue;
        }
        dist[nidx] = depth;
        next.push_back(nidx);
      }
    }
    frontier.swap(next);
  }
  return dist;
}

// Pose-space BFS for a single block: minimum rolls from its current pose to
// any pose covering each cell (UINT16_MAX = uncoverable). extraWalls
// (satisfied cells, the parked partner) are impassable; unsatisfied
// must-touch cells count as passable — an optimistic one-shot relaxation,
// the leg cracker is the truth. This is exact where the cell-BFS field lies:
// a domino needs two consecutive free cells to stand up onto an isolated
// cell, so cell connectivity overestimates what a block can actually cover.
std::vector<uint16_t> coverField(const replay::Puzzle &puzzle,
                                 const Block &start,
                                 const boost::dynamic_bitset<> &extraWalls) {
  const int width = puzzle.gridWidth;
  const int height = puzzle.gridHeight;
  const size_t totalCells = puzzle.cells.size();
  std::vector<uint16_t> cover(totalCells, UINT16_MAX);
  constexpr std::array kDirs = {Direction::UP, Direction::RIGHT,
                                Direction::DOWN, Direction::LEFT};

  const auto posePassable = [&](const Block &pose) {
    if (pose.x < 0 || pose.y < 0 || pose.x + pose.width > width ||
        pose.y + pose.depth > height) {
      return false;
    }
    for (int8_t px = pose.x; px < pose.x + static_cast<int8_t>(pose.width);
         px++) {
      for (int8_t py = pose.y; py < pose.y + static_cast<int8_t>(pose.depth);
           py++) {
        const auto idx = positionToIndex(px, py, puzzle.gridWidth);
        if (puzzle.cells[idx] == Tile::Unplayable || extraWalls.test(idx)) {
          return false;
        }
      }
    }
    return true;
  };
  const auto markCover = [&](const Block &pose, const uint16_t d) {
    for (int8_t px = pose.x; px < pose.x + static_cast<int8_t>(pose.width);
         px++) {
      for (int8_t py = pose.y; py < pose.y + static_cast<int8_t>(pose.depth);
           py++) {
        auto &best = cover[positionToIndex(px, py, puzzle.gridWidth)];
        best = std::min(best, d);
      }
    }
  };
  // Orientation ids: (width, depth) pairs discovered lazily; a dims
  // multiset has at most 6 of them, and the footprint determines the
  // height (it is the leftover dimension).
  std::array<std::pair<uint8_t, uint8_t>, 6> orientKeys{};
  size_t orientCount = 0;
  const auto orientIdx = [&](const Block &pose) {
    const std::pair key{pose.width, pose.depth};
    for (size_t i = 0; i < orientCount; i++) {
      if (orientKeys[i] == key) {
        return i;
      }
    }
    orientKeys[orientCount] = key;
    return orientCount++;
  };
  const auto stateIdx = [&](const Block &pose, const size_t orient) {
    return orient * totalCells +
           static_cast<size_t>(pose.x) +
           static_cast<size_t>(pose.y) * static_cast<size_t>(width);
  };

  std::vector<uint16_t> dist(totalCells * 6, UINT16_MAX);
  std::vector<Block> frontier{start};
  dist[stateIdx(start, orientIdx(start))] = 0;
  markCover(start, 0);
  std::vector<Block> next;
  uint16_t depth = 0;
  while (!frontier.empty()) {
    next.clear();
    depth++;
    for (const auto &pose : frontier) {
      for (const auto dir : kDirs) {
        Block moved = pose.clone();
        moved.roll(dir);
        if (!posePassable(moved)) {
          continue;
        }
        auto &seen = dist[stateIdx(moved, orientIdx(moved))];
        if (seen != UINT16_MAX) {
          continue;
        }
        seen = depth;
        markCover(moved, depth);
        next.push_back(moved);
      }
    }
    frontier.swap(next);
  }
  return cover;
}

std::vector<Turn> crackLeg(const replay::Puzzle &sub, const AStar::Config &base,
                           const uint32_t maxMs, AStar::SearchStats &statsOut,
                           const std::function<void(uint32_t)> &onProgress,
                           const uint64_t progressAt,
                           const std::vector<uint16_t> *required = nullptr) {
  AStar::Config cfg = base;
  cfg.maxMs = maxMs;
  cfg.requiredCells = required;
  AStar solver(sub.gridWidth, sub.gridHeight, sub.cells, cfg);
  if (onProgress) {
    solver.setOnProgress([&onProgress, progressAt](const uint32_t n) {
      onProgress(static_cast<uint32_t>(progressAt + n));
    });
  }
  auto turns = solver.searchCracker(Node(sub.blocks));
  statsOut.nodesExpanded += solver.stats().nodesExpanded;
  statsOut.stoppedOnMemory =
      statsOut.stoppedOnMemory || solver.stats().stoppedOnMemory;
  return turns;
}

size_t unsatisfiedCount(const replay::Puzzle &sub) {
  boost::dynamic_bitset sat(sub.cells.size());
  for (const auto &b : sub.blocks) {
    sat = b.updateMustTouchCells(sub.gridWidth, sub.cells, sat);
  }
  size_t open = 0;
  for (size_t i = 0; i < sub.cells.size(); i++) {
    if (sub.cells[i] == Tile::MustTouch && !sat.test(i)) {
      open++;
    }
  }
  return open;
}

// Chunked alternation, the scheme for boards whose witness INTERLEAVES the
// two blocks (fuzz-7007's class — an all-A-then-all-B plan walls the second
// block into pockets). Alternate short legs A1 B1 A2 B2 …: each leg runs
// the single-block cracker against the active block's nearest still-open
// chunk of its share, re-planned from the real mid state (satisfied cells
// and the parked partner are walls). Every leg's plan is applied to the
// REAL board before the next leg, and the concatenation must survive a full
// replay at the end.
std::vector<Turn> runChunkedAlternation(
    const replay::Puzzle &puzzle, const AStar::Config &base,
    AStar::SearchStats &statsOut,
    const std::function<void(uint32_t)> &onProgress,
    const uint64_t progressBase, const std::vector<uint8_t> &shareOf,
    const size_t firstIdx, const bool wallForeign, const size_t chunkCount,
    const bool farthestFirst, const uint32_t legMs, const uint64_t deadline) {
  const size_t totalCells = puzzle.cells.size();

  std::array<size_t, 2> chunkSize = {1, 1};
  for (size_t i = 0; i < totalCells; i++) {
    if (puzzle.cells[i] == Tile::MustTouch) {
      chunkSize[shareOf[i]]++;
    }
  }
  for (auto &size : chunkSize) {
    size = std::max<size_t>(1, (size + chunkCount - 1) / chunkCount);
  }

  std::vector<Turn> plan;
  std::vector<Block> cur = puzzle.blocks;
  boost::dynamic_bitset sat(totalCells);
  for (const auto &b : cur) {
    sat = b.updateMustTouchCells(puzzle.gridWidth, puzzle.cells, sat);
  }

  // Straggler gate: cells no block can cover any more (pose-BFS with the
  // satisfied cells as walls; the partner is ignored — it can move away, so
  // only the monotone satisfied set counts). A leg that grows this set has
  // stranded a cell for good and gets rolled back.
  const auto deadCount = [&] {
    const auto f0 = coverField(puzzle, cur[0], sat);
    const auto f1 = coverField(puzzle, cur[1], sat);
    size_t dead = 0;
    for (size_t i = 0; i < totalCells; i++) {
      if (puzzle.cells[i] == Tile::MustTouch && !sat.test(i) &&
          f0[i] == UINT16_MAX && f1[i] == UINT16_MAX) {
        dead++;
      }
    }
    return dead;
  };
  const size_t baselineDead = deadCount();

  // Hand-level backtracking: greedy leg ORDER is what paints the scheme
  // into corners, so every successful leg snapshots the state before it.
  // When both hands are stuck, rewind to the most recent leg that still
  // has unused seed variants and replay it differently instead of
  // discarding the whole attempt.
  struct LegSnap {
    std::vector<Block> blocks;
    boost::dynamic_bitset<> sat;
    size_t planLen = 0;
    size_t active = 0;
    uint32_t seedBump = 0;
  };
  std::vector<LegSnap> history;
  constexpr uint32_t kMaxBacktracks = 64;
  constexpr uint32_t kMaxLegSeeds = 3;
  uint32_t backtracks = 0;
  uint32_t pendingBump = 0;

  size_t active = firstIdx;
  int stuckHands = 0;
  std::array<uint32_t, 2> consecFails{};
  size_t lastFinisherOpen = SIZE_MAX;
  const auto rewind = [&] {
    // Periodic deep rewind: shallow rewinds keep reconverging when the
    // real mistake is a giant early leg, so occasionally jump straight
    // back toward it (but never drain a short history — those snapshots
    // are the only retry capital an attempt has).
    if (backtracks % 6 == 5 && history.size() > 8) {
      const size_t target = history.size() / 2;
      while (history.size() > target) {
        history.pop_back();
      }
    }
    while (!history.empty() && backtracks < kMaxBacktracks) {
      LegSnap snap = std::move(history.back());
      history.pop_back();
      backtracks++;
      if (snap.seedBump + 1 >= kMaxLegSeeds) {
        continue; // this decision point is spent; rewind further
      }
      cur = std::move(snap.blocks);
      sat = std::move(snap.sat);
      plan.resize(snap.planLen);
      active = snap.active;
      pendingBump = snap.seedBump + 1;
      stuckHands = 0;
      consecFails = {};
      return true;
    }
    return false;
  };
  // The joint finisher: once the alternation has shrunk the board to a
  // small endgame, hand the WHOLE remaining sub-puzzle (both blocks, real
  // one-shot semantics, satisfied cells as walls) to the joint cracker.
  // The joint walk drowned on the full 306-cell board but a sub-100-cell
  // endgame is exactly its size; gated on the open count improving so a
  // stuck plateau does not pay for it repeatedly.
  const auto tryJointFinish = [&](const bool atStuckPoint) -> bool {
    size_t open = 0;
    for (size_t i = 0; i < totalCells; i++) {
      if (puzzle.cells[i] == Tile::MustTouch && !sat.test(i)) {
        open++;
      }
    }
    if (open == 0 || open > 100) {
      return false;
    }
    // The after-leg site is gated on (open, backtracks) so a plateau does
    // not pay for the finisher repeatedly; a genuine stuck point is the
    // valuable state and always gets its shot.
    const size_t finisherKey = open * 1000 + backtracks;
    if (!atStuckPoint && finisherKey == lastFinisherOpen) {
      return false;
    }
    lastFinisherOpen = finisherKey;
    const uint64_t now = nowMs();
    if (now >= deadline) {
      return false;
    }
    replay::Puzzle fin{.gridWidth = puzzle.gridWidth,
                       .gridHeight = puzzle.gridHeight,
                       .cells = puzzle.cells,
                       .blocks = cur};
    for (size_t i = 0; i < totalCells; i++) {
      if (puzzle.cells[i] == Tile::MustTouch && sat.test(i)) {
        fin.cells[i] = Tile::Unplayable;
      }
    }
    AStar::Config finCfg = base;
    finCfg.seed = base.seed + 31337 + backtracks;
    finCfg.jointCoverageIntact = true;
    const auto finTurns = crackLeg(
        fin, finCfg,
        static_cast<uint32_t>(
            std::min<uint64_t>(4ULL * legMs, deadline - now)),
        statsOut, onProgress, progressBase + statsOut.nodesExpanded);
    if (finTurns.empty()) {
      return false;
    }
    const size_t planLen = plan.size();
    plan.insert(plan.end(), finTurns.begin(), finTurns.end());
    if (const auto outcome = replay::replayTurns(puzzle, plan);
        outcome.legal && outcome.solvedAtEnd) {
      return true;
    }
    plan.resize(planLen);
    return false;
  };

  while (true) {
    const uint64_t now = nowMs();
    if (now >= deadline) {
      return {};
    }
    bool anyOpen = false;
    for (size_t i = 0; i < totalCells && !anyOpen; i++) {
      anyOpen = puzzle.cells[i] == Tile::MustTouch && !sat.test(i);
    }
    if (!anyOpen) {
      break;
    }

    boost::dynamic_bitset<> walls = sat;
    for (const uint16_t idx :
         blockFootprint(cur[1 - active], puzzle.gridWidth)) {
      walls.set(idx);
    }
    const auto field = coverField(puzzle, cur[active], walls);

    // The active block's own share first; when that is exhausted or walled
    // off, mop up the partner's share too — the nearest-block assignment is
    // a heuristic, not a commitment.
    std::vector<uint16_t> candidates;
    for (size_t i = 0; i < totalCells; i++) {
      if (puzzle.cells[i] == Tile::MustTouch && !sat.test(i) &&
          shareOf[i] == active && field[i] != UINT16_MAX) {
        candidates.push_back(static_cast<uint16_t>(i));
      }
    }
    if (candidates.empty()) {
      for (size_t i = 0; i < totalCells; i++) {
        if (puzzle.cells[i] == Tile::MustTouch && !sat.test(i) &&
            field[i] != UINT16_MAX) {
          candidates.push_back(static_cast<uint16_t>(i));
        }
      }
    }
    if (candidates.empty()) {
      // Nothing reachable for this block right now — hand over. Two
      // consecutive stuck hands mean neither block can progress from here;
      // rewind to an earlier leg (satisfied cells only accumulate, so
      // waiting cannot help).
      if (++stuckHands >= 2) {
        if (tryJointFinish(true)) {
          return plan;
        }
        if (!rewind()) {
          return {};
        }
        continue;
      }
      pendingBump = 0;
      active = 1 - active;
      continue;
    }
    // Nearest-first mops outward from the block; farthest-first fills the
    // deepest pockets before they get walled shut and retreats outward —
    // the discipline a coverage walk's witness follows.
    std::ranges::sort(candidates, {},
                      [&field](const uint16_t c) { return field[c]; });
    if (farthestFirst) {
      std::ranges::reverse(candidates);
    }
    // Backtracked re-runs need STRUCTURAL variety — the ordering terms
    // dominate the seeded jitter, so a reseeded identical hand replays the
    // identical leg. Bump 1 flips the target order, bump 2 rotates it.
    if (pendingBump == 1) {
      std::ranges::reverse(candidates);
    } else if (pendingBump == 2 && candidates.size() > 1) {
      std::ranges::rotate(candidates, candidates.begin() + 1);
    }

    // A hand gets a few seed-diversified tries. Each try solves a leg
    // (adaptively halving the target chunk down to one cell when the
    // cracker declines), applies its legal prefix to the real board, and
    // passes two gates: it must satisfy something new, and it must not
    // strand a cell (deadCount growing means some still-open cell became
    // uncoverable by BOTH blocks — walls only accumulate, so that loss is
    // permanent and the leg gets rolled back).
    if (consecFails[active] >= 3 && stuckHands == 0) {
      // This block keeps failing; let the partner mop at full speed
      // instead of paying a full hand budget every other turn. It gets a
      // real try again once the partner is stuck too (or after a rewind).
      active = 1 - active;
      continue;
    }

    const std::vector<Block> handCur = cur;
    const boost::dynamic_bitset<> handSat = sat;
    const size_t handPlanLen = plan.size();
    // A hand never gets more than ~1.5 legs of wall clock: a block that is
    // about to fail otherwise burns retries x ladder x legMs while its
    // partner has real work waiting.
    const uint64_t handStart = nowMs();
    const uint64_t handDeadline =
        std::min<uint64_t>(deadline, handStart + legMs + legMs / 2);

    bool handDone = false;
    for (uint32_t retry = 0; retry < 2 && !handDone; retry++) {
      AStar::Config legCfg = base;
      legCfg.seed = base.seed + (pendingBump * 2 + retry) * 104729;
      // Every touching move inside the leg must keep every open cell
      // coverable by the active block or the parked partner — the prune
      // that stops dense-blob sweeps from walling off whole regions.
      legCfg.coveragePartner = &cur[1 - active];

      size_t tryCount = std::min(candidates.size(), chunkSize[active]);
      std::vector<Turn> legTurns;
      while (true) {
        replay::Puzzle sub{.gridWidth = puzzle.gridWidth,
                           .gridHeight = puzzle.gridHeight,
                           .cells = puzzle.cells,
                           .blocks = {cur[active]}};
        for (const uint16_t idx :
             blockFootprint(cur[1 - active], puzzle.gridWidth)) {
          sub.cells[idx] = Tile::Unplayable;
        }
        std::vector<uint16_t> requiredVec;
        if (wallForeign) {
          // "Avoid" style: everything outside the target chunk is a wall —
          // interaction-free but heavily constrained.
          boost::dynamic_bitset target(totalCells);
          for (size_t t = 0; t < tryCount; t++) {
            target.set(candidates[t]);
          }
          for (size_t i = 0; i < totalCells; i++) {
            if (puzzle.cells[i] == Tile::MustTouch && !target.test(i)) {
              sub.cells[i] = Tile::Unplayable;
            }
          }
        } else {
          // Subset style: every must-touch cell keeps its real one-shot
          // semantics (crossable once, then a wall the engine tracks), and
          // the cracker is told to chase only the target chunk. Leg plans
          // found this way replay legally on the full board by construction.
          for (size_t i = 0; i < totalCells; i++) {
            if (puzzle.cells[i] == Tile::MustTouch && sat.test(i)) {
              sub.cells[i] = Tile::Unplayable;
            }
          }
          if (tryCount == 1 && farthestFirst) {
            // Single-cell fallback always goes for the NEAREST cell — a
            // lone farthest target is the hardest ask in the scheme.
            requiredVec.assign(1, candidates.back());
          } else {
            requiredVec.assign(candidates.begin(),
                               candidates.begin() +
                                   static_cast<ptrdiff_t>(tryCount));
          }
        }
        const uint64_t legNow = nowMs();
        if (legNow >= deadline) {
          return {};
        }
        if (legNow >= handDeadline) {
          break;
        }
        legTurns = crackLeg(
            sub, legCfg,
            static_cast<uint32_t>(
                std::min<uint64_t>(legMs, handDeadline - legNow)),
            statsOut, onProgress, progressBase + statsOut.nodesExpanded,
            requiredVec.empty() ? nullptr : &requiredVec);
        if (!legTurns.empty() || tryCount == 1) {
          break;
        }
        // The coverage-intact prune makes smaller legs strictly easier, so
        // shrink aggressively instead of a long halving ladder.
        tryCount = tryCount > 4 ? tryCount / 4 : 1;
      }
      if (legTurns.empty()) {
        continue;
      }

      // Apply the leg's legal PREFIX to the real board. A subset-style leg
      // replays fully by construction; a free prefix that dies early still
      // carries real progress. Snapshot first so the gates can roll back.
      const std::vector<Block> curSnap = cur;
      const boost::dynamic_bitset<> satSnap = sat;
      const size_t planLen = plan.size();
      for (const auto &turn : legTurns) {
        const auto it = std::ranges::find_if(
            cur, [&turn](const Block &b) { return b.id == turn.blockId; });
        if (it == cur.end()) {
          return {};
        }
        it->roll(turn.direction);
        if (!it->checkValidity(puzzle.gridWidth, puzzle.gridHeight,
                               puzzle.cells, cur, sat)) {
          constexpr std::array kInverse = {Direction::DOWN, Direction::LEFT,
                                           Direction::UP, Direction::RIGHT};
          it->roll(kInverse[static_cast<size_t>(turn.direction)]);
          break;
        }
        sat = it->updateMustTouchCells(puzzle.gridWidth, puzzle.cells, sat);
        plan.push_back(turn);
      }
      if (sat.count() == satSnap.count() || deadCount() > baselineDead) {
        cur = curSnap;
        sat = satSnap;
        plan.resize(planLen);
        continue;
      }
      handDone = true;
    }
    if (!handDone) {
      consecFails[active]++;
      if (++stuckHands >= 2) {
        if (tryJointFinish(true)) {
          return plan;
        }
        if (!rewind()) {
          return {};
        }
        continue;
      }
      pendingBump = 0;
      active = 1 - active;
      continue;
    }
    history.push_back({.blocks = handCur,
                       .sat = handSat,
                       .planLen = handPlanLen,
                       .active = active,
                       .seedBump = pendingBump});
    consecFails[active] = 0;
    pendingBump = 0;
    stuckHands = 0;
    active = 1 - active;
    if (tryJointFinish(false)) {
      return plan;
    }
  }

  if (const auto outcome = replay::replayTurns(puzzle, plan);
      outcome.legal && outcome.solvedAtEnd) {
    return plan;
  }
  return {};
}

// Two-block coverage split, the fix for the fuzz campaign's surviving
// boards: partition the unsatisfied must-touch cells by nearest block, then
// run the single-block cracker per block IN SEQUENCE — the idle block's
// footprint becomes a wall, the other block's share of cells becomes either
// walls ("avoid" style, provably interaction-free) or plain floor ("free"
// style, more connective but the first block may satisfy cells en route).
// Four attempts (2 orders x 2 styles) get the first HALF of the budget;
// every candidate plan must survive a full replay of the REAL puzzle, so
// the sub-puzzle relaxations can suggest but never certify. The second half
// goes to chunked alternation (runChunkedAlternation above) for the boards
// where sequential legs are structurally impossible.
std::vector<Turn> runSplitCoverage(
    const replay::Puzzle &puzzle, const AStar::Config &base,
    AStar::SearchStats &statsOut,
    const std::function<void(uint32_t)> &onProgress,
    const uint64_t progressBase) {
  if (puzzle.blocks.size() != 2 ||
      std::ranges::contains(puzzle.cells, Tile::Goal)) {
    return {};
  }
  const uint32_t totalMs = base.maxMs == 0 ? 300000 : base.maxMs;
  const uint64_t start = nowMs();
  const uint64_t deadline = start + totalMs;
  // The plain sequential scheme wins in seconds when it wins at all
  // (fuzz-7043: 1.7 s), so it gets a sixth of the budget; the bulk goes to
  // chunked alternation, whose legs are where hard boards get solved.
  const uint64_t plainDeadline = start + totalMs / 6;
  const size_t totalCells = puzzle.cells.size();

  const auto fields = std::array{
      nearestField(puzzle, blockFootprint(puzzle.blocks[0], puzzle.gridWidth),
                   nullptr),
      nearestField(puzzle, blockFootprint(puzzle.blocks[1], puzzle.gridWidth),
                   nullptr)};

  boost::dynamic_bitset rootSat(totalCells);
  for (const auto &b : puzzle.blocks) {
    rootSat = b.updateMustTouchCells(puzzle.gridWidth, puzzle.cells, rootSat);
  }

  struct Attempt {
    size_t firstIdx = 0;
    bool wallForeign = false;
  };
  constexpr std::array<Attempt, 4> kAttempts = {
      {{.firstIdx = 0, .wallForeign = true},
       {.firstIdx = 1, .wallForeign = true},
       {.firstIdx = 0, .wallForeign = false},
       {.firstIdx = 1, .wallForeign = false}}};
  const uint32_t perLeg = std::max<uint32_t>(1000, totalMs / 24);

  for (const auto &attempt : kAttempts) {
    const uint64_t now = nowMs();
    if (now >= plainDeadline) {
      break;
    }
    const Block &first = puzzle.blocks[attempt.firstIdx];
    const Block &second = puzzle.blocks[1 - attempt.firstIdx];
    const auto &firstField = fields[attempt.firstIdx];
    const auto &secondField = fields[1 - attempt.firstIdx];

    // Leg 1: the first block alone against its share of the cells.
    replay::Puzzle sub1{.gridWidth = puzzle.gridWidth,
                        .gridHeight = puzzle.gridHeight,
                        .cells = puzzle.cells,
                        .blocks = {first}};
    for (const uint16_t idx : blockFootprint(second, puzzle.gridWidth)) {
      sub1.cells[idx] = Tile::Unplayable;
    }
    for (size_t i = 0; i < totalCells; i++) {
      if (puzzle.cells[i] != Tile::MustTouch || rootSat.test(i)) {
        continue;
      }
      if (secondField[i] < firstField[i]) {
        sub1.cells[i] =
            attempt.wallForeign ? Tile::Unplayable : Tile::Regular;
      }
    }
    std::vector<Turn> leg1;
    if (unsatisfiedCount(sub1) > 0) {
      leg1 = crackLeg(sub1, base,
                      static_cast<uint32_t>(
                          std::min<uint64_t>(perLeg, plainDeadline - now)),
                      statsOut, onProgress,
                      progressBase + statsOut.nodesExpanded);
      if (leg1.empty()) {
        continue;
      }
    }

    // The mid position on the REAL board decides what leg 2 faces.
    std::vector<Block> midBlocks;
    boost::dynamic_bitset<> midSat;
    if (!replay::applyTurns(puzzle, leg1, midBlocks, midSat)) {
      continue; // "free" style tripped over a cell it satisfied en route
    }
    const auto firstMid = std::ranges::find_if(
        midBlocks, [&](const Block &b) { return b.id == first.id; });
    const auto secondMid = std::ranges::find_if(
        midBlocks, [&](const Block &b) { return b.id == second.id; });

    // Leg 2: the second block alone against everything still open; the
    // parked first block and every satisfied cell act as walls (equivalent
    // semantics for a solo block).
    replay::Puzzle sub2{.gridWidth = puzzle.gridWidth,
                        .gridHeight = puzzle.gridHeight,
                        .cells = puzzle.cells,
                        .blocks = {*secondMid}};
    for (const uint16_t idx : blockFootprint(*firstMid, puzzle.gridWidth)) {
      sub2.cells[idx] = Tile::Unplayable;
    }
    for (size_t i = 0; i < totalCells; i++) {
      if (puzzle.cells[i] == Tile::MustTouch && midSat.test(i)) {
        sub2.cells[i] = Tile::Unplayable;
      }
    }
    std::vector<Turn> leg2;
    if (unsatisfiedCount(sub2) > 0) {
      const uint64_t mid = nowMs();
      if (mid >= plainDeadline) {
        break;
      }
      leg2 = crackLeg(sub2, base,
                      static_cast<uint32_t>(
                          std::min<uint64_t>(perLeg, plainDeadline - mid)),
                      statsOut, onProgress,
                      progressBase + statsOut.nodesExpanded);
      if (leg2.empty()) {
        continue;
      }
    }

    std::vector<Turn> plan = leg1;
    plan.insert(plan.end(), leg2.begin(), leg2.end());
    if (const auto outcome = replay::replayTurns(puzzle, plan);
        outcome.legal && outcome.solvedAtEnd) {
      return plan;
    }
  }

  // Phase 2: chunked alternation over whatever budget remains. Free style
  // first — interleaving witnesses thread through each other's shares, so
  // walling foreign cells is usually what deadlocked phase 1; fine chunks
  // before coarse for the same reason.
  std::vector<uint8_t> shareOf(totalCells, 0);
  for (size_t i = 0; i < totalCells; i++) {
    if (fields[1][i] < fields[0][i]) {
      shareOf[i] = 1;
    }
  }
  struct ChunkAttempt {
    size_t firstIdx = 0;
    bool wallForeign = false;
    size_t chunks = 4;
    bool farthest = false;
  };
  // The adaptive hand-flipping makes firstIdx nearly irrelevant (a failed
  // hand just passes to the partner), so the attempts vary the chunk
  // discipline instead. Nearest-first before farthest-first: with the
  // coverage-intact prune the near sweep is disciplined anyway, and its
  // legs are far cheaper.
  constexpr std::array<ChunkAttempt, 6> kChunkAttempts = {{
      {.firstIdx = 0, .wallForeign = false, .chunks = 8, .farthest = false},
      {.firstIdx = 0, .wallForeign = false, .chunks = 8, .farthest = true},
      {.firstIdx = 1, .wallForeign = false, .chunks = 4, .farthest = false},
      {.firstIdx = 1, .wallForeign = false, .chunks = 4, .farthest = true},
      {.firstIdx = 0, .wallForeign = false, .chunks = 16, .farthest = false},
      {.firstIdx = 0, .wallForeign = true, .chunks = 8, .farthest = false},
  }};
  // Absolute cap on leg time: scaling legs with the budget just makes each
  // hand slower without adding exploration — more legs and more backtracks
  // beat longer legs (measured on fuzz-7007: 570 s explored no more leg
  // orders than 300 s when legs scaled).
  const uint32_t legMs =
      std::clamp<uint32_t>(totalMs / 24, 2000, 8000);
  const uint64_t chunkDeadline = start + totalMs / 8 * 7;
  uint32_t attemptSeed = base.seed;
  for (const auto &attempt : kChunkAttempts) {
    if (nowMs() >= chunkDeadline) {
      break;
    }
    // Each attempt gets its own seed so the leg crackers explore different
    // walk orders instead of replaying one deterministic failure.
    AStar::Config chunkCfg = base;
    chunkCfg.seed = attemptSeed;
    attemptSeed += 7919;
    auto plan = runChunkedAlternation(
        puzzle, chunkCfg, statsOut, onProgress, progressBase, shareOf,
        attempt.firstIdx, attempt.wallForeign, attempt.chunks,
        attempt.farthest, legMs, chunkDeadline);
    if (!plan.empty()) {
      return plan;
    }
  }

  // Phase 3: the JOINT two-block cracker over the final eighth. The
  // historic "joint DFS is useless here" measurement (fixture 34, 8.4M
  // expansions, nothing) predates the transit distance field, the orphan
  // prune and the joint coverage-intact prune — with those, the joint walk
  // holds the exact global one-shot state the leg schemes only
  // approximate, so it gets the last word.
  if (const uint64_t now = nowMs(); now < deadline) {
    AStar::Config jointCfg = base;
    jointCfg.jointCoverageIntact = true;
    auto turns =
        crackLeg(puzzle, jointCfg,
                 static_cast<uint32_t>(deadline - now), statsOut, onProgress,
                 progressBase + statsOut.nodesExpanded);
    if (!turns.empty()) {
      if (const auto outcome = replay::replayTurns(puzzle, turns);
          outcome.legal && outcome.solvedAtEnd) {
        return turns;
      }
    }
  }
  return {};
}

std::vector<Turn> runSingle(const replay::Puzzle &puzzle, const SingleArm &arm,
                            const AStar::Config &base,
                            AStar::SearchStats &statsOut,
                            const std::function<void(uint32_t)> &onProgress,
                            const uint64_t progressBase) {
  if (arm.gated) {
    const auto features = puzzleprofile::analyze(puzzle);
    if (arm.engine == "cracker" &&
        !puzzleprofile::coverageProfile(features)) {
      return {};
    }
    if (arm.engine == "exact" && !puzzleprofile::exactProfile(features)) {
      return {};
    }
  }

  // Two-block coverage boards route through the split scheme — the joint
  // DFS was measured useless there (8.4M expansions, nothing, fixture 34).
  if (arm.engine == "cracker" && puzzle.blocks.size() == 2) {
    return runSplitCoverage(puzzle, base, statsOut, onProgress, progressBase);
  }

  AStar::Config cfg = base;
  if (arm.overrideWeight) {
    cfg.weight = arm.weight;
  }
  if (arm.seed != 0) {
    cfg.seed = arm.seed;
  }
  if (arm.engine == "exact") {
    // Weight 0 makes f = g: uniform-cost search, optimal when it finishes.
    // Self-limits by node budget instead of a structural gate — it retires
    // gracefully on boards too big to enumerate.
    cfg.weight = 0;
    if (cfg.maxNodes == 0 || cfg.maxNodes > 2000000) {
      cfg.maxNodes = 2000000;
    }
  } else if (arm.engine == "greedy") {
    // Heavily weighted best-first: depth at all costs, the optimizer cleans
    // up afterwards.
    cfg.weight = 64;
  }

  AStar solver(puzzle.gridWidth, puzzle.gridHeight, puzzle.cells, cfg);
  if (onProgress) {
    solver.setOnProgress([&onProgress, progressBase](const uint32_t n) {
      // Offset by the expansions earlier arms already reported, so the
      // page's readout never moves backwards at an arm boundary.
      onProgress(static_cast<uint32_t>(progressBase + n));
    });
  }

  std::vector<Turn> turns;
  if (arm.engine == "cracker") {
    turns = solver.searchCracker(Node(puzzle.blocks));
  } else if (arm.engine == "beam") {
    turns = solver.searchBeam(Node(puzzle.blocks), arm.beamWidth);
  } else {
    turns = solver.search(Node(puzzle.blocks));
  }

  statsOut.nodesExpanded += solver.stats().nodesExpanded;
  statsOut.statesStored =
      std::max(statsOut.statesStored, solver.stats().statesStored);
  statsOut.stoppedOnMemory =
      statsOut.stoppedOnMemory || solver.stats().stoppedOnMemory;
  return turns;
}

// The single-threaded cascade: specialists first (they decline or finish
// fast), the zero-regression weighted arm in the middle, breadth and
// diversified retries after. Fractions are of the TOTAL budget and sum past
// 1 on purpose: later arms only see time that earlier arms declined to use.
struct ChainStep {
  SingleArm arm;
  double budgetShare = 0;
};

// Order re-measured on the first fuzz campaign (30 boards, seeds 5000-5029):
// greedy sat behind wastar+beam and never ran, yet solo it cracked the two
// single-region boards nothing else touched (seed 5012 goal in 6s, seed 5028
// two-block coverage in ~20s) — so it now runs directly after the
// zero-regression arm, whose share shrank to make room.
constexpr double kExactShare = 0.10;
constexpr double kCrackerShare = 0.25;
constexpr double kWastarShare = 0.40;
constexpr double kGreedyShare = 0.25;
constexpr double kBeamShare = 0.25;
constexpr double kRetryShare = 0.20;
constexpr double kTailShare = 0.15;

constexpr ChainStep kCascade[] = {
    {.arm = {.engine = "exact", .gated = true}, .budgetShare = kExactShare},
    {.arm = {.engine = "cracker", .gated = true}, .budgetShare = kCrackerShare},
    {.arm = {.engine = "wastar", .weight = 2, .overrideWeight = true},
     .budgetShare = kWastarShare},
    {.arm = {.engine = "greedy"}, .budgetShare = kGreedyShare},
    {.arm = {.engine = "beam", .beamWidth = 50000}, .budgetShare = kBeamShare},
    {.arm = {.engine = "cracker", .seed = 1}, .budgetShare = kRetryShare},
    {.arm = {.engine = "wastar", .weight = 4, .overrideWeight = true},
     .budgetShare = kTailShare},
    {.arm = {.engine = "wastar", .weight = 1, .overrideWeight = true},
     .budgetShare = kTailShare},
};

} // namespace

namespace {

// Region decomposition. A block's footprint is a rectangle and may never
// cover an Unplayable cell, so a block can neither straddle nor jump a wall:
// every block stays inside its starting 4-connected playable region forever.
// Regions are therefore fully independent sub-puzzles — solving each alone
// and concatenating the plans is sound, and it collapses the product state
// space that defeats every arm on multi-region boards (found by the fuzz
// campaign's mixed boards, where a single-block coverage region gated the
// cracker out purely because ANOTHER region's blocks raised the count).
struct Region {
  replay::Puzzle sub;   // full-size board, other regions' goals/must-touch
                        // neutralized, only this region's blocks
  bool needsWork = false;
  bool impossible = false; // goals with no blocks to cover them
};

std::vector<Region> decompose(const replay::Puzzle &puzzle) {
  const size_t totalCells = puzzle.cells.size();
  std::vector<int> component(totalCells, -1);
  int componentCount = 0;
  std::vector<uint16_t> stack;
  for (size_t start = 0; start < totalCells; start++) {
    if (puzzle.cells[start] == Tile::Unplayable || component[start] != -1) {
      continue;
    }
    const int id = componentCount++;
    component[start] = id;
    stack.push_back(static_cast<uint16_t>(start));
    while (!stack.empty()) {
      const uint16_t idx = stack.back();
      stack.pop_back();
      const int cx = idx % puzzle.gridWidth;
      const int cy = idx / puzzle.gridWidth;
      constexpr std::array kSteps = {std::pair{1, 0}, std::pair{-1, 0},
                                     std::pair{0, 1}, std::pair{0, -1}};
      for (const auto &[dx, dy] : kSteps) {
        const int nx = cx + dx;
        const int ny = cy + dy;
        if (nx < 0 || nx >= puzzle.gridWidth || ny < 0 ||
            ny >= puzzle.gridHeight) {
          continue;
        }
        const auto nidx = static_cast<uint16_t>(nx + ny * puzzle.gridWidth);
        if (puzzle.cells[nidx] == Tile::Unplayable || component[nidx] != -1) {
          continue;
        }
        component[nidx] = id;
        stack.push_back(nidx);
      }
    }
  }
  if (componentCount <= 1) {
    return {};
  }

  std::vector<Region> regions(static_cast<size_t>(componentCount));
  for (size_t r = 0; r < regions.size(); r++) {
    Region &region = regions[r];
    region.sub.gridWidth = puzzle.gridWidth;
    region.sub.gridHeight = puzzle.gridHeight;
    region.sub.cells = puzzle.cells;
    for (size_t i = 0; i < totalCells; i++) {
      if (component[i] != static_cast<int>(r) &&
          (region.sub.cells[i] == Tile::MustTouch ||
           region.sub.cells[i] == Tile::Goal)) {
        region.sub.cells[i] = Tile::Regular;
      }
      if (component[i] == static_cast<int>(r) &&
          (puzzle.cells[i] == Tile::MustTouch ||
           puzzle.cells[i] == Tile::Goal)) {
        region.needsWork = true;
      }
    }
  }
  for (const auto &block : puzzle.blocks) {
    const auto anchor =
        static_cast<size_t>(block.x + block.y * puzzle.gridWidth);
    const int id = component[anchor];
    if (id >= 0) {
      regions[static_cast<size_t>(id)].sub.blocks.push_back(block);
    }
  }
  for (auto &region : regions) {
    bool hasGoal = false;
    for (size_t i = 0; i < totalCells; i++) {
      if (region.sub.cells[i] == Tile::Goal) {
        hasGoal = true;
        break;
      }
    }
    if ((hasGoal || region.needsWork) && region.sub.blocks.empty()) {
      region.impossible = true;
    }
  }
  return regions;
}

} // namespace

namespace arms {

bool knownEngine(const std::string &engine) {
  return std::ranges::any_of(kEngines,
                             [&](const char *e) { return engine == e; });
}

namespace {

Outcome solveUndecomposed(
    const replay::Puzzle &puzzle, const ArmSpec &spec,
    const AStar::Config &cfg,
    const std::function<void(uint32_t)> &onProgress,
    const std::function<void(const std::string &)> &onArmStart) {
  Outcome outcome;

  if (spec.engine != "cascade") {
    const SingleArm arm{.engine = spec.engine,
                        .gated = spec.gated,
                        .beamWidth = spec.beamWidth};
    if (onArmStart) {
      onArmStart(spec.engine);
    }
    outcome.turns =
        runSingle(puzzle, arm, cfg, outcome.stats, onProgress, 0);
    outcome.arm = spec.engine;
    return outcome;
  }

  // An unlimited cascade would let its first non-declining arm run forever;
  // give it the browser's default ceiling instead.
  const uint32_t totalMs = cfg.maxMs == 0 ? 300000 : cfg.maxMs;
  const uint64_t deadline = nowMs() + totalMs;

  for (const auto &[arm, budgetShare] : kCascade) {
    const uint64_t now = nowMs();
    if (now >= deadline) {
      break;
    }
    AStar::Config armCfg = cfg;
    armCfg.maxMs = static_cast<uint32_t>(
        std::min<uint64_t>(deadline - now,
                           static_cast<uint64_t>(budgetShare * totalMs)));
    if (onArmStart) {
      onArmStart(std::string(arm.engine));
    }
    const uint64_t progressBase = outcome.stats.nodesExpanded;
    auto turns =
        runSingle(puzzle, arm, armCfg, outcome.stats, onProgress, progressBase);
    if (!turns.empty()) {
      outcome.turns = std::move(turns);
      outcome.arm = arm.engine;
      return outcome;
    }
  }
  outcome.arm = "none";
  return outcome;
}

} // namespace

Outcome solve(const replay::Puzzle &puzzle, const ArmSpec &spec,
              const AStar::Config &cfg,
              const std::function<void(uint32_t)> &onProgress,
              const std::function<void(const std::string &)> &onArmStart) {
  // Independent playable regions decompose into independent sub-puzzles
  // solved one after another (cascade only, so a named engine still measures
  // exactly one engine on the whole board).
  if (spec.engine == "cascade") {
    const auto regions = decompose(puzzle);
    if (!regions.empty()) {
      Outcome outcome;
      const uint32_t totalMs = cfg.maxMs == 0 ? 300000 : cfg.maxMs;
      const uint64_t deadline = nowMs() + totalMs;
      for (const auto &region : regions) {
        if (region.impossible) {
          outcome.turns.clear();
          outcome.arm = "decompose:impossible";
          return outcome;
        }
        if (!region.needsWork) {
          continue;
        }
        const uint64_t now = nowMs();
        if (now >= deadline) {
          outcome.turns.clear();
          outcome.arm = "none";
          return outcome;
        }
        AStar::Config regionCfg = cfg;
        regionCfg.maxMs = static_cast<uint32_t>(deadline - now);
        const uint64_t progressBase = outcome.stats.nodesExpanded;
        const Outcome sub = solveUndecomposed(
            region.sub, spec, regionCfg,
            onProgress ? std::function(
                             [&onProgress, progressBase](const uint32_t n) {
                               onProgress(static_cast<uint32_t>(
                                   progressBase + n));
                             })
                       : std::function<void(uint32_t)>{},
            onArmStart);
        outcome.stats.nodesExpanded += sub.stats.nodesExpanded;
        outcome.stats.stoppedOnMemory =
            outcome.stats.stoppedOnMemory || sub.stats.stoppedOnMemory;
        if (sub.turns.empty()) {
          outcome.turns.clear();
          outcome.arm = "none";
          return outcome;
        }
        outcome.turns.insert(outcome.turns.end(), sub.turns.begin(),
                             sub.turns.end());
        outcome.arm = outcome.arm.empty() || outcome.arm == sub.arm
                          ? sub.arm
                          : outcome.arm + "+" + sub.arm;
      }
      if (!outcome.turns.empty()) {
        outcome.arm = "decompose:" + outcome.arm;
      }
      return outcome;
    }
  }
  return solveUndecomposed(puzzle, spec, cfg, onProgress, onArmStart);
}

#ifdef __EMSCRIPTEN_PTHREADS__

namespace {

// One entry per racing thread; mirrors the TS bridge's PORTFOLIO so the
// isolated and non-isolated paths run the same arm set.
constexpr SingleArm kPortfolio[] = {
    {.engine = "exact", .gated = true},
    {.engine = "cracker", .gated = true},
    {.engine = "wastar", .weight = 2, .overrideWeight = true},
    {.engine = "greedy"},
    {.engine = "beam", .beamWidth = 50000},
    {.engine = "cracker", .seed = 1},
    {.engine = "wastar", .weight = 4, .overrideWeight = true},
    {.engine = "wastar", .weight = 1, .overrideWeight = true},
};
constexpr int kArmCount = static_cast<int>(std::size(kPortfolio));

} // namespace

Outcome solveParallel(
    const replay::Puzzle &puzzle, const AStar::Config &cfg,
    const std::function<void(uint32_t)> &onProgress,
    const std::function<void(const std::string &)> &onArmStart) {
  // Multi-region boards go through the decomposition path: per-region
  // cascades beat racing eight arms against the regions' product space.
  if (!decompose(puzzle).empty()) {
    return solve(puzzle, ArmSpec{}, cfg, onProgress, onArmStart);
  }
  Outcome outcome;
  const uint32_t totalMs = cfg.maxMs == 0 ? 300000 : cfg.maxMs;
  const uint64_t heapMax = memprobe::heapCeilingBytes();

  std::atomic<bool> cancel{false};
  std::atomic<int> winner{-1};
  std::atomic<int> finished{0};
  std::array<std::atomic<uint32_t>, kArmCount> progress{};
  std::array<std::vector<Turn>, kArmCount> results;
  std::array<AStar::SearchStats, kArmCount> armStats{};

  {
    std::array<std::thread, kArmCount> threads;
    for (int i = 0; i < kArmCount; i++) {
      threads[static_cast<size_t>(i)] = std::thread([&, i] {
        AStar::Config armCfg = cfg;
        armCfg.maxMs = totalMs;
        armCfg.cancel = &cancel;
        if (heapMax != 0) {
          // 85%: all arms allocate into ONE heap, and the probe's live-bytes
          // reading trails the true peak between checkpoints.
          armCfg.maxHeapBytes = heapMax / 100 * 85;
        }
        auto turns = runSingle(
            puzzle, kPortfolio[static_cast<size_t>(i)], armCfg,
            armStats[static_cast<size_t>(i)],
            [&progress, i](const uint32_t n) {
              progress[static_cast<size_t>(i)].store(
                  n, std::memory_order_relaxed);
            },
            0);
        if (!turns.empty()) {
          int expected = -1;
          if (winner.compare_exchange_strong(expected, i)) {
            results[static_cast<size_t>(i)] = std::move(turns);
            cancel.store(true);
          }
        }
        finished.fetch_add(1);
      });
    }

    // Only this (the module's own) thread may talk to JS: poll the arm
    // progress atomics and forward the sum.
    while (finished.load() < kArmCount) {
      std::this_thread::sleep_for(std::chrono::milliseconds(200));
      if (onProgress) {
        uint64_t sum = 0;
        for (const auto &p : progress) {
          sum += p.load(std::memory_order_relaxed);
        }
        onProgress(static_cast<uint32_t>(sum));
      }
    }
    for (auto &t : threads) {
      t.join();
    }
  }

  for (int i = 0; i < kArmCount; i++) {
    outcome.stats.nodesExpanded += armStats[static_cast<size_t>(i)].nodesExpanded;
    outcome.stats.stoppedOnMemory =
        outcome.stats.stoppedOnMemory ||
        armStats[static_cast<size_t>(i)].stoppedOnMemory;
  }

  if (const int w = winner.load(); w >= 0) {
    outcome.turns = std::move(results[static_cast<size_t>(w)]);
    outcome.arm = kPortfolio[static_cast<size_t>(w)].engine;
    return outcome;
  }

  // Every arm came back empty inside the race; retry the arms one at a time
  // with the whole heap to themselves.
  if (onArmStart) {
    onArmStart("sequential");
  }
  AStar::Config seqCfg = cfg;
  if (heapMax != 0) {
    seqCfg.maxHeapBytes = heapMax / 100 * 90;
  }
  const uint64_t progressBase = outcome.stats.nodesExpanded;
  ArmSpec cascade;
  const Outcome seq = solve(
      puzzle, cascade, seqCfg,
      onProgress
          ? std::function(
                [&onProgress, progressBase](const uint32_t n) {
                  onProgress(static_cast<uint32_t>(progressBase + n));
                })
          : std::function<void(uint32_t)>{},
      onArmStart);
  outcome.turns = seq.turns;
  outcome.arm = seq.arm;
  outcome.stats.nodesExpanded += seq.stats.nodesExpanded;
  outcome.stats.stoppedOnMemory =
      outcome.stats.stoppedOnMemory || seq.stats.stoppedOnMemory;
  return outcome;
}

#endif // __EMSCRIPTEN_PTHREADS__

} // namespace arms
