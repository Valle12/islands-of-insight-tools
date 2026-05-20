#include "AStar.h"

#include <algorithm>
#include <chrono>
#include <compare>
#include <cmath>
#include <deque>
#include <iostream>
#include <queue>
#include <utility>

namespace {
uint64_t nowMs() {
  using namespace std::chrono;
  return static_cast<uint64_t>(
      duration_cast<milliseconds>(steady_clock::now().time_since_epoch())
          .count());
}
} // namespace

struct HeapEntry {
  uint32_t f;
  uint32_t g;
  NodeKey signature;
  auto operator<=>(const HeapEntry &o) const { return f <=> o.f; }
  bool operator==(const HeapEntry &o) const = default;
};

AStar::AStar(const uint8_t gridWidth, const uint8_t gridHeight,
             std::vector<std::vector<Position>> shapes,
             std::vector<Position> initialAnchors, const uint8_t goalIndex,
             const Position goalAnchor, const Config config)
    : gridWidth_(gridWidth), gridHeight_(gridHeight),
      shapes_(std::move(shapes)),
      initialAnchors_(std::move(initialAnchors)), goalIndex_(goalIndex),
      goalAnchor_(goalAnchor), cfg_(config) {
  shapeBoxWidth_.reserve(shapes_.size());
  shapeBoxHeight_.reserve(shapes_.size());
  shapeCellSets_.reserve(shapes_.size());
  for (const auto &shape : shapes_) {
    uint8_t maxX = 0;
    uint8_t maxY = 0;
    for (const auto &cell : shape) {
      if (cell.x > static_cast<int8_t>(maxX))
        maxX = static_cast<uint8_t>(cell.x);
      if (cell.y > static_cast<int8_t>(maxY))
        maxY = static_cast<uint8_t>(cell.y);
    }
    shapeBoxWidth_.push_back(maxX + 1);
    shapeBoxHeight_.push_back(maxY + 1);
    std::unordered_set<uint16_t> set;
    set.reserve(shape.size() * 2);
    for (const auto &cell : shape) {
      set.insert(static_cast<uint16_t>(static_cast<uint32_t>(cell.x) *
                                           SHAPE_STRIDE +
                                       cell.y));
    }
    shapeCellSets_.push_back(std::move(set));
  }
  const auto &goalShape = shapes_[goalIndex_];
  for (const auto &cell : goalShape) {
    const auto ax = static_cast<int16_t>(goalAnchor_.x + cell.x);
    const auto ay = static_cast<int16_t>(goalAnchor_.y + cell.y);
    goalBlockFinalCells_.insert(
        static_cast<uint16_t>(ax * static_cast<int16_t>(gridHeight_) + ay));
  }

  // Identify blocks that can never move from the initial state and exclude
  // them from move generation. Also detect upfront whether one of them
  // permanently blocks the goal block's final footprint → unsolvable.
  auto movableFromStart = computeMovableSet(initialAnchors_);
  movableBlockIndices_.reserve(shapes_.size());
  for (uint8_t i = 0; i < shapes_.size(); i++) {
    if (movableFromStart[i] || i == goalIndex_) {
      movableBlockIndices_.push_back(i);
    } else {
      const auto &a = initialAnchors_[i];
      for (const auto &cell : shapes_[i]) {
        const auto enc = static_cast<uint16_t>((a.x + cell.x) * gridHeight_ +
                                               (a.y + cell.y));
        if (goalBlockFinalCells_.contains(enc)) {
          unsolvableAtStart_ = true;
          break;
        }
      }
    }
  }
  computeGoalAnchorBfs();
  computeBlockReachability();

  std::cout << "AStar: " << movableBlockIndices_.size() << " of "
            << shapes_.size() << " blocks movable from start"
            << (unsolvableAtStart_ ? " (UNSOLVABLE — locked block at goal)"
                                    : "")
            << "\n";
}

