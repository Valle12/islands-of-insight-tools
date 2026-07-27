// AStar: collision geometry and the heuristic components.
//
// The per-node cost functions the search sums into h, plus the bounds and
// collision predicates they and move generation share, plus the NodeKey
// signatures that key the state map.

#include "ClangdCompat.h" // must stay first; see the header

#include "AStar.h"

#include <algorithm>
#include <array>
#include <cstdlib>
#include <deque>
#include <unordered_set>
#include <utility>

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
  return std::ranges::any_of(shapes_[i], [&](const Position &cellA) {
    const int relX = cellA.x + dx;
    const int relY = cellA.y + dy;
    if (relX < 0 || relY < 0)
      return false;
    if (relX >= bw || relY >= bh)
      return false;
    return setJ.contains(static_cast<uint16_t>(
        static_cast<uint32_t>(relX) * SHAPE_STRIDE + relY));
  });
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

uint32_t
AStar::countFinalPositionBlockers(const std::vector<Position> &anchors) const {
  const int gw = shapeBoxWidth_[goalIndex_];
  const int gh = shapeBoxHeight_[goalIndex_];
  uint32_t count = 0;
  for (size_t i = 0; i < anchors.size(); i++) {
    if (i == goalIndex_)
      continue;
    const auto &[ax, ay] = anchors[i];
    const int aw = shapeBoxWidth_[i];
    const int ah = shapeBoxHeight_[i];
    if (ax + aw <= goalAnchor_.x || goalAnchor_.x + gw <= ax)
      continue;
    if (ay + ah <= goalAnchor_.y || goalAnchor_.y + gh <= ay)
      continue;
    for (const auto &[dx, dy] : shapes_[i]) {
      const auto enc =
          static_cast<uint16_t>((ax + dx) * gridHeight_ + (ay + dy));
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
  if (goal.x == goalAnchor_.x && goal.y == goalAnchor_.y)
    return 0;
  const uint16_t bfs = goalAnchorAt(goal.x, goal.y);
  const auto base =
      bfs == UINT16_MAX
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
uint32_t AStar::axisAwareBlockerCost(const std::vector<Position> &anchors,
                                     const Position currentGoal) const {
  // Corridor: rectangle covering both current and target footprints.
  const int gw = shapeBoxWidth_[goalIndex_];
  const int gh = shapeBoxHeight_[goalIndex_];
  const int xLo = std::min(static_cast<int>(currentGoal.x),
                           static_cast<int>(goalAnchor_.x));
  const int xHi = std::max(static_cast<int>(currentGoal.x),
                           static_cast<int>(goalAnchor_.x)) +
                  gw;
  const int yLo = std::min(static_cast<int>(currentGoal.y),
                           static_cast<int>(goalAnchor_.y));
  const int yHi = std::max(static_cast<int>(currentGoal.y),
                           static_cast<int>(goalAnchor_.y)) +
                  gh;

  uint32_t cost = 0;
  for (const uint8_t i : movableBlockIndices_) {
    if (i == goalIndex_)
      continue;
    const auto &[ax, ay] = anchors[i];
    const int aw = shapeBoxWidth_[i];
    const int ah = shapeBoxHeight_[i];
    // bbox quick reject
    if (ax + aw <= xLo || ax >= xHi)
      continue;
    if (ay + ah <= yLo || ay >= yHi)
      continue;
    bool overlapsCorridor = false;
    for (const auto &[dx, dy] : shapes_[i]) {
      const int cx = ax + dx;
      if (const int cy = ay + dy;
          cx >= xLo && cx < xHi && cy >= yLo && cy < yHi) {
        overlapsCorridor = true;
        break;
      }
    }
    if (!overlapsCorridor)
      continue;

    // Decide block axis by probing one cell moves in each direction.
    bool canMoveHoriz = false;
    bool canMoveVert = false;
    static constexpr std::array dirsH = {1, 3}; // RIGHT, LEFT
    static constexpr std::array dirsV = {0, 2}; // UP, DOWN
    for (const int d : dirsH) {
      const Position p = {.x = static_cast<int8_t>(ax + DX[d]),
                          .y = static_cast<int8_t>(ay + DY[d])};
      if (inBounds(i, p) && !collidesWithOthers(i, p, anchors)) {
        canMoveHoriz = true;
        break;
      }
    }
    for (const int d : dirsV) {
      const Position p = {.x = static_cast<int8_t>(ax + DX[d]),
                          .y = static_cast<int8_t>(ay + DY[d])};
      if (inBounds(i, p) && !collidesWithOthers(i, p, anchors)) {
        canMoveVert = true;
        break;
      }
    }

    // NOTE: the perpendicular/parallel distinction this function is named for
    // is NOT currently implemented. The two branches that used to read
    // `canMoveVert ? 1 : 1` / `canMoveHoriz ? 1 : 1` were no-op ternaries —
    // both arms were the literal 1 — so canMoveHoriz/canMoveVert only ever fed
    // the "stuck" test, and `horizontalTrip` selected between two identical
    // statements. Collapsed to the behaviour that actually shipped. Giving a
    // perpendicular blocker a different cost than a parallel one would change
    // every benchmark on record, so it needs a deliberate re-tune rather than
    // a silent fix here.
    cost += !canMoveHoriz && !canMoveVert
                ? 2 // stuck right now; needs cascade to vacate
                : 1;
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
    if (i == goalIndex_)
      continue;
    const auto &[ax, ay] = anchors[i];
    for (const auto &[dx, dy] : shapes_[i]) {
      occupancy[(ax + dx) * gridHeight_ + (ay + dy)] = static_cast<int16_t>(i);
    }
  }

  // BFS anchor-graph from currentGoal toward goalAnchor; goal block sits on
  // a cell if its shape (translated by anchor) overlaps with another block's
  // occupancy. Passable = (no overlap with a non-goal block at any shape
  // cell).
  const auto &gShape = shapes_[goalIndex_];
  const int gw = shapeBoxWidth_[goalIndex_];
  const int gh = shapeBoxHeight_[goalIndex_];
  auto anchorPassable = [&](const int8_t x, const int8_t y) {
    if (x < 0 || y < 0)
      return false;
    if (x + gw > gridWidth_ || y + gh > gridHeight_)
      return false;
    return true;
  };
  // Per anchor cell, store predecessor for path reconstruction. -2 = not
  // visited, -1 = root.
  std::vector pred(total, -2);
  pred[currentGoal.x * gridHeight_ + currentGoal.y] = -1;
  std::deque<std::pair<int8_t, int8_t>> queue;
  queue.emplace_back(currentGoal.x, currentGoal.y);
  bool reached =
      currentGoal.x == goalAnchor_.x && currentGoal.y == goalAnchor_.y;
  while (!queue.empty() && !reached) {
    auto [x, y] = queue.front();
    queue.pop_front();
    for (int dir = 0; dir < 4; dir++) {
      const auto nx = static_cast<int8_t>(x + DX[dir]);
      const auto ny = static_cast<int8_t>(y + DY[dir]);
      if (!anchorPassable(nx, ny))
        continue;
      const int npos = nx * gridHeight_ + ny;
      if (pred[npos] != -2)
        continue;
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
    const auto ax = static_cast<int8_t>(cur / gridHeight_);
    const auto ay = static_cast<int8_t>(cur % gridHeight_);
    for (const auto &[dx, dy] : gShape) {
      const int gx = ax + dx;
      const int gy = ay + dy;
      if (const int16_t occ = occupancy[gx * gridHeight_ + gy]; occ != -1)
        blockerSet.insert(occ);
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
    if (i == goalIndex_)
      continue;
    const auto &[ax, ay] = anchors[i];
    const int aw = shapeBoxWidth_[i];
    const int ah = shapeBoxHeight_[i];
    // Braced init, not a plain assignment: Position::x/y are int8_t used as
    // small signed numbers, and bugprone-signed-char-misuse reads any
    // signed-char-to-int conversion as a character mix-up. int{} states that
    // this is a lossless widening of a number (a static_cast does NOT satisfy
    // the check — measured).
    const auto distLeft = int{ax};
    const int distRight = gridWidth_ - (ax + aw);
    const auto distTop = int{ay};
    const int distBottom = gridHeight_ - (ay + ah);
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
  const int xLo =
      std::min(static_cast<int>(goal.x), static_cast<int>(goalAnchor_.x));
  const int xHi =
      std::max(static_cast<int>(goal.x), static_cast<int>(goalAnchor_.x)) + gw;
  const int yLo =
      std::min(static_cast<int>(goal.y), static_cast<int>(goalAnchor_.y));
  const int yHi =
      std::max(static_cast<int>(goal.y), static_cast<int>(goalAnchor_.y)) + gh;

  uint32_t count = 0;
  for (const uint8_t i : movableBlockIndices_) {
    if (i == goalIndex_)
      continue;
    const auto &[ax, ay] = anchors[i];
    const int aw = shapeBoxWidth_[i];
    const int ah = shapeBoxHeight_[i];
    // bbox quick reject
    if (ax + aw <= xLo || ax >= xHi)
      continue;
    if (ay + ah <= yLo || ay >= yHi)
      continue;
    // cell-level: any cell of this block inside the sweep rect?
    for (const auto &[dx, dy] : shapes_[i]) {
      const int cx = ax + dx;
      if (const int cy = ay + dy;
          cx >= xLo && cx < xHi && cy >= yLo && cy < yHi) {
        count++;
        break;
      }
    }
  }
  return count;
}

bool AStar::isGoalState(const Node &node) const {
  const auto &[anchorX, anchorY] = node.anchors[goalIndex_];
  return anchorX == goalAnchor_.x && anchorY == goalAnchor_.y;
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
    const auto &[ax, ay] = anchors[i];
    for (const auto &[dx, dy] : shapes_[i]) {
      occupancy[(ax + dx) * gridHeight_ + (ay + dy)] = static_cast<int16_t>(i);
    }
  }
  std::vector movable(n, false);
  bool changed = true;
  while (changed) {
    changed = false;
    for (size_t i = 0; i < n; i++) {
      if (movable[i])
        continue;
      const auto &[ax, ay] = anchors[i];
      const auto &shape = shapes_[i];
      bool canMove = false;
      for (int d = 0; d < 4; d++) {
        const Position newAnchor = {.x = static_cast<int8_t>(ax + DX[d]),
                                    .y = static_cast<int8_t>(ay + DY[d])};
        if (!inBounds(static_cast<uint8_t>(i), newAnchor))
          continue;
        bool allFreeable = true;
        for (const auto &[dx, dy] : shape) {
          const int nx = newAnchor.x + dx;
          const int ny = newAnchor.y + dy;
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
  // True iff block `i` currently covers any cell of the goal block's final
  // footprint. Both sweeps below ask exactly this question.
  const auto sitsOnGoalFootprint = [&](const size_t i) {
    const auto &[ax, ay] = anchors[i];
    return std::ranges::any_of(shapes_[i], [&](const Position &cell) {
      return goalBlockFinalCells_.contains(
          static_cast<uint16_t>((ax + cell.x) * gridHeight_ + (ay + cell.y)));
    });
  };

  bool hasBlocker = false;
  for (size_t i = 0; i < anchors.size(); i++) {
    if (i == goalIndex_)
      continue;
    if (sitsOnGoalFootprint(i)) {
      hasBlocker = true;
      break;
    }
  }
  if (!hasBlocker)
    return false;
  auto movable = computeMovableSet(anchors);
  for (size_t i = 0; i < anchors.size(); i++) {
    if (i == goalIndex_ || movable[i])
      continue;
    if (sitsOnGoalFootprint(i))
      return true;
  }
  return false;
}

NodeKey
AStar::signatureFromAnchors(const std::vector<Position> &anchors) const {
  const auto n = static_cast<uint8_t>(anchors.size());
  NodeKey key(n);
  uint16_t *d = key.data();
  for (uint8_t i = 0; i < n; i++) {
    const auto &[ax, ay] = anchors[i];
    d[i] = static_cast<uint16_t>(static_cast<unsigned>(static_cast<uint8_t>(ax))
                                     << 8u |
                                 static_cast<uint8_t>(ay));
  }
  // Canonicalise interchangeable blocks: within each same-shape group, sort
  // the packed anchors so states that differ only by permuting identical
  // blocks collapse to a single signature.
  for (const auto &group : symmetryGroups_) {
    const size_t m = group.size();
    if (m > 64)
      continue; // absurdly large group — skip (still correct)
    std::array<uint16_t, 64> vals; // NOLINT — only [0,m) is written then read
    for (size_t k = 0; k < m; k++)
      vals[k] = d[group[k]];
    std::sort(vals.begin(), vals.begin() + static_cast<ptrdiff_t>(m));
    for (size_t k = 0; k < m; k++)
      d[group[k]] = vals[k];
  }
  return key;
}

NodeKey AStar::nodeSignature(const Node &node) const {
  return signatureFromAnchors(node.anchors);
}
