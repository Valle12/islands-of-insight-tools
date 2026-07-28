// AStar: construction and one-shot board analysis.
//
// Everything here runs once per AStar instance, before any search: shape
// boxes and cell sets, same-shape symmetry groups, move-stride detection,
// the per-block reachability masks and the goal-anchor BFS. The search
// lives in AStarSearch.cpp and the cost functions in AStarHeuristics.cpp.

#include "ClangdCompat.h" // must stay first; see the header

#include "AStar.h"

#include <algorithm>
#include <cstdlib>
#include <deque>
#include <iostream>
#include <numeric>
#include <ranges>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <utility>

AStar::AStar(const uint8_t gridWidth, const uint8_t gridHeight,
             std::vector<std::vector<Position>> shapes,
             std::vector<Position> initialAnchors, const uint8_t goalIndex,
             const Position goalAnchor, const Config &config)
    : gridWidth_(gridWidth), gridHeight_(gridHeight),
      shapes_(std::move(shapes)), initialAnchors_(std::move(initialAnchors)),
      goalIndex_(goalIndex), goalAnchor_(goalAnchor), cfg_(config) {
  shapeBoxWidth_.reserve(shapes_.size());
  shapeBoxHeight_.reserve(shapes_.size());
  shapeCellSets_.reserve(shapes_.size());
  for (const auto &shape : shapes_) {
    uint8_t maxX = 0;
    uint8_t maxY = 0;
    for (const auto &[cx, cy] : shape) {
      if (cx > static_cast<int8_t>(maxX))
        maxX = static_cast<uint8_t>(cx);
      if (cy > static_cast<int8_t>(maxY))
        maxY = static_cast<uint8_t>(cy);
    }
    shapeBoxWidth_.push_back(maxX + 1);
    shapeBoxHeight_.push_back(maxY + 1);
    std::unordered_set<uint16_t> set;
    set.reserve(shape.size() * 2);
    for (const auto &[cx, cy] : shape) {
      set.insert(
          static_cast<uint16_t>(static_cast<uint32_t>(cx) * SHAPE_STRIDE + cy));
    }
    shapeCellSets_.push_back(std::move(set));
  }

  // Group non-goal blocks by identical shape. Blocks within a group are
  // physically interchangeable, so signatureFromAnchors canonicalises their
  // anchors — collapsing permutation-equivalent states. For puzzles with many
  // same-shape blocks this shrinks the search space by orders of magnitude.
  {
    // Sonar suggests a transparent hasher here. Skipped deliberately: the only
    // lookup is `byShape[shapeKey]` with a std::string we just built, so a
    // heterogeneous hasher would add machinery no call site can use.
    std::unordered_map<std::string, std::vector<uint8_t>> byShape;
    for (size_t i = 0; i < shapes_.size(); i++) {
      if (i == goalIndex_)
        continue;
      std::vector<Position> cells = shapes_[i];
      // A cell-less shape has no normalisation origin. Leaving it ungrouped
      // only forgoes an optimisation, whereas cells[0] on an empty vector is
      // undefined behaviour.
      if (cells.empty())
        continue;
      int8_t minX = cells[0].x;
      int8_t minY = cells[0].y;
      for (const auto &[cx, cy] : cells) {
        minX = std::min(minX, cx);
        minY = std::min(minY, cy);
      }
      for (auto &[cx, cy] : cells) {
        cx = static_cast<int8_t>(cx - minX);
        cy = static_cast<int8_t>(cy - minY);
      }
      std::ranges::sort(cells, [](const Position &a, const Position &b) {
        return a.x != b.x ? a.x < b.x : a.y < b.y;
      });
      std::string shapeKey;
      shapeKey.reserve(cells.size() * 2);
      for (const auto &[cx, cy] : cells) {
        shapeKey.push_back(static_cast<char>(cx));
        shapeKey.push_back(static_cast<char>(cy));
      }
      byShape[shapeKey].push_back(static_cast<uint8_t>(i));
    }
    for (auto &group : byShape | std::views::values) {
      if (group.size() >= 2)
        symmetryGroups_.push_back(std::move(group));
    }
  }

  for (const auto &[cx, cy] : shapes_[goalIndex_]) {
    const auto ax = static_cast<int16_t>(goalAnchor_.x + cx);
    const auto ay = static_cast<int16_t>(goalAnchor_.y + cy);
    goalBlockFinalCells_.insert(
        static_cast<uint16_t>(ax * static_cast<int16_t>(gridHeight_) + ay));
  }

  // Identify blocks that can never move from the initial state and exclude
  // them from move generation. Also detect upfront whether one of them
  // permanently blocks the goal block's final footprint → unsolvable.
  auto movableFromStart = computeMovableSet(initialAnchors_);
  movableBlockIndices_.reserve(shapes_.size());
  for (size_t i = 0; i < shapes_.size(); i++) {
    if (movableFromStart[i] || i == goalIndex_) {
      movableBlockIndices_.push_back(static_cast<uint8_t>(i));
    } else {
      const auto &[ax, ay] = initialAnchors_[i];
      for (const auto &[cx, cy] : shapes_[i]) {
        const auto enc =
            static_cast<uint16_t>((ax + cx) * gridHeight_ + (ay + cy));
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
  for (const auto &[cx, cy] : shape) {
    superCellCount[cx / g * 4096 + cy / g]++;
  }
  return std::ranges::all_of(superCellCount | std::views::values,
                             [g](const int count) { return count == g * g; });
}

// True iff `shape` is exactly the perimeter of its bounding box — a hollow
// rectangular ring with a non-empty interior. Reports the bbox in w/h.
bool isPerimeterRing(const std::vector<Position> &shape, int &w, int &h) {
  int mx = 0;
  int my = 0;
  for (const auto &[cx, cy] : shape) {
    mx = std::max(mx, static_cast<int>(cx));
    my = std::max(my, static_cast<int>(cy));
  }
  w = mx + 1;
  h = my + 1;
  if (w < 3 || h < 3)
    return false; // needs a non-empty interior
  std::vector<uint8_t> grid(static_cast<size_t>(w) * h, 0);
  for (const auto &[cx, cy] : shape)
    grid[cx * h + cy] = 1;
  for (int x = 0; x < w; x++) {
    for (int y = 0; y < h; y++) {
      if (const bool onBorder = x == 0 || x == w - 1 || y == 0 || y == h - 1;
          (grid[x * h + y] != 0) != onBorder)
        return false;
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
  int g = std::gcd(static_cast<int>(gridWidth_), static_cast<int>(gridHeight_));
  const auto [goalStartX, goalStartY] = initialAnchors_[goalIndex_];
  g = std::gcd(g, std::abs(static_cast<int>(goalAnchor_.x) - goalStartX));
  g = std::gcd(g, std::abs(static_cast<int>(goalAnchor_.y) - goalStartY));
  for (size_t i = 0; i < shapes_.size(); i++) {
    if (shapes_[i].size() <= 1)
      continue; // points don't constrain the stride
    if (shapeBoxWidth_[i] > 1)
      g = std::gcd(g, static_cast<int>(shapeBoxWidth_[i]));
    if (shapeBoxHeight_[i] > 1)
      g = std::gcd(g, static_cast<int>(shapeBoxHeight_[i]));
  }
  if (g <= 1)
    return 1;

  // Largest divisor of g for which every shape is stride-safe.
  for (int cand = g; cand >= 2; cand--) {
    if (g % cand != 0)
      continue;
    bool allSafe = true;
    for (const auto &shape : shapes_) {
      if (shape.size() == 1)
        continue; // point
      if (shapeScaledBy(shape, cand))
        continue;
      int w = 0;
      if (int h = 0;
          isPerimeterRing(shape, w, h) && w % cand == 0 && h % cand == 0)
        continue;
      allSafe = false;
      break;
    }
    if (allSafe)
      return static_cast<uint8_t>(cand);
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
  for (size_t i = 0; i < shapes_.size(); i++) {
    if (movable[i] || i == goalIndex_)
      continue;
    const auto &[ax, ay] = initialAnchors_[i];
    for (const auto &[cx, cy] : shapes_[i]) {
      lockedCell[(ax + cx) * gridHeight_ + (ay + cy)] = 1;
    }
  }

  // 2. Per-block valid-anchor mask.
  blockValidAnchorMask_.assign(shapes_.size(), std::vector<uint8_t>(total, 0));
  for (size_t i = 0; i < shapes_.size(); i++) {
    if (i == goalIndex_)
      continue;
    const int aw = shapeBoxWidth_[i];
    const int ah = shapeBoxHeight_[i];
    for (int x = 0; x + aw <= gridWidth_; x++) {
      for (int y = 0; y + ah <= gridHeight_; y++) {
        bool ok = true;
        for (const auto &[cx, cy] : shapes_[i]) {
          if (lockedCell[(x + cx) * gridHeight_ + (y + cy)]) {
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
  const auto [initGoalX, initGoalY] = initialAnchors_[goalIndex_];
  if (goalAnchorAt(initGoalX, initGoalY) == UINT16_MAX)
    return;
  const uint16_t dStart = goalAnchorAt(initGoalX, initGoalY);
  const auto &gShape = shapes_[goalIndex_];
  // Collect via reverse BFS: an anchor (x,y) is on some shortest path if
  //   bfs[x,y] + dist((x,y) → initGoal) = dStart and bfs[x,y] + bfs_back ==
  //   dStart
  // since the anchor graph is undirected we just check
  //   bfs[x,y] + manhattan((x,y), initGoal) == dStart (necessary, not
  //   sufficient — but cheap and acceptable for a fixed reference path).
  for (int x = 0; x < gridWidth_; x++) {
    for (int y = 0; y < gridHeight_; y++) {
      const uint16_t d =
          goalAnchorAt(static_cast<int8_t>(x), static_cast<int8_t>(y));
      if (d == UINT16_MAX || d > dStart)
        continue;
      if (const int mh = std::abs(x - initGoalX) + std::abs(y - initGoalY);
          d + mh != dStart)
        continue;
      for (const auto &[cx, cy] : gShape) {
        initialGoalPathCells_[(x + cx) * gridHeight_ + (y + cy)] = 1;
      }
    }
  }

  // 4. Per-block safe-anchor distance field. A "safe" anchor is a valid
  //    anchor whose footprint clears the corridor. The set of safe anchors is
  //    fixed (precomputed data only), so a one-shot multi-source BFS gives,
  //    for every cell, the Manhattan distance to the nearest safe anchor —
  //    exactly what lpDisplacementCost needs, in O(1) per lookup.
  // Element type spelled out, NOT deduced: UINT16_MAX is an int, so
  // std::vector(total, UINT16_MAX) deduces vector<int> and does not match this
  // member. Clang rejects it; MSVC accepts it, so the native build is not
  // enough to catch the mistake.
  blockSafeAnchorDist_.assign(shapes_.size(),
                              std::vector<uint16_t>(total, UINT16_MAX));
  for (size_t i = 0; i < shapes_.size(); i++) {
    if (i == goalIndex_)
      continue;
    const int aw = shapeBoxWidth_[i];
    const int ah = shapeBoxHeight_[i];
    auto &dist = blockSafeAnchorDist_[i];
    std::deque<std::pair<int, int>> queue;
    for (int x = 0; x + aw <= gridWidth_; x++) {
      for (int y = 0; y + ah <= gridHeight_; y++) {
        if (!blockValidAnchorMask_[i][x * gridHeight_ + y])
          continue;
        bool inside = false;
        for (const auto &[cx, cy] : shapes_[i]) {
          if (initialGoalPathCells_[(x + cx) * gridHeight_ + (y + cy)]) {
            inside = true;
            break;
          }
        }
        if (inside)
          continue;
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
        if (cell != UINT16_MAX)
          continue;
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
uint32_t AStar::lpDisplacementCost(const std::vector<Position> &anchors) const {
  if (initialGoalPathCells_.empty())
    return 0;
  uint32_t total = 0;
  for (const uint8_t i : movableBlockIndices_) {
    if (i == goalIndex_)
      continue;
    const auto &[ax, ay] = anchors[i];
    // Is this block currently inside the corridor?
    bool inCorridor = false;
    for (const auto &[cx, cy] : shapes_[i]) {
      if (initialGoalPathCells_[(ax + cx) * gridHeight_ + (ay + cy)]) {
        inCorridor = true;
        break;
      }
    }
    if (!inCorridor)
      continue;

    // Min Manhattan distance from this anchor to a safe one — a precomputed
    // O(1) field lookup. UINT16_MAX means no safe anchor exists, so the
    // blocker is
    // permanently in the corridor; treat as +1 (search must route around it).
    const uint16_t d = blockSafeAnchorDist_[i][ax * gridHeight_ + ay];
    total += d == UINT16_MAX ? 1u : static_cast<uint32_t>(d);
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
  for (size_t i = 0; i < shapes_.size(); i++) {
    if (movable[i] || i == goalIndex_)
      continue;
    const auto &[ax, ay] = initialAnchors_[i];
    for (const auto &[cx, cy] : shapes_[i]) {
      lockedWall[(ax + cx) * gridHeight_ + (ay + cy)] = 1;
    }
  }

  // Helper: is this anchor valid for the goal block (in-bounds + no locked
  // cell overlap)?
  const auto &gShape = shapes_[goalIndex_];
  const int gw = shapeBoxWidth_[goalIndex_];
  const int gh = shapeBoxHeight_[goalIndex_];
  auto anchorValid = [&](const int8_t x, const int8_t y) {
    if (x < 0 || y < 0)
      return false;
    if (x + gw > gridWidth_ || y + gh > gridHeight_)
      return false;
    for (const auto &[cx, cy] : gShape) {
      if (lockedWall[(x + cx) * gridHeight_ + (y + cy)])
        return false;
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
      const auto nx = static_cast<int8_t>(x + DX[dir]);
      const auto ny = static_cast<int8_t>(y + DY[dir]);
      if (!anchorValid(nx, ny))
        continue;
      uint16_t &cell = goalAnchorBfsDist_[nx * gridHeight_ + ny];
      if (cell != UINT16_MAX)
        continue;
      cell = d + 1;
      queue.emplace_back(nx, ny);
    }
  }

  if (goalAnchorAt(initialAnchors_[goalIndex_].x,
                   initialAnchors_[goalIndex_].y) == UINT16_MAX) {
    unsolvableAtStart_ = true;
  }
}
