#include "SolverArms.h"

#include "Node.h"
#include "PuzzleProfile.h"
#include "SolverClock.h"

#include <algorithm>
#include <array>
#include <optional>
#include <string_view>
#include <utility>

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
      forEachNeighbor(puzzle.gridWidth, puzzle.gridHeight, idx,
                      [&puzzle, &dist, &next, &depth,
                       extraWalls](const uint16_t nidx) {
                        if (dist[nidx] != UINT16_MAX ||
                            puzzle.cells[nidx] == Tile::Unplayable ||
                            (extraWalls != nullptr &&
                             extraWalls->test(nidx))) {
                          return;
                        }
                        dist[nidx] = depth;
                        next.push_back(nidx);
                      });
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
// A pose fits when its footprint stays on the board and clear of both
// Unplayable cells and extraWalls.
bool posePassable(const replay::Puzzle &puzzle,
                  const boost::dynamic_bitset<> &extraWalls,
                  const Block &pose) {
  if (pose.x < 0 || pose.y < 0 || pose.x + pose.width > puzzle.gridWidth ||
      pose.y + pose.depth > puzzle.gridHeight) {
    return false;
  }
  for (int8_t px = pose.x; px < pose.x + static_cast<int8_t>(pose.width);
       px++) {
    for (int8_t py = pose.y; py < pose.y + static_cast<int8_t>(pose.depth);
         py++) {
      if (const auto idx = positionToIndex(px, py, puzzle.gridWidth);
          puzzle.cells[idx] == Tile::Unplayable || extraWalls.test(idx)) {
        return false;
      }
    }
  }
  return true;
}

// Fold a pose's footprint into the per-cell minimum roll distance.
void markCover(std::vector<uint16_t> &cover, const uint8_t gridWidth,
               const Block &pose, const uint16_t d) {
  for (int8_t px = pose.x; px < pose.x + static_cast<int8_t>(pose.width);
       px++) {
    for (int8_t py = pose.y; py < pose.y + static_cast<int8_t>(pose.depth);
         py++) {
      auto &best = cover[positionToIndex(px, py, gridWidth)];
      best = std::min(best, d);
    }
  }
}

std::vector<uint16_t> coverField(const replay::Puzzle &puzzle,
                                 const Block &start,
                                 const boost::dynamic_bitset<> &extraWalls) {
  const size_t totalCells = puzzle.cells.size();
  std::vector<uint16_t> cover(totalCells, UINT16_MAX);

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
    return orient * totalCells + static_cast<size_t>(pose.x) +
           static_cast<size_t>(pose.y) * static_cast<size_t>(puzzle.gridWidth);
  };

  std::vector<uint16_t> dist(totalCells * 6, UINT16_MAX);
  std::vector frontier{start};
  dist[stateIdx(start, orientIdx(start))] = 0;
  markCover(cover, puzzle.gridWidth, start, 0);
  std::vector<Block> next;
  uint16_t depth = 0;
  const auto expandPose = [&](const Block &pose) {
    using enum Direction;
    constexpr std::array kDirs = {UP, RIGHT, DOWN, LEFT};
    for (const auto dir : kDirs) {
      Block moved = pose.clone();
      moved.roll(dir);
      if (!posePassable(puzzle, extraWalls, moved)) {
        continue;
      }
      auto &seen = dist[stateIdx(moved, orientIdx(moved))];
      if (seen != UINT16_MAX) {
        continue;
      }
      seen = depth;
      markCover(cover, puzzle.gridWidth, moved, depth);
      next.push_back(moved);
    }
  };
  while (!frontier.empty()) {
    next.clear();
    depth++;
    for (const auto &pose : frontier) {
      expandPose(pose);
    }
    frontier.swap(next);
  }
  return cover;
}

