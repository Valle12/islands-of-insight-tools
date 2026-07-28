// AStar: the search loop, move expansion and reachability pruning.
//
// Construction, the A* loop itself, the roll-a-block successor generator,
// and the flood fill that rejects states where an unsatisfied must-touch
// cell has become unreachable. The heuristics and the goal-cluster
// machinery they score against live in AStarGoals.cpp.

#include "AStar.h"

#include <algorithm>
#include <array>
#include <compare>
#include <iostream>

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
