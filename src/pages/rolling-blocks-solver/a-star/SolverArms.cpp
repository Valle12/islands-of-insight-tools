#include "SolverArms.h"

#include "Node.h"
#include "PuzzleProfile.h"
#include "SolverClock.h"

#include <algorithm>
#include <array>
#include <cassert>
#include <compare>
#include <iterator>
#include <map>
#include <optional>
#include <set>
#include <string_view>
#include <utility>
#include <type_traits>

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
    // `positionToIndex` casts to uint16_t, so a block sitting off the board
    // arrives here as ~65535 and this store would land ~120 KB past `dist`.
    // Nothing upstream rejects an off-board block: neither `capsError` at the
    // wasm boundary nor `AStar::inputWithinCaps` looks at x/y.
    if (idx >= dist.size())
      continue;
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

// Per-attempt knobs for one leg-order search.
struct ChunkOptions {
  bool wallForeign = false;
  // Per-leg cap. Deliberately short: successful legs land in single-digit
  // milliseconds, so a tight cap costs almost no solutions and buys an
  // order of magnitude more exploration.
  uint32_t legMs = 500;
  uint64_t deadline = 0;
  size_t beamWidth = 12;
};

// A board position mid-search: where the blocks stand, which cells are
// satisfied, and the plan that produced it.
struct LegState {
  std::vector<Block> blocks;
  boost::dynamic_bitset<> sat;
  std::vector<Turn> plan;

  // dynamic_bitset is generic over allocators and so does not mark its move
  // noexcept, which makes the implicit move here potentially throwing — and
  // LegStates live inside Nodes inside vectors, where that means every
  // relocation copies the bitset instead of stealing it. With the default
  // allocator the move is a vector move and cannot throw. Declaring these
  // drops the aggregate initialization (hence the assignments in run()).
  LegState() = default;
  LegState(const LegState &) = default;
  LegState &operator=(const LegState &) = default;
  LegState(LegState &&) noexcept = default;
  LegState &operator=(LegState &&) noexcept = default;
  ~LegState() = default;
};

// One leg's shape: which block moves, which of its reachable cells it
// aims at (by rank in the distance ordering, optionally counted from the
// far end), and how many consecutive cells it tries to take at once.
//
// Small targets are the whole point. A leg that asks for a big chunk of a
// dense blob usually FAILS, and a failed leg costs its entire time budget
// while telling the search nothing — measured on the 7007 endgame, 14 of
// 15 whole-share legs came back empty and the frontier never grew past one
// node. One-cell legs land in milliseconds, so the search gets the breadth
// it needs and the thing being searched becomes the cell ORDER.
struct LegChoice {
  size_t active = 0;
  size_t targetRank = 0;
  size_t chunk = 1;
  bool farthest = false;
};

// A cell is passable while it is not a wall: satisfied must-touch cells are
// walls forever (the game's one-shot rule), so passability only shrinks.
bool cellPassable(const replay::Puzzle &puzzle,
                  const boost::dynamic_bitset<> &sat, const size_t idx) {
  return puzzle.cells[idx] != Tile::Unplayable &&
         !(puzzle.cells[idx] == Tile::MustTouch && sat.test(idx));
}

// Open cells with at most one way in. A pocket-end has to be entered from
// its single neighbor and left the same way, so every one of them is a
// future deadlock the ordering has to spend a visit on.
size_t countFragile(const replay::Puzzle &puzzle,
                    const boost::dynamic_bitset<> &sat) {
  size_t fragile = 0;
  for (size_t i = 0; i < puzzle.cells.size(); i++) {
    if (puzzle.cells[i] != Tile::MustTouch || sat.test(i)) {
      continue;
    }
    size_t ways = 0;
    forEachNeighbor(puzzle.gridWidth, puzzle.gridHeight,
                    static_cast<uint16_t>(i),
                    [&puzzle, &sat, &ways](const uint16_t nidx) {
                      ways += cellPassable(puzzle, sat, nidx) ? 1 : 0;
                    });
    if (ways <= 1) {
      fragile++;
    }
  }
  return fragile;
}