// Offset a progress callback by the expansions earlier arms/legs/regions
// already reported, so the page's readout never moves backwards at a
// boundary. The wrapper holds a REFERENCE to onProgress: it must not
// outlive the callback it wraps.
std::function<void(uint32_t)> offsetProgress(
    const std::function<void(uint32_t)> &onProgress,
    const uint64_t progressBase) {
  if (!onProgress) {
    return {};
  }
  return [&onProgress, progressBase](const uint32_t n) {
    onProgress(static_cast<uint32_t>(progressBase + n));
  };
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
  solver.setOnProgress(offsetProgress(onProgress, progressAt));
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

// Shared read-side context for the two-block coverage machinery: the real
// board, the base config, and the stats/progress plumbing every leg shares.
struct SplitContext {
  const replay::Puzzle &puzzle;
  const AStar::Config &base;
  AStar::SearchStats &stats;
  const std::function<void(uint32_t)> &onProgress;
  uint64_t progressBase = 0;
};

// Per-attempt knobs for one chunked-alternation run.
struct ChunkOptions {
  size_t firstIdx = 0;
  bool wallForeign = false;
  size_t chunkCount = 4;
  bool farthestFirst = false;
  uint32_t legMs = 0;
  uint64_t deadline = 0;
};

constexpr uint32_t kMaxBacktracks = 64;
constexpr uint32_t kMaxLegSeeds = 3;

// Chunked alternation, the scheme for boards whose witness INTERLEAVES the
// two blocks (fuzz-7007's class — an all-A-then-all-B plan walls the second
// block into pockets). Alternate short legs A1 B1 A2 B2 …: each leg runs
// the single-block cracker against the active block's nearest still-open
// chunk of its share, re-planned from the real mid state (satisfied cells
// and the parked partner are walls). Every leg's plan is applied to the
// REAL board before the next leg, and the concatenation must survive a full
// replay at the end.
class ChunkedAlternation {
public:
  ChunkedAlternation(const SplitContext &ctx,
                     const std::vector<uint8_t> &shareOf,
                     const ChunkOptions &opts)
      : ctx_(ctx), shareOf_(shareOf), opts_(opts),
        totalCells_(ctx.puzzle.cells.size()), cur_(ctx.puzzle.blocks),
        sat_(ctx.puzzle.cells.size()), active_(opts.firstIdx) {
    for (size_t i = 0; i < totalCells_; i++) {
      if (ctx_.puzzle.cells[i] == Tile::MustTouch) {
        chunkSize_[shareOf_[i]]++;
      }
    }
    for (auto &size : chunkSize_) {
      size = std::max<size_t>(1, (size + opts_.chunkCount - 1) /
                                     opts_.chunkCount);
    }
    for (const auto &b : cur_) {
      sat_ = b.updateMustTouchCells(ctx_.puzzle.gridWidth, ctx_.puzzle.cells,
                                    sat_);
    }
    baselineDead_ = deadCount();
  }

  std::vector<Turn> run() {
    using enum Step;
    while (true) {
      if (nowMs() >= opts_.deadline) {
        return {};
      }
      if (!anyOpenCell()) {
        break;
      }
      const Step step = runStep();
      if (step == Solved) {
        return plan_;
      }
      if (step == Dead) {
        return {};
      }
    }
    if (const auto outcome = replay::replayTurns(ctx_.puzzle, plan_);
        outcome.legal && outcome.solvedAtEnd) {
      return plan_;
    }
    return {};
  }

private:
  enum class Step : uint8_t { Continue, Solved, Dead };
  enum class HandOutcome : uint8_t { Done, Failed, Aborted };
  enum class ApplyResult : uint8_t { Progress, NoProgress, UnknownBlock };
  struct Leg {
    std::vector<Turn> turns;
    bool aborted = false;
  };
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

    LegSnap(std::vector<Block> blocksIn, boost::dynamic_bitset<> satIn,
            const size_t planLenIn, const size_t activeIn,
            const uint32_t seedBumpIn)
        : blocks(std::move(blocksIn)), sat(std::move(satIn)),
          planLen(planLenIn), active(activeIn), seedBump(seedBumpIn) {}
    LegSnap(const LegSnap &) = default;
    LegSnap &operator=(const LegSnap &) = default;
    LegSnap(LegSnap &&) noexcept = default;
    LegSnap &operator=(LegSnap &&) noexcept = default;
    ~LegSnap() = default;
  };

  Step runStep() {
    using enum Step;
    const auto candidates = collectCandidates();
    if (candidates.empty()) {
      // Nothing reachable for this block right now — hand over. Two
      // consecutive stuck hands mean neither block can progress from here;
      // rewind to an earlier leg (satisfied cells only accumulate, so
      // waiting cannot help).
      return handOver();
    }
    if (consecFails_[active_] >= 3 && stuckHands_ == 0) {
      // This block keeps failing; let the partner mop at full speed
      // instead of paying a full hand budget every other turn. It gets a
      // real try again once the partner is stuck too (or after a rewind).
      active_ = 1 - active_;
      return Continue;
    }
    const HandOutcome hand = runHand(candidates);
    if (hand == HandOutcome::Aborted) {
      return Dead;
    }
    if (hand == HandOutcome::Failed) {
      consecFails_[active_]++;
      return handOver();
    }
    consecFails_[active_] = 0;
    pendingBump_ = 0;
    stuckHands_ = 0;
    active_ = 1 - active_;
    return tryJointFinish(false) ? Solved : Continue;
  }

  // The current hand cannot progress: pass to the partner, and once both
  // hands are stuck in a row, try the joint finisher and then rewind.
  Step handOver() {
    using enum Step;
    if (++stuckHands_ >= 2) {
      if (tryJointFinish(true)) {
        return Solved;
      }
      return rewind() ? Continue : Dead;
    }
    pendingBump_ = 0;
    active_ = 1 - active_;
    return Continue;
  }

  [[nodiscard]] std::vector<uint16_t> collectCandidates() const {
    boost::dynamic_bitset<> walls = sat_;
    for (const uint16_t idx :
         blockFootprint(cur_[1 - active_], ctx_.puzzle.gridWidth)) {
      walls.set(idx);
    }
    const auto field = coverField(ctx_.puzzle, cur_[active_], walls);

    // The active block's own share first; when that is exhausted or walled
    // off, mop up the partner's share too — the nearest-block assignment is
    // a heuristic, not a commitment.
    std::vector<uint16_t> candidates;
    for (size_t i = 0; i < totalCells_; i++) {
      if (ctx_.puzzle.cells[i] == Tile::MustTouch && !sat_.test(i) &&
          shareOf_[i] == active_ && field[i] != UINT16_MAX) {
        candidates.push_back(static_cast<uint16_t>(i));
      }
    }
    if (candidates.empty()) {
      for (size_t i = 0; i < totalCells_; i++) {
        if (ctx_.puzzle.cells[i] == Tile::MustTouch && !sat_.test(i) &&
            field[i] != UINT16_MAX) {
          candidates.push_back(static_cast<uint16_t>(i));
        }
      }
    }
    // Nearest-first mops outward from the block; farthest-first fills the
    // deepest pockets before they get walled shut and retreats outward —
    // the discipline a coverage walk's witness follows.
    std::ranges::sort(candidates, {},
                      [&field](const uint16_t c) { return field[c]; });
    if (opts_.farthestFirst) {
      std::ranges::reverse(candidates);
    }
    // Backtracked re-runs need STRUCTURAL variety — the ordering terms
    // dominate the seeded jitter, so a reseeded identical hand replays the
    // identical leg. Bump 1 flips the target order, bump 2 rotates it.
    if (pendingBump_ == 1) {
      std::ranges::reverse(candidates);
    } else if (pendingBump_ == 2 && candidates.size() > 1) {
      std::ranges::rotate(candidates, candidates.begin() + 1);
    }
    return candidates;
  }

  // A hand gets a few seed-diversified tries. Each try solves a leg
  // (adaptively halving the target chunk down to one cell when the
  // cracker declines), applies its legal prefix to the real board, and
  // passes two gates: it must satisfy something new, and it must not
  // strand a cell (deadCount growing means some still-open cell became
  // uncoverable by BOTH blocks — walls only accumulate, so that loss is
  // permanent and the leg gets rolled back).
  HandOutcome runHand(const std::vector<uint16_t> &candidates) {
    const std::vector<Block> handCur = cur_;
    const boost::dynamic_bitset<> handSat = sat_;
    const size_t handPlanLen = plan_.size();
    // A hand never gets more than ~1.5 legs of wall clock: a block that is
    // about to fail otherwise burns retries x ladder x legMs while its
    // partner has real work waiting.
    const uint64_t handDeadline = std::min<uint64_t>(
        opts_.deadline, nowMs() + opts_.legMs + opts_.legMs / 2);
    for (uint32_t retry = 0; retry < 2; retry++) {
      Leg leg = solveLeg(candidates, retry, handDeadline);
      if (leg.aborted) {
        return HandOutcome::Aborted;
      }
      if (leg.turns.empty()) {
        continue;
      }
      const ApplyResult applied = applyLegPrefix(leg.turns);
      if (applied == ApplyResult::UnknownBlock) {
        return HandOutcome::Aborted;
      }
      if (applied == ApplyResult::NoProgress) {
        continue;
      }
      history_.emplace_back(handCur, handSat, handPlanLen, active_,
                            pendingBump_);
      return HandOutcome::Done;
    }
    return HandOutcome::Failed;
  }

  [[nodiscard]] Leg solveLeg(const std::vector<uint16_t> &candidates,
                             const uint32_t retry,
                             const uint64_t handDeadline) const {
    AStar::Config legCfg = ctx_.base;
    legCfg.seed = ctx_.base.seed + (pendingBump_ * 2 + retry) * 104729;
    // Every touching move inside the leg must keep every open cell
    // coverable by the active block or the parked partner — the prune
    // that stops dense-blob sweeps from walling off whole regions.
    legCfg.coveragePartner = &cur_[1 - active_];

    size_t tryCount = std::min(candidates.size(), chunkSize_[active_]);
    while (true) {
      const auto [sub, requiredVec] = buildLegPuzzle(candidates, tryCount);
      const uint64_t legNow = nowMs();
      if (legNow >= opts_.deadline) {
        return {.aborted = true};
      }
      if (legNow >= handDeadline) {
        return {};
      }
      if (auto legTurns =
              crackLeg(sub, legCfg,
                       static_cast<uint32_t>(std::min<uint64_t>(
                           opts_.legMs, handDeadline - legNow)),
                       ctx_.stats, ctx_.onProgress,
                       ctx_.progressBase + ctx_.stats.nodesExpanded,
                       requiredVec.empty() ? nullptr : &requiredVec);
          !legTurns.empty() || tryCount == 1) {
        return {.turns = std::move(legTurns)};
      }
      // The coverage-intact prune makes smaller legs strictly easier, so
      // shrink aggressively instead of a long halving ladder.
      tryCount = tryCount > 4 ? tryCount / 4 : 1;
    }
  }

  [[nodiscard]] std::pair<replay::Puzzle, std::vector<uint16_t>>
  buildLegPuzzle(const std::vector<uint16_t> &candidates,
                 const size_t tryCount) const {
    replay::Puzzle sub{.gridWidth = ctx_.puzzle.gridWidth,
                       .gridHeight = ctx_.puzzle.gridHeight,
                       .cells = ctx_.puzzle.cells,
                       .blocks = {cur_[active_]}};
    for (const uint16_t idx :
         blockFootprint(cur_[1 - active_], ctx_.puzzle.gridWidth)) {
      sub.cells[idx] = Tile::Unplayable;
    }
    std::vector<uint16_t> requiredVec;
    if (opts_.wallForeign) {
      // "Avoid" style: everything outside the target chunk is a wall —
      // interaction-free but heavily constrained.
      boost::dynamic_bitset target(totalCells_);
      for (size_t t = 0; t < tryCount; t++) {
        target.set(candidates[t]);
      }
      for (size_t i = 0; i < totalCells_; i++) {
        if (ctx_.puzzle.cells[i] == Tile::MustTouch && !target.test(i)) {
          sub.cells[i] = Tile::Unplayable;
        }
      }
    } else {
      // Subset style: every must-touch cell keeps its real one-shot
      // semantics (crossable once, then a wall the engine tracks), and
      // the cracker is told to chase only the target chunk. Leg plans
      // found this way replay legally on the full board by construction.
      for (size_t i = 0; i < totalCells_; i++) {
        if (ctx_.puzzle.cells[i] == Tile::MustTouch && sat_.test(i)) {
          sub.cells[i] = Tile::Unplayable;
        }
      }
      if (tryCount == 1 && opts_.farthestFirst) {
        // Single-cell fallback always goes for the NEAREST cell — a
        // lone farthest target is the hardest ask in the scheme.
        requiredVec.assign(1, candidates.back());
      } else {
        requiredVec.assign(candidates.begin(),
                           candidates.begin() +
                               static_cast<ptrdiff_t>(tryCount));
      }
    }
    return {std::move(sub), std::move(requiredVec)};
  }

  // Apply the leg's legal PREFIX to the real board. A subset-style leg
  // replays fully by construction; a free prefix that dies early still
  // carries real progress. Snapshot first so the gates can roll back.
  ApplyResult applyLegPrefix(const std::vector<Turn> &legTurns) {
    const std::vector<Block> curSnap = cur_;
    const boost::dynamic_bitset<> satSnap = sat_;
    const size_t planLen = plan_.size();
    for (const auto &turn : legTurns) {
      const auto it = std::ranges::find_if(
          cur_, [&turn](const Block &b) { return b.id == turn.blockId; });
      if (it == cur_.end()) {
        return ApplyResult::UnknownBlock;
      }
      it->roll(turn.direction);
      if (!it->checkValidity(ctx_.puzzle.gridWidth, ctx_.puzzle.gridHeight,
                             ctx_.puzzle.cells, cur_, sat_)) {
        using enum Direction;
        constexpr std::array kInverse = {DOWN, LEFT, UP, RIGHT};
        it->roll(kInverse[std::to_underlying(turn.direction)]);
        break;
      }
      sat_ = it->updateMustTouchCells(ctx_.puzzle.gridWidth, ctx_.puzzle.cells,
                                      sat_);
      plan_.push_back(turn);
    }
    if (sat_.count() == satSnap.count() || deadCount() > baselineDead_) {
      cur_ = curSnap;
      sat_ = satSnap;
      plan_.resize(planLen);
      return ApplyResult::NoProgress;
    }
    return ApplyResult::Progress;
  }

  bool rewind() {
    // Periodic deep rewind: shallow rewinds keep reconverging when the
    // real mistake is a giant early leg, so occasionally jump straight
    // back toward it (but never drain a short history — those snapshots
    // are the only retry capital an attempt has).
    if (backtracks_ % 6 == 5 && history_.size() > 8) {
      const size_t target = history_.size() / 2;
      while (history_.size() > target) {
        history_.pop_back();
      }
    }
    while (!history_.empty() && backtracks_ < kMaxBacktracks) {
      LegSnap snap = std::move(history_.back());
      history_.pop_back();
      backtracks_++;
      if (snap.seedBump + 1 >= kMaxLegSeeds) {
        continue; // this decision point is spent; rewind further
      }
      cur_ = std::move(snap.blocks);
      sat_ = std::move(snap.sat);
      plan_.resize(snap.planLen);
      active_ = snap.active;
      pendingBump_ = snap.seedBump + 1;
      stuckHands_ = 0;
      consecFails_ = {};
      return true;
    }
    return false;
  }

  // The joint finisher: once the alternation has shrunk the board to a
  // small endgame, hand the WHOLE remaining sub-puzzle (both blocks, real
  // one-shot semantics, satisfied cells as walls) to the joint cracker.
  // The joint walk drowned on the full 306-cell board but a sub-100-cell
  // endgame is exactly its size; gated on the open count improving so a
  // stuck plateau does not pay for it repeatedly.
  bool tryJointFinish(const bool atStuckPoint) {
    size_t open = 0;
    for (size_t i = 0; i < totalCells_; i++) {
      if (ctx_.puzzle.cells[i] == Tile::MustTouch && !sat_.test(i)) {
        open++;
      }
    }
    if (open == 0 || open > 100) {
      return false;
    }
    // The after-leg site is gated on (open, backtracks) so a plateau does
    // not pay for the finisher repeatedly; a genuine stuck point is the
    // valuable state and always gets its shot.
    const size_t finisherKey = open * 1000 + backtracks_;
    if (!atStuckPoint && finisherKey == lastFinisherOpen_) {
      return false;
    }
    lastFinisherOpen_ = finisherKey;
    const uint64_t now = nowMs();
    if (now >= opts_.deadline) {
      return false;
    }
    replay::Puzzle fin{.gridWidth = ctx_.puzzle.gridWidth,
                       .gridHeight = ctx_.puzzle.gridHeight,
                       .cells = ctx_.puzzle.cells,
                       .blocks = cur_};
    for (size_t i = 0; i < totalCells_; i++) {
      if (ctx_.puzzle.cells[i] == Tile::MustTouch && sat_.test(i)) {
        fin.cells[i] = Tile::Unplayable;
      }
    }
    AStar::Config finCfg = ctx_.base;
    finCfg.seed = ctx_.base.seed + 31337 + backtracks_;
    finCfg.jointCoverageIntact = true;
    const auto finTurns =
        crackLeg(fin, finCfg,
                 static_cast<uint32_t>(std::min<uint64_t>(
                     4ULL * opts_.legMs, opts_.deadline - now)),
                 ctx_.stats, ctx_.onProgress,
                 ctx_.progressBase + ctx_.stats.nodesExpanded);
    if (finTurns.empty()) {
      return false;
    }
    const size_t planLen = plan_.size();
    plan_.insert(plan_.end(), finTurns.begin(), finTurns.end());
    if (const auto outcome = replay::replayTurns(ctx_.puzzle, plan_);
        outcome.legal && outcome.solvedAtEnd) {
      return true;
    }
    plan_.resize(planLen);
    return false;
  }

  [[nodiscard]] bool anyOpenCell() const {
    for (size_t i = 0; i < totalCells_; i++) {
      if (ctx_.puzzle.cells[i] == Tile::MustTouch && !sat_.test(i)) {
        return true;
      }
    }
    return false;
  }

  // Straggler gate: cells no block can cover any more (pose-BFS with the
  // satisfied cells as walls; the partner is ignored — it can move away, so
  // only the monotone satisfied set counts). A leg that grows this set has
  // stranded a cell for good and gets rolled back.
  [[nodiscard]] size_t deadCount() const {
    const auto f0 = coverField(ctx_.puzzle, cur_[0], sat_);
    const auto f1 = coverField(ctx_.puzzle, cur_[1], sat_);
    size_t dead = 0;
    for (size_t i = 0; i < totalCells_; i++) {
      if (ctx_.puzzle.cells[i] == Tile::MustTouch && !sat_.test(i) &&
          f0[i] == UINT16_MAX && f1[i] == UINT16_MAX) {
        dead++;
      }
    }
    return dead;
  }

  const SplitContext &ctx_;
  const std::vector<uint8_t> &shareOf_;
  ChunkOptions opts_;
  size_t totalCells_ = 0;
  // Counters first (the constructor tallies each share's cells into them),
  // then divided into per-hand chunk sizes with a floor of 1.
  std::array<size_t, 2> chunkSize_ = {0, 0};
  std::vector<Turn> plan_;
  std::vector<Block> cur_;
  boost::dynamic_bitset<> sat_;
  size_t baselineDead_ = 0;
  std::vector<LegSnap> history_;
  uint32_t backtracks_ = 0;
  uint32_t pendingBump_ = 0;
  size_t active_ = 0;
  int stuckHands_ = 0;
  std::array<uint32_t, 2> consecFails_{};
  size_t lastFinisherOpen_ = SIZE_MAX;
};

