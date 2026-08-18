// AStar: construction and one-shot board analysis.
//
// Everything here runs once per AStar instance, before any search: shape
// boxes and cell sets, same-shape symmetry groups, move-stride detection,
// the per-block reachability masks and the goal-anchor BFS. The search
// lives in AStarSearch.cpp and the cost functions in AStarHeuristics.cpp.
//
// PERFORMANCE NOTE. Splitting the three oversized functions here into named
// phases costs a MEASURED ~3.3% on the unit leg, reproduced against a
// freshly-built HEAD (9 interleaved reps; every other leg within noise, and
// reverting only this file's changes recovers all of it). Nothing that was
// split runs per node — they are all construction — so the cost is this
// translation unit's codegen shifting around lpDisplacementCost below, which
// IS per node. Two attempts to recover it made things worse: routing
// lpDisplacementCost's corridor test through footprintClear(), and moving the
// function to AStarHeuristics.cpp (unit +3.7%, beam +4.2%). Accepted rather
// than chased, because unlike a pure style fix this buys the actual
// reductions: 43, 80 and 28 down to single digits, plus eight nesting
// findings. Re-measure before rearranging this file.

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
  buildShapeMetadata();
  buildSymmetryGroups();
  buildGoalFinalCells();
  detectMovableAndUnsolvable();
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

void AStar::buildShapeMetadata() {
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
}

std::vector<Position> AStar::normalizedCells(const std::vector<Position> &shape) {
  std::vector<Position> cells = shape;
  if (cells.empty())
    return cells;
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
  return cells;
}

// Group non-goal blocks by identical shape. Blocks within a group are
// physically interchangeable, so signatureFromAnchors canonicalizes their
// anchors — collapsing permutation-equivalent states. For puzzles with many
// same-shape blocks this shrinks the search space by orders of magnitude.
//
// Grouped by comparing normalized cell lists directly rather than through an
// unordered_map keyed on a serialized string. There are at most a few dozen
// blocks, so the pairwise scan costs nothing at construction, and it drops
// both the serialize-to-string step and the transparent-hasher question that
// map raised. Group ORDER changes from hash order to first-appearance order,
// which nothing depends on: signatureFromAnchors sorts each group's slots
// independently.
void AStar::buildSymmetryGroups() {
  std::vector<std::vector<Position>> shapeKeys;
  std::vector<std::vector<uint8_t>> groups;
  for (size_t i = 0; i < shapes_.size(); i++) {
    if (i == goalIndex_)
      continue;
    std::vector<Position> cells = normalizedCells(shapes_[i]);
    // A cell-less shape has no normalization origin, so it cannot be matched
    // against anything; leaving it ungrouped only forgoes an optimization.
    if (cells.empty())
      continue;
    const auto it = std::ranges::find(shapeKeys, cells);
    if (it == shapeKeys.end()) {
      shapeKeys.push_back(std::move(cells));
      groups.push_back({static_cast<uint8_t>(i)});
      continue;
    }
    groups[static_cast<size_t>(std::distance(shapeKeys.begin(), it))].push_back(
        static_cast<uint8_t>(i));
  }
  for (auto &group : groups) {
    if (group.size() >= 2)
      symmetryGroups_.push_back(std::move(group));
  }
}

void AStar::buildGoalFinalCells() {
  for (const auto &[cx, cy] : shapes_[goalIndex_]) {
    const auto ax = static_cast<int16_t>(goalAnchor_.x + cx);
    const auto ay = static_cast<int16_t>(goalAnchor_.y + cy);
    goalBlockFinalCells_.insert(
        static_cast<uint16_t>(ax * static_cast<int16_t>(gridHeight_) + ay));
  }
}

bool AStar::blockOnGoalFootprint(const size_t i, const Position anchor) const {
  return std::ranges::any_of(shapes_[i], [&](const Position &cell) {
    return goalBlockFinalCells_.contains(static_cast<uint16_t>(
        (anchor.x + cell.x) * gridHeight_ + (anchor.y + cell.y)));
  });
}