// Connected pieces of still-passable floor that hold open cells: the
// remaining work split into how many separate errands. Each extra piece is
// a transit the blocks may no longer be able to make.
size_t countOpenRegions(const replay::Puzzle &puzzle,
                        const boost::dynamic_bitset<> &sat) {
  const size_t totalCells = puzzle.cells.size();
  std::vector<bool> seen(totalCells, false);
  std::vector<uint16_t> stack;
  size_t regions = 0;
  for (size_t start = 0; start < totalCells; start++) {
    if (seen[start] || !cellPassable(puzzle, sat, start)) {
      continue;
    }
    bool hasOpen = false;
    seen[start] = true;
    stack.push_back(static_cast<uint16_t>(start));
    while (!stack.empty()) {
      const uint16_t idx = stack.back();
      stack.pop_back();
      hasOpen = hasOpen || puzzle.cells[idx] == Tile::MustTouch;
      forEachNeighbor(puzzle.gridWidth, puzzle.gridHeight, idx,
                      [&puzzle, &sat, &seen, &stack](const uint16_t nidx) {
                        if (seen[nidx] || !cellPassable(puzzle, sat, nidx)) {
                          return;
                        }
                        seen[nidx] = true;
                        stack.push_back(nidx);
                      });
    }
    if (hasOpen) {
      regions++;
    }
  }
  return regions;
}

// How healthy a position is. `open` is the progress axis; `dead` is the
// hard gate (a cell neither block can reach any more is a lost board); the
// other two are the SHAPE of what is left, which is what separates two
// equally-far-along positions into one that finishes and one that
// deadlocks three legs later.
struct StateScore {
  size_t open = 0;
  size_t dead = 0;
  size_t fragile = 0;
  size_t regions = 0;
};

StateScore scoreState(const replay::Puzzle &puzzle, const LegState &state) {
  const auto reachA = coverField(puzzle, state.blocks[0], state.sat);
  const auto reachB = coverField(puzzle, state.blocks[1], state.sat);
  StateScore score;
  for (size_t i = 0; i < puzzle.cells.size(); i++) {
    if (puzzle.cells[i] != Tile::MustTouch || state.sat.test(i)) {
      continue;
    }
    score.open++;
    if (reachA[i] == UINT16_MAX && reachB[i] == UINT16_MAX) {
      score.dead++;
    }
  }
  score.fragile = countFragile(puzzle, state.sat);
  score.regions = countOpenRegions(puzzle, state.sat);
  return score;
}

constexpr uint64_t kOpenWeight = 1000;

// Lower is better, and progress is LEXICALLY first: the shape terms are
// capped below the per-cell weight so they can only order positions that
// are equally far along. Letting them cross that line was measured to
// stall the search outright — a leg that satisfies one cell but leaves
// three new pocket-ends scored worse than its own parent, so the frontier
// kept abandoning the line it had just advanced and thrashed among shallow
// positions (227 open where a plain greedy dive reaches 96).
uint64_t stateCost(const StateScore &score) {
  const uint64_t shape = 2ULL * score.fragile + 4ULL * score.regions;
  return kOpenWeight * score.open + std::min<uint64_t>(shape, kOpenWeight - 1);
}

// The split scheme is two-block by construction — runSplitCoverage returns
// empty for any other count — which is what lets a pose key be a fixed-size
// array instead of a vector.
constexpr size_t kSplitBlocks = 2;
constexpr size_t kPoseBytes = 5;

// Closed-set key. The satisfied set is monotone and the blocks' poses are
// the rest of the state, so an exact repeat means a different leg order
// reached the same position — the one that got there first was at least as
// cheap, and re-expanding is pure waste.
struct StateKey {
  std::array<uint8_t, kSplitBlocks * kPoseBytes> poses{};
  boost::dynamic_bitset<> sat;

  // Keys live in a std::set, which only ever needs `<` — but a three-way
  // comparison is what the ordering actually is, and `<` is rewritten from
  // it. dynamic_bitset has no <=> of its own, so its half is spelled out
  // from the same `<` the previous operator used: same order, same set.
  std::strong_ordering operator<=>(const StateKey &other) const {
    if (const auto cmp = poses <=> other.poses;
        cmp != std::strong_ordering::equal) {
      return cmp;
    }
    if (sat < other.sat) {
      return std::strong_ordering::less;
    }
    if (other.sat < sat) {
      return std::strong_ordering::greater;
    }
    return std::strong_ordering::equal;
  }