// One plain-sequential attempt: which block goes first, and whether the
// other block's share of cells becomes walls or plain floor.
struct Attempt {
  size_t firstIdx = 0;
  bool wallForeign = false;
};

// One leg of a plain sequential attempt: nothing to do yields an empty
// plan, a needed-but-unsolved leg yields nullopt and fails the attempt.
std::optional<std::vector<Turn>> solveSequentialLeg(
    const SplitContext &ctx, const replay::Puzzle &sub, const uint32_t perLeg,
    const uint64_t plainDeadline) {
  if (unsatisfiedCount(sub) == 0) {
    return std::vector<Turn>{};
  }
  const uint64_t now = nowMs();
  if (now >= plainDeadline) {
    return std::nullopt;
  }
  auto leg = crackLeg(
      sub, ctx.base,
      static_cast<uint32_t>(std::min<uint64_t>(perLeg, plainDeadline - now)),
      ctx.stats, ctx.onProgress, ctx.progressBase + ctx.stats.nodesExpanded);
  if (leg.empty()) {
    return std::nullopt;
  }
  return leg;
}

// Leg 1: the first block alone against its share of the cells; leg 2: the
// second block against everything still open from the real mid state. The
// sub-puzzle relaxations can suggest but never certify, so the whole plan
// must survive a full replay of the REAL puzzle.
std::vector<Turn> runSequentialAttempt(
    const SplitContext &ctx, const std::array<std::vector<uint16_t>, 2> &fields,
    const boost::dynamic_bitset<> &rootSat, const Attempt &attempt,
    const uint32_t perLeg, const uint64_t plainDeadline) {
  using enum Tile;
  const replay::Puzzle &puzzle = ctx.puzzle;
  const size_t totalCells = puzzle.cells.size();
  const auto &[firstIdx, wallForeign] = attempt;
  const Block &first = puzzle.blocks[firstIdx];
  const Block &second = puzzle.blocks[1 - firstIdx];
  const auto &firstField = fields[firstIdx];
  const auto &secondField = fields[1 - firstIdx];

  // Leg 1: the first block alone against its share of the cells.
  replay::Puzzle sub1{.gridWidth = puzzle.gridWidth,
                      .gridHeight = puzzle.gridHeight,
                      .cells = puzzle.cells,
                      .blocks = {first}};
  for (const uint16_t idx : blockFootprint(second, puzzle.gridWidth)) {
    sub1.cells[idx] = Unplayable;
  }
  for (size_t i = 0; i < totalCells; i++) {
    if (puzzle.cells[i] != MustTouch || rootSat.test(i)) {
      continue;
    }
    if (secondField[i] < firstField[i]) {
      sub1.cells[i] = wallForeign ? Unplayable : Regular;
    }
  }
  const auto leg1 = solveSequentialLeg(ctx, sub1, perLeg, plainDeadline);
  if (!leg1) {
    return {};
  }

  // The mid position on the REAL board decides what leg 2 faces.
  std::vector<Block> midBlocks;
  boost::dynamic_bitset<> midSat;
  if (!replay::applyTurns(puzzle, *leg1, midBlocks, midSat)) {
    return {}; // "free" style tripped over a cell it satisfied en route
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
    sub2.cells[idx] = Unplayable;
  }
  for (size_t i = 0; i < totalCells; i++) {
    if (puzzle.cells[i] == MustTouch && midSat.test(i)) {
      sub2.cells[i] = Unplayable;
    }
  }
  const auto leg2 = solveSequentialLeg(ctx, sub2, perLeg, plainDeadline);
  if (!leg2) {
    return {};
  }

  std::vector<Turn> plan = *leg1;
  plan.insert(plan.end(), leg2->begin(), leg2->end());
  if (const auto outcome = replay::replayTurns(puzzle, plan);
      outcome.legal && outcome.solvedAtEnd) {
    return plan;
  }
  return {};
}