// For each block, mark every (x, y) anchor where the block's shape doesn't
// overlap any permanently-locked cell. We don't bother with movable blocks
// here — that's the whole point of the relaxation: the cache assumes other
// movable blocks can be displaced.
//
// Also captures the goal block's BFS path through locked walls as a fixed
// "corridor" used by the LP-relaxed displacement heuristic.
void AStar::computeBlockReachability() {
  const size_t total =
      static_cast<size_t>(gridWidth_) * static_cast<size_t>(gridHeight_);

  // 1. Mark locked cells.
  std::vector<uint8_t> lockedCell(total, 0);
  auto movable = computeMovableSet(initialAnchors_);
  for (uint8_t i = 0; i < shapes_.size(); i++) {
    if (movable[i] || i == goalIndex_) continue;
    const auto &a = initialAnchors_[i];
    for (const auto &cell : shapes_[i]) {
      lockedCell[(a.x + cell.x) * gridHeight_ + (a.y + cell.y)] = 1;
    }
  }

  // 2. Per-block valid-anchor mask.
  blockValidAnchorMask_.assign(shapes_.size(), std::vector<uint8_t>(total, 0));
  for (uint8_t i = 0; i < shapes_.size(); i++) {
    if (i == goalIndex_) continue;
    const int aw = shapeBoxWidth_[i];
    const int ah = shapeBoxHeight_[i];
    for (int x = 0; x + aw <= gridWidth_; x++) {
      for (int y = 0; y + ah <= gridHeight_; y++) {
        bool ok = true;
        for (const auto &cell : shapes_[i]) {
          if (lockedCell[(x + cell.x) * gridHeight_ + (y + cell.y)]) {
            ok = false;
            break;
          }
        }
        if (ok) {
          blockValidAnchorMask_[i][x * gridHeight_ + y] = 1;
        }
      }
    }
  }

  // 3. Initial-state goal-block BFS path cells. Walk every anchor that lies
  //    on a shortest path from goalAnchor → initialAnchor; the goal block's
  //    footprint at any such anchor is part of the "corridor".
  initialGoalPathCells_.assign(total, 0);
  const auto initGoal = initialAnchors_[goalIndex_];
  if (goalAnchorAt(initGoal.x, initGoal.y) == UINT16_MAX) return;
  const uint16_t dStart = goalAnchorAt(initGoal.x, initGoal.y);
  const auto &gShape = shapes_[goalIndex_];
  // Collect via reverse BFS: an anchor (x,y) is on some shortest path if
  //   bfs[x,y] + dist((x,y) → initGoal) = dStart and bfs[x,y] + bfs_back == dStart
  // since the anchor graph is undirected we just check
  //   bfs[x,y] + manhattan((x,y), initGoal) == dStart (necessary, not
  //   sufficient — but cheap and acceptable for a fixed reference path).
  for (int x = 0; x < gridWidth_; x++) {
    for (int y = 0; y < gridHeight_; y++) {
      const uint16_t d = goalAnchorAt(static_cast<int8_t>(x),
                                       static_cast<int8_t>(y));
      if (d == UINT16_MAX || d > dStart) continue;
      const int mh = std::abs(x - initGoal.x) + std::abs(y - initGoal.y);
      if (d + mh != dStart) continue;
      for (const auto &cell : gShape) {
        initialGoalPathCells_[(x + cell.x) * gridHeight_ + (y + cell.y)] = 1;
      }
    }
  }
}

// For each movable non-goal block whose current footprint overlaps the
// pre-computed goal-block path corridor, add a lower bound on how far that
// block must move to clear the corridor — namely, the minimum Manhattan
// distance from its current anchor to a valid anchor whose shape lies
// entirely outside the corridor. Sum is admissible because each blocker
// must move at least that far, and we ignore the bipartite-assignment
// conflict (LP relaxation) which can only decrease the bound.
uint32_t
AStar::lpDisplacementCost(const std::vector<Position> &anchors) const {
  if (initialGoalPathCells_.empty()) return 0;
  uint32_t total = 0;
  for (const uint8_t i : movableBlockIndices_) {
    if (i == goalIndex_) continue;
    const auto &a = anchors[i];
    // Is this block currently inside the corridor?
    bool inCorridor = false;
    for (const auto &cell : shapes_[i]) {
      if (initialGoalPathCells_[(a.x + cell.x) * gridHeight_ +
                                 (a.y + cell.y)]) {
        inCorridor = true;
        break;
      }
    }
    if (!inCorridor) continue;

    // Find min Manhattan distance from `a` to any valid-anchor of block i
    // whose shape doesn't overlap the corridor.
    uint32_t best = UINT32_MAX;
    const auto &mask = blockValidAnchorMask_[i];
    const int aw = shapeBoxWidth_[i];
    const int ah = shapeBoxHeight_[i];
    for (int x = 0; x + aw <= gridWidth_; x++) {
      for (int y = 0; y + ah <= gridHeight_; y++) {
        if (!mask[x * gridHeight_ + y]) continue;
        bool inside = false;
        for (const auto &cell : shapes_[i]) {
          if (initialGoalPathCells_[(x + cell.x) * gridHeight_ +
                                     (y + cell.y)]) {
            inside = true;
            break;
          }
        }
        if (inside) continue;
        const uint32_t d = static_cast<uint32_t>(std::abs(x - a.x) +
                                                  std::abs(y - a.y));
        if (d < best) best = d;
      }
    }
    if (best == UINT32_MAX) {
      // No safe anchor exists — this blocker is permanently in the corridor;
      // treat as +1 (the corridor must route around it during search).
      total += 1;
    } else {
      total += best;
    }
  }
  return total;
}