  // As for LegState: a dynamic_bitset member costs the implicit move its
  // noexcept, and these keys are moved into the closed set.
  StateKey() = default;
  StateKey(const StateKey &) = default;
  StateKey &operator=(const StateKey &) = default;
  StateKey(StateKey &&) noexcept = default;
  StateKey &operator=(StateKey &&) noexcept = default;
  ~StateKey() = default;
};

// The five above exist ONLY to promise noexcept, so pin the promise: a member
// whose own move is not noexcept would otherwise quietly reintroduce the
// copy-on-reallocation this avoids, and nothing would say so. It also puts the
// two operators the rule of five obliges us to declare to real use — they are
// what cpp:S1144 reports as unused, and deleting either leaves the type
// unassignable by any route.
static_assert(std::is_nothrow_move_constructible_v<StateKey>);
static_assert(std::is_nothrow_move_assignable_v<StateKey>);

StateKey makeKey(const LegState &state) {
  // `poses` is sized for the two blocks the scheme is gated on; a third
  // would run off the end rather than fail a comparison.
  assert(state.blocks.size() <= kSplitBlocks);
  StateKey key;
  key.sat = state.sat;
  size_t at = 0;
  for (const auto &b : state.blocks) {
    key.poses[at++] = static_cast<uint8_t>(b.x);
    key.poses[at++] = static_cast<uint8_t>(b.y);
    key.poses[at++] = b.width;
    key.poses[at++] = b.depth;
    key.poses[at++] = b.height;
  }
  return key;
}

// The cells this leg may chase: the active block's own share first, and
// when that is exhausted or walled off, the partner's too — the
// nearest-block partition is a heuristic, not a commitment. Ordered by
// pose-space distance, nearest or deepest first per the choice.
std::vector<uint16_t> collectCandidates(const SplitContext &ctx,
                                        const std::vector<uint8_t> &shareOf,
                                        const LegState &state,
                                        const size_t active) {
  const size_t totalCells = ctx.puzzle.cells.size();
  boost::dynamic_bitset<> walls = state.sat;
  for (const uint16_t idx :
       blockFootprint(state.blocks[1 - active], ctx.puzzle.gridWidth)) {
    walls.set(idx);
  }
  const auto field = coverField(ctx.puzzle, state.blocks[active], walls);

  std::vector<uint16_t> candidates;
  const auto gather = [&](const bool ownShareOnly) {
    for (size_t i = 0; i < totalCells; i++) {
      if (ctx.puzzle.cells[i] != Tile::MustTouch || state.sat.test(i) ||
          field[i] == UINT16_MAX) {
        continue;
      }
      if (!ownShareOnly || shareOf[i] == active) {
        candidates.push_back(static_cast<uint16_t>(i));
      }
    }
  };
  gather(true);
  if (candidates.empty()) {
    gather(false);
  }
  std::ranges::sort(candidates, {},
                    [&field](const uint16_t c) { return field[c]; });
  return candidates;
}

// The single-block sub-puzzle for one leg. "Avoid" style walls every
// foreign must-touch cell (interaction-free but heavily constrained);
// subset style keeps the real one-shot semantics everywhere and merely
// tells the cracker which cells this leg is responsible for, so the plan
// replays legally on the full board by construction.
std::pair<replay::Puzzle, std::vector<uint16_t>>
buildLegPuzzle(const SplitContext &ctx, const LegState &state,
               const size_t active, const std::vector<uint16_t> &targets,
               const bool wallForeign) {
  const size_t totalCells = ctx.puzzle.cells.size();
  replay::Puzzle sub{.gridWidth = ctx.puzzle.gridWidth,
                     .gridHeight = ctx.puzzle.gridHeight,
                     .cells = ctx.puzzle.cells,
                     .blocks = {state.blocks[active]}};
  for (const uint16_t idx :
       blockFootprint(state.blocks[1 - active], ctx.puzzle.gridWidth)) {
    sub.cells[idx] = Tile::Unplayable;
  }
  std::vector<uint16_t> requiredVec;
  if (wallForeign) {
    boost::dynamic_bitset wanted(totalCells);
    for (const uint16_t idx : targets) {
      wanted.set(idx);
    }
    for (size_t i = 0; i < totalCells; i++) {
      if (ctx.puzzle.cells[i] == Tile::MustTouch && !wanted.test(i)) {
        sub.cells[i] = Tile::Unplayable;
      }
    }
  } else {
    for (size_t i = 0; i < totalCells; i++) {
      if (ctx.puzzle.cells[i] == Tile::MustTouch && state.sat.test(i)) {
        sub.cells[i] = Tile::Unplayable;
      }
    }
    requiredVec = targets;
  }
  return {std::move(sub), std::move(requiredVec)};
}