struct ChunkAttempt {
  size_t firstIdx = 0;
  bool wallForeign = false;
  size_t chunks = 4;
  bool farthest = false;
};

// Phase 2: chunked alternation over whatever budget remains. Free style
// first — interleaving witnesses thread through each other's shares, so
// walling foreign cells is usually what deadlocked phase 1; fine chunks
// before coarse for the same reason.
std::vector<Turn> runChunkedPhase(const SplitContext &ctx,
                                  const std::vector<uint8_t> &shareOf,
                                  const uint32_t totalMs,
                                  const uint64_t start) {
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
  const uint32_t legMs = std::clamp<uint32_t>(totalMs / 24, 2000, 8000);
  const uint64_t chunkDeadline = start + totalMs / 8 * 7;
  uint32_t attemptSeed = ctx.base.seed;
  for (const auto &[firstIdx, wallForeign, chunks, farthest] :
       kChunkAttempts) {
    if (nowMs() >= chunkDeadline) {
      break;
    }
    // Each attempt gets its own seed so the leg crackers explore different
    // walk orders instead of replaying one deterministic failure.
    AStar::Config chunkCfg = ctx.base;
    chunkCfg.seed = attemptSeed;
    attemptSeed += 7919;
    const SplitContext attemptCtx{.puzzle = ctx.puzzle,
                                  .base = chunkCfg,
                                  .stats = ctx.stats,
                                  .onProgress = ctx.onProgress,
                                  .progressBase = ctx.progressBase};
    ChunkedAlternation alternation(attemptCtx, shareOf,
                                   {.firstIdx = firstIdx,
                                    .wallForeign = wallForeign,
                                    .chunkCount = chunks,
                                    .farthestFirst = farthest,
                                    .legMs = legMs,
                                    .deadline = chunkDeadline});
    if (auto plan = alternation.run(); !plan.empty()) {
      return plan;
    }
  }
  return {};
}