// Precompute BFS distance from every in-bounds anchor for the goal block to
// goalAnchor, treating cells occupied by permanently-locked blocks as walls.
// All other cells are passable (movable blocks can be displaced for free in
// this lower bound; we only need to count goal-block moves). The result
// dominates Manhattan whenever locked obstacles force a detour and detects
// unsolvability when goalAnchor is unreachable from initial.
void AStar::computeGoalAnchorBfs() {
  const size_t total =
      static_cast<size_t>(gridWidth_) * static_cast<size_t>(gridHeight_);
  goalAnchorBfsDist_.assign(total, UINT16_MAX);

  // Mark cells occupied by locked blocks as walls.
  std::vector<uint8_t> lockedWall(total, 0);
  auto movable = computeMovableSet(initialAnchors_);
  for (uint8_t i = 0; i < shapes_.size(); i++) {
    if (movable[i] || i == goalIndex_) continue;
    const auto &a = initialAnchors_[i];
    for (const auto &cell : shapes_[i]) {
      lockedWall[(a.x + cell.x) * gridHeight_ + (a.y + cell.y)] = 1;
    }
  }

  // Helper: is this anchor valid for the goal block (in-bounds + no locked
  // cell overlap)?
  const auto &gShape = shapes_[goalIndex_];
  const int gw = shapeBoxWidth_[goalIndex_];
  const int gh = shapeBoxHeight_[goalIndex_];
  auto anchorValid = [&](int8_t x, int8_t y) -> bool {
    if (x < 0 || y < 0) return false;
    if (x + gw > gridWidth_ || y + gh > gridHeight_) return false;
    for (const auto &cell : gShape) {
      if (lockedWall[(x + cell.x) * gridHeight_ + (y + cell.y)]) return false;
    }
    return true;
  };

  if (!anchorValid(goalAnchor_.x, goalAnchor_.y)) {
    unsolvableAtStart_ = true;
    return;
  }

  goalAnchorBfsDist_[goalAnchor_.x * gridHeight_ + goalAnchor_.y] = 0;
  std::deque<std::pair<int8_t, int8_t>> queue;
  queue.emplace_back(goalAnchor_.x, goalAnchor_.y);
  while (!queue.empty()) {
    auto [x, y] = queue.front();
    queue.pop_front();
    const uint16_t d = goalAnchorBfsDist_[x * gridHeight_ + y];
    for (int dir = 0; dir < 4; dir++) {
      const int8_t nx = x + DX[dir];
      const int8_t ny = y + DY[dir];
      if (!anchorValid(nx, ny)) continue;
      uint16_t &cell = goalAnchorBfsDist_[nx * gridHeight_ + ny];
      if (cell != UINT16_MAX) continue;
      cell = d + 1;
      queue.emplace_back(nx, ny);
    }
  }

  if (goalAnchorAt(initialAnchors_[goalIndex_].x,
                    initialAnchors_[goalIndex_].y) == UINT16_MAX) {
    unsolvableAtStart_ = true;
  }
}

bool AStar::inBounds(const uint8_t blockIndex, const Position anchor) const {
  return anchor.x >= 0 && anchor.y >= 0 &&
         anchor.x + static_cast<int>(shapeBoxWidth_[blockIndex]) <=
             gridWidth_ &&
         anchor.y + static_cast<int>(shapeBoxHeight_[blockIndex]) <=
             gridHeight_;
}

bool AStar::boundingBoxesOverlap(const uint8_t i, const Position ai,
                                 const uint8_t j, const Position aj) const {
  const int aw = shapeBoxWidth_[i];
  const int ah = shapeBoxHeight_[i];
  const int bw = shapeBoxWidth_[j];
  const int bh = shapeBoxHeight_[j];
  if (ai.x + aw <= aj.x || aj.x + bw <= ai.x)
    return false;
  if (ai.y + ah <= aj.y || aj.y + bh <= ai.y)
    return false;
  return true;
}

bool AStar::blocksCollide(const uint8_t i, const Position ai, const uint8_t j,
                          const Position aj) const {
  if (!boundingBoxesOverlap(i, ai, j, aj))
    return false;
  const int dx = ai.x - aj.x;
  const int dy = ai.y - aj.y;
  const int bw = shapeBoxWidth_[j];
  const int bh = shapeBoxHeight_[j];
  const auto &setJ = shapeCellSets_[j];
  for (const auto &cellA : shapes_[i]) {
    const int relX = cellA.x + dx;
    const int relY = cellA.y + dy;
    if (relX < 0 || relY < 0)
      continue;
    if (relX >= bw || relY >= bh)
      continue;
    if (setJ.contains(static_cast<uint16_t>(static_cast<uint32_t>(relX) *
                                                SHAPE_STRIDE +
                                            relY)))
      return true;
  }
  return false;
}

bool AStar::collidesWithOthers(const uint8_t blockIndex,
                               const Position newAnchor,
                               const std::vector<Position> &anchors) const {
  for (size_t j = 0; j < anchors.size(); j++) {
    if (j == blockIndex)
      continue;
    if (blocksCollide(blockIndex, newAnchor, static_cast<uint8_t>(j),
                      anchors[j]))
      return true;
  }
  return false;
}

uint32_t AStar::countFinalPositionBlockers(
    const std::vector<Position> &anchors) const {
  const int gw = shapeBoxWidth_[goalIndex_];
  const int gh = shapeBoxHeight_[goalIndex_];
  uint32_t count = 0;
  for (size_t i = 0; i < anchors.size(); i++) {
    if (i == goalIndex_)
      continue;
    const auto &a = anchors[i];
    const int aw = shapeBoxWidth_[i];
    const int ah = shapeBoxHeight_[i];
    if (a.x + aw <= goalAnchor_.x || goalAnchor_.x + gw <= a.x)
      continue;
    if (a.y + ah <= goalAnchor_.y || goalAnchor_.y + gh <= a.y)
      continue;
    for (const auto &cell : shapes_[i]) {
      const auto enc =
          static_cast<uint16_t>((a.x + cell.x) * gridHeight_ + (a.y + cell.y));
      if (goalBlockFinalCells_.contains(enc)) {
        count++;
        break;
      }
    }
  }
  return count;
}

uint32_t AStar::heuristic(const Node &node) const {
  const auto &goal = node.anchors[goalIndex_];
  if (goal.x == goalAnchor_.x && goal.y == goalAnchor_.y) return 0;
  uint32_t base;
  if (cfg_.allWallsBfsBase) {
    base = allWallsBfsDistance(node.anchors, goal);
  } else {
    const uint16_t bfs = goalAnchorAt(goal.x, goal.y);
    base = bfs == UINT16_MAX
               ? static_cast<uint32_t>(std::abs(goal.x - goalAnchor_.x) +
                                       std::abs(goal.y - goalAnchor_.y))
               : static_cast<uint32_t>(bfs);
  }
  uint32_t h = base + countFinalPositionBlockers(node.anchors);
  if (cfg_.pathBlockerWeight != 0) {
    h += cfg_.pathBlockerWeight * countPathBlockers(node.anchors, goal);
  }
  if (cfg_.boundaryDistanceWeight != 0) {
    h += cfg_.boundaryDistanceWeight * boundaryDistanceSum(node.anchors);
  }
  if (cfg_.axisAwareWeight != 0) {
    h += cfg_.axisAwareWeight * axisAwareBlockerCost(node.anchors, goal);
  }
  if (cfg_.lpDisplacementWeight != 0) {
    h += cfg_.lpDisplacementWeight * lpDisplacementCost(node.anchors);
  }
  return h;
}

