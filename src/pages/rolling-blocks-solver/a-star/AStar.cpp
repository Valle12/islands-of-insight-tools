#include "AStar.h"

#include <algorithm>
#include <array>
#include <compare>
#include <iostream>
#include <limits>
#include <queue>

AStar::AStar(const uint8_t gridWidth, const uint8_t gridHeight,
             std::vector<Tile> cells, const uint8_t weight)
    : gridWidth_(gridWidth), gridHeight_(gridHeight), cells_(std::move(cells)),
      weight_(weight) {
  goalClusters_ = precomputeGoalClusters();
  for (int8_t x = 0; x < static_cast<int8_t>(gridWidth_); x++) {
    for (int8_t y = 0; y < static_cast<int8_t>(gridHeight_); y++) {
      const auto idx = positionToIndex(x, y, gridWidth_);
      if (cells_[idx] == Tile::MustTouch) {
        mustTouchIndices_.push_back({x, y, idx});
      }
      if (cells_[idx] == Tile::Goal) {
        goalIndices_.push_back(idx);
      }
    }
  }
}

struct HeapEntry {
  uint32_t f;
  uint32_t g;
  NodeKey signature;
  auto operator<=>(const HeapEntry &o) const { return f <=> o.f; }
  bool operator==(const HeapEntry &o) const = default;
};