// Phase 3: the JOINT two-block cracker over the final eighth. The
// historic "joint DFS is useless here" measurement (fixture 34, 8.4M
// expansions, nothing) predates the transit distance field, the orphan
// prune and the joint coverage-intact prune — with those, the joint walk
// holds the exact global one-shot state the leg schemes only
// approximate, so it gets the last word.
std::vector<Turn> runJointPhase(const SplitContext &ctx,
                                const uint64_t deadline) {
  const uint64_t now = nowMs();
  if (now >= deadline) {
    return {};
  }
  AStar::Config jointCfg = ctx.base;
  jointCfg.jointCoverageIntact = true;
  auto turns =
      crackLeg(ctx.puzzle, jointCfg, static_cast<uint32_t>(deadline - now),
               ctx.stats, ctx.onProgress,
               ctx.progressBase + ctx.stats.nodesExpanded);
  if (turns.empty()) {
    return {};
  }
  if (const auto outcome = replay::replayTurns(ctx.puzzle, turns);
      outcome.legal && outcome.solvedAtEnd) {
    return turns;
  }
  return {};
}

// Two-block coverage split, the fix for the fuzz campaign's surviving
// boards: partition the unsatisfied must-touch cells by nearest block, then
// run the single-block cracker per block IN SEQUENCE — the idle block's
// footprint becomes a wall, the other block's share of cells becomes either
// walls ("avoid" style, provably interaction-free) or plain floor ("free"
// style, more connective but the first block may satisfy cells en route).
// Four attempts (2 orders x 2 styles) open the budget; every candidate plan
// must survive a full replay of the REAL puzzle, so the sub-puzzle
// relaxations can suggest but never certify. The bulk of the budget goes to
// chunked alternation (ChunkedAlternation above) for the boards where
// sequential legs are structurally impossible.
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
  const SplitContext ctx{.puzzle = puzzle,
                         .base = base,
                         .stats = statsOut,
                         .onProgress = onProgress,
                         .progressBase = progressBase};

  const auto fields = std::array{
      nearestField(puzzle, blockFootprint(puzzle.blocks[0], puzzle.gridWidth),
                   nullptr),
      nearestField(puzzle, blockFootprint(puzzle.blocks[1], puzzle.gridWidth),
                   nullptr)};

  boost::dynamic_bitset rootSat(totalCells);
  for (const auto &b : puzzle.blocks) {
    rootSat = b.updateMustTouchCells(puzzle.gridWidth, puzzle.cells, rootSat);
  }

  constexpr std::array<Attempt, 4> kAttempts = {
      {{.firstIdx = 0, .wallForeign = true},
       {.firstIdx = 1, .wallForeign = true},
       {.firstIdx = 0, .wallForeign = false},
       {.firstIdx = 1, .wallForeign = false}}};
  const uint32_t perLeg = std::max<uint32_t>(1000, totalMs / 24);
  for (const auto &attempt : kAttempts) {
    if (nowMs() >= plainDeadline) {
      break;
    }
    if (auto plan = runSequentialAttempt(ctx, fields, rootSat, attempt,
                                         perLeg, plainDeadline);
        !plan.empty()) {
      return plan;
    }
  }

  std::vector<uint8_t> shareOf(totalCells, 0);
  for (size_t i = 0; i < totalCells; i++) {
    if (fields[1][i] < fields[0][i]) {
      shareOf[i] = 1;
    }
  }
  if (auto plan = runChunkedPhase(ctx, shareOf, totalMs, start);
      !plan.empty()) {
    return plan;
  }
  return runJointPhase(ctx, deadline);
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
  solver.setOnProgress(offsetProgress(onProgress, progressBase));

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