// Apply the leg's legal PREFIX to `state`. A subset-style leg replays whole
// by construction; a prefix that dies early still carries real progress.
// Returns whether anything new got satisfied.
bool applyLegPrefix(const SplitContext &ctx, LegState &state,
                    const std::vector<Turn> &legTurns) {
  const size_t before = state.sat.count();
  for (const auto &turn : legTurns) {
    const auto it = std::ranges::find_if(
        state.blocks,
        [&turn](const Block &b) { return b.id == turn.blockId; });
    if (it == state.blocks.end()) {
      return false;
    }
    it->roll(turn.direction);
    if (!it->checkValidity(ctx.puzzle.gridWidth, ctx.puzzle.gridHeight,
                           ctx.puzzle.cells, state.blocks, state.sat)) {
      using enum Direction;
      constexpr std::array kInverse = {DOWN, LEFT, UP, RIGHT};
      it->roll(kInverse[std::to_underlying(turn.direction)]);
      break;
    }
    state.sat = it->updateMustTouchCells(ctx.puzzle.gridWidth,
                                         ctx.puzzle.cells, state.sat);
    state.plan.push_back(turn);
  }
  return state.sat.count() > before;
}

// Once the alternation has shrunk the board to a small endgame, hand the
// WHOLE remainder (both blocks, real one-shot semantics, satisfied cells as
// walls) to the joint cracker: the joint walk drowns on a 300-cell board
// but a sub-100-cell endgame is exactly its size.
constexpr size_t kJointFinishOpen = 100;
constexpr uint64_t kJointFinishMs = 10000;
constexpr uint64_t kBulkLegFactor = 6;
constexpr size_t kBulkShareDivisor = 8;
constexpr size_t kChildrenPerExpansion = 4;
constexpr size_t kMaxReserve = 4000;

std::vector<Turn> jointFinish(const SplitContext &ctx, const LegState &state,
                              const uint32_t budgetMs, const uint32_t seed) {
  replay::Puzzle fin{.gridWidth = ctx.puzzle.gridWidth,
                     .gridHeight = ctx.puzzle.gridHeight,
                     .cells = ctx.puzzle.cells,
                     .blocks = state.blocks};
  for (size_t i = 0; i < ctx.puzzle.cells.size(); i++) {
    if (ctx.puzzle.cells[i] == Tile::MustTouch && state.sat.test(i)) {
      fin.cells[i] = Tile::Unplayable;
    }
  }
  AStar::Config finCfg = ctx.base;
  finCfg.seed = seed;
  finCfg.jointCoverageIntact = true;
  return crackLeg(fin, finCfg, budgetMs, ctx.stats, ctx.onProgress,
                  ctx.progressBase + ctx.stats.nodesExpanded);
}

// A real search over leg ORDER — the scheme for boards whose witness
// INTERLEAVES the two blocks (fuzz-7007's class, where an
// all-A-then-all-B plan walls the second block into pockets).
//
// Its predecessor walked ONE greedy chunk sequence and could only repair it
// by rewinding a bounded number of legs, which was measured to be far too
// little: the mistake on those boards is the ORDER itself, usually several
// legs back, and the position that pays for it still looks like the best
// one available. So here every position is a node, every leg is an edge,
// and the frontier is expanded best-first on how healthy the REMAINING
// board looks (see stateCost). A promising-but-doomed line simply loses to
// a sibling instead of having to be unwound step by step.
class LegOrderSearch {
public:
  LegOrderSearch(const SplitContext &ctx, const std::vector<uint8_t> &shareOf,
                 const ChunkOptions &opts)
      : ctx_(ctx), shareOf_(shareOf), opts_(opts) {
    for (size_t i = 0; i < ctx_.puzzle.cells.size(); i++) {
      if (ctx_.puzzle.cells[i] == Tile::MustTouch) {
        bulkChunk_[shareOf_[i]]++;
      }
    }
    for (auto &size : bulkChunk_) {
      size = std::max<size_t>(1, size / kBulkShareDivisor);
    }
  }

