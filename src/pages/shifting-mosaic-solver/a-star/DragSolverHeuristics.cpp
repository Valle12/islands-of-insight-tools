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
#include <ranges>
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
// cfg_.jam.blockerPenalty (long blocks are charged once per cell over a
// traversal, not once per step). jamSweepRows_ = the argmin route's swept
// footprint from the goal's current anchor. Returns the goal's own term.
// One step of a goal route costs this; see computeJamField.
static constexpr uint32_t JAM_STEP = 4;

void DragSolver::buildJamOccupancy(const std::vector<Position> &anchors) {
  jamMovRows_.assign(gridHeight_, 0);
  jamLockRows_.assign(gridHeight_, 0);
  std::vector isMovable(shapes_.size(), false);
  for (const uint8_t i : movableBlockIndices_)
    isMovable[i] = true;
  for (size_t i = 0; i < shapes_.size(); i++) {
    if (i == goalIndex_)
      continue;
    auto &dst = isMovable[i] ? jamMovRows_ : jamLockRows_;
    const auto &rows = grid_.shapeRows(static_cast<uint8_t>(i));
    for (size_t r = 0; r < rows.size(); r++)
      dst[anchors[i].y + r] |= rows[r] << static_cast<unsigned>(anchors[i].x);
  }
}

bool DragSolver::jamAnchorValid(const int x, const int y,
                                const JamGeometry &geo) const {
  if (x < 0 || y < 0 || x > geo.maxX || y > geo.maxY)
    return false;
  for (size_t r = 0; r < geo.gRows.size(); r++) {
    const uint64_t fp = geo.gRows[r] << static_cast<unsigned>(x);
    if (fp & jamLockRows_[y + r])
      return false;
    if (geo.pinActive && fp & ~jamPinRows_[y + r])
      return false; // outside the pinned corridor
  }
  return true;
}

uint32_t DragSolver::jamNewlyBlocked(const int cx, const int cy, const int nx,
                                     const int ny,
                                     const JamGeometry &geo) const {
  uint32_t cells = 0;
  for (size_t r = 0; r < geo.gRows.size(); r++) {
    const uint64_t nMask = geo.gRows[r] << static_cast<unsigned>(nx);
    const int absY = ny + static_cast<int>(r);
    uint64_t cMask = 0;
    if (const int cr = absY - cy;
        cr >= 0 && cr < static_cast<int>(geo.gRows.size()))
      cMask = geo.gRows[cr] << static_cast<unsigned>(cx);
    cells += static_cast<uint32_t>(
        std::popcount(nMask & ~cMask & jamMovRows_[absY]));
  }
  return cells;
}

void DragSolver::runJamDijkstra(const uint16_t targetIdx,
                                const uint16_t goalIdx,
                                const JamGeometry &geo) {
  const int H = gridHeight_;
  const uint32_t penalty = cfg_.jam.blockerPenalty;
  using QE = std::pair<uint32_t, uint16_t>;
  std::priority_queue<QE, std::vector<QE>, std::greater<>> pq;
  if (jamAnchorValid(goalAnchor_.x, goalAnchor_.y, geo)) {
    jamField_[targetIdx] = 0;
    pq.emplace(0, targetIdx);
  }
  // Early exit: values are only consumed at the goal's current anchor and
  // its nearby drag targets. Once the current anchor is finalized, anchors
  // costlier than it + MARGIN can stay unfinalized (they read as the clamp
  // value — they are ordering-irrelevant losers anyway). Cuts the Dijkstra
  // to a fraction of the board on large grids.
  constexpr uint32_t MARGIN = 12 * JAM_STEP;
  uint32_t limit = UINT32_MAX;
  while (!pq.empty()) {
    const auto [d, n] = pq.top();
    if (d > limit)
      break;
    pq.pop();
    if (d != jamField_[n])
      continue;
    if (n == goalIdx && limit == UINT32_MAX)
      limit = d + MARGIN;
    const int nx = n / H;
    const int ny = n % H;
    for (int k = 0; k < 4; k++) {
      const int ax = nx + BitGrid::DX[k];
      const int ay = ny + BitGrid::DY[k];
      if (!jamAnchorValid(ax, ay, geo))
        continue;
      const auto a = static_cast<uint16_t>(ax * H + ay);
      // Forward edge a → n: entering n newly sweeps cells relative to a.
      const uint32_t cand =
          d + JAM_STEP + penalty * jamNewlyBlocked(ax, ay, nx, ny, geo);
      if (cand < jamField_[a]) {
        jamField_[a] = cand;
        jamNextHop_[a] = n;
        pq.emplace(cand, a);
      }
    }
  }
}

void DragSolver::buildJamSweepRows(const uint16_t goalIdx,
                                   const JamGeometry &geo) {
  const int H = gridHeight_;
  jamSweepRows_.assign(H, 0);
  if (jamField_[goalIdx] == UINT32_MAX)
    return;
  for (int32_t cur = goalIdx; cur != -1; cur = jamNextHop_[cur]) {
    const int cx = cur / H;
    const int cy = cur % H;
    for (size_t r = 0; r < geo.gRows.size(); r++)
      jamSweepRows_[cy + r] |= geo.gRows[r] << static_cast<unsigned>(cx);
  }
}