// Identify blocks that can never move from the initial state and exclude them
// from move generation. Also detect upfront whether one of them permanently
// blocks the goal block's final footprint → unsolvable.
void AStar::detectMovableAndUnsolvable() {
  const auto movableFromStart = computeMovableSet(initialAnchors_);
  movableBlockIndices_.reserve(shapes_.size());
  for (size_t i = 0; i < shapes_.size(); i++) {
    if (movableFromStart[i] || i == goalIndex_) {
      movableBlockIndices_.push_back(static_cast<uint8_t>(i));
      continue;
    }
    if (blockOnGoalFootprint(i, initialAnchors_[i]))
      unsolvableAtStart_ = true;
  }
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
std::vector<uint8_t> AStar::lockedCellMask() const {
  const size_t total =
      static_cast<size_t>(gridWidth_) * static_cast<size_t>(gridHeight_);
  std::vector<uint8_t> locked(total, 0);
  const auto movable = computeMovableSet(initialAnchors_);
  for (size_t i = 0; i < shapes_.size(); i++) {
    if (movable[i] || i == goalIndex_)
      continue;
    const auto &[ax, ay] = initialAnchors_[i];
    for (const auto &[cx, cy] : shapes_[i])
      locked[(ax + cx) * gridHeight_ + (ay + cy)] = 1;
  }
  return locked;
}

bool AStar::footprintClear(const size_t i, const int x, const int y,
                           const std::vector<uint8_t> &cellMask) const {
  return std::ranges::none_of(shapes_[i], [&](const Position &cell) {
    return cellMask[(x + cell.x) * gridHeight_ + (y + cell.y)] != 0;
  });
}

void AStar::markValidAnchors(const size_t i,
                             const std::vector<uint8_t> &lockedCell) {
  const int aw = shapeBoxWidth_[i];
  const int ah = shapeBoxHeight_[i];
  auto &mask = blockValidAnchorMask_[i];
  for (int x = 0; x + aw <= gridWidth_; x++)
    for (int y = 0; y + ah <= gridHeight_; y++)
      if (footprintClear(i, x, y, lockedCell))
        mask[x * gridHeight_ + y] = 1;
}

void AStar::buildValidAnchorMasks(const std::vector<uint8_t> &lockedCell) {
  const size_t total =
      static_cast<size_t>(gridWidth_) * static_cast<size_t>(gridHeight_);
  blockValidAnchorMask_.assign(shapes_.size(), std::vector<uint8_t>(total, 0));
  for (size_t i = 0; i < shapes_.size(); i++)
    if (i != goalIndex_)
      markValidAnchors(i, lockedCell);
}

// Collect via reverse BFS: an anchor (x,y) is on some shortest path if
//   bfs[x,y] + dist((x,y) → initGoal) = dStart and bfs[x,y] + bfs_back ==
//   dStart
// since the anchor graph is undirected we just check
//   bfs[x,y] + manhattan((x,y), initGoal) == dStart (necessary, not
//   sufficient — but cheap and acceptable for a fixed reference path).
bool AStar::onShortestGoalPath(const int x, const int y, const int initGoalX,
                               const int initGoalY,
                               const uint16_t dStart) const {
  const uint16_t d =
      goalAnchorAt(static_cast<int8_t>(x), static_cast<int8_t>(y));
  if (d == UINT16_MAX || d > dStart)
    return false;
  const int mh = std::abs(x - initGoalX) + std::abs(y - initGoalY);
  return d + mh == dStart;
}

// Initial-state goal-block BFS path cells. Walk every anchor that lies on a
// shortest path from goalAnchor → initialAnchor; the goal block's footprint at
// any such anchor is part of the "corridor".
bool AStar::buildInitialGoalPathCells() {
  const size_t total =
      static_cast<size_t>(gridWidth_) * static_cast<size_t>(gridHeight_);
  initialGoalPathCells_.assign(total, 0);
  const auto [initGoalX, initGoalY] = initialAnchors_[goalIndex_];
  const uint16_t dStart = goalAnchorAt(initGoalX, initGoalY);
  if (dStart == UINT16_MAX)
    return false;
  const auto &gShape = shapes_[goalIndex_];
  for (int x = 0; x < gridWidth_; x++) {
    for (int y = 0; y < gridHeight_; y++) {
      if (!onShortestGoalPath(x, y, initGoalX, initGoalY, dStart))
        continue;
      for (const auto &[cx, cy] : gShape)
        initialGoalPathCells_[(x + cx) * gridHeight_ + (y + cy)] = 1;
    }
  }
  return true;
}

void AStar::buildSafeAnchorField(const size_t i) {
  const int aw = shapeBoxWidth_[i];
  const int ah = shapeBoxHeight_[i];
  auto &dist = blockSafeAnchorDist_[i];
  std::deque<std::pair<int, int>> queue;
  for (int x = 0; x + aw <= gridWidth_; x++) {
    for (int y = 0; y + ah <= gridHeight_; y++) {
      // Safe = a valid anchor whose footprint also clears the corridor.
      if (!blockValidAnchorMask_[i][x * gridHeight_ + y] ||
          !footprintClear(i, x, y, initialGoalPathCells_))
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

// Per-block safe-anchor distance field. The set of safe anchors is fixed
// (precomputed data only), so a one-shot multi-source BFS gives, for every
// cell, the Manhattan distance to the nearest safe anchor — exactly what
// lpDisplacementCost needs, in O(1) per lookup.
void AStar::buildSafeAnchorDistances() {
  const size_t total =
      static_cast<size_t>(gridWidth_) * static_cast<size_t>(gridHeight_);
  // Element type spelled out, NOT deduced: UINT16_MAX is an int, so
  // std::vector(total, UINT16_MAX) deduces vector<int> and does not match this
  // member. Clang rejects it; MSVC accepts it, so the native build is not
  // enough to catch the mistake. (Reverted once from a CLion CTAD quick-fix,
  // which broke the wasm build while every native check stayed green.)
  blockSafeAnchorDist_.assign(shapes_.size(),
                              std::vector<uint16_t>(total, UINT16_MAX));
  for (size_t i = 0; i < shapes_.size(); i++)
    if (i != goalIndex_)
      buildSafeAnchorField(i);
}

void AStar::computeBlockReachability() {
  const std::vector<uint8_t> lockedCell = lockedCellMask();
  buildValidAnchorMasks(lockedCell);
  // A goal block that cannot reach its target has no corridor, so there is
  // nothing for the safe-anchor fields to measure distance from — the original
  // returned at exactly this point, leaving them empty.
  if (!buildInitialGoalPathCells())
    return;
  buildSafeAnchorDistances();
}

// For each movable non-goal block whose current footprint overlaps the
// pre-computed goal-block path corridor, add a lower bound on how far that
// block must move to clear the corridor — namely, the minimum Manhattan
// distance from its current anchor to a valid anchor whose shape lies
// entirely outside the corridor. Sum is admissible because each blocker
// must move at least that far, and we ignore the bipartite-assignment
// conflict (LP relaxation) which can only decrease the bound.
//
// The corridor test below is what footprintClear() does, but is NOT routed
// through it: this is the one per-node function in this file, and both sharing
// the helper and moving the function to AStarHeuristics.cpp were measured and
// made things worse. See the note on the construction split above.
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
    // blocker is permanently in the corridor; treat as +1 (the search must
    // route around it).
    const uint16_t d = blockSafeAnchorDist_[i][ax * gridHeight_ + ay];
    total += d == UINT16_MAX ? 1u : static_cast<uint32_t>(d);
  }
  return total;
}

// Is this anchor valid for the goal block: in-bounds, and no overlap with a
// permanently-locked cell?
bool AStar::goalAnchorValid(const int8_t x, const int8_t y,
                            const std::vector<uint8_t> &lockedWall) const {
  if (x < 0 || y < 0)
    return false;
  if (x + shapeBoxWidth_[goalIndex_] > gridWidth_ ||
      y + shapeBoxHeight_[goalIndex_] > gridHeight_)
    return false;
  return footprintClear(goalIndex_, x, y, lockedWall);
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

  // Cells occupied by locked blocks are the walls — the same mask the
  // reachability pass builds.
  const std::vector<uint8_t> lockedWall = lockedCellMask();

  if (!goalAnchorValid(goalAnchor_.x, goalAnchor_.y, lockedWall)) {
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
      if (!goalAnchorValid(nx, ny, lockedWall))
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