  std::vector<Turn> run() {
    LegState root;
    root.blocks = ctx_.puzzle.blocks;
    root.sat = boost::dynamic_bitset(ctx_.puzzle.cells.size());
    for (const auto &b : root.blocks) {
      root.sat = b.updateMustTouchCells(ctx_.puzzle.gridWidth,
                                        ctx_.puzzle.cells, root.sat);
    }
    const StateScore rootScore = scoreState(ctx_.puzzle, root);
    baselineDead_ = rootScore.dead;
    push(std::move(root), rootScore);

    while (nowMs() < opts_.deadline) {
      if (frontier_.empty() && !refillFromReserve()) {
        break;
      }
      if (auto solved = expand(popBest()); !solved.empty()) {
        return solved;
      }
    }
    return {};
  }

private:
  struct Node {
    LegState state;
    uint64_t cost = 0;
    size_t open = 0;
    size_t lastActive = SIZE_MAX;
  };

  // The successor set of every position, per block. It has to span chunk
  // SIZES, not just which cell comes next: big sweeps are where the cheap
  // progress is (one leg can land dozens of cells when the neighborhood
  // is open), while single-cell legs are the ones that still land in a
  // dense blob where every big ask fails. Offering both lets the search
  // take bulk progress while it is available and switch to precision when
  // it is not — the greedy scheme had to be configured for one or the
  // other up front, per attempt.
  static constexpr std::array<LegChoice, 12> kChoices = {{
      {.active = 0, .targetRank = 0, .chunk = 0, .farthest = false},
      {.active = 1, .targetRank = 0, .chunk = 0, .farthest = false},
      {.active = 0, .targetRank = 0, .chunk = 8, .farthest = false},
      {.active = 1, .targetRank = 0, .chunk = 8, .farthest = false},
      {.active = 0, .targetRank = 0, .chunk = 1, .farthest = false},
      {.active = 1, .targetRank = 0, .chunk = 1, .farthest = false},
      {.active = 0, .targetRank = 1, .chunk = 1, .farthest = false},
      {.active = 1, .targetRank = 1, .chunk = 1, .farthest = false},
      {.active = 0, .targetRank = 2, .chunk = 1, .farthest = false},
      {.active = 1, .targetRank = 2, .chunk = 1, .farthest = false},
      {.active = 0, .targetRank = 0, .chunk = 1, .farthest = true},
      {.active = 1, .targetRank = 0, .chunk = 1, .farthest = true},
  }};

  enum class Step : uint8_t { None, Solved };

  // One side's worth of successors. `wanted` is the block that should move
  // (SIZE_MAX at the root, where either may); a solved child short-circuits
  // the whole search through `out`.
  Step expandSide(const Node &node, const size_t wanted, size_t &born,
                  std::vector<Turn> &out) {
    for (const auto &choice : kChoices) {
      if (nowMs() >= opts_.deadline || born >= kChildrenPerExpansion) {
        return Step::None;
      }
      if (wanted != SIZE_MAX && choice.active != wanted) {
        continue;
      }
      auto child = growChild(node, choice);
      if (!child) {
        continue;
      }
      if (child->open == 0) {
        if (auto plan = validated(child->state.plan); !plan.empty()) {
          out = std::move(plan);
          return Step::Solved;
        }
        continue;
      }
      child->lastActive = choice.active;
      born++;
      pushNode(std::move(*child));
    }
    return Step::None;
  }