constexpr auto kCascade = std::to_array<ChainStep>({
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
});

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

// Label the 4-connected playable regions; Unplayable cells stay -1.
std::pair<std::vector<int>, int> labelComponents(const replay::Puzzle &puzzle) {
  const size_t totalCells = puzzle.cells.size();
  std::vector component(totalCells, -1);
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
      forEachNeighbor(puzzle.gridWidth, puzzle.gridHeight, idx,
                      [&puzzle, &component, &stack, id](const uint16_t nidx) {
                        if (puzzle.cells[nidx] == Tile::Unplayable ||
                            component[nidx] != -1) {
                          return;
                        }
                        component[nidx] = id;
                        stack.push_back(nidx);
                      });
    }
  }
  return {std::move(component), componentCount};
}

// One region's sub-puzzle: the full-size board with every OTHER region's
// goals and must-touch cells neutralized.
Region buildRegion(const replay::Puzzle &puzzle,
                   const std::vector<int> &component, const int id) {
  using enum Tile;
  Region region;
  region.sub.gridWidth = puzzle.gridWidth;
  region.sub.gridHeight = puzzle.gridHeight;
  region.sub.cells = puzzle.cells;
  for (size_t i = 0; i < puzzle.cells.size(); i++) {
    if (component[i] != id &&
        (region.sub.cells[i] == MustTouch || region.sub.cells[i] == Goal)) {
      region.sub.cells[i] = Regular;
    }
    if (component[i] == id &&
        (puzzle.cells[i] == MustTouch || puzzle.cells[i] == Goal)) {
      region.needsWork = true;
    }
  }
  return region;
}