// ---------------------------------------------------------------------------
// Helper: check if a moved block touches any new must-touch cell
// ---------------------------------------------------------------------------
bool AStar::blockTouchesNewMustTouch(
    const Block &block, const boost::dynamic_bitset<> &satisfied) const {
  for (int8_t cx = block.x; cx < block.x + static_cast<int8_t>(block.width);
       cx++) {
    for (int8_t cy = block.y; cy < block.y + static_cast<int8_t>(block.depth);
         cy++) {
      if (const auto idx = positionToIndex(cx, cy, gridWidth_);
          cells_[idx] == Tile::MustTouch && !satisfied.test(idx)) {
        return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Helper: try to expand a single neighbor in search
// ---------------------------------------------------------------------------
void AStar::expandNeighbor(const Node &node, const size_t bi,
                           const Direction direction, const HeapEntry &current,
                           SearchContext &ctx) {
  Block newBlock = node.blocks[bi].clone();
  newBlock.roll(direction);

  if (!newBlock.checkValidity(gridWidth_, gridHeight_, cells_, node.blocks,
                              node.mustTouchCellsSatisfied)) {
    return;
  }

  const bool touchesNew =
      blockTouchesNewMustTouch(newBlock, node.mustTouchCellsSatisfied);
  if (touchesNew) {
    ctx.mustTouchBuf = newBlock.updateMustTouchCells(
        gridWidth_, cells_, node.mustTouchCellsSatisfied);
  }
  const auto &mustTouchRef =
      touchesNew ? ctx.mustTouchBuf : node.mustTouchCellsSatisfied;

  if (!isReachable(node.blocks, bi, newBlock, mustTouchRef)) {
    return;
  }

  auto newSig = signatureFromParts(node.blocks, bi, newBlock, mustTouchRef);

  auto [newStateIt, inserted] = ctx.states.try_emplace(newSig);
  if (!inserted && (newStateIt->second.closed ||
                    current.g + 1 >= newStateIt->second.gScore)) {
    return;
  }

  const uint32_t newG = current.g + 1;

  std::vector<Block> newBlocks = node.blocks;
  newBlocks[bi] = newBlock;
  Node newNode(std::move(newBlocks), mustTouchRef);

  newStateIt->second = {
      newG, current.signature, {node.blocks[bi].id, direction}, true, false};
  ctx.nodeStore.insert_or_assign(newSig, std::move(newNode));
  ctx.openHeap.emplace(newG + weight_ *
                                  heuristic(ctx.nodeStore.find(newSig)->second),
                       newG, newSig);
}

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------
std::vector<Turn> AStar::search(Node root) {
  if (const size_t totalCells = static_cast<size_t>(gridWidth_) * gridHeight_;
      root.mustTouchCellsSatisfied.size() < totalCells) {
    root.mustTouchCellsSatisfied.resize(totalCells, false);
  }

  for (const auto &block : root.blocks) {
    root.mustTouchCellsSatisfied = block.updateMustTouchCells(
        gridWidth_, cells_, root.mustTouchCellsSatisfied);
  }

  assignBlocksToGoals(root.blocks);

  auto rootSig = nodeSignature(root);

  SearchContext ctx;
  ctx.states[rootSig] = {0, {}, {}, false, false};
  ctx.nodeStore.try_emplace(rootSig, root);
  ctx.openHeap.emplace(weight_ * heuristic(root), 0, rootSig);

  uint32_t nodesExpanded = 0;
  constexpr std::array dirs = {Direction::UP, Direction::RIGHT, Direction::DOWN,
                               Direction::LEFT};

  while (!ctx.openHeap.empty()) {
    HeapEntry current = ctx.openHeap.top();
    ctx.openHeap.pop();

    auto sit = ctx.states.find(current.signature);
    if (sit == ctx.states.end() || sit->second.closed ||
        sit->second.gScore < current.g) {
      continue;
    }

    sit->second.closed = true;
    auto nit = ctx.nodeStore.find(current.signature);
    Node node = std::move(nit->second);
    ctx.nodeStore.erase(nit);

    if (isGoalState(node)) {
      std::cout << "A* (w=" << static_cast<int>(weight_)
                << ") found solution in " << current.g << " moves, expanded "
                << nodesExpanded << " nodes\n";
      return reconstructPath(ctx.states, current.signature);
    }

    nodesExpanded++;
    if (onProgress && nodesExpanded % 10000 == 0) {
      onProgress(nodesExpanded);
    }

    for (size_t bi = 0; bi < node.blocks.size(); bi++) {
      for (const auto direction : dirs) {
        expandNeighbor(node, bi, direction, current, ctx);
      }
    }
  }

  std::cout << "No solution found\n";
  return {};
}

uint32_t AStar::heuristic(const Node &node) const {
  return std::max({mustTouchHeuristic(node), groupedMustTouchHeuristic(node),
                   goalDistanceHeuristic(node)});
}

// ---------------------------------------------------------------------------
// Helper: mark a single block's footprint in reachability buffer
// ---------------------------------------------------------------------------
void AStar::seedBlockReachability(const Block &block) {
  for (int8_t cx = block.x; cx < block.x + static_cast<int8_t>(block.width);
       cx++) {
    for (int8_t cy = block.y; cy < block.y + static_cast<int8_t>(block.depth);
         cy++) {
      if (const auto idx = positionToIndex(cx, cy, gridWidth_);
          !reachBuf_[idx]) {
        reachBuf_[idx] = 1;
        reachStack_.push_back(idx);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helper: seed reachability buffer with block cells
// ---------------------------------------------------------------------------
void AStar::seedReachability(const std::vector<Block> &blocks,
                             const size_t replaceIdx,
                             const Block &replacement) {
  for (size_t i = 0; i < blocks.size(); i++) {
    const auto &block = i == replaceIdx ? replacement : blocks[i];
    seedBlockReachability(block);
  }
}

// ---------------------------------------------------------------------------
// Helper: flood-fill and count reachable unsatisfied must-touch cells
// ---------------------------------------------------------------------------
bool AStar::floodFillReachable(
    const boost::dynamic_bitset<> &mustTouchSatisfied,
    const uint32_t totalUnsatisfied) {

  uint32_t reachableUnsatisfied = 0;
  while (!reachStack_.empty()) {
    const uint16_t idx = reachStack_.back();
    reachStack_.pop_back();

    if (cells_[idx] == Tile::MustTouch && !mustTouchSatisfied.test(idx)) {
      ++reachableUnsatisfied;
      if (reachableUnsatisfied == totalUnsatisfied) {
        return true;
      }
    }

    const auto cx = static_cast<int8_t>(idx % gridWidth_);
    const auto cy = static_cast<int8_t>(idx / gridWidth_);
    for (int d = 0; d < 4; d++) {
      constexpr std::array<int8_t, 4> dy = {1, -1, 0, 0};
      constexpr std::array<int8_t, 4> dx = {0, 0, 1, -1};
      const auto nx = static_cast<int8_t>(cx + dx[d]);
      const auto ny = static_cast<int8_t>(cy + dy[d]);
      if (nx < 0 || nx >= gridWidth_ || ny < 0 || ny >= gridHeight_) {
        continue;
      }
      const auto nidx = positionToIndex(nx, ny, gridWidth_);
      if (reachBuf_[nidx] || cells_[nidx] == Tile::Unplayable) {
        continue;
      }
      if (cells_[nidx] == Tile::MustTouch && mustTouchSatisfied.test(nidx)) {
        continue;
      }
      reachBuf_[nidx] = 1;
      reachStack_.push_back(nidx);
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// isReachable
// ---------------------------------------------------------------------------
bool AStar::isReachable(const std::vector<Block> &blocks,
                        const size_t replaceIdx, const Block &replacement,
                        const boost::dynamic_bitset<> &mustTouchSatisfied) {
  if (mustTouchIndices_.empty()) {
    return true;
  }

  uint32_t totalUnsatisfied = 0;
  for (const auto &[mx, my, idx] : mustTouchIndices_) {
    if (!mustTouchSatisfied.test(idx)) {
      totalUnsatisfied++;
    }
  }
  if (totalUnsatisfied == 0) {
    return true;
  }

  const size_t totalCells = static_cast<size_t>(gridWidth_) * gridHeight_;
  reachBuf_.assign(totalCells, 0);
  reachStack_.clear();

  seedReachability(blocks, replaceIdx, replacement);
  return floodFillReachable(mustTouchSatisfied, totalUnsatisfied);
}

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
  uint32_t seen = 0;
  for (const auto &[w, d] : dims) {
    const auto k = static_cast<uint32_t>(static_cast<uint16_t>(w) << 8 |
                                         static_cast<uint16_t>(d));
    if (seen & 1u << (k & 31u)) {
      continue;
    }
    seen |= 1u << (k & 31u);
    if (w == cluster.width && d == cluster.depth) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Helper: count compatible clusters for a block and return index if unique
// ---------------------------------------------------------------------------
int AStar::countCompatibleClusters(const Block &block,
                                   const std::array<bool, 64> &taken,
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
                              std::array<bool, 64> &taken) {
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
                              std::array<bool, 64> &taken) {
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
  std::array<bool, 64> taken{};
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
