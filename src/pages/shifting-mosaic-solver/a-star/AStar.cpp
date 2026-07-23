#include "AStar.h"

#include <algorithm>
#include <chrono>
#include <compare>
#include <cmath>
#include <deque>
#include <iostream>
#include <numeric>
#include <queue>
#include <string>
#include <unordered_map>
#include <utility>

namespace {
uint64_t nowMs() {
  using namespace std::chrono;
  return static_cast<uint64_t>(
      duration_cast<milliseconds>(steady_clock::now().time_since_epoch())
          .count());
}

// Runs a callback on scope exit — used to accumulate SearchStats on every
// return path of a search pass.
template <typename F> struct ScopeExit {
  F fn;
  ~ScopeExit() { fn(); }
};
template <typename F> ScopeExit(F) -> ScopeExit<F>;
} // namespace

struct HeapEntry {
  uint32_t f;
  uint32_t g;
  NodeKey signature;
  // Order by f; on ties, prefer the deeper node (larger g) so the search
  // dives toward goals instead of fanning out across an f-plateau.
  auto operator<=>(const HeapEntry &o) const {
    if (const auto c = f <=> o.f; c != 0) return c;
    return o.g <=> g;
  }
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

  // Group non-goal blocks by identical shape. Blocks within a group are
  // physically interchangeable, so signatureFromAnchors canonicalises their
  // anchors — collapsing permutation-equivalent states. For puzzles with many
  // same-shape blocks this shrinks the search space by orders of magnitude.
  {
    std::unordered_map<std::string, std::vector<uint8_t>> byShape;
    for (uint8_t i = 0; i < shapes_.size(); i++) {
      if (i == goalIndex_) continue;
      std::vector<Position> cells = shapes_[i];
      int8_t minX = cells[0].x;
      int8_t minY = cells[0].y;
      for (const auto &c : cells) {
        minX = std::min(minX, c.x);
        minY = std::min(minY, c.y);
      }
      for (auto &c : cells) {
        c.x = static_cast<int8_t>(c.x - minX);
        c.y = static_cast<int8_t>(c.y - minY);
      }
      std::sort(cells.begin(), cells.end(),
                [](const Position &a, const Position &b) {
                  return a.x != b.x ? a.x < b.x : a.y < b.y;
                });
      std::string shapeKey;
      shapeKey.reserve(cells.size() * 2);
      for (const auto &c : cells) {
        shapeKey.push_back(static_cast<char>(c.x));
        shapeKey.push_back(static_cast<char>(c.y));
      }
      byShape[shapeKey].push_back(i);
    }
    for (auto &[key, group] : byShape) {
      if (group.size() >= 2) symmetryGroups_.push_back(std::move(group));
    }
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

  moveStride_ = cfg_.strideOverride != 0 ? cfg_.strideOverride : detectStride();

  std::cout << "AStar: " << movableBlockIndices_.size() << " of "
            << shapes_.size() << " blocks movable from start, move stride="
            << static_cast<int>(moveStride_)
            << (unsolvableAtStart_ ? " (UNSOLVABLE — locked block at goal)"
                                    : "")
            << "\n";
}

namespace {
// True iff `shape` is a clean G-magnification: every G×G super-cell it
// touches is completely filled. (A full rectangle with G-multiple sides is
// the common case.)
bool shapeScaledBy(const std::vector<Position> &shape, const int g) {
  std::unordered_map<int, int> superCellCount;
  for (const auto &c : shape) {
    superCellCount[(c.x / g) * 4096 + (c.y / g)]++;
  }
  for (const auto &[key, count] : superCellCount) {
    if (count != g * g) return false;
  }
  return true;
}

// True iff `shape` is exactly the perimeter of its bounding box — a hollow
// rectangular ring with a non-empty interior. Reports the bbox in w/h.
bool isPerimeterRing(const std::vector<Position> &shape, int &w, int &h) {
  int mx = 0;
  int my = 0;
  for (const auto &c : shape) {
    mx = std::max(mx, static_cast<int>(c.x));
    my = std::max(my, static_cast<int>(c.y));
  }
  w = mx + 1;
  h = my + 1;
  if (w < 3 || h < 3) return false; // needs a non-empty interior
  std::vector<uint8_t> grid(static_cast<size_t>(w) * h, 0);
  for (const auto &c : shape) grid[c.x * h + c.y] = 1;
  for (int x = 0; x < w; x++) {
    for (int y = 0; y < h; y++) {
      const bool onBorder = x == 0 || x == w - 1 || y == 0 || y == h - 1;
      if ((grid[x * h + y] != 0) != onBorder) return false;
    }
  }
  return true;
}
} // namespace

// Auto-detect a move stride G > 1: the period at which the puzzle's
// structure repeats. A move of G cells then keeps every block on its own
// mod-G sublattice.
//
// Step 1 — candidate G: GCD of the grid dimensions, the goal block's
// *displacement* (delta, not absolute anchor — the goal block may sit on an
// offset sublattice), and the bbox dimensions of every structured (non-1×1)
// block.
//
// Step 2 — shape verification: a candidate G is only trustworthy if EVERY
// block is a kind that genuinely has no sub-G structure — a 1×1 point, a
// G-scaled block, or a perimeter ring with a G-multiple bbox. Without this
// check the bare GCD produces false positives: e.g. an L-tromino in a 2×2
// box has even bbox dimensions but no period-2 structure whatsoever, so
// stride-2 would (silently, via the fallback) waste a search pass.
//
// Restricting moves to multiples of a verified G is sound (every emitted
// macro move is still a sequence of validated 1-cell hops). The stride-1
// fallback in search() remains as a final safety net.
uint8_t AStar::detectStride() const {
  int g = std::gcd(static_cast<int>(gridWidth_),
                   static_cast<int>(gridHeight_));
  const auto gi = initialAnchors_[goalIndex_];
  g = std::gcd(g, std::abs(static_cast<int>(goalAnchor_.x) - gi.x));
  g = std::gcd(g, std::abs(static_cast<int>(goalAnchor_.y) - gi.y));
  for (size_t i = 0; i < shapes_.size(); i++) {
    if (shapes_[i].size() <= 1) continue; // points don't constrain the stride
    if (shapeBoxWidth_[i] > 1)
      g = std::gcd(g, static_cast<int>(shapeBoxWidth_[i]));
    if (shapeBoxHeight_[i] > 1)
      g = std::gcd(g, static_cast<int>(shapeBoxHeight_[i]));
  }
  if (g <= 1) return 1;

  // Largest divisor of g for which every shape is stride-safe.
  for (int cand = g; cand >= 2; cand--) {
    if (g % cand != 0) continue;
    bool allSafe = true;
    for (const auto &shape : shapes_) {
      if (shape.size() == 1) continue; // point
      if (shapeScaledBy(shape, cand)) continue;
      int w = 0;
      int h = 0;
      if (isPerimeterRing(shape, w, h) && w % cand == 0 && h % cand == 0)
        continue;
      allSafe = false;
      break;
    }
    if (allSafe) return static_cast<uint8_t>(cand);
  }
  return 1;
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

  // 4. Per-block safe-anchor distance field. A "safe" anchor is a valid
  //    anchor whose footprint clears the corridor. The set of safe anchors is
  //    fixed (precomputed data only), so a one-shot multi-source BFS gives,
  //    for every cell, the Manhattan distance to the nearest safe anchor —
  //    exactly what lpDisplacementCost needs, in O(1) per lookup.
  blockSafeAnchorDist_.assign(shapes_.size(),
                              std::vector<uint16_t>(total, UINT16_MAX));
  for (uint8_t i = 0; i < shapes_.size(); i++) {
    if (i == goalIndex_) continue;
    const int aw = shapeBoxWidth_[i];
    const int ah = shapeBoxHeight_[i];
    auto &dist = blockSafeAnchorDist_[i];
    std::deque<std::pair<int, int>> queue;
    for (int x = 0; x + aw <= gridWidth_; x++) {
      for (int y = 0; y + ah <= gridHeight_; y++) {
        if (!blockValidAnchorMask_[i][x * gridHeight_ + y]) continue;
        bool inside = false;
        for (const auto &cell : shapes_[i]) {
          if (initialGoalPathCells_[(x + cell.x) * gridHeight_ +
                                     (y + cell.y)]) {
            inside = true;
            break;
          }
        }
        if (inside) continue;
        dist[x * gridHeight_ + y] = 0;
        queue.emplace_back(x, y);
      }
    }
    while (!queue.empty()) {
      auto [x, y] = queue.front();
      queue.pop_front();
      const uint16_t d = dist[x * gridHeight_ + y];
      for (int dir = 0; dir < 4; dir++) {
        const int nx = x + DX[dir];
        const int ny = y + DY[dir];
        if (nx < 0 || ny < 0 || nx >= gridWidth_ || ny >= gridHeight_)
          continue;
        uint16_t &cell = dist[nx * gridHeight_ + ny];
        if (cell != UINT16_MAX) continue;
        cell = d + 1;
        queue.emplace_back(nx, ny);
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

    // Min Manhattan distance from `a` to a safe anchor — a precomputed O(1)
    // field lookup. UINT16_MAX means no safe anchor exists, so the blocker is
    // permanently in the corridor; treat as +1 (search must route around it).
    const uint16_t d = blockSafeAnchorDist_[i][a.x * gridHeight_ + a.y];
    total += (d == UINT16_MAX) ? 1u : static_cast<uint32_t>(d);
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
  const uint16_t bfs = goalAnchorAt(goal.x, goal.y);
  const auto base = bfs == UINT16_MAX
                        ? static_cast<uint32_t>(std::abs(goal.x - goalAnchor_.x) +
                                                std::abs(goal.y - goalAnchor_.y))
                        : static_cast<uint32_t>(bfs);
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

NodeKey AStar::signatureFromAnchors(
    const std::vector<Position> &anchors) const {
  const auto n = static_cast<uint8_t>(anchors.size());
  NodeKey key(n);
  uint16_t *d = key.data();
  for (uint8_t i = 0; i < n; i++) {
    const auto &a = anchors[i];
    d[i] = static_cast<uint16_t>(
        (static_cast<uint16_t>(static_cast<uint8_t>(a.x)) << 8) |
        static_cast<uint8_t>(a.y));
  }
  // Canonicalise interchangeable blocks: within each same-shape group, sort
  // the packed anchors so states that differ only by permuting identical
  // blocks collapse to a single signature.
  for (const auto &group : symmetryGroups_) {
    const size_t m = group.size();
    if (m > 64) continue; // absurdly large group — skip (still correct)
    uint16_t vals[64];
    for (size_t k = 0; k < m; k++) vals[k] = d[group[k]];
    std::sort(vals, vals + m);
    for (size_t k = 0; k < m; k++) d[group[k]] = vals[k];
  }
  return key;
}

NodeKey AStar::nodeSignature(const Node &node) const {
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

// Public entry: runs A* at the detected/forced move stride, and — when the
// stride was auto-detected (strideOverride==0) — falls back to stride-1 if
// the quantized search genuinely exhausts without a solution. Stride
// quantization is sound but not provably complete for every layout, so the
// fallback guarantees we never lose a puzzle that stride-1 could solve.
std::vector<Turn> AStar::search(const uint32_t maxMs, const uint32_t maxNodes) {
  stats_ = {};
  std::vector<Turn> result = runAStar(maxMs, maxNodes);
  if (result.empty() && searchExhausted_ && moveStride_ > 1 &&
      cfg_.strideOverride == 0) {
    std::cout << "A*: stride-" << static_cast<int>(moveStride_)
              << " search exhausted with no solution — falling back to "
                 "stride-1\n";
    const uint8_t saved = moveStride_;
    moveStride_ = 1;
    result = runAStar(maxMs, maxNodes);
    moveStride_ = saved;
  }
  // Last resort: if the guided search came up empty, retry as pure BFS
  // (weight 0, stride 1). BFS can't be led astray by a weak heuristic, so it
  // cracks dense puzzles where weighted A* just wanders. This only ever runs
  // when A* already failed, so it cannot regress a puzzle A* can solve.
  if (result.empty() && cfg_.bfsFallback && cfg_.weight != 0) {
    std::cout << "A*: guided search found nothing — retrying as pure BFS\n";
    const uint8_t savedWeight = cfg_.weight;
    const uint8_t savedStride = moveStride_;
    cfg_.weight = 0;
    moveStride_ = 1;
    result = runAStar(maxMs, maxNodes);
    cfg_.weight = savedWeight;
    moveStride_ = savedStride;
  }
  if (cfg_.postProcess && !result.empty()) {
    const size_t beforeMoves = result.size();
    const size_t beforeSteps = countSteps(result);
    result = optimizeSolution(result);
    std::cout << "post-process: " << beforeMoves << " -> " << result.size()
              << " moves, " << beforeSteps << " -> " << countSteps(result)
              << " steps\n";
  }
  return result;
}

std::vector<Turn> AStar::runAStar(const uint32_t maxMs,
                                  const uint32_t maxNodes) {
  searchExhausted_ = false;
  if (unsolvableAtStart_) {
    std::cout << "A* short-circuit: a permanently-locked block sits on the "
                 "goal block's final footprint — puzzle is unsolvable\n";
    searchExhausted_ = true;
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
  const ScopeExit statsGuard{[&] {
    stats_.passes++;
    stats_.nodesExpanded += nodesExpanded;
    stats_.statesStored += states.size();
  }};

  while (!openHeap.empty()) {
    if (cfg_.cancel && (nodesExpanded & 0xFF) == 0 &&
        cfg_.cancel->load(std::memory_order_relaxed)) {
      std::cout << "A* cancelled after " << nodesExpanded << " nodes\n";
      return {};
    }
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
    if (nodesExpanded % 2000000 == 0) {
      std::cout << "  ... A* working: " << nodesExpanded << " nodes, heap="
                << openHeap.size() << ", states=" << states.size() << ", g="
                << current.g << "\n";
      std::cout.flush();
    }

    if (cfg_.deadlockPruning && isDeadlocked(node.anchors))
      continue;

    for (const uint8_t i : movableBlockIndices_) {
      for (int d = 0; d < 4; d++) {
        // Slide block i in direction d until the first stride-aligned cell,
        // which is the only real search state in that direction; the cells
        // skipped on the way are valid 1-cell hops but never branched on.
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
          // Only stride-aligned cells are real search states; the cells in
          // between are valid 1-cell hops but never branched on.
          if (k % moveStride_ != 0) continue;

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

          break;
        }
      }
    }
  }

  std::cout << "A* found no solution, expanded " << nodesExpanded << " nodes\n";
  searchExhausted_ = true;
  return {};
}

// ===========================================================================
// Solution post-processing
//
// A* with weighted/non-admissible heuristics returns a *valid* but not
// necessarily *optimal* solution. This pass shortens it with a handful of
// local rewrites, each one accepted only if a full replay confirms the
// candidate is still a valid solution that is no longer than the input. That
// replay check (`replaySolves`) is the single source of truth — every rewrite
// rule is just a *candidate generator*, so a buggy generator can never produce
// an invalid or longer solution, only miss an improvement.
//
// Rewrites, applied greedily to a fixed point:
//   * truncation        — drop everything after the goal block first reaches
//                         goalAnchor.
//   * run-pair cancel   — a block slides one way and later the opposite way;
//                         cancel the overlapping part of both slides.
//   * run removal       — a block's entire slide turns out to be unnecessary.
//   * single removal    — one stray turn is unnecessary.
//   * reorder / merge   — "A slides, B slides, A slides the same way again":
//                         do both of A's slides back-to-back (one player
//                         drag) when no collision forbids it.
// ===========================================================================

std::vector<AStar::MoveRun>
AStar::computeRuns(const std::vector<Turn> &turns) {
  std::vector<MoveRun> runs;
  for (size_t i = 0; i < turns.size(); i++) {
    if (!runs.empty() && runs.back().blockId == turns[i].blockId &&
        runs.back().dir == turns[i].direction) {
      runs.back().len++;
    } else {
      runs.push_back({i, 1, turns[i].blockId, turns[i].direction});
    }
  }
  return runs;
}

// Player steps as the UI counts them (solutionView.ts): one step = a maximal
// run of consecutive turns of the SAME BLOCK, across direction changes — the
// player performs it as a single polyline drag. (computeRuns is finer: it
// splits on direction too, because the rewrite passes operate on straight
// legs.)
size_t AStar::countSteps(const std::vector<Turn> &turns) {
  size_t steps = 0;
  for (size_t i = 0; i < turns.size(); i++)
    if (i == 0 || turns[i].blockId != turns[i - 1].blockId)
      steps++;
  return steps;
}

bool AStar::replaySolves(const std::vector<Turn> &turns) const {
  std::vector<Position> anchors = initialAnchors_;
  for (const auto &t : turns) {
    if (t.blockId >= anchors.size()) return false;
    const int d = static_cast<int>(t.direction);
    const Position next{static_cast<int8_t>(anchors[t.blockId].x + DX[d]),
                        static_cast<int8_t>(anchors[t.blockId].y + DY[d])};
    if (!inBounds(t.blockId, next)) return false;
    anchors[t.blockId] = next;
    if (collidesWithOthers(t.blockId, next, anchors)) return false;
  }
  return anchors[goalIndex_] == goalAnchor_;
}

size_t
AStar::firstSolvingPrefixLen(const std::vector<Turn> &turns) const {
  std::vector<Position> anchors = initialAnchors_;
  if (anchors[goalIndex_] == goalAnchor_) return 0;
  for (size_t i = 0; i < turns.size(); i++) {
    const auto &t = turns[i];
    const int d = static_cast<int>(t.direction);
    anchors[t.blockId] = {
        static_cast<int8_t>(anchors[t.blockId].x + DX[d]),
        static_cast<int8_t>(anchors[t.blockId].y + DY[d])};
    if (t.blockId == goalIndex_ && anchors[goalIndex_] == goalAnchor_)
      return i + 1;
  }
  return turns.size();
}

// A block slides `dir` for `runA` turns and later slides the opposite way for
// `runB` turns. The overlapping min(lenA, lenB) cells are a pure detour: try
// to delete that many turns from each run (largest overlap first).
bool AStar::tryRunPairCancellation(std::vector<Turn> &turns) const {
  const auto runs = computeRuns(turns);
  for (size_t a = 0; a < runs.size(); a++) {
    for (size_t b = a + 1; b < runs.size(); b++) {
      if (runs[a].blockId != runs[b].blockId) continue;
      if ((static_cast<int>(runs[a].dir) + 2) % 4 !=
          static_cast<int>(runs[b].dir))
        continue; // not opposite directions
      const size_t maxC = std::min(runs[a].len, runs[b].len);
      for (size_t c = maxC; c >= 1; c--) {
        const size_t aLo = runs[a].start + runs[a].len - c;
        const size_t aHi = runs[a].start + runs[a].len;
        const size_t bLo = runs[b].start;
        const size_t bHi = runs[b].start + c;
        std::vector<Turn> cand;
        cand.reserve(turns.size() - 2 * c);
        for (size_t k = 0; k < turns.size(); k++) {
          if (k >= aLo && k < aHi) continue;
          if (k >= bLo && k < bHi) continue;
          cand.push_back(turns[k]);
        }
        if (replaySolves(cand)) {
          turns = std::move(cand);
          return true;
        }
      }
    }
  }
  return false;
}

// An entire slide of a block may be superfluous (e.g. a block edged aside for
// a clearance that the rest of the solution never actually needed).
bool AStar::tryRunRemoval(std::vector<Turn> &turns) const {
  const auto runs = computeRuns(turns);
  for (const auto &r : runs) {
    std::vector<Turn> cand;
    cand.reserve(turns.size() - r.len);
    for (size_t k = 0; k < turns.size(); k++) {
      if (k >= r.start && k < r.start + r.len) continue;
      cand.push_back(turns[k]);
    }
    if (replaySolves(cand)) {
      turns = std::move(cand);
      return true;
    }
  }
  return false;
}

// General clean-up: drop any single turn whose removal still leaves a valid
// solution. Looped, this also unwinds detours one cell at a time.
bool AStar::trySingleRemoval(std::vector<Turn> &turns) const {
  for (size_t k = 0; k < turns.size(); k++) {
    std::vector<Turn> cand;
    cand.reserve(turns.size() - 1);
    for (size_t m = 0; m < turns.size(); m++)
      if (m != k) cand.push_back(turns[m]);
    if (replaySolves(cand)) {
      turns = std::move(cand);
      return true;
    }
  }
  return false;
}

// "A slides, B slides, A slides the same way again." If nothing forbids it,
// run both of A's slides back-to-back so the player performs a single drag.
// Turn count is unchanged; the player-step count drops by one. Only A's two
// runs are relocated past *other* blocks' runs — A's own move order is never
// reordered — so the run brought adjacent always merges.
bool AStar::tryReorderMerge(std::vector<Turn> &turns) const {
  const auto runs = computeRuns(turns);
  const size_t baseSteps = runs.size();
  std::vector<int> prevRunOfBlock(shapes_.size(), -1);
  for (size_t j = 0; j < runs.size(); j++) {
    const int prev = prevRunOfBlock[runs[j].blockId];
    prevRunOfBlock[runs[j].blockId] = static_cast<int>(j);
    if (prev < 0) continue;
    const auto &ri = runs[static_cast<size_t>(prev)];
    const auto &rj = runs[j];
    if (ri.dir != rj.dir) continue; // different dir → cannot merge cleanly
    if (static_cast<size_t>(prev) + 1 == j) continue; // already adjacent
    const size_t riEnd = ri.start + ri.len;
    const size_t rjEnd = rj.start + rj.len;

    // Candidate 1: pull run j left, right after run i.
    {
      std::vector<Turn> cand;
      cand.reserve(turns.size());
      for (size_t k = 0; k < riEnd; k++) cand.push_back(turns[k]);
      for (size_t k = rj.start; k < rjEnd; k++) cand.push_back(turns[k]);
      for (size_t k = riEnd; k < rj.start; k++) cand.push_back(turns[k]);
      for (size_t k = rjEnd; k < turns.size(); k++) cand.push_back(turns[k]);
      if (countSteps(cand) < baseSteps && replaySolves(cand)) {
        turns = std::move(cand);
        return true;
      }
    }
    // Candidate 2: push run i right, just before run j.
    {
      std::vector<Turn> cand;
      cand.reserve(turns.size());
      for (size_t k = 0; k < ri.start; k++) cand.push_back(turns[k]);
      for (size_t k = riEnd; k < rj.start; k++) cand.push_back(turns[k]);
      for (size_t k = ri.start; k < riEnd; k++) cand.push_back(turns[k]);
      for (size_t k = rj.start; k < turns.size(); k++) cand.push_back(turns[k]);
      if (countSteps(cand) < baseSteps && replaySolves(cand)) {
        turns = std::move(cand);
        return true;
      }
    }
  }
  return false;
}

std::vector<Turn>
AStar::optimizeSolution(const std::vector<Turn> &input) const {
  std::vector<Turn> cur = input;
  cur.resize(firstSolvingPrefixLen(cur));

  // Every accepted rewrite strictly lowers (turns, then steps), both bounded
  // below by 0, so the loop terminates; the cap is only a paranoia guard.
  constexpr int kMaxIterations = 100000;
  for (int iter = 0; iter < kMaxIterations; iter++) {
    const bool improved =
        tryRunPairCancellation(cur) || tryRunRemoval(cur) ||
        trySingleRemoval(cur) || tryReorderMerge(cur);
    if (!improved) break;
    cur.resize(firstSolvingPrefixLen(cur));
  }
  return cur;
}
