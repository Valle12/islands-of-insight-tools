// DragSolver: per-node cost functions and state encoding.
//
// Everything the search calls once per expanded node — the admissible cut
// heuristic, the jam dig-cost field, the movable/deadlock fixpoints, the
// NodeKey signatures and the displacement fields they score against.

#include "DragSolver.h"

#include <algorithm>
#include <array>
#include <bit>
#include <functional>
#include <queue>
#include <utility>

uint32_t DragSolver::heuristic(const std::vector<Position> &anchors) const {
  const auto &[gx, gy] = anchors[goalIndex_];
  if (gx == goalAnchor_.x && gy == goalAnchor_.y)
    return 0;
  // Blocks intersecting the footprint of any still-ahead cut must each move
  // at least once — the goal has to pass through those cells. One drag moves
  // one block and a goal drag only crosses cuts whose footprints were already
  // clear, so h drops by at most 1 per drag: admissible and consistent.
  uint32_t h = 1;
  const uint16_t p = progressIndex_[gx * gridHeight_ + gy];
  const auto &mask =
      cutSuffixRows_[p < cutSuffixRows_.size() ? p : cutSuffixRows_.size() - 1];
  for (const uint8_t i : movableBlockIndices_) {
    if (i == goalIndex_)
      continue;
    if (blockOnMask(i, anchors[i], mask))
      h++;
  }
  return h;
}