  std::vector<Turn> expand(const Node &node) {
    if (auto finished = tryJointFinish(node); !finished.empty()) {
      return finished;
    }
    std::vector<Turn> out;
    // ALTERNATE first. Cost is dominated by progress, so a frontier left
    // to its own devices keeps handing the next leg to whichever block
    // just gained the most — it mono-block dives and walls itself in,
    // which is the exact failure the two-block scheme exists to avoid
    // (measured: without this the search stalled at 227 open where the
    // alternating predecessor reached 96). Same-block legs are still
    // available, but only once the partner has nothing to offer.
    size_t born = 0;
    // The root has no previous mover, so neither side is "the partner" and
    // every choice is allowed — which is exactly expandSide's SIZE_MAX
    // wildcard. Spelled out because `1 - lastActive` reached the same
    // children only by wrapping to 2, matching no choice, and falling
    // through to the second pass.
    const size_t partner =
        node.lastActive == SIZE_MAX ? SIZE_MAX : 1 - node.lastActive;
    if (const Step step = expandSide(node, partner, born, out);
        step != Step::None) {
      return out;
    }
    if (born == 0 && partner != SIZE_MAX) {
      if (const Step step = expandSide(node, node.lastActive, born, out);
          step != Step::None) {
        return out;
      }
    }
    return {};
  }

  // A stable per-choice salt so siblings get different cracker walks.
  [[nodiscard]] static uint32_t seedOf(const LegChoice &choice) {
    return static_cast<uint32_t>(choice.active * 7U + choice.targetRank * 3U +
                                 choice.chunk + (choice.farthest ? 1U : 0U));
  }

  // The cells this choice aims at: a slice of the distance ordering,
  // counted from the near end or (farthest) the deep end. Candidates are
  // recomputed per choice because the two blocks see different fields.
  [[nodiscard]] std::vector<uint16_t>
  pickTargets(const LegState &state, const LegChoice &choice) const {
    const auto candidates =
        collectCandidates(ctx_, shareOf_, state, choice.active);
    if (choice.targetRank >= candidates.size()) {
      return {};
    }
    if (choice.farthest) {
      return {candidates.back()};
    }
    const size_t from = choice.targetRank;
    const size_t want = choice.chunk == 0 ? bulkChunk_[choice.active]
                                          : choice.chunk;
    const size_t to = std::min(candidates.size(), from + want);
    return {candidates.begin() + static_cast<ptrdiff_t>(from),
            candidates.begin() + static_cast<ptrdiff_t>(to)};
  }

  // One leg from `node`: pick the targets, solve them with the
  // single-block cracker, apply the legal prefix, and keep the result only
  // if it made progress without stranding a cell for good.
  [[nodiscard]] std::optional<Node> growChild(const Node &node,
                                              const LegChoice &choice) const {
    const auto targets = pickTargets(node.state, choice);
    if (targets.empty()) {
      return std::nullopt;
    }
    const auto [sub, requiredVec] = buildLegPuzzle(
        ctx_, node.state, choice.active, targets, opts_.wallForeign);

    const uint64_t now = nowMs();
    if (now >= opts_.deadline) {
      return std::nullopt;
    }
    AStar::Config legCfg = ctx_.base;
    // Every touching move inside the leg must keep every open cell
    // coverable by the active block or the parked partner.
    legCfg.coveragePartner = &node.state.blocks[1 - choice.active];
    // Distinct seed per (position, choice): with one shared seed the
    // cracker's restarts and jitter reproduce the same walk for every
    // sibling, which collapses them into duplicates the closed set then
    // throws away — the frontier starves on its own determinism.
    legCfg.seed = ctx_.base.seed +
                  static_cast<uint32_t>(node.state.plan.size() * 2654435761U +
                                        seedOf(choice) * 104729U);
    const uint64_t legBudget =
        opts_.legMs * (targets.size() >= 8 ? kBulkLegFactor : 1);
    const auto legTurns = crackLeg(
        sub, legCfg,
        static_cast<uint32_t>(
            std::min<uint64_t>(legBudget, opts_.deadline - now)),
        ctx_.stats, ctx_.onProgress,
        ctx_.progressBase + ctx_.stats.nodesExpanded,
        requiredVec.empty() ? nullptr : &requiredVec);
    if (legTurns.empty()) {
      return std::nullopt;
    }

    LegState next = node.state;
    if (!applyLegPrefix(ctx_, next, legTurns)) {
      return std::nullopt;
    }
    const StateScore score = scoreState(ctx_.puzzle, next);
    if (score.dead > baselineDead_) {
      return std::nullopt; // this leg stranded a cell permanently
    }
    return Node{.state = std::move(next),
                .cost = stateCost(score),
                .open = score.open};
  }