uint64_t DragSolver::dilateRow(const std::vector<uint64_t> &rows,
                               const int y) const {
  uint64_t m = rows[y] | rows[y] << 1u | rows[y] >> 1u;
  if (y > 0)
    m |= rows[y - 1];
  if (y + 1 < gridHeight_)
    m |= rows[y + 1];
  return m;
}

void DragSolver::pinJamRoute() {
  const int W = gridWidth_;
  const uint64_t colMask =
      W >= 64 ? ~uint64_t{0} : (uint64_t{1} << static_cast<unsigned>(W)) - 1;
  std::vector<uint64_t> dil = jamSweepRows_;
  for (int pass = 0; pass < 2; pass++) {
    std::vector<uint64_t> next(gridHeight_, 0);
    for (int y = 0; y < gridHeight_; y++)
      next[y] = dilateRow(dil, y) & colMask;
    dil = std::move(next);
  }
  jamPinRows_ = std::move(dil);
  jamPinned_ = true;
}

uint32_t DragSolver::computeJamField(const std::vector<Position> &anchors) {
  const uint8_t gi = goalIndex_;
  const int H = gridHeight_;
  buildJamOccupancy(anchors);

  const JamGeometry geo{.gRows = grid_.shapeRows(gi),
                        .maxX = gridWidth_ - grid_.boxWidth(gi),
                        .maxY = H - grid_.boxHeight(gi),
                        .pinActive = cfg_.jam.pinRoute && jamPinned_};
  const auto targetIdx =
      static_cast<uint16_t>(goalAnchor_.x * H + goalAnchor_.y);
  // The goal's CURRENT anchor: both the Dijkstra's early-exit trigger and the
  // route the sweep rows are read back from.
  const auto &[gx, gy] = anchors[gi];
  const auto goalIdx = static_cast<uint16_t>(gx * H + gy);

  const int totalAnchors = gridWidth_ * H;
  jamField_.assign(totalAnchors, UINT32_MAX);
  jamNextHop_.assign(totalAnchors, -1);
  runJamDijkstra(targetIdx, goalIdx, geo);
  buildJamSweepRows(goalIdx, geo);
  // First successful field with jamPinRoute: freeze this route's 2-dilated
  // footprint as the corridor every later Dijkstra must stay inside.
  if (cfg_.jam.pinRoute && !jamPinned_ && jamField_[goalIdx] != UINT32_MAX)
    pinJamRoute();
  return jamField_[goalIdx];
}

std::vector<int16_t>
DragSolver::buildOccupancyIndex(const std::vector<Position> &anchors) const {
  const size_t total =
      static_cast<size_t>(gridWidth_) * static_cast<size_t>(gridHeight_);
  std::vector<int16_t> occupancy(total, -1);
  for (size_t i = 0; i < anchors.size(); i++) {
    const auto &[ax, ay] = anchors[i];
    for (const auto &[dx, dy] : shapes_[i])
      occupancy[(ax + dx) * gridHeight_ + (ay + dy)] = static_cast<int16_t>(i);
  }
  return occupancy;
}

bool DragSolver::inBoundsBox(const size_t i, const Position p) const {
  return p.x >= 0 && p.y >= 0 &&
         p.x + grid_.boxWidth(static_cast<uint8_t>(i)) <= gridWidth_ &&
         p.y + grid_.boxHeight(static_cast<uint8_t>(i)) <= gridHeight_;
}

// Every cell block i would cover at `to` is either free, its own, or held by a
// block already known movable.
bool DragSolver::allBlockersMovable(const size_t i, const Position to,
                                    const std::vector<int16_t> &occupancy,
                                    const std::vector<bool> &movable) const {
  return std::ranges::none_of(shapes_[i], [&](const Position &cell) {
    const int occ =
        occupancy[(to.x + cell.x) * gridHeight_ + (to.y + cell.y)];
    return occ != -1 && occ != static_cast<int>(i) && !movable[occ];
  });
}

bool DragSolver::canFreeSomeDirection(
    const size_t i, const Position from, const std::vector<int16_t> &occupancy,
    const std::vector<bool> &movable) const {
  return std::ranges::any_of(std::views::iota(0, 4), [&](const int d) {
    const Position to{.x = static_cast<int8_t>(from.x + BitGrid::DX[d]),
                      .y = static_cast<int8_t>(from.y + BitGrid::DY[d])};
    return inBoundsBox(i, to) && allBlockersMovable(i, to, occupancy, movable);
  });
}