// Rush-hour-style heuristic. Decide whether the goal block's net trip is
// dominantly horizontal or vertical, then for each movable non-goal block
// whose footprint intersects the goal block's corridor:
//   * if the block can only move ALONG the corridor (parallel axis) →
//     it has to shift `min(start-side, end-side)` cells to clear; we count 1
//     as a lower bound that the block has to move at least once.
//   * if the block can move PERPENDICULAR (rush-hour side-track) → at least
//     1 perpendicular move to vacate the corridor.
//   * otherwise (block stuck right now) → it must still be displaced; 2 is a
//     conservative penalty.
// Non-admissible; intended for weighted A* / IDA* on rush-hour puzzles.
uint32_t
AStar::axisAwareBlockerCost(const std::vector<Position> &anchors,
                             const Position currentGoal) const {
  const int dx = goalAnchor_.x - currentGoal.x;
  const int dy = goalAnchor_.y - currentGoal.y;
  const bool horizontalTrip = std::abs(dx) >= std::abs(dy);
  // Corridor: rectangle covering both current and target footprints.
  const int gw = shapeBoxWidth_[goalIndex_];
  const int gh = shapeBoxHeight_[goalIndex_];
  const int xLo = std::min(static_cast<int>(currentGoal.x),
                            static_cast<int>(goalAnchor_.x));
  const int xHi =
      std::max(static_cast<int>(currentGoal.x),
               static_cast<int>(goalAnchor_.x)) +
      gw;
  const int yLo = std::min(static_cast<int>(currentGoal.y),
                            static_cast<int>(goalAnchor_.y));
  const int yHi =
      std::max(static_cast<int>(currentGoal.y),
               static_cast<int>(goalAnchor_.y)) +
      gh;

  uint32_t cost = 0;
  for (const uint8_t i : movableBlockIndices_) {
    if (i == goalIndex_) continue;
    const auto &a = anchors[i];
    const int aw = shapeBoxWidth_[i];
    const int ah = shapeBoxHeight_[i];
    // bbox quick reject
    if (a.x + aw <= xLo || a.x >= xHi) continue;
    if (a.y + ah <= yLo || a.y >= yHi) continue;
    bool overlapsCorridor = false;
    for (const auto &cell : shapes_[i]) {
      const int cx = a.x + cell.x;
      const int cy = a.y + cell.y;
      if (cx >= xLo && cx < xHi && cy >= yLo && cy < yHi) {
        overlapsCorridor = true;
        break;
      }
    }
    if (!overlapsCorridor) continue;

    // Decide block axis by probing one cell moves in each direction.
    bool canMoveHoriz = false;
    bool canMoveVert = false;
    const int dirsH[2] = {1, 3}; // RIGHT, LEFT
    const int dirsV[2] = {0, 2}; // UP, DOWN
    for (int k = 0; k < 2; k++) {
      const Position p = {static_cast<int8_t>(a.x + DX[dirsH[k]]),
                           static_cast<int8_t>(a.y + DY[dirsH[k]])};
      if (inBounds(i, p) && !collidesWithOthers(i, p, anchors)) {
        canMoveHoriz = true;
        break;
      }
    }
    for (int k = 0; k < 2; k++) {
      const Position p = {static_cast<int8_t>(a.x + DX[dirsV[k]]),
                           static_cast<int8_t>(a.y + DY[dirsV[k]])};
      if (inBounds(i, p) && !collidesWithOthers(i, p, anchors)) {
        canMoveVert = true;
        break;
      }
    }

    if (!canMoveHoriz && !canMoveVert) {
      cost += 2; // stuck right now; needs cascade to vacate
    } else if (horizontalTrip) {
      // Perpendicular = vertical for a horizontal trip.
      cost += canMoveVert ? 1 : 1; // either way >=1; parallel pushes are also 1
    } else {
      cost += canMoveHoriz ? 1 : 1;
    }
  }
  return cost;
}