std::vector<Region> decompose(const replay::Puzzle &puzzle) {
  const auto [component, componentCount] = labelComponents(puzzle);
  if (componentCount <= 1) {
    return {};
  }

  std::vector<Region> regions;
  regions.reserve(static_cast<size_t>(componentCount));
  for (int id = 0; id < componentCount; id++) {
    regions.push_back(buildRegion(puzzle, component, id));
  }
  for (const auto &block : puzzle.blocks) {
    const auto anchor =
        static_cast<size_t>(block.x + block.y * puzzle.gridWidth);
    if (const int id = component[anchor]; id >= 0) {
      regions[static_cast<size_t>(id)].sub.blocks.push_back(block);
    }
  }
  for (auto &[sub, needsWork, impossible] : regions) {
    const bool hasGoal = std::ranges::contains(sub.cells, Tile::Goal);
    if ((hasGoal || needsWork) && sub.blocks.empty()) {
      impossible = true;
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
    // Floor of 1: maxMs == 0 means UNLIMITED everywhere in this file, so a
    // sub-10ms total budget truncating a share to 0 must not hand the first
    // arm the whole clock.
    armCfg.maxMs = static_cast<uint32_t>(std::max<uint64_t>(
        1, std::min<uint64_t>(deadline - now,
                              static_cast<uint64_t>(budgetShare * totalMs))));
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

// One solve per independent region, plans concatenated in region order.
Outcome solveDecomposed(
    const std::vector<Region> &regions, const ArmSpec &spec,
    const AStar::Config &cfg,
    const std::function<void(uint32_t)> &onProgress,
    const std::function<void(const std::string &)> &onArmStart) {
  Outcome outcome;
  const uint32_t totalMs = cfg.maxMs == 0 ? 300000 : cfg.maxMs;
  const uint64_t deadline = nowMs() + totalMs;
  for (const auto &[regionSub, needsWork, impossible] : regions) {
    if (impossible) {
      outcome.turns.clear();
      outcome.arm = "decompose:impossible";
      return outcome;
    }
    if (!needsWork) {
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
    const auto [subTurns, subArm, subStats] =
        solveUndecomposed(regionSub, spec, regionCfg,
                          offsetProgress(onProgress, progressBase), onArmStart);
    outcome.stats.nodesExpanded += subStats.nodesExpanded;
    outcome.stats.stoppedOnMemory =
        outcome.stats.stoppedOnMemory || subStats.stoppedOnMemory;
    if (subTurns.empty()) {
      outcome.turns.clear();
      outcome.arm = "none";
      return outcome;
    }
    outcome.turns.insert(outcome.turns.end(), subTurns.begin(),
                         subTurns.end());
    outcome.arm = outcome.arm.empty() || outcome.arm == subArm
                      ? subArm
                      : outcome.arm + "+" + subArm;
  }
  if (!outcome.turns.empty()) {
    outcome.arm = "decompose:" + outcome.arm;
  }
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
    if (const auto regions = decompose(puzzle); !regions.empty()) {
      return solveDecomposed(regions, spec, cfg, onProgress, onArmStart);
    }
  }
  return solveUndecomposed(puzzle, spec, cfg, onProgress, onArmStart);
}

#ifdef __EMSCRIPTEN_PTHREADS__

namespace {

// One entry per racing thread; mirrors the TS bridge's PORTFOLIO so the
// isolated and non-isolated paths run the same arm set.
constexpr auto kPortfolio = std::to_array<SingleArm>({
    {.engine = "exact", .gated = true},
    {.engine = "cracker", .gated = true},
    {.engine = "wastar", .weight = 2, .overrideWeight = true},
    {.engine = "greedy"},
    {.engine = "beam", .beamWidth = 50000},
    {.engine = "cracker", .seed = 1},
    {.engine = "wastar", .weight = 4, .overrideWeight = true},
    {.engine = "wastar", .weight = 1, .overrideWeight = true},
});
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
  const Outcome seq =
      solve(puzzle, cascade, seqCfg, offsetProgress(onProgress, progressBase),
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
