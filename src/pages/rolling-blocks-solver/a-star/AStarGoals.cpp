// AStar: heuristics and the goal-cluster machinery.
//
// The lower bounds combined by heuristic(), the connected goal regions they
// measure against, and the goal test. All of it works on decoded scratch
// states (a blocks vector plus a cell-indexed must-touch bitset) — block ids
// in here are slot indices from decodeState, never real ids, so nothing may
// key persistent data on them.

#include "AStar.h"

#include <algorithm>
#include <array>
#include <limits>
#include <queue>

uint32_t AStar::heuristic(const std::vector<Block> &blocks,
                          const boost::dynamic_bitset<> &mustTouch,
                          const boost::dynamic_bitset<> &ordinal) {
  return std::max({mustTouchHeuristic(blocks, ordinal),
                   groupedMustTouchHeuristic(blocks, mustTouch),
                   goalDistanceHeuristic(blocks)});
}

uint32_t
AStar::mustTouchHeuristic(const std::vector<Block> &blocks,
                          const boost::dynamic_bitset<> &ordinal) const {
  uint32_t maxFootprint = 1;
  for (const auto &block : blocks) {
    maxFootprint = std::max(maxFootprint,
                            static_cast<uint32_t>(block.width) * block.depth);
  }
  const auto unsatisfied =
      static_cast<uint32_t>(mustTouchIndices_.size() - ordinal.count());
  return (unsatisfied + maxFootprint - 1) / maxFootprint;
}