// Dig Dijkstra from the TARGET over the locked-walls-only anchor graph under
// the occupancy in `anchors`: jamField_[a] = cheapest goal route a → target
// where a step costs 4 and every newly swept movable-block cell costs
// cfg_.jamBlockerPenalty (long blocks are charged once per cell over a
// traversal, not once per step). jamSweepRows_ = the argmin route's swept
// footprint from the goal's current anchor. Returns the goal's own term.
uint32_t DragSolver::computeJamField(const std::vector<Position> &anchors) {
  const uint8_t gi = goalIndex_;
  const int W = gridWidth_;
  const int H = gridHeight_;
  const int totalAnchors = W * H;
  constexpr uint32_t STEP = 4;
  const uint32_t penalty = cfg_.jamBlockerPenalty;

  jamMovRows_.assign(H, 0);
  jamLockRows_.assign(H, 0);
  {
    std::vector isMovable(shapes_.size(), false);
    for (const uint8_t i : movableBlockIndices_)
      isMovable[i] = true;
    for (size_t i = 0; i < shapes_.size(); i++) {
      if (i == gi)
        continue;
      auto &dst = isMovable[i] ? jamMovRows_ : jamLockRows_;
      const auto &rows = grid_.shapeRows(static_cast<uint8_t>(i));
      for (size_t r = 0; r < rows.size(); r++)
        dst[anchors[i].y + r] |= rows[r] << static_cast<unsigned>(anchors[i].x);
    }
  }

  const auto &gRows = grid_.shapeRows(gi);
  const int maxX = W - grid_.boxWidth(gi);
  const int maxY = H - grid_.boxHeight(gi);
  const bool pinActive = cfg_.jamPinRoute && jamPinned_;
  const auto validAnchor = [&](const int x, const int y) {
    if (x < 0 || y < 0 || x > maxX || y > maxY)
      return false;
    for (size_t r = 0; r < gRows.size(); r++) {
      const uint64_t fp = gRows[r] << static_cast<unsigned>(x);
      if (fp & jamLockRows_[y + r])
        return false;
      if (pinActive && fp & ~jamPinRows_[y + r])
        return false; // outside the pinned corridor
    }
    return true;
  };
  // Movable-occupied cells the goal footprint at (nx, ny) covers that the
  // footprint at (cx, cy) did not — the newly swept cells of one step.
  const auto newBlockedCells = [&](const int cx, const int cy, const int nx,
                                   const int ny) {
    uint32_t cells = 0;
    for (size_t r = 0; r < gRows.size(); r++) {
      const uint64_t nMask = gRows[r] << static_cast<unsigned>(nx);
      const int absY = ny + static_cast<int>(r);
      uint64_t cMask = 0;
      if (const int cr = absY - cy;
          cr >= 0 && cr < static_cast<int>(gRows.size()))
        cMask = gRows[cr] << static_cast<unsigned>(cx);
      cells += static_cast<uint32_t>(
          std::popcount(nMask & ~cMask & jamMovRows_[absY]));
    }
    return cells;
  };

  const auto targetIdx =
      static_cast<uint16_t>(goalAnchor_.x * H + goalAnchor_.y);
  const auto &[goalX, goalY] = anchors[gi];
  const auto goalCurIdx = static_cast<uint16_t>(goalX * H + goalY);
  jamField_.assign(totalAnchors, UINT32_MAX);
  jamNextHop_.assign(totalAnchors, -1);
  using QE = std::pair<uint32_t, uint16_t>;
  std::priority_queue<QE, std::vector<QE>, std::greater<>> pq;
  if (validAnchor(goalAnchor_.x, goalAnchor_.y)) {
    jamField_[targetIdx] = 0;
    pq.emplace(0, targetIdx);
  }
  // Early exit: values are only consumed at the goal's current anchor and
  // its nearby drag targets. Once the current anchor is finalized, anchors
  // costlier than it + MARGIN can stay unfinalized (they read as the clamp
  // value — they are ordering-irrelevant losers anyway). Cuts the Dijkstra
  // to a fraction of the board on large grids.
  constexpr uint32_t MARGIN = 12 * STEP;
  uint32_t limit = UINT32_MAX;
  while (!pq.empty()) {
    const auto [d, n] = pq.top();
    if (d > limit)
      break;
    pq.pop();
    if (d != jamField_[n])
      continue;
    if (n == goalCurIdx && limit == UINT32_MAX)
      limit = d + MARGIN;
    const int nx = n / H;
    const int ny = n % H;
    for (int k = 0; k < 4; k++) {
      const int ax = nx + BitGrid::DX[k];
      const int ay = ny + BitGrid::DY[k];
      if (!validAnchor(ax, ay))
        continue;
      const auto a = static_cast<uint16_t>(ax * H + ay);
      // Forward edge a → n: entering n newly sweeps cells relative to a.
      const uint32_t cand =
          d + STEP + penalty * newBlockedCells(ax, ay, nx, ny);
      if (cand < jamField_[a]) {
        jamField_[a] = cand;
        jamNextHop_[a] = n;
        pq.emplace(cand, a);
      }
    }
  }

  const auto &[gx, gy] = anchors[gi];
  const auto goalIdx = static_cast<uint16_t>(gx * H + gy);
  jamSweepRows_.assign(H, 0);
  if (jamField_[goalIdx] != UINT32_MAX)
    for (int32_t cur = goalIdx; cur != -1; cur = jamNextHop_[cur]) {
      const int cx = cur / H;
      const int cy = cur % H;
      for (size_t r = 0; r < gRows.size(); r++)
        jamSweepRows_[cy + r] |= gRows[r] << static_cast<unsigned>(cx);
    }
  // First successful field with jamPinRoute: freeze this route's 2-dilated
  // footprint as the corridor every later Dijkstra must stay inside.
  if (cfg_.jamPinRoute && !jamPinned_ && jamField_[goalIdx] != UINT32_MAX) {
    const uint64_t colMask =
        W >= 64 ? ~uint64_t{0} : (uint64_t{1} << static_cast<unsigned>(W)) - 1;
    std::vector<uint64_t> dil = jamSweepRows_;
    for (int pass = 0; pass < 2; pass++) {
      std::vector<uint64_t> next(H, 0);
      for (int y = 0; y < H; y++) {
        uint64_t m = dil[y] | dil[y] << 1u | dil[y] >> 1u;
        if (y > 0)
          m |= dil[y - 1];
        if (y + 1 < H)
          m |= dil[y + 1];
        next[y] = m & colMask;
      }
      dil = std::move(next);
    }
    jamPinRows_ = std::move(dil);
    jamPinned_ = true;
  }
  return jamField_[goalIdx];
}