  // Gated on a NEW best open count: the finisher is worth a real slice of
  // budget exactly once per depth the search has never reached before.
  std::vector<Turn> tryJointFinish(const Node &node) {
    if (node.open == 0 || node.open > kJointFinishOpen ||
        node.open >= bestFinishOpen_) {
      return {};
    }
    bestFinishOpen_ = node.open;
    const uint64_t now = nowMs();
    if (now >= opts_.deadline) {
      return {};
    }
    // A real slice, not a multiple of the (deliberately tiny) leg cap: the
    // finisher is a whole two-block endgame search, and it only runs on
    // positions deeper than anything the search has reached before.
    const auto finTurns = jointFinish(
        ctx_, node.state,
        static_cast<uint32_t>(
            std::min<uint64_t>(kJointFinishMs, opts_.deadline - now)),
        ctx_.base.seed + 31337 + static_cast<uint32_t>(node.open));
    if (finTurns.empty()) {
      return {};
    }
    std::vector<Turn> plan = node.state.plan;
    plan.insert(plan.end(), finTurns.begin(), finTurns.end());
    return validated(plan);
  }

  [[nodiscard]] std::vector<Turn>
  validated(const std::vector<Turn> &plan) const {
    if (const auto outcome = replay::replayTurns(ctx_.puzzle, plan);
        outcome.legal && outcome.solvedAtEnd) {
      return plan;
    }
    return {};
  }

  void push(LegState state, const StateScore &score) {
    pushNode({.state = std::move(state),
              .cost = stateCost(score),
              .open = score.open});
  }

  void pushNode(Node node) {
    if (!closed_.insert(makeKey(node.state)).second) {
      return;
    }
    frontier_.push_back(std::move(node));
    if (frontier_.size() > opts_.beamWidth * 4) {
      prune();
    }
  }

  // The frontier is a bounded beam, but two things go wrong if pruning
  // simply keeps the best-cost nodes and drops the rest.
  //
  // It collapses onto ONE lineage: cost is dominated by progress, so the
  // deepest line's siblings crowd out everything else and the search
  // degenerates into the greedy dive it exists to replace — and when that
  // line turns out to be doomed, every position left shares its fatal
  // prefix. Capping how many survivors sit at the same depth keeps
  // genuinely earlier, less-committed positions to back out to.
  //
  // And it STARVES: most legs fail on a dense board, so nodes routinely
  // produce no surviving child, and a frontier that can only shrink hits
  // zero (measured on fuzz-7007: exhausted after 2.3 s of a 180 s budget).
  // The overflow goes to a reserve the search refills from instead.
  void prune() {
    std::ranges::sort(frontier_, {}, &Node::cost);
    const size_t perDepth = std::max<size_t>(4, opts_.beamWidth / 2);
    std::map<size_t, size_t> keptAtDepth;
    std::vector<Node> kept;
    kept.reserve(opts_.beamWidth);
    for (auto &node : frontier_) {
      size_t &atDepth = keptAtDepth[node.open];
      if (kept.size() < opts_.beamWidth && atDepth < perDepth) {
        atDepth++;
        kept.push_back(std::move(node));
      } else {
        reserve_.push_back(std::move(node));
      }
    }
    frontier_ = std::move(kept);
    if (reserve_.size() > kMaxReserve) {
      std::ranges::sort(reserve_, {}, &Node::cost);
      reserve_.resize(kMaxReserve);
    }
  }

  // Beam-with-backtracking: an emptied frontier means every line currently
  // in hand dead-ended, so resume from the best positions set aside
  // earlier rather than declaring the whole search finished.
  bool refillFromReserve() {
    if (reserve_.empty()) {
      return false;
    }
    std::ranges::sort(reserve_, {}, &Node::cost);
    const size_t take = std::min(opts_.beamWidth, reserve_.size());
    frontier_.assign(std::make_move_iterator(reserve_.begin()),
                     std::make_move_iterator(reserve_.begin() +
                                             static_cast<ptrdiff_t>(take)));
    reserve_.erase(reserve_.begin(),
                   reserve_.begin() + static_cast<ptrdiff_t>(take));
    return true;
  }

  Node popBest() {
    const auto best = std::ranges::min_element(frontier_, {}, &Node::cost);
    Node node = std::move(*best);
    frontier_.erase(best);
    return node;
  }