// Count of movable non-goal blocks whose footprint intersects the goal
// block's BFS shortest path through the *current* non-goal blocks. The path
// itself is one of several possible shortest paths, so this is approximate
// (non-admissible) but strong: each counted block stands between the goal
// block and its target on at least one optimal anchor-path.
uint32_t AStar::countPathBlockers(const std::vector<Position> &anchors,
                                   const Position currentGoal) const {
  const size_t total =
      static_cast<size_t>(gridWidth_) * static_cast<size_t>(gridHeight_);

  // Per-cell occupancy: -1 empty, otherwise block index. Allows attributing
  // path cells to specific blockers.
  std::vector<int16_t> occupancy(total, -1);
  for (size_t i = 0; i < anchors.size(); i++) {
    if (i == goalIndex_) continue;
    const auto &a = anchors[i];
    for (const auto &cell : shapes_[i]) {
      occupancy[(a.x + cell.x) * gridHeight_ + (a.y + cell.y)] =
          static_cast<int16_t>(i);
    }
  }

  // BFS anchor-graph from currentGoal toward goalAnchor; goal block sits on
  // a cell if its shape (translated by anchor) overlaps with another block's
  // occupancy. Passable = (no overlap with a non-goal block at any shape
  // cell).
  const auto &gShape = shapes_[goalIndex_];
  const int gw = shapeBoxWidth_[goalIndex_];
  const int gh = shapeBoxHeight_[goalIndex_];
  auto anchorPassable = [&](int8_t x, int8_t y) -> bool {
    if (x < 0 || y < 0) return false;
    if (x + gw > gridWidth_ || y + gh > gridHeight_) return false;
    return true;
  };
  // Per anchor cell, store predecessor for path reconstruction. -2 = not
  // visited, -1 = root.
  std::vector<int32_t> pred(total, -2);
  pred[currentGoal.x * gridHeight_ + currentGoal.y] = -1;
  std::deque<std::pair<int8_t, int8_t>> queue;
  queue.emplace_back(currentGoal.x, currentGoal.y);
  bool reached = currentGoal.x == goalAnchor_.x &&
                 currentGoal.y == goalAnchor_.y;
  while (!queue.empty() && !reached) {
    auto [x, y] = queue.front();
    queue.pop_front();
    for (int dir = 0; dir < 4; dir++) {
      const int8_t nx = x + DX[dir];
      const int8_t ny = y + DY[dir];
      if (!anchorPassable(nx, ny)) continue;
      const int npos = nx * gridHeight_ + ny;
      if (pred[npos] != -2) continue;
      pred[npos] = x * gridHeight_ + y;
      if (nx == goalAnchor_.x && ny == goalAnchor_.y) {
        reached = true;
        break;
      }
      queue.emplace_back(nx, ny);
    }
  }
  if (!reached) {
    // No anchor-path even ignoring movable blocks → push hard.
    return 4;
  }

  // Walk path from goal anchor back to current; collect blockers along the
  // way.
  std::unordered_set<int16_t> blockerSet;
  int32_t cur = goalAnchor_.x * gridHeight_ + goalAnchor_.y;
  while (cur != -1) {
    const int8_t ax = static_cast<int8_t>(cur / gridHeight_);
    const int8_t ay = static_cast<int8_t>(cur % gridHeight_);
    for (const auto &cell : gShape) {
      const int gx = ax + cell.x;
      const int gy = ay + cell.y;
      const int16_t occ = occupancy[gx * gridHeight_ + gy];
      if (occ != -1) blockerSet.insert(occ);
    }
    cur = pred[cur];
  }
  return static_cast<uint32_t>(blockerSet.size());
}

// Penalize non-goal movable blocks that are far from the grid boundary.
// Encourages the search to push outer blocks outward to free interior space.
uint32_t
AStar::boundaryDistanceSum(const std::vector<Position> &anchors) const {
  uint32_t total = 0;
  for (const uint8_t i : movableBlockIndices_) {
    if (i == goalIndex_) continue;
    const auto &a = anchors[i];
    const int aw = shapeBoxWidth_[i];
    const int ah = shapeBoxHeight_[i];
    const int distLeft = a.x;
    const int distRight = gridWidth_ - (a.x + aw);
    const int distTop = a.y;
    const int distBottom = gridHeight_ - (a.y + ah);
    const int distToEdge = std::min({distLeft, distRight, distTop, distBottom});
    total += static_cast<uint32_t>(distToEdge);
  }
  return total;
}

// Admissible: BFS the goal block through all current non-goal blocks treated
// as walls. The distance is the minimum number of goal-block moves needed if
// no movable blocks are displaced. Slow if computed per-state but tighter
// than the locked-walls precomputation. UINT16_MAX → unreachable; fall back
// to Manhattan + 1.
uint32_t
AStar::allWallsBfsDistance(const std::vector<Position> &anchors,
                            const Position currentGoal) const {
  const size_t total =
      static_cast<size_t>(gridWidth_) * static_cast<size_t>(gridHeight_);
  std::vector<uint8_t> wall(total, 0);
  for (size_t i = 0; i < anchors.size(); i++) {
    if (i == goalIndex_) continue;
    const auto &a = anchors[i];
    for (const auto &cell : shapes_[i]) {
      wall[(a.x + cell.x) * gridHeight_ + (a.y + cell.y)] = 1;
    }
  }

  const auto &gShape = shapes_[goalIndex_];
  const int gw = shapeBoxWidth_[goalIndex_];
  const int gh = shapeBoxHeight_[goalIndex_];
  auto anchorOk = [&](int8_t x, int8_t y) -> bool {
    if (x < 0 || y < 0) return false;
    if (x + gw > gridWidth_ || y + gh > gridHeight_) return false;
    for (const auto &cell : gShape) {
      if (wall[(x + cell.x) * gridHeight_ + (y + cell.y)]) return false;
    }
    return true;
  };

  if (!anchorOk(goalAnchor_.x, goalAnchor_.y)) {
    return static_cast<uint32_t>(std::abs(currentGoal.x - goalAnchor_.x) +
                                  std::abs(currentGoal.y - goalAnchor_.y)) +
           1;
  }

  std::vector<uint16_t> dist(total, UINT16_MAX);
  dist[currentGoal.x * gridHeight_ + currentGoal.y] = 0;
  std::deque<std::pair<int8_t, int8_t>> q;
  q.emplace_back(currentGoal.x, currentGoal.y);
  while (!q.empty()) {
    auto [x, y] = q.front();
    q.pop_front();
    if (x == goalAnchor_.x && y == goalAnchor_.y) {
      return dist[x * gridHeight_ + y];
    }
    const uint16_t d = dist[x * gridHeight_ + y];
    for (int dir = 0; dir < 4; dir++) {
      const int8_t nx = x + DX[dir];
      const int8_t ny = y + DY[dir];
      if (!anchorOk(nx, ny)) continue;
      uint16_t &cell = dist[nx * gridHeight_ + ny];
      if (cell != UINT16_MAX) continue;
      cell = d + 1;
      q.emplace_back(nx, ny);
    }
  }
  return static_cast<uint32_t>(std::abs(currentGoal.x - goalAnchor_.x) +
                                std::abs(currentGoal.y - goalAnchor_.y)) +
         1;
}