// Same least-fixpoint as AStar::computeMovableSet: start with nobody movable,
// add a block iff some direction's blockers are all already-movable.
std::vector<bool>
DragSolver::computeMovableSet(const std::vector<Position> &anchors) const {
  const size_t n = anchors.size();
  const size_t total =
      static_cast<size_t>(gridWidth_) * static_cast<size_t>(gridHeight_);
  std::vector<int16_t> occupancy(total, -1);
  for (size_t i = 0; i < n; i++) {
    const auto &[ax, ay] = anchors[i];
    for (const auto &[dx, dy] : shapes_[i])
      occupancy[(ax + dx) * gridHeight_ + (ay + dy)] = static_cast<int16_t>(i);
  }
  const auto inBoundsBox = [&](const size_t i, const Position p) {
    return p.x >= 0 && p.y >= 0 &&
           p.x + grid_.boxWidth(static_cast<uint8_t>(i)) <= gridWidth_ &&
           p.y + grid_.boxHeight(static_cast<uint8_t>(i)) <= gridHeight_;
  };
  std::vector movable(n, false);
  bool changed = true;
  while (changed) {
    changed = false;
    for (size_t i = 0; i < n; i++) {
      if (movable[i])
        continue;
      const auto &[ax, ay] = anchors[i];
      bool canMove = false;
      for (int d = 0; d < 4 && !canMove; d++) {
        const Position newAnchor = {
            .x = static_cast<int8_t>(ax + BitGrid::DX[d]),
            .y = static_cast<int8_t>(ay + BitGrid::DY[d])};
        if (!inBoundsBox(i, newAnchor))
          continue;
        bool allFreeable = true;
        for (const auto &[dx, dy] : shapes_[i]) {
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
        canMove = allFreeable;
      }
      if (canMove) {
        movable[i] = true;
        changed = true;
      }
    }
  }
  return movable;
}

bool DragSolver::isDeadlocked(const std::vector<Position> &anchors) const {
  // Cheap classic check: a permanently-frozen block on the goal's final
  // footprint. The fixpoint only runs when a block sits there at all.
  // Note that drags are reversible, so on a SOLVABLE board no reachable
  // state is ever dead — this only accelerates unsolvability verdicts.
  bool hasBlocker = false;
  for (size_t i = 0; i < anchors.size() && !hasBlocker; i++) {
    if (i == goalIndex_)
      continue;
    hasBlocker = blockOnGoalFootprint(static_cast<uint8_t>(i), anchors[i]);
  }
  if (!hasBlocker)
    return false;
  const auto movable = computeMovableSet(anchors);
  for (size_t i = 0; i < anchors.size(); i++) {
    if (i == goalIndex_ || movable[i])
      continue;
    if (blockOnGoalFootprint(static_cast<uint8_t>(i), anchors[i]))
      return true;
  }
  return false;
}

NodeKey
DragSolver::coarseSignature(const std::vector<Position> &anchors) const {
  const auto n = static_cast<uint8_t>(anchors.size());
  NodeKey key(n);
  uint16_t *d = key.data();
  for (uint8_t i = 0; i < n; i++) {
    const auto &[ax, ay] = anchors[i];
    d[i] = static_cast<uint16_t>(
        static_cast<unsigned>(static_cast<uint8_t>(ax)) >> 2u << 8u |
        static_cast<unsigned>(static_cast<uint8_t>(ay)) >> 2u);
  }
  for (const auto &group : symmetryGroups_) {
    const size_t m = group.size();
    if (m > 64)
      continue;
    std::array<uint16_t, 64> vals; // NOLINT — only [0,m) is written then read
    for (size_t k = 0; k < m; k++)
      vals[k] = d[group[k]];
    std::sort(vals.begin(), vals.begin() + static_cast<ptrdiff_t>(m));
    for (size_t k = 0; k < m; k++)
      d[group[k]] = vals[k];
  }
  return key;
}

NodeKey DragSolver::childSignature(const NodeKey &parentKey,
                                   const uint8_t block, const Position oldPos,
                                   const Position newPos) const {
  const auto pack = [](const Position p) {
    return static_cast<uint16_t>(
        static_cast<unsigned>(static_cast<uint8_t>(p.x)) << 8u |
        static_cast<uint8_t>(p.y));
  };
  NodeKey key = parentKey;
  uint16_t *d = key.data();
  const int16_t g = blockGroup_[block];
  if (g < 0 || !cfg_.canonicalizeSymmetry) {
    d[block] = pack(newPos);
    return key;
  }
  // The group's slots hold a sorted multiset of packed anchors: swap the old
  // value for the new one and restore sortedness.
  const auto &slots = symmetryGroups_[g];
  const uint16_t oldPacked = pack(oldPos);
  const uint16_t newPacked = pack(newPos);
  const size_t m = slots.size();
  if (m > 64) { // matches signatureFromAnchors' skip: group left unsorted
    d[block] = newPacked;
    return key;
  }
  std::array<uint16_t, 64> vals; // NOLINT — only [0,m) is written then read
  for (size_t k = 0; k < m; k++)
    vals[k] = d[slots[k]];
  for (size_t k = 0; k < m; k++) {
    if (vals[k] == oldPacked) {
      vals[k] = newPacked;
      break;
    }
  }
  std::sort(vals.begin(), vals.begin() + static_cast<ptrdiff_t>(m));
  for (size_t k = 0; k < m; k++)
    d[slots[k]] = vals[k];
  return key;
}

NodeKey
DragSolver::signatureFromAnchors(const std::vector<Position> &anchors) const {
  const auto n = static_cast<uint8_t>(anchors.size());
  NodeKey key(n);
  uint16_t *d = key.data();
  for (uint8_t i = 0; i < n; i++) {
    const auto &[ax, ay] = anchors[i];
    d[i] = static_cast<uint16_t>(static_cast<unsigned>(static_cast<uint8_t>(ax))
                                     << 8u |
                                 static_cast<uint8_t>(ay));
  }
  if (!cfg_.canonicalizeSymmetry)
    return key;
  for (const auto &group : symmetryGroups_) {
    const size_t m = group.size();
    if (m > 64)
      continue;
    std::array<uint16_t, 64> vals; // NOLINT — only [0,m) is written then read
    for (size_t k = 0; k < m; k++)
      vals[k] = d[group[k]];
    std::sort(vals.begin(), vals.begin() + static_cast<ptrdiff_t>(m));
    for (size_t k = 0; k < m; k++)
      d[group[k]] = vals[k];
  }
  return key;
}

void DragSolver::computeDisplacementFields(const uint32_t maskIndex) {
  const auto &mask = cutSuffixRows_[maskIndex];
  dispField_.assign(shapes_.size(), {});

  std::vector<uint64_t> lockedRows(gridHeight_, 0);
  {
    std::vector isMovable(shapes_.size(), false);
    for (const uint8_t i : movableBlockIndices_)
      isMovable[i] = true;
    for (size_t i = 0; i < shapes_.size(); i++) {
      if (isMovable[i])
        continue;
      const auto &rows = grid_.shapeRows(static_cast<uint8_t>(i));
      for (size_t r = 0; r < rows.size(); r++)
        lockedRows[initialAnchors_[i].y + r] |=
            rows[r] << static_cast<unsigned>(initialAnchors_[i].x);
    }
  }

  const int H = gridHeight_;
  const int total = gridWidth_ * H;
  for (const uint8_t i : movableBlockIndices_) {
    if (i == goalIndex_)
      continue;
    const auto &rows = grid_.shapeRows(i);
    const int maxX = gridWidth_ - grid_.boxWidth(i);
    const int maxY = gridHeight_ - grid_.boxHeight(i);
    const auto valid = [&](const int x, const int y) {
      if (x < 0 || y < 0 || x > maxX || y > maxY)
        return false;
      for (size_t r = 0; r < rows.size(); r++)
        if (rows[r] << static_cast<unsigned>(x) & lockedRows[y + r])
          return false;
      return true;
    };
    auto &field = dispField_[i];
    field.assign(total, UINT16_MAX);
    std::vector<uint16_t> queue;
    queue.reserve(total);
    if (!packedSlot_.empty() && packedSlot_[i] >= 0) {
      // Packing guide: steer toward this block's assigned final slot.
      if (const auto s = static_cast<uint16_t>(packedSlot_[i]);
          valid(s / H, s % H)) {
        field[s] = 0;
        queue.push_back(s);
      }
    } else {
      // Multi-source BFS from every valid anchor that clears the mask.
      for (int x = 0; x <= maxX; x++)
        for (int y = 0; y <= maxY; y++) {
          if (!valid(x, y))
            continue;
          bool clear = true;
          for (uint8_t r = 0; r < rows.size() && clear; r++)
            if (rows[r] << static_cast<unsigned>(x) & mask[y + r])
              clear = false;
          if (clear) {
            field[x * H + y] = 0;
            queue.push_back(static_cast<uint16_t>(x * H + y));
          }
        }
    }
    for (size_t head = 0; head < queue.size(); head++) {
      const uint16_t cur = queue[head];
      const int cx = cur / H;
      const int cy = cur % H;
      for (int d = 0; d < 4; d++) {
        const int nx = cx + BitGrid::DX[d];
        const int ny = cy + BitGrid::DY[d];
        if (!valid(nx, ny))
          continue;
        const auto nIdx = static_cast<uint16_t>(nx * H + ny);
        if (field[nIdx] != UINT16_MAX)
          continue;
        field[nIdx] = static_cast<uint16_t>(field[cur] + 1);
        queue.push_back(nIdx);
      }
    }
  }
}

uint32_t
DragSolver::displacementSum(const std::vector<Position> &anchors) const {
  uint32_t sum = 0;
  if (dispField_.size() < shapes_.size())
    return 0; // fields not computed yet
  for (const uint8_t i : movableBlockIndices_) {
    if (i == goalIndex_ || dispField_[i].empty())
      continue;
    const uint16_t d = dispField_[i][anchors[i].x * gridHeight_ + anchors[i].y];
    sum += d == UINT16_MAX ? 128 : std::min<uint32_t>(d, 64);
  }
  return sum;
}

uint32_t DragSolver::progressOf(const std::vector<Position> &anchors) const {
  const auto &[gx, gy] = anchors[goalIndex_];
  if (gx == goalAnchor_.x && gy == goalAnchor_.y)
    return middleCuts_ + 1;
  return progressIndex_[gx * gridHeight_ + gy];
}