  const SplitContext &ctx_;
  const std::vector<uint8_t> &shareOf_;
  ChunkOptions opts_;
  // A bulk leg asks for this many of a block's own cells at once — the
  // size the greedy predecessor used, which on fuzz-7007 turned a 20-cell
  // ask into an 80-cell sweep because the walk satisfies whatever else it
  // crosses on the way.
  std::array<size_t, 2> bulkChunk_ = {0, 0};
  std::vector<Node> frontier_;
  std::vector<Node> reserve_;
  std::set<StateKey> closed_;
  size_t baselineDead_ = 0;
  size_t bestFinishOpen_ = SIZE_MAX;
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

// One leg-order search configuration: how foreign cells are treated, how
// wide the frontier is, and what fraction of the phase budget it gets.
struct ChunkAttempt {
  bool wallForeign = false;
  size_t beamWidth = 12;
  uint32_t share = 1;
};

// Phase 2: the leg-order search over whatever budget remains. Free style
// first — interleaving witnesses thread through each other's shares, so
// walling foreign cells is usually what deadlocked phase 1. The attempts
// vary only what the search cannot vary internally: chunk granularity,
// foreign-cell style, and how much breadth the frontier keeps.
std::vector<Turn> runChunkedPhase(const SplitContext &ctx,
                                  const std::vector<uint8_t> &shareOf,
                                  const uint32_t totalMs,
                                  const uint64_t start) {
  // Measured on fuzz-7007 at a 180 s budget: the narrow free-style search
  // reached 92 open cells and was still improving when its slice ran out,
  // while the same window spent on the "avoid" style reached only 235. So
  // the productive configuration gets the bulk of the phase and the wider
  // frontier gets the rest; walling foreign cells is left to phase 1,
  // which is built around exactly that relaxation.
  constexpr std::array<ChunkAttempt, 2> kChunkAttempts = {{
      {.wallForeign = false, .beamWidth = 12, .share = 2},
      {.wallForeign = false, .beamWidth = 40, .share = 1},
  }};
  // Absolute cap on leg time: scaling legs with the budget just makes each
  // leg slower without adding exploration — more legs and more branching
  // beat longer legs (measured on fuzz-7007: 570 s explored no more leg
  // orders than 300 s when legs scaled).
  const uint32_t legMs = std::clamp<uint32_t>(totalMs / 120, 200, 1000);
  const uint64_t chunkDeadline = start + totalMs / 8 * 7;
  uint32_t attemptSeed = ctx.base.seed;
  uint32_t sharesLeft = 0;
  for (const auto &attempt : kChunkAttempts) {
    sharesLeft += attempt.share;
  }
  for (const auto &[wallForeign, beamWidth, share] : kChunkAttempts) {
    const uint64_t now = nowMs();
    if (now >= chunkDeadline) {
      break;
    }
    // Proportional slices, with whatever an exhausted attempt leaves behind
    // rolling into the next one.
    const uint64_t attemptDeadline =
        now + (chunkDeadline - now) * share / sharesLeft;
    sharesLeft -= share;
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
    LegOrderSearch search(attemptCtx, shareOf,
                          {.wallForeign = wallForeign,
                           .legMs = legMs,
                           .deadline = attemptDeadline,
                           .beamWidth = beamWidth});
    if (auto plan = search.run(); !plan.empty()) {
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
// the leg-order search (LegOrderSearch above) for the boards where
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
    // Bounds per AXIS, and BEFORE flattening. A negative anchor casts to
    // SIZE_MAX, and the id read back out of bounds then indexes `regions` — an
    // out-of-range WRITE, not just a bad read. Checking the flat index alone
    // does not catch every off-board block though: x = -1 with y = 1 flattens
    // back INTO range as the last cell of row 0, and would file the block
    // under a region it is nowhere near. An off-board block belongs to no
    // region; leaving it out is what the `sub.blocks.empty()` pass below
    // already knows how to handle.
    if (block.x < 0 || block.y < 0 || block.x >= puzzle.gridWidth ||
        block.y >= puzzle.gridHeight)
      continue;
    const size_t anchor = static_cast<size_t>(block.x) +
                          static_cast<size_t>(block.y) * puzzle.gridWidth;
    if (anchor >= component.size())
      continue;
    if (const int id = component[anchor];
        id >= 0 && static_cast<size_t>(id) < regions.size()) {
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