uint32_t
AStar::countSweepRectangleBlockers(const std::vector<Position> &anchors,
                                   const Position goal) const {
  const int gw = shapeBoxWidth_[goalIndex_];
  const int gh = shapeBoxHeight_[goalIndex_];
  const int xLo = std::min(static_cast<int>(goal.x), static_cast<int>(goalAnchor_.x));
  const int xHi = std::max(static_cast<int>(goal.x), static_cast<int>(goalAnchor_.x)) + gw;
  const int yLo = std::min(static_cast<int>(goal.y), static_cast<int>(goalAnchor_.y));
  const int yHi = std::max(static_cast<int>(goal.y), static_cast<int>(goalAnchor_.y)) + gh;

  uint32_t count = 0;
  for (const uint8_t i : movableBlockIndices_) {
    if (i == goalIndex_) continue;
    const auto &a = anchors[i];
    const int aw = shapeBoxWidth_[i];
    const int ah = shapeBoxHeight_[i];
    // bbox quick reject
    if (a.x + aw <= xLo || a.x >= xHi) continue;
    if (a.y + ah <= yLo || a.y >= yHi) continue;
    // cell-level: any cell of this block inside the sweep rect?
    for (const auto &cell : shapes_[i]) {
      const int cx = a.x + cell.x;
      const int cy = a.y + cell.y;
      if (cx >= xLo && cx < xHi && cy >= yLo && cy < yHi) {
        count++;
        break;
      }
    }
  }
  return count;
}

bool AStar::isGoalState(const Node &node) const {
  const auto &anchor = node.anchors[goalIndex_];
  return anchor.x == goalAnchor_.x && anchor.y == goalAnchor_.y;
}

// Correct fixpoint: start with NOBODY proven movable, and add X iff some
// direction has every blocker already proven movable. This catches mutual
// locks (e.g. a hollow ring around a single cell where each blocks the other
// in every direction) — the optimistic "start full and remove" variant would
// keep both in the movable set forever, hiding the deadlock.
std::vector<bool>
AStar::computeMovableSet(const std::vector<Position> &anchors) const {
  const size_t n = anchors.size();
  const size_t total =
      static_cast<size_t>(gridWidth_) * static_cast<size_t>(gridHeight_);
  std::vector<int16_t> occupancy(total, -1);
  for (size_t i = 0; i < n; i++) {
    const auto &a = anchors[i];
    for (const auto &cell : shapes_[i]) {
      occupancy[(a.x + cell.x) * gridHeight_ + (a.y + cell.y)] =
          static_cast<int16_t>(i);
    }
  }
  std::vector<bool> movable(n, false);
  bool changed = true;
  while (changed) {
    changed = false;
    for (size_t i = 0; i < n; i++) {
      if (movable[i])
        continue;
      const auto &a = anchors[i];
      const auto &shape = shapes_[i];
      bool canMove = false;
      for (int d = 0; d < 4; d++) {
        const Position newAnchor = {static_cast<int8_t>(a.x + DX[d]),
                                     static_cast<int8_t>(a.y + DY[d])};
        if (!inBounds(static_cast<uint8_t>(i), newAnchor))
          continue;
        bool allFreeable = true;
        for (const auto &cell : shape) {
          const int nx = newAnchor.x + cell.x;
          const int ny = newAnchor.y + cell.y;
          const int occ = occupancy[nx * gridHeight_ + ny];
          if (occ == -1 || occ == static_cast<int>(i))
            continue;
          if (!movable[occ]) {
            allFreeable = false;
            break;
          }
        }
        if (allFreeable) {
          canMove = true;
          break;
        }
      }
      if (canMove) {
        movable[i] = true;
        changed = true;
      }
    }
  }
  return movable;
}

bool AStar::isDeadlocked(const std::vector<Position> &anchors) const {
  bool hasBlocker = false;
  for (size_t i = 0; i < anchors.size() && !hasBlocker; i++) {
    if (i == goalIndex_)
      continue;
    const auto &a = anchors[i];
    for (const auto &cell : shapes_[i]) {
      const auto enc =
          static_cast<uint16_t>((a.x + cell.x) * gridHeight_ + (a.y + cell.y));
      if (goalBlockFinalCells_.contains(enc)) {
        hasBlocker = true;
        break;
      }
    }
  }
  if (!hasBlocker)
    return false;
  auto movable = computeMovableSet(anchors);
  for (size_t i = 0; i < anchors.size(); i++) {
    if (i == goalIndex_ || movable[i])
      continue;
    const auto &a = anchors[i];
    for (const auto &cell : shapes_[i]) {
      const auto enc =
          static_cast<uint16_t>((a.x + cell.x) * gridHeight_ + (a.y + cell.y));
      if (goalBlockFinalCells_.contains(enc))
        return true;
    }
  }
  return false;
}

