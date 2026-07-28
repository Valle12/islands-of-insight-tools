// AStar: heuristics and the goal-cluster machinery.
//
// The three admissible lower bounds combined by heuristic(), the connected
// goal regions they measure against, and the block-to-cluster assignment
// that decides which block is expected to cover which region.

#include "AStar.h"

#include <algorithm>
#include <array>
#include <limits>
#include <queue>


uint32_t AStar::mustTouchHeuristic(const Node &node) const {
  uint32_t unsatisfied = 0;
  uint32_t maxFootprint = 1;
  for (const auto &block : node.blocks) {
    maxFootprint = std::max(maxFootprint,
                            static_cast<uint32_t>(block.width) * block.depth);
  }
  for (const auto &[mx, my, idx] : mustTouchIndices_) {
    if (idx >= node.mustTouchCellsSatisfied.size() ||
        !node.mustTouchCellsSatisfied.test(idx)) {
      unsatisfied++;
    }
  }
  return (unsatisfied + maxFootprint - 1) / maxFootprint;
}

uint32_t AStar::groupedMustTouchHeuristic(const Node &node) const {
  std::array<uint32_t, 256> counts{};
  for (const auto &[mx, my, idx] : mustTouchIndices_) {
    if (idx < node.mustTouchCellsSatisfied.size() &&
        node.mustTouchCellsSatisfied.test(idx)) {
      continue;
    }
    uint8_t bestId = node.blocks[0].id;
    int bestDist = std::numeric_limits<int>::max();
    for (const auto &block : node.blocks) {
      const int d = std::abs(static_cast<int>(block.x) - mx) +
                    std::abs(static_cast<int>(block.y) - my);
      if (d < bestDist) {
        bestDist = d;
        bestId = block.id;
      }
    }
    counts[bestId]++;
  }
  uint32_t maxLowerBound = 0;
  for (const auto &block : node.blocks) {
    const uint32_t count = counts[block.id];
    if (count == 0) {
      continue;
    }
    const uint32_t footprint = static_cast<uint32_t>(block.width) * block.depth;
    maxLowerBound =
        std::max(maxLowerBound, (count + footprint - 1) / footprint);
  }
  return maxLowerBound;
}

uint32_t AStar::goalDistanceHeuristic(const Node &node) const {
  if (goalIndices_.empty()) {
    return 0;
  }
  uint32_t total = 0;
  for (const auto &block : node.blocks) {
    const auto &[cluster, valid] = blockGoalAssignment_[block.id];
    if (!valid || blockCoversGoal(block, cluster)) {
      continue;
    }
    total += std::abs(static_cast<int>(block.x) - cluster.minX) +
             std::abs(static_cast<int>(block.y) - cluster.minY);
  }
  return total;
}