// Same least-fixpoint as AStar::computeMovableSet: start with nobody movable,
// add a block iff some direction's blockers are all already-movable.
std::vector<bool>
DragSolver::computeMovableSet(const std::vector<Position> &anchors) const {
  const size_t n = anchors.size();
  const std::vector<int16_t> occupancy = buildOccupancyIndex(anchors);
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

bool DragSolver::isDeadlocked(const std::vector<Position> &anchors) const {
  // Cheap classic check: a permanently-frozen block on the goal's final
  // footprint. The fixpoint only runs when a block sits there at all.
  // Note that drags are reversible, so on a SOLVABLE board no reachable
  // state is ever dead — this only accelerates unsolvability verdicts.
  const auto blocksGoal = [&](const size_t i) {
    return i != goalIndex_ &&
           blockOnGoalFootprint(static_cast<uint8_t>(i), anchors[i]);
  };
  const auto indices = std::views::iota(size_t{0}, anchors.size());
  if (std::ranges::none_of(indices, blocksGoal))
    return false;
  const auto movable = computeMovableSet(anchors);
  return std::ranges::any_of(
      indices, [&](const size_t i) { return !movable[i] && blocksGoal(i); });
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

std::vector<uint64_t> DragSolver::lockedWallRows() const {
  std::vector<uint64_t> walls(gridHeight_, 0);
  std::vector isMovable(shapes_.size(), false);
  for (const uint8_t i : movableBlockIndices_)
    isMovable[i] = true;
  for (size_t i = 0; i < shapes_.size(); i++) {
    if (isMovable[i])
      continue;
    const auto &rows = grid_.shapeRows(static_cast<uint8_t>(i));
    for (size_t r = 0; r < rows.size(); r++)
      walls[initialAnchors_[i].y + r] |=
          rows[r] << static_cast<unsigned>(initialAnchors_[i].x);
  }
  return walls;
}

bool DragSolver::anchorClearOfWalls(const int x, const int y,
                                    const DispGeometry &geo) {
  if (x < 0 || y < 0 || x > geo.maxX || y > geo.maxY)
    return false;
  for (size_t r = 0; r < geo.rows.size(); r++)
    if (geo.rows[r] << static_cast<unsigned>(x) & geo.lockedRows[y + r])
      return false;
  return true;
}

bool DragSolver::footprintClearsMask(const std::vector<uint64_t> &rows,
                                     const int x, const int y,
                                     const std::vector<uint64_t> &mask) {
  for (size_t r = 0; r < rows.size(); r++)
    if (rows[r] << static_cast<unsigned>(x) & mask[y + r])
      return false;
  return true;
}

void DragSolver::seedDisplacementQueue(const uint8_t i,
                                       const DispGeometry &geo,
                                       const std::vector<uint64_t> &mask,
                                       std::vector<uint16_t> &field,
                                       std::vector<uint16_t> &queue) const {
  const int H = gridHeight_;
  if (!packedSlot_.empty() && packedSlot_[i] >= 0) {
    // Packing guide: steer toward this block's assigned final slot.
    if (const auto s = static_cast<uint16_t>(packedSlot_[i]);
        anchorClearOfWalls(s / H, s % H, geo)) {
      field[s] = 0;
      queue.push_back(s);
    }
    return;
  }
  // Multi-source BFS from every valid anchor that clears the mask.
  for (int x = 0; x <= geo.maxX; x++)
    for (int y = 0; y <= geo.maxY; y++) {
      if (!anchorClearOfWalls(x, y, geo) ||
          !footprintClearsMask(geo.rows, x, y, mask))
        continue;
      field[x * H + y] = 0;
      queue.push_back(static_cast<uint16_t>(x * H + y));
    }
}

void DragSolver::runDisplacementBfs(const DispGeometry &geo,
                                    std::vector<uint16_t> &field,
                                    std::vector<uint16_t> &queue) const {
  const int H = gridHeight_;
  // Worklist BFS: the body pushes onto `queue` while it is being walked, so
  // this is deliberately an index walk and not a range-for.
  size_t head = 0;
  while (head < queue.size()) {
    const uint16_t cur = queue[head];
    head++;
    const int cx = cur / H;
    const int cy = cur % H;
    for (int d = 0; d < 4; d++) {
      const int nx = cx + BitGrid::DX[d];
      const int ny = cy + BitGrid::DY[d];
      if (!anchorClearOfWalls(nx, ny, geo))
        continue;
      const auto nIdx = static_cast<uint16_t>(nx * H + ny);
      if (field[nIdx] != UINT16_MAX)
        continue;
      field[nIdx] = static_cast<uint16_t>(field[cur] + 1);
      queue.push_back(nIdx);
    }
  }
}

void DragSolver::computeDisplacementFields(const uint32_t maskIndex) {
  const auto &mask = cutSuffixRows_[maskIndex];
  dispField_.assign(shapes_.size(), {});
  const std::vector<uint64_t> lockedRows = lockedWallRows();
  const int total = gridWidth_ * gridHeight_;
  for (const uint8_t i : movableBlockIndices_) {
    if (i == goalIndex_)
      continue;
    const DispGeometry geo{.rows = grid_.shapeRows(i),
                           .lockedRows = lockedRows,
                           .maxX = gridWidth_ - grid_.boxWidth(i),
                           .maxY = gridHeight_ - grid_.boxHeight(i)};
    auto &field = dispField_[i];
    field.assign(total, UINT16_MAX);
    std::vector<uint16_t> queue;
    queue.reserve(total);
    seedDisplacementQueue(i, geo, mask, field, queue);
    runDisplacementBfs(geo, field, queue);
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