NodeKey AStar::signatureFromAnchors(const std::vector<Position> &anchors) {
  const auto n = static_cast<uint8_t>(anchors.size());
  NodeKey key(n);
  uint32_t *d = key.data();
  for (uint8_t i = 0; i < n; i++) {
    const auto &a = anchors[i];
    d[i] = (static_cast<uint32_t>(static_cast<uint8_t>(a.x)) << 16) |
           static_cast<uint32_t>(static_cast<uint8_t>(a.y));
  }
  return key;
}

NodeKey AStar::nodeSignature(const Node &node) {
  return signatureFromAnchors(node.anchors);
}

std::vector<Turn> AStar::reconstructPath(const StateMap &states,
                                         const NodeKey &goalSignature) {
  // Walk cameFrom backward, collect macro moves, then expand each macro into
  // (slideDistance) 1-cell Turns.
  std::vector<InternalMove> moves;
  NodeKey current = goalSignature;
  while (true) {
    auto it = states.find(current);
    if (it == states.end() || !it->second.hasParent)
      break;
    moves.push_back(it->second.move);
    current = it->second.parent;
  }
  std::reverse(moves.begin(), moves.end());

  std::vector<Turn> turns;
  for (const auto &m : moves) {
    const uint8_t d = m.slideDistance == 0 ? 1 : m.slideDistance;
    for (uint8_t k = 0; k < d; k++) {
      turns.push_back({m.blockId, m.direction});
    }
  }
  return turns;
}

std::vector<Turn> AStar::search(const uint32_t maxMs, const uint32_t maxNodes) {
  if (unsolvableAtStart_) {
    std::cout << "A* short-circuit: a permanently-locked block sits on the "
                 "goal block's final footprint — puzzle is unsolvable\n";
    return {};
  }

  const uint64_t deadline = maxMs == 0 ? 0 : nowMs() + maxMs;

  Node root(initialAnchors_);
  if (isGoalState(root))
    return {};

  NodeKey rootSig = nodeSignature(root);

  StateMap states;
  std::unordered_map<NodeKey, Node, NodeKeyHash> nodeStore;
  std::priority_queue<HeapEntry, std::vector<HeapEntry>, std::greater<>>
      openHeap;

  states[rootSig] = {0, {}, {}, false, false};
  nodeStore.try_emplace(rootSig, root);
  openHeap.emplace(cfg_.weight * heuristic(root), 0, rootSig);

  uint32_t nodesExpanded = 0;

  while (!openHeap.empty()) {
    if (deadline != 0 && (nodesExpanded & 0xFFF) == 0 && nowMs() > deadline) {
      std::cout << "A* timed out after " << nodesExpanded
                << " nodes (budget " << maxMs << "ms)\n";
      return {};
    }
    if (maxNodes != 0 && nodesExpanded >= maxNodes) {
      std::cout << "A* hit node cap of " << maxNodes << " (open=" << openHeap.size()
                << ", states=" << states.size() << ", store=" << nodeStore.size()
                << ")\n";
      return {};
    }
    HeapEntry current = openHeap.top();
    openHeap.pop();

    auto sit = states.find(current.signature);
    if (sit == states.end() || sit->second.closed ||
        sit->second.gScore < current.g)
      continue;

    sit->second.closed = true;
    auto nit = nodeStore.find(current.signature);
    if (nit == nodeStore.end())
      continue;
    Node node = std::move(nit->second);
    nodeStore.erase(nit);

    if (isGoalState(node)) {
      std::cout << "A* (w=" << static_cast<int>(cfg_.weight) << ") found solution in "
                << current.g << " moves, expanded " << nodesExpanded
                << " nodes\n";
      return reconstructPath(states, current.signature);
    }

    nodesExpanded++;
    if (onProgress && nodesExpanded % 10000 == 0)
      onProgress(nodesExpanded);

    if (cfg_.deadlockPruning && isDeadlocked(node.anchors))
      continue;

    for (const uint8_t i : movableBlockIndices_) {
      for (int d = 0; d < 4; d++) {
        // Slide block i in direction d one cell at a time. With macroMoves
        // enabled we emit a separate successor for each reachable slide
        // distance (1..until-collision); without it we stop after k=1.
        Position cursor = node.anchors[i];
        std::vector<Position> newAnchors = node.anchors;
        for (uint8_t k = 1; ; k++) {
          const Position next = {static_cast<int8_t>(cursor.x + DX[d]),
                                  static_cast<int8_t>(cursor.y + DY[d])};
          if (!inBounds(static_cast<uint8_t>(i), next)) break;
          // Restore previous slot then test collision against the rest.
          newAnchors[i] = next;
          if (collidesWithOthers(static_cast<uint8_t>(i), next, newAnchors))
            break;
          cursor = next;

          Node newNode(newAnchors);
          NodeKey newSig = signatureFromAnchors(newAnchors);

          const uint32_t newG = current.g + k;

          auto [newIt, inserted] = states.try_emplace(newSig);
          if (inserted || (!newIt->second.closed && newG < newIt->second.gScore)) {
            newIt->second = {newG, current.signature,
                             {static_cast<uint8_t>(i), DIRS[d], k}, true, false};
            nodeStore.insert_or_assign(newSig, std::move(newNode));
            openHeap.emplace(
                newG +
                    cfg_.weight * heuristic(nodeStore.find(newSig)->second),
                newG, newSig);
          }

          if (!cfg_.macroMoves) break;
        }
      }
    }
  }

  std::cout << "A* found no solution, expanded " << nodesExpanded << " nodes\n";
  return {};
}

