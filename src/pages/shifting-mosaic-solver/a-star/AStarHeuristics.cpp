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
#include <ranges>
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
AStar::Rect AStar::goalCorridor(const Position currentGoal) const {
  const int gw = shapeBoxWidth_[goalIndex_];
  const int gh = shapeBoxHeight_[goalIndex_];
  return {.xLo = std::min(static_cast<int>(currentGoal.x),
                          static_cast<int>(goalAnchor_.x)),
          .xHi = std::max(static_cast<int>(currentGoal.x),
                          static_cast<int>(goalAnchor_.x)) +
                 gw,
          .yLo = std::min(static_cast<int>(currentGoal.y),
                          static_cast<int>(goalAnchor_.y)),
          .yHi = std::max(static_cast<int>(currentGoal.y),
                          static_cast<int>(goalAnchor_.y)) +
                 gh};
}

bool AStar::blockOverlapsRect(const uint8_t i, const Position anchor,
                              const Rect &rect) const {
  // bbox quick reject
  if (anchor.x + shapeBoxWidth_[i] <= rect.xLo || anchor.x >= rect.xHi)
    return false;
  if (anchor.y + shapeBoxHeight_[i] <= rect.yLo || anchor.y >= rect.yHi)
    return false;
  // cell-level: any cell of this block inside the rect?
  return std::ranges::any_of(shapes_[i], [&](const Position &cell) {
    const int cx = anchor.x + cell.x;
    const int cy = anchor.y + cell.y;
    return cx >= rect.xLo && cx < rect.xHi && cy >= rect.yLo && cy < rect.yHi;
  });
}

bool AStar::canStepAlong(const uint8_t i, const Position anchor,
                         const Axis axis,
                         const std::vector<Position> &anchors) const {
  // Indices into DX/DY: RIGHT, LEFT on the horizontal axis; UP, DOWN on the
  // vertical one.
  const std::array<int, 2> dirs =
      axis == Axis::Horizontal ? std::array{1, 3} : std::array{0, 2};
  return std::ranges::any_of(dirs, [&](const int d) {
    const Position p = {.x = static_cast<int8_t>(anchor.x + DX[d]),
                        .y = static_cast<int8_t>(anchor.y + DY[d])};
    return inBounds(i, p) && !collidesWithOthers(i, p, anchors);
  });
}

uint32_t AStar::axisAwareBlockerCost(const std::vector<Position> &anchors,
                                     const Position currentGoal) const {
  const Rect corridor = goalCorridor(currentGoal);
  uint32_t cost = 0;
  for (const uint8_t i : movableBlockIndices_) {
    if (i == goalIndex_ || !blockOverlapsRect(i, anchors[i], corridor))
      continue;
    // NOTE: the perpendicular/parallel distinction this function is named for
    // is NOT currently implemented. The two branches that used to read
    // `canMoveVert ? 1 : 1` / `canMoveHoriz ? 1 : 1` were no-op ternaries —
    // both arms were the literal 1 — so the axis probes only ever fed the
    // "stuck" test, and `horizontalTrip` selected between two identical
    // statements. Collapsed to the behaviour that actually shipped. Giving a
    // perpendicular blocker a different cost than a parallel one would change
    // every benchmark on record, so it needs a deliberate re-tune rather than
    // a silent fix here.
    const bool stuck =
        !canStepAlong(i, anchors[i], Axis::Horizontal, anchors) &&
        !canStepAlong(i, anchors[i], Axis::Vertical, anchors);
    cost += stuck ? 2 // stuck right now; needs cascade to vacate
                  : 1;
  }
  return cost;
}

// Count of movable non-goal blocks whose footprint intersects the goal
// block's BFS shortest path through the *current* non-goal blocks. The path
// itself is one of several possible shortest paths, so this is approximate
// (non-admissible) but strong: each counted block stands between the goal
// block and its target on at least one optimal anchor-path.
std::vector<int32_t> AStar::goalAnchorPredecessors(const Position from) const {
  const size_t total =
      static_cast<size_t>(gridWidth_) * static_cast<size_t>(gridHeight_);
  std::vector<int32_t> pred(total, -2);
  pred[from.x * gridHeight_ + from.y] = -1;
  if (from.x == goalAnchor_.x && from.y == goalAnchor_.y)
    return pred;
  std::deque<std::pair<int8_t, int8_t>> queue;
  queue.emplace_back(from.x, from.y);
  while (!queue.empty()) {
    auto [x, y] = queue.front();
    queue.pop_front();
    for (int dir = 0; dir < 4; dir++) {
      const Position next = {.x = static_cast<int8_t>(x + DX[dir]),
                             .y = static_cast<int8_t>(y + DY[dir])};
      // The old anchorPassable lambda spelled this out; it is exactly the
      // goal block's own bounds test.
      if (!inBounds(goalIndex_, next))
        continue;
      const int npos = next.x * gridHeight_ + next.y;
      if (pred[npos] != -2)
        continue;
      pred[npos] = x * gridHeight_ + y;
      if (next.x == goalAnchor_.x && next.y == goalAnchor_.y)
        return pred;
      queue.emplace_back(next.x, next.y);
    }
  }
  return {}; // target unreachable even on a clear board
}