bool AStar::blockCoversGoal(const Block &block, const GoalCluster &goal) const {
  if (block.width != goal.width || block.depth != goal.depth) {
    return false;
  }
  for (int8_t cx = block.x; cx < block.x + static_cast<int8_t>(block.width);
       cx++) {
    for (int8_t cy = block.y; cy < block.y + static_cast<int8_t>(block.depth);
         cy++) {
      if (const auto idx = positionToIndex(cx, cy, gridWidth_);
          idx >= cells_.size() || cells_[idx] != Tile::Goal) {
        return false;
      }
    }
  }
  return true;
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
// Helper: count compatible clusters for a block and return index if unique
// ---------------------------------------------------------------------------
int AStar::countCompatibleClusters(const Block &block,
                                   const std::vector<bool> &taken,
                                   size_t &outIdx) const {
  int count = 0;
  for (size_t i = 0; i < goalClusters_.size(); i++) {
    if (!taken[i] && blockCompatibleWithCluster(block, goalClusters_[i])) {
      outIdx = i;
      if (++count > 1) {
        break;
      }
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// Helper: assign blocks that have exactly one compatible cluster
// ---------------------------------------------------------------------------
void AStar::assignUniqueGoals(const std::vector<Block> &blocks,
                              std::vector<bool> &taken) {
  bool changed = true;
  while (changed) {
    changed = false;
    for (const auto &block : blocks) {
      if (blockGoalAssignment_[block.id].valid) {
        continue;
      }
      size_t compatIdx = std::numeric_limits<size_t>::max();
      if (const int compatCount =
              countCompatibleClusters(block, taken, compatIdx);
          compatCount == 1) {
        blockGoalAssignment_[block.id] = {goalClusters_[compatIdx], true};
        taken[compatIdx] = true;
        changed = true;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helper: greedily assign remaining blocks to nearest compatible cluster
// ---------------------------------------------------------------------------
void AStar::assignGreedyGoals(const std::vector<Block> &blocks,
                              std::vector<bool> &taken) {
  for (const auto &block : blocks) {
    if (blockGoalAssignment_[block.id].valid) {
      continue;
    }
    int bestDist = std::numeric_limits<int>::max();
    size_t bestIdx = std::numeric_limits<size_t>::max();
    for (size_t i = 0; i < goalClusters_.size(); i++) {
      if (taken[i] || !blockCompatibleWithCluster(block, goalClusters_[i])) {
        continue;
      }
      const int d =
          std::abs(static_cast<int>(block.x) - goalClusters_[i].minX) +
          std::abs(static_cast<int>(block.y) - goalClusters_[i].minY);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    if (bestIdx != std::numeric_limits<size_t>::max()) {
      blockGoalAssignment_[block.id] = {goalClusters_[bestIdx], true};
      taken[bestIdx] = true;
    }
  }
}

void AStar::assignBlocksToGoals(const std::vector<Block> &blocks) {
  for (auto &[cluster, valid] : blockGoalAssignment_) {
    valid = false;
  }
  if (goalClusters_.empty()) {
    return;
  }
  // Sized to the actual cluster count: goalClusters_ is one entry per
  // connected Goal component, and a scattered Goal layout on a full-size
  // board produces far more than the 64 a fixed array used to allow — every
  // loop below indexes and writes taken[i] over the whole range.
  std::vector<bool> taken(goalClusters_.size(), false);
  assignUniqueGoals(blocks, taken);
  assignGreedyGoals(blocks, taken);
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

bool AStar::isGoalState(const Node &node) const {
  for (const auto &[mx, my, idx] : mustTouchIndices_) {
    if (idx >= node.mustTouchCellsSatisfied.size() ||
        !node.mustTouchCellsSatisfied.test(idx)) {
      return false;
    }
  }
  if (goalIndices_.empty()) {
    return true;
  }
  size_t satisfied = 0;
  for (const auto &block : node.blocks) {
    if (isBlockFullyOnGoal(block)) {
      satisfied += static_cast<size_t>(block.width) * block.depth;
    }
  }
  return satisfied >= goalIndices_.size();
}

std::vector<Turn> AStar::reconstructPath(const StateMap &states,
                                         const NodeKey &goalSignature) {
  std::vector<Turn> turns;
  NodeKey current = goalSignature;
  while (true) {
    auto it = states.find(current);
    if (it == states.end() || !it->second.hasParent) {
      break;
    }
    turns.push_back(it->second.turn);
    current = it->second.parent;
  }
  std::ranges::reverse(turns);
  return turns;
}

NodeKey AStar::nodeSignature(const Node &node) {
  const auto n = static_cast<uint8_t>(node.blocks.size());
  std::array<uint8_t, 256> indices{};
  for (uint8_t i = 0; i < n; i++) {
    indices[i] = i;
  }
  std::sort(indices.begin(), indices.begin() + n,
            [&](const uint8_t a, const uint8_t b) {
              const auto &ba = node.blocks[a];
              const auto &bb = node.blocks[b];
              if (ba.x != bb.x) {
                return ba.x < bb.x;
              }
              if (ba.y != bb.y) {
                return ba.y < bb.y;
              }
              if (ba.width != bb.width) {
                return ba.width < bb.width;
              }
              return ba.depth < bb.depth;
            });
  return buildSignature(
      n, indices.data(),
      [&node](const uint8_t i) -> const Block & { return node.blocks[i]; },
      node.mustTouchCellsSatisfied);
}

NodeKey AStar::signatureFromParts(const std::vector<Block> &blocks,
                                  const size_t replaceIdx,
                                  const Block &replacement,
                                  const boost::dynamic_bitset<> &mustTouch) {
  const auto n = static_cast<uint8_t>(blocks.size());
  std::array<uint8_t, 256> indices{};
  for (uint8_t i = 0; i < n; i++) {
    indices[i] = i;
  }
  std::sort(indices.begin(), indices.begin() + n,
            [&](const uint8_t a, const uint8_t b) {
              const auto &ba = a == replaceIdx ? replacement : blocks[a];
              const auto &bb = b == replaceIdx ? replacement : blocks[b];
              if (ba.x != bb.x) {
                return ba.x < bb.x;
              }
              if (ba.y != bb.y) {
                return ba.y < bb.y;
              }
              if (ba.width != bb.width) {
                return ba.width < bb.width;
              }
              return ba.depth < bb.depth;
            });
  return buildSignature(
      n, indices.data(),
      [replaceIdx, &replacement, &blocks](const uint8_t i) -> const Block & {
        return i == replaceIdx ? replacement : blocks[i];
      },
      mustTouch);
}

// buildSignature is a template defined in AStar.h