// Group each unsatisfied must-touch cell with its nearest block, then bound
// every group by that block's footprint. Blocks are addressed by INDEX — the
// grouping is symmetric under permuting same-shaped blocks, which keeps it
// coherent with the canonical (id-free) state encoding.
uint32_t
AStar::groupedMustTouchHeuristic(const std::vector<Block> &blocks,
                                 const boost::dynamic_bitset<> &mustTouch) {
  groupScratch_.assign(blocks.size(), 0);
  for (const auto &[mx, my, idx] : mustTouchIndices_) {
    if (mustTouch.test(idx)) {
      continue;
    }
    size_t bestIdx = 0;
    int bestDist = std::numeric_limits<int>::max();
    for (size_t i = 0; i < blocks.size(); i++) {
      const int d = std::abs(static_cast<int>(blocks[i].x) - mx) +
                    std::abs(static_cast<int>(blocks[i].y) - my);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    groupScratch_[bestIdx]++;
  }
  uint32_t maxLowerBound = 0;
  for (size_t i = 0; i < blocks.size(); i++) {
    const uint32_t count = groupScratch_[i];
    if (count == 0) {
      continue;
    }
    const uint32_t footprint =
        static_cast<uint32_t>(blocks[i].width) * blocks[i].depth;
    maxLowerBound =
        std::max(maxLowerBound, (count + footprint - 1) / footprint);
  }
  return maxLowerBound;
}

// Minimum-cost matching of clusters to distinct compatible blocks, computed
// per state from geometry alone. The previous per-id assignment table is
// meaningless under the canonical encoding, where physically interchangeable
// blocks trade identities freely between states; a plain per-cluster minimum
// let one block "cover" several clusters and blew up goal-bearing fixtures
// five-fold; a greedy claim in cluster order oscillated between neighbouring
// states and was far worse. The optimal matching is the strongest bound of
// this family AND permutation-symmetric. Subset DP over clusters: dp[S] =
// cheapest way to serve cluster set S with the blocks seen so far.
uint32_t AStar::goalDistanceHeuristic(const std::vector<Block> &blocks) {
  if (goalIndices_.empty()) {
    return 0;
  }
  constexpr int kInf = std::numeric_limits<int>::max() / 2;
  const size_t numClusters = goalClusters_.size();
  // 2^C states: past 12 clusters fall back to "0" rather than blow up the
  // per-successor cost; such boards are goal-scatter puzzles the must-touch
  // bounds carry anyway.
  if (numClusters > 12) {
    return 0;
  }
  const size_t full = (size_t{1} << numClusters) - 1;
  matchDp_.assign(full + 1, kInf);
  matchDp_[0] = 0;
  for (const auto &block : blocks) {
    for (size_t s = full; s > 0; s--) {
      if (matchDp_[s] >= kInf) {
        continue;
      }
      for (size_t c = 0; c < numClusters; c++) {
        if ((s >> c & 1u) != 0) {
          continue;
        }
        if (!blockCompatibleWithCluster(block, goalClusters_[c])) {
          continue;
        }
        const int d =
            std::abs(static_cast<int>(block.x) - goalClusters_[c].minX) +
            std::abs(static_cast<int>(block.y) - goalClusters_[c].minY);
        matchDp_[s | size_t{1} << c] =
            std::min(matchDp_[s | size_t{1} << c], matchDp_[s] + d);
      }
    }
    // s == 0 seeds single-cluster assignments for this block.
    for (size_t c = 0; c < numClusters; c++) {
      if (blockCompatibleWithCluster(block, goalClusters_[c])) {
        const int d =
            std::abs(static_cast<int>(block.x) - goalClusters_[c].minX) +
            std::abs(static_cast<int>(block.y) - goalClusters_[c].minY);
        matchDp_[size_t{1} << c] =
            std::min(matchDp_[size_t{1} << c], d);
      }
    }
  }
  // The best over all subsets of maximal size that are actually assignable:
  // clusters no block fits contribute nothing, matching the old behaviour of
  // simply leaving them unassigned.
  if (matchDp_[full] < kInf) {
    return static_cast<uint32_t>(matchDp_[full]);
  }
  int best = 0;
  for (size_t s = 0; s <= full; s++) {
    if (matchDp_[s] < kInf) {
      best = std::max(best, matchDp_[s]);
    }
  }
  return static_cast<uint32_t>(best);
}

// ---------------------------------------------------------------------------
// Helper: BFS to find a connected component of Goal cells
// ---------------------------------------------------------------------------
void AStar::discoverGoalComponent(
    int8_t startX, int8_t startY, std::vector<bool> &visited,
    std::vector<std::pair<int8_t, int8_t>> &component) const {

  std::queue<std::pair<int8_t, int8_t>> q;
  q.emplace(startX, startY);
  visited[positionToIndex(startX, startY, gridWidth_)] = true;

  while (!q.empty()) {
    auto [cx, cy] = q.front();
    q.pop();
    component.emplace_back(cx, cy);
    for (int i = 0; i < 4; i++) {
      constexpr std::array<int8_t, 4> dys = {1, -1, 0, 0};
      constexpr std::array<int8_t, 4> dxs = {0, 0, 1, -1};
      const auto nx = static_cast<int8_t>(cx + dxs[i]);
      const auto ny = static_cast<int8_t>(cy + dys[i]);
      if (nx < 0 || nx >= gridWidth_ || ny < 0 || ny >= gridHeight_) {
        continue;
      }
      const auto nidx = positionToIndex(nx, ny, gridWidth_);
      if (cells_[nidx] != Tile::Goal || visited[nidx]) {
        continue;
      }
      visited[nidx] = true;
      q.emplace(nx, ny);
    }
  }
}

std::vector<GoalCluster> AStar::precomputeGoalClusters() const {
  const size_t totalCells = static_cast<size_t>(gridWidth_) * gridHeight_;
  std::vector visited(totalCells, false);
  std::vector<GoalCluster> clusters;

  for (int8_t x = 0; x < static_cast<int8_t>(gridWidth_); x++) {
    for (int8_t y = 0; y < static_cast<int8_t>(gridHeight_); y++) {
      if (const auto idx = positionToIndex(x, y, gridWidth_);
          cells_[idx] != Tile::Goal || visited[idx]) {
        continue;
      }
      std::vector<std::pair<int8_t, int8_t>> component;
      discoverGoalComponent(x, y, visited, component);

      int8_t minX = component[0].first;
      int8_t maxX = component[0].first;
      int8_t minY = component[0].second;
      int8_t maxY = component[0].second;
      for (const auto &[cx, cy] : component) {
        minX = std::min(minX, cx);
        maxX = std::max(maxX, cx);
        minY = std::min(minY, cy);
        maxY = std::max(maxY, cy);
      }
      clusters.push_back({minX, maxX, minY, maxY,
                          static_cast<uint8_t>(maxX - minX + 1),
                          static_cast<uint8_t>(maxY - minY + 1)});
    }
  }
  return clusters;
}

bool AStar::blockCompatibleWithCluster(const Block &block,
                                       const GoalCluster &cluster) {
  const std::array<std::array<uint8_t, 2>, 6> dims = {
      {{block.width, block.depth},
       {block.height, block.depth},
       {block.width, block.height},
       {block.depth, block.width},
       {block.depth, block.height},
       {block.height, block.width}}};
  // Six entries, compared directly: the bitmask dedup this used to carry
  // hashed (w, d) down to 5 bits, where the width dropped out entirely and
  // distinct pairs with congruent depths aliased onto one another — skipping
  // a genuine match. Deduplicating six comparisons was never worth that.
  return std::ranges::any_of(dims, [&cluster](const auto &wd) {
    return wd[0] == cluster.width && wd[1] == cluster.depth;
  });
}

// ---------------------------------------------------------------------------
// Helper: check if a single block is fully on Goal cells
// ---------------------------------------------------------------------------
bool AStar::isBlockFullyOnGoal(const Block &block) const {
  for (int8_t cx = block.x; cx < block.x + static_cast<int8_t>(block.width);
       cx++) {
    for (int8_t cy = block.y; cy < block.y + static_cast<int8_t>(block.depth);
         cy++) {
      if (cells_[positionToIndex(cx, cy, gridWidth_)] != Tile::Goal) {
        return false;
      }
    }
  }
  return true;
}

bool AStar::isGoalState(const std::vector<Block> &blocks,
                        const boost::dynamic_bitset<> &ordinal) const {
  // all() is vacuously true on an empty bitset, matching "no must-touch
  // cells" — and is a word-wise scan, not a per-cell loop.
  if (!ordinal.all()) {
    return false;
  }
  if (goalIndices_.empty()) {
    return true;
  }
  size_t satisfied = 0;
  for (const auto &block : blocks) {
    if (isBlockFullyOnGoal(block)) {
      satisfied += static_cast<size_t>(block.width) * block.depth;
    }
  }
  // Footprints are disjoint and every counted cell is a Goal cell, so the sum
  // equals the number of DISTINCT goal cells covered — ">=" is only ever
  // reachable as "==", i.e. this is an exact-cover test.
  return satisfied >= goalIndices_.size();
}