uint32_t AStar::countPathBlockers(const std::vector<Position> &anchors,
                                  const Position currentGoal) const {
  // BFS the anchor graph first: when the target is unreachable even ignoring
  // movable blocks there is nothing to attribute, so the occupancy index below
  // is not built at all.
  const std::vector<int32_t> pred = goalAnchorPredecessors(currentGoal);
  if (pred.empty())
    return 4; // no anchor-path at all → push hard

  // Per-cell occupancy: -1 empty, otherwise block index. Lets path cells be
  // attributed to specific blockers.
  const std::vector<int16_t> occupancy = buildOccupancyIndex(anchors, true);

  // Walk path from goal anchor back to current; collect blockers along the
  // way.
  const auto &gShape = shapes_[goalIndex_];
  std::unordered_set<int16_t> blockerSet;
  int32_t cur = goalAnchor_.x * gridHeight_ + goalAnchor_.y;
  while (cur != -1) {
    const auto ax = static_cast<int8_t>(cur / gridHeight_);
    const auto ay = static_cast<int8_t>(cur % gridHeight_);
    for (const auto &[dx, dy] : gShape)
      if (const int16_t occ = occupancy[(ax + dx) * gridHeight_ + (ay + dy)];
          occ != -1)
        blockerSet.insert(occ);
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
  const Rect sweep = goalCorridor(goal);
  return static_cast<uint32_t>(
      std::ranges::count_if(movableBlockIndices_, [&](const uint8_t i) {
        return i != goalIndex_ && blockOverlapsRect(i, anchors[i], sweep);
      }));
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
std::vector<int16_t>
AStar::buildOccupancyIndex(const std::vector<Position> &anchors,
                          const bool skipGoal) const {
  const size_t total =
      static_cast<size_t>(gridWidth_) * static_cast<size_t>(gridHeight_);
  std::vector<int16_t> occupancy(total, -1);
  for (size_t i = 0; i < anchors.size(); i++) {
    if (skipGoal && i == goalIndex_)
      continue;
    const auto &[ax, ay] = anchors[i];
    for (const auto &[dx, dy] : shapes_[i])
      occupancy[(ax + dx) * gridHeight_ + (ay + dy)] = static_cast<int16_t>(i);
  }
  return occupancy;
}

// Every cell block i would cover at `to` is free, its own, or held by a block
// already proven movable.
bool AStar::allBlockersMovable(const size_t i, const Position to,
                               const std::vector<int16_t> &occupancy,
                               const std::vector<bool> &movable) const {
  return std::ranges::none_of(shapes_[i], [&](const Position &cell) {
    const int occ = occupancy[(to.x + cell.x) * gridHeight_ + (to.y + cell.y)];
    return occ != -1 && occ != static_cast<int>(i) && !movable[occ];
  });
}

bool AStar::canFreeSomeDirection(const size_t i, const Position from,
                                 const std::vector<int16_t> &occupancy,
                                 const std::vector<bool> &movable) const {
  return std::ranges::any_of(std::views::iota(0, 4), [&](const int d) {
    const Position to = {.x = static_cast<int8_t>(from.x + DX[d]),
                         .y = static_cast<int8_t>(from.y + DY[d])};
    return inBounds(static_cast<uint8_t>(i), to) &&
           allBlockersMovable(i, to, occupancy, movable);
  });
}

std::vector<bool>
AStar::computeMovableSet(const std::vector<Position> &anchors) const {
  const size_t n = anchors.size();
  const std::vector<int16_t> occupancy = buildOccupancyIndex(anchors, false);
  std::vector movable(n, false);
  bool changed = true;
  while (changed) {
    changed = false;
    for (size_t i = 0; i < n; i++) {
      if (movable[i] ||
          !canFreeSomeDirection(i, anchors[i], occupancy, movable))
        continue;
      movable[i] = true;
      changed = true;
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