// ---------------------------------------------------------------------------
// IDA*  (iterative deepening A*)
//
// O(depth) memory.  Repeats DFS with progressively raised f-thresholds until
// a solution is found or all f-values exceed UINT32_MAX. Cycle detection via
// a per-path set keyed on node signatures — keeps memory bounded by depth.
// ---------------------------------------------------------------------------

AStar::IDAResult
AStar::idaStarDFS(std::vector<Position> &anchors, const uint32_t g,
                  const uint32_t threshold,
                  std::vector<InternalMove> &path,
                  std::unordered_set<NodeKey, NodeKeyHash> &pathSet,
                  const uint64_t deadline, const uint32_t maxNodes,
                  uint32_t &nodesExpanded) {
  Node temp(anchors);
  const uint32_t h = cfg_.weight * heuristic(temp);
  const uint32_t f = g + h;
  if (f > threshold) {
    return {false, f, false};
  }

  // Goal check.
  const auto &goal = anchors[goalIndex_];
  if (goal.x == goalAnchor_.x && goal.y == goalAnchor_.y) {
    return {true, threshold, false};
  }

  if ((nodesExpanded & 0xFFF) == 0 && deadline != 0 && nowMs() > deadline) {
    return {false, UINT32_MAX, true};
  }
  if (maxNodes != 0 && nodesExpanded >= maxNodes) {
    return {false, UINT32_MAX, true};
  }

  nodesExpanded++;

  if (cfg_.deadlockPruning && isDeadlocked(anchors)) {
    return {false, UINT32_MAX, false};
  }

  uint32_t nextThreshold = UINT32_MAX;

  for (const uint8_t i : movableBlockIndices_) {
    const auto saved = anchors[i];
    for (int d = 0; d < 4; d++) {
      Position cursor = saved;
      for (uint8_t k = 1; ; k++) {
        const Position next = {static_cast<int8_t>(cursor.x + DX[d]),
                                static_cast<int8_t>(cursor.y + DY[d])};
        if (!inBounds(i, next)) break;
        anchors[i] = next;
        if (collidesWithOthers(i, next, anchors)) {
          anchors[i] = saved;
          break;
        }
        cursor = next;

        NodeKey sig = signatureFromAnchors(anchors);
        auto [it, inserted] = pathSet.insert(sig);
        if (!inserted) {
          // Cycle on current path — try a longer slide of the same block.
          if (!cfg_.macroMoves) break;
          continue;
        }
        path.push_back({i, DIRS[d], k});

        const IDAResult r =
            idaStarDFS(anchors, g + k, threshold, path, pathSet, deadline,
                       maxNodes, nodesExpanded);

        if (r.exhausted) {
          path.pop_back();
          pathSet.erase(sig);
          anchors[i] = saved;
          return r;
        }
        if (r.found) {
          // Leave path/pathSet/anchors intact so the caller chain returns the
          // discovered solution.
          return r;
        }

        path.pop_back();
        pathSet.erase(sig);
        if (r.nextThreshold < nextThreshold) nextThreshold = r.nextThreshold;

        if (!cfg_.macroMoves) break;
      }
      anchors[i] = saved;
    }
  }
  return {false, nextThreshold, false};
}

std::vector<Turn> AStar::searchIDAStar(const uint32_t maxMs,
                                       const uint32_t maxNodes) {
  if (unsolvableAtStart_) {
    std::cout << "IDA* short-circuit: unsolvable\n";
    return {};
  }
  const uint64_t deadline = maxMs == 0 ? 0 : nowMs() + maxMs;

  std::vector<Position> anchors = initialAnchors_;
  Node root(anchors);
  if (isGoalState(root)) return {};

  uint32_t threshold = cfg_.weight * heuristic(root);
  uint32_t nodesExpanded = 0;
  std::vector<InternalMove> path;
  std::unordered_set<NodeKey, NodeKeyHash> pathSet;
  pathSet.insert(signatureFromAnchors(anchors));

  uint32_t iteration = 0;
  while (true) {
    iteration++;
    const IDAResult r =
        idaStarDFS(anchors, 0, threshold, path, pathSet, deadline, maxNodes,
                   nodesExpanded);
    if (r.exhausted) {
      std::cout << "IDA* aborted at iter=" << iteration
                << " threshold=" << threshold << " nodes=" << nodesExpanded
                << "\n";
      return {};
    }
    if (r.found) {
      std::vector<Turn> turns;
      for (const auto &m : path) {
        const uint8_t d = m.slideDistance == 0 ? 1 : m.slideDistance;
        for (uint8_t k = 0; k < d; k++) {
          turns.push_back({m.blockId, m.direction});
        }
      }
      std::cout << "IDA* (w=" << static_cast<int>(cfg_.weight)
                << ") found solution in " << turns.size() << " moves, "
                << "iter=" << iteration << " threshold=" << threshold
                << " nodes=" << nodesExpanded << "\n";
      return turns;
    }
    if (r.nextThreshold == UINT32_MAX) {
      std::cout << "IDA* exhausted, no solution found, nodes=" << nodesExpanded
                << "\n";
      return {};
    }
    threshold = r.nextThreshold;
  }
}
