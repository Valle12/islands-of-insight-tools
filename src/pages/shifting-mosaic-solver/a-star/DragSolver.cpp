#include "DragSolver.h"
#include "MemoryProbe.h"

#include "AStar.h"

#include <algorithm>
#include <bit>
#include <chrono>
#include <compare>
#include <cstdlib>
#include <cstring>
#include <functional>
#include <iostream>
#include <queue>
#include <random>

namespace {
uint64_t nowMs() {
  using namespace std::chrono;
  return static_cast<uint64_t>(
      duration_cast<milliseconds>(steady_clock::now().time_since_epoch())
          .count());
}

struct DragHeapEntry {
  uint32_t f;
  uint32_t g;
  uint32_t cells;
  // cells + scaled remaining-displacement estimate (see dispField_): among
  // equal (f, g), prefer states whose mask-blockers are closest to viable
  // parking. Pure ordering hint — never enters f.
  uint32_t tie;
  NodeKey signature;
  auto operator<=>(const DragHeapEntry &o) const {
    if (const auto c = f <=> o.f; c != 0) return c;
    if (const auto c = o.g <=> g; c != 0) return c;
    return tie <=> o.tie;
  }
  bool operator==(const DragHeapEntry &o) const {
    return f == o.f && g == o.g && tie == o.tie;
  }
};
} // namespace

DragSolver::DragSolver(const uint8_t gridWidth, const uint8_t gridHeight,
                       std::vector<std::vector<Position>> shapes,
                       std::vector<Position> initialAnchors,
                       const uint8_t goalIndex, const Position goalAnchor,
                       const Config config)
    : gridWidth_(gridWidth), gridHeight_(gridHeight),
      shapes_(std::move(shapes)), initialAnchors_(std::move(initialAnchors)),
      goalIndex_(goalIndex), goalAnchor_(goalAnchor), cfg_(config),
      grid_(gridWidth, gridHeight, shapes_) {
  // Same-shape symmetry groups (mirrors AStar's construction).
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
    for (auto &[key, group] : byShape)
      if (group.size() >= 2) symmetryGroups_.push_back(std::move(group));
  }
  blockGroup_.assign(shapes_.size(), -1);
  for (size_t g = 0; g < symmetryGroups_.size(); g++)
    for (const uint8_t member : symmetryGroups_[g])
      blockGroup_[member] = static_cast<int16_t>(g);

  goalFinalRows_.assign(gridHeight_, 0);
  for (const auto &cell : shapes_[goalIndex_])
    goalFinalRows_[goalAnchor_.y + cell.y] |= uint64_t{1}
                                              << (goalAnchor_.x + cell.x);

  const auto movableFromStart = computeMovableSet(initialAnchors_);
  movableBlockIndices_.reserve(shapes_.size());
  for (uint8_t i = 0; i < shapes_.size(); i++) {
    if (movableFromStart[i] || i == goalIndex_) {
      movableBlockIndices_.push_back(i);
    } else if (blockOnGoalFootprint(i, initialAnchors_[i])) {
      unsolvableAtStart_ = true;
    }
  }

  computeCutSchedule();
  computeFinalPacking();
}

// Tries to pack every non-goal movable block into anchors whose footprints
// clear the ENTIRE cut sweep (cutSuffixRows_[0]) — a set of final positions
// that provably never obstructs the goal's remaining journey. First-empty-
// cell DFS with a bounded hole budget; on success each block gets an
// assigned slot that the displacement tie-break then steers toward. For
// puzzles whose off-sweep region cannot hold all blocks (they must re-park
// behind the goal instead), the packer fails fast and the guide stays off.
void DragSolver::computeFinalPacking() {
  packedSlot_.assign(shapes_.size(), -1);
  packingGuideActive_ = false;
  if (!cfg_.packingGuide || unsolvableAtStart_ || cutSuffixRows_.empty())
    return;
  tryComputePacking(0, -1);
}

bool DragSolver::tryComputePacking(const int cellOrderVariant,
                                   const int demotedPiece) {
  packedSlot_.assign(shapes_.size(), -1);
  packingGuideActive_ = false;
  if (cutSuffixRows_.empty())
    return false;

  const int H = gridHeight_;
  const int total = gridWidth_ * H;
  std::vector<uint64_t> lockedRows(gridHeight_, 0);
  {
    std::vector<bool> isMovable(shapes_.size(), false);
    for (const uint8_t i : movableBlockIndices_) isMovable[i] = true;
    for (uint8_t i = 0; i < shapes_.size(); i++) {
      if (isMovable[i]) continue;
      const auto &rows = grid_.shapeRows(i);
      for (uint8_t r = 0; r < rows.size(); r++)
        lockedRows[initialAnchors_[i].y + r] |= rows[r]
                                                << initialAnchors_[i].x;
    }
  }
  const auto &sweep = cutSuffixRows_[0];

  std::vector<uint8_t> allowed(total, 0);
  std::vector<uint16_t> cellList;
  for (int x = 0; x < gridWidth_; x++)
    for (int y = 0; y < H; y++) {
      const uint64_t bit = uint64_t{1} << x;
      if ((lockedRows[y] & bit) || (sweep[y] & bit))
        continue;
      allowed[x * H + y] = 1;
      cellList.push_back(static_cast<uint16_t>(x * H + y));
    }
  // First-empty-cell scan order — the main packing-shape lever.
  switch (cellOrderVariant & 3) {
  case 0:
    std::sort(cellList.begin(), cellList.end());
    break;
  case 1:
    std::sort(cellList.begin(), cellList.end(), std::greater<>());
    break;
  case 2:
    std::sort(cellList.begin(), cellList.end(),
              [H](const uint16_t a, const uint16_t b) {
                const int ya = a % H, yb = b % H;
                return ya != yb ? ya < yb : a < b;
              });
    break;
  default:
    std::sort(cellList.begin(), cellList.end(),
              [H](const uint16_t a, const uint16_t b) {
                const int ya = a % H, yb = b % H;
                return ya != yb ? ya > yb : a < b;
              });
    break;
  }

  std::vector<uint8_t> pieces;
  size_t pieceCells = 0;
  for (const uint8_t i : movableBlockIndices_) {
    if (i == goalIndex_) continue;
    pieces.push_back(i);
    pieceCells += shapes_[i].size();
  }
  std::sort(pieces.begin(), pieces.end(), [&](const uint8_t a, const uint8_t b) {
    return shapes_[a].size() > shapes_[b].size();
  });
  if (demotedPiece >= 0) {
    // Demote one piece to last choice everywhere — steers the DFS into a
    // structurally different packing.
    const auto it = std::find(pieces.begin(), pieces.end(),
                              static_cast<uint8_t>(demotedPiece));
    if (it != pieces.end()) {
      pieces.erase(it);
      pieces.push_back(static_cast<uint8_t>(demotedPiece));
    }
  }
  if (pieces.empty() || pieceCells > cellList.size())
    return false;
  int holeBudget = static_cast<int>(cellList.size() - pieceCells);

  std::vector<uint8_t> occ(total, 0);
  std::vector<bool> used(pieces.size(), false);
  std::vector<int32_t> anchorOf(pieces.size(), -1);
  uint32_t nodes = 0;
  constexpr uint32_t PACK_NODE_CAP = 5000000;

  const auto canPlaceAt = [&](const uint8_t id, const int ax, const int ay) {
    for (const auto &c : shapes_[id]) {
      const int x = ax + c.x;
      const int y = ay + c.y;
      if (x < 0 || y < 0 || x >= gridWidth_ || y >= H)
        return false;
      const int idx = x * H + y;
      if (!allowed[idx] || occ[idx])
        return false;
    }
    return true;
  };
  const auto setCells = [&](const uint8_t id, const int ax, const int ay,
                            const uint8_t v) {
    for (const auto &c : shapes_[id])
      occ[(ax + c.x) * H + (ay + c.y)] = v;
  };

  std::function<bool(size_t)> dfs = [&](const size_t fromRank) -> bool {
    if (++nodes > PACK_NODE_CAP)
      return false;
    size_t r = fromRank;
    while (r < cellList.size() && occ[cellList[r]])
      r++;
    if (r == cellList.size())
      return true;
    const uint16_t target = cellList[r];
    const int tx = target / H;
    const int ty = target % H;
    for (size_t pi = 0; pi < pieces.size(); pi++) {
      if (used[pi]) continue;
      const uint8_t id = pieces[pi];
      for (const auto &cover : shapes_[id]) {
        const int ax = tx - cover.x;
        const int ay = ty - cover.y;
        if (!canPlaceAt(id, ax, ay))
          continue;
        used[pi] = true;
        setCells(id, ax, ay, 1);
        anchorOf[pi] = ax * H + ay;
        if (dfs(r))
          return true;
        anchorOf[pi] = -1;
        setCells(id, ax, ay, 0);
        used[pi] = false;
        if (nodes > PACK_NODE_CAP)
          return false;
      }
    }
    if (holeBudget > 0) {
      holeBudget--;
      occ[target] = 2;
      if (dfs(r + 1))
        return true;
      occ[target] = 0;
      holeBudget++;
    }
    return false;
  };

  if (!dfs(0)) {
    std::cout << "DragSolver: no off-sweep packing (variant "
              << cellOrderVariant << "/" << demotedPiece << ", "
              << (nodes > PACK_NODE_CAP ? "budget" : "exhausted")
              << ") — packing guide off\n";
    return false;
  }
  for (size_t pi = 0; pi < pieces.size(); pi++)
    packedSlot_[pieces[pi]] = anchorOf[pi];

  // Same-shape blocks are interchangeable: greedily reassign each group's
  // slots to minimize summed start→slot Manhattan distance.
  for (const auto &group : symmetryGroups_) {
    std::vector<uint8_t> members;
    std::vector<int32_t> slots;
    for (const uint8_t m : group)
      if (packedSlot_[m] >= 0) {
        members.push_back(m);
        slots.push_back(packedSlot_[m]);
      }
    std::vector<bool> taken(slots.size(), false);
    for (const uint8_t m : members) {
      int best = -1;
      int bestDist = INT32_MAX;
      for (size_t s = 0; s < slots.size(); s++) {
        if (taken[s]) continue;
        const int dx = std::abs(initialAnchors_[m].x - slots[s] / H);
        const int dy = std::abs(initialAnchors_[m].y - slots[s] % H);
        if (dx + dy < bestDist) {
          bestDist = dx + dy;
          best = static_cast<int>(s);
        }
      }
      if (best >= 0) {
        taken[best] = true;
        packedSlot_[m] = slots[best];
      }
    }
  }
  packingGuideActive_ = true;
  std::cout << "DragSolver: packing guide on (" << pieces.size()
            << " blocks assigned, " << nodes << " pack nodes, variant "
            << cellOrderVariant << "/" << demotedPiece << ")\n";
  return true;
}

// Builds the cut schedule (see header). Cut anchors — banning them
// disconnects start from target in the locked-walls-only anchor graph — must
// each be occupied by the goal at some point in ANY solution, and necessarily
// lie on one (any) shortest path, so only that path's anchors are tested.
void DragSolver::computeCutSchedule() {
  const int totalAnchors = gridWidth_ * gridHeight_;
  progressIndex_.assign(totalAnchors, 0);
  cutSuffixRows_.assign(1, goalFinalRows_);
  const uint8_t gi = goalIndex_;
  const auto &start = initialAnchors_[gi];
  if (start.x == goalAnchor_.x && start.y == goalAnchor_.y)
    return;

  std::vector<uint64_t> lockedRows(gridHeight_, 0);
  {
    std::vector<bool> isMovable(shapes_.size(), false);
    for (const uint8_t i : movableBlockIndices_) isMovable[i] = true;
    for (uint8_t i = 0; i < shapes_.size(); i++) {
      if (isMovable[i]) continue;
      const auto &rows = grid_.shapeRows(i);
      for (uint8_t r = 0; r < rows.size(); r++)
        lockedRows[initialAnchors_[i].y + r] |= rows[r]
                                                << initialAnchors_[i].x;
    }
  }

  const int maxX = gridWidth_ - grid_.boxWidth(gi);
  const int maxY = gridHeight_ - grid_.boxHeight(gi);
  const auto validAnchor = [&](const int x, const int y) {
    if (x < 0 || y < 0 || x > maxX || y > maxY)
      return false;
    const auto &rows = grid_.shapeRows(gi);
    for (uint8_t r = 0; r < rows.size(); r++)
      if ((rows[r] << x) & lockedRows[y + r])
        return false;
    return true;
  };

  const int H = gridHeight_;
  const uint16_t startIdx = static_cast<uint16_t>(start.x * H + start.y);
  const uint16_t targetIdx =
      static_cast<uint16_t>(goalAnchor_.x * H + goalAnchor_.y);

  // BFS over valid anchors from `source`, skipping `banned` (-1 = none).
  // Fills `seen` completely; optionally records parents.
  std::vector<int32_t> parent(totalAnchors, -1);
  std::vector<bool> seen;
  const auto bfsFrom = [&](const uint16_t source, const int32_t banned,
                           const bool track) {
    seen.assign(totalAnchors, false);
    std::vector<uint16_t> queue;
    queue.reserve(totalAnchors);
    seen[source] = true;
    if (track) parent[source] = -1;
    queue.push_back(source);
    for (size_t head = 0; head < queue.size(); head++) {
      const uint16_t cur = queue[head];
      const int cx = cur / H;
      const int cy = cur % H;
      for (int d = 0; d < 4; d++) {
        const int nx = cx + BitGrid::DX[d];
        const int ny = cy + BitGrid::DY[d];
        if (!validAnchor(nx, ny))
          continue;
        const auto nIdx = static_cast<uint16_t>(nx * H + ny);
        if (seen[nIdx] || static_cast<int32_t>(nIdx) == banned)
          continue;
        seen[nIdx] = true;
        if (track) parent[nIdx] = cur;
        queue.push_back(nIdx);
      }
    }
  };

  bfsFrom(startIdx, -1, true);
  if (!validAnchor(start.x, start.y) || !seen[targetIdx]) {
    std::cout << "DragSolver: goal anchor unreachable even through locked "
                 "walls only — unsolvable\n";
    unsolvableAtStart_ = true;
    return;
  }

  // One shortest path start→target; cut anchors are a subset of it. Order it
  // start→target so cuts come out in crossing order.
  std::vector<uint16_t> path;
  for (int32_t cur = targetIdx; cur != -1; cur = parent[cur])
    path.push_back(static_cast<uint16_t>(cur));
  std::reverse(path.begin(), path.end());

  // Middle cuts: banning them separates start from target. For each, the
  // target-side component marks anchors that have already crossed it.
  std::vector<uint16_t> cuts;
  for (const uint16_t v : path) {
    if (v == startIdx || v == targetIdx)
      continue;
    bfsFrom(startIdx, v, false);
    if (!seen[targetIdx])
      cuts.push_back(v);
  }
  for (const uint16_t v : cuts) {
    bfsFrom(targetIdx, v, false);
    for (int a = 0; a < totalAnchors; a++)
      if (seen[a])
        progressIndex_[a]++;
  }

  // Corridor mode: no unavoidable cuts, but a long goal journey still needs
  // receding-horizon decomposition. Assign each anchor a progress band from
  // its BFS distance to target, and lay one waypoint pseudo-cut per band
  // along the shortest path. progressOf then rises as the goal advances, so
  // hier can subgoal "push the goal one band closer" instead of solving the
  // whole corridor at once. Pseudo-cuts are guidance, not constraints.
  if (cfg_.corridorBands && cuts.empty() &&
      path.size() >= cfg_.corridorBandMinPath) {
    std::vector<int32_t> dist(totalAnchors, -1);
    std::vector<uint16_t> q{targetIdx};
    dist[targetIdx] = 0;
    for (size_t head = 0; head < q.size(); head++) {
      const uint16_t c = q[head];
      const int cx = c / H, cy = c % H;
      for (int d = 0; d < 4; d++) {
        const int nx = cx + BitGrid::DX[d], ny = cy + BitGrid::DY[d];
        if (!validAnchor(nx, ny)) continue;
        const auto n = static_cast<uint16_t>(nx * H + ny);
        if (dist[n] != -1) continue;
        dist[n] = dist[c] + 1;
        q.push_back(n);
      }
    }
    const int D = dist[startIdx];
    if (D > 0) {
      const int numBands = std::clamp(D, 4, 20);
      const int bandWidth = (D + numBands - 1) / numBands; // ceil
      for (int a = 0; a < totalAnchors; a++) {
        if (dist[a] < 0) { progressIndex_[a] = 0; continue; }
        const int b = (D - dist[a]) / bandWidth;
        progressIndex_[a] = static_cast<uint16_t>(std::clamp(b, 0, numBands));
      }
      // One waypoint per band: the first path anchor reaching that band.
      int nextBand = 1;
      for (const uint16_t v : path) {
        if (v == startIdx) continue;
        while (nextBand <= numBands &&
               progressIndex_[v] >= static_cast<uint16_t>(nextBand)) {
          cuts.push_back(v);
          nextBand++;
        }
        if (nextBand > numBands) break;
      }
      corridorBandsActive_ = !cuts.empty();
    }
  }

  middleCuts_ = static_cast<uint32_t>(cuts.size());
  cuts.push_back(targetIdx); // the target is trivially on every path

  // Suffix footprint masks: cutSuffixRows_[p] = union of goal footprints of
  // the cuts still ahead after crossing p of them.
  const auto &rows = grid_.shapeRows(gi);
  const size_t k = cuts.size();
  cutSuffixRows_.assign(k, std::vector<uint64_t>(gridHeight_, 0));
  std::vector<uint64_t> acc(gridHeight_, 0);
  for (size_t i = k; i-- > 0;) {
    const int vx = cuts[i] / H;
    const int vy = cuts[i] % H;
    for (uint8_t r = 0; r < rows.size(); r++)
      acc[vy + r] |= rows[r] << vx;
    cutSuffixRows_[i] = acc;
  }
  std::cout << "DragSolver: cut schedule — " << (k - 1) << " of "
            << path.size() - 2 << " middle path anchors are cuts\n";
}

bool DragSolver::blockOnMask(const uint8_t i, const Position a,
                             const std::vector<uint64_t> &mask) const {
  const auto &rows = grid_.shapeRows(i);
  for (uint8_t r = 0; r < rows.size(); r++)
    if ((rows[r] << a.x) & mask[a.y + r])
      return true;
  return false;
}

bool DragSolver::blockOnGoalFootprint(const uint8_t i, const Position a) const {
  return blockOnMask(i, a, goalFinalRows_);
}

uint32_t
DragSolver::blockCellsOnMask(const uint8_t i, const Position a,
                             const std::vector<uint64_t> &mask) const {
  const auto &rows = grid_.shapeRows(i);
  uint32_t n = 0;
  for (uint8_t r = 0; r < rows.size(); r++)
    n += static_cast<uint32_t>(std::popcount((rows[r] << a.x) & mask[a.y + r]));
  return n;
}

uint32_t DragSolver::heuristic(const std::vector<Position> &anchors) const {
  const auto &g = anchors[goalIndex_];
  if (g.x == goalAnchor_.x && g.y == goalAnchor_.y)
    return 0;
  // Blocks intersecting the footprint of any still-ahead cut must each move
  // at least once — the goal has to pass through those cells. One drag moves
  // one block and a goal drag only crosses cuts whose footprints were already
  // clear, so h drops by at most 1 per drag: admissible and consistent.
  uint32_t h = 1;
  const uint16_t p = progressIndex_[g.x * gridHeight_ + g.y];
  const auto &mask = cutSuffixRows_[p < cutSuffixRows_.size()
                                        ? p
                                        : cutSuffixRows_.size() - 1];
  for (const uint8_t i : movableBlockIndices_) {
    if (i == goalIndex_) continue;
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
    std::vector<bool> isMovable(shapes_.size(), false);
    for (const uint8_t i : movableBlockIndices_) isMovable[i] = true;
    for (uint8_t i = 0; i < shapes_.size(); i++) {
      if (i == gi)
        continue;
      auto &dst = isMovable[i] ? jamMovRows_ : jamLockRows_;
      const auto &rows = grid_.shapeRows(i);
      for (uint8_t r = 0; r < rows.size(); r++)
        dst[anchors[i].y + r] |= rows[r] << anchors[i].x;
    }
  }

  const auto &gRows = grid_.shapeRows(gi);
  const int maxX = W - grid_.boxWidth(gi);
  const int maxY = H - grid_.boxHeight(gi);
  const bool pinActive = cfg_.jamPinRoute && jamPinned_;
  const auto validAnchor = [&](const int x, const int y) {
    if (x < 0 || y < 0 || x > maxX || y > maxY)
      return false;
    for (uint8_t r = 0; r < gRows.size(); r++) {
      const uint64_t fp = gRows[r] << x;
      if (fp & jamLockRows_[y + r])
        return false;
      if (pinActive && (fp & ~jamPinRows_[y + r]))
        return false; // outside the pinned corridor
    }
    return true;
  };
  // Movable-occupied cells the goal footprint at (nx, ny) covers that the
  // footprint at (cx, cy) did not — the newly swept cells of one step.
  const auto newBlockedCells = [&](const int cx, const int cy, const int nx,
                                   const int ny) {
    uint32_t cells = 0;
    for (uint8_t r = 0; r < gRows.size(); r++) {
      const uint64_t nMask = gRows[r] << nx;
      const int absY = ny + r;
      uint64_t cMask = 0;
      const int cr = absY - cy;
      if (cr >= 0 && cr < static_cast<int>(gRows.size()))
        cMask = gRows[cr] << cx;
      cells += static_cast<uint32_t>(
          std::popcount(nMask & ~cMask & jamMovRows_[absY]));
    }
    return cells;
  };

  const uint16_t targetIdx =
      static_cast<uint16_t>(goalAnchor_.x * H + goalAnchor_.y);
  const auto &gpos = anchors[gi];
  const auto goalCurIdx = static_cast<uint16_t>(gpos.x * H + gpos.y);
  jamField_.assign(totalAnchors, UINT32_MAX);
  jamNextHop_.assign(totalAnchors, -1);
  using QE = std::pair<uint32_t, uint16_t>;
  std::priority_queue<QE, std::vector<QE>, std::greater<>> pq;
  if (validAnchor(goalAnchor_.x, goalAnchor_.y)) {
    jamField_[targetIdx] = 0;
    pq.push({0, targetIdx});
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
        pq.push({cand, a});
      }
    }
  }

  const auto &g = anchors[gi];
  const auto goalIdx = static_cast<uint16_t>(g.x * H + g.y);
  jamSweepRows_.assign(H, 0);
  if (jamField_[goalIdx] != UINT32_MAX)
    for (int32_t cur = goalIdx; cur != -1; cur = jamNextHop_[cur]) {
      const int cx = cur / H;
      const int cy = cur % H;
      for (uint8_t r = 0; r < gRows.size(); r++)
        jamSweepRows_[cy + r] |= gRows[r] << cx;
    }
  // First successful field with jamPinRoute: freeze this route's 2-dilated
  // footprint as the corridor every later Dijkstra must stay inside.
  if (cfg_.jamPinRoute && !jamPinned_ && jamField_[goalIdx] != UINT32_MAX) {
    const uint64_t colMask = W >= 64 ? ~uint64_t{0} : (uint64_t{1} << W) - 1;
    std::vector<uint64_t> dil = jamSweepRows_;
    for (int pass = 0; pass < 2; pass++) {
      std::vector<uint64_t> next(H, 0);
      for (int y = 0; y < H; y++) {
        uint64_t m = dil[y] | (dil[y] << 1) | (dil[y] >> 1);
        if (y > 0) m |= dil[y - 1];
        if (y + 1 < H) m |= dil[y + 1];
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
    const auto &a = anchors[i];
    for (const auto &cell : shapes_[i])
      occupancy[(a.x + cell.x) * gridHeight_ + (a.y + cell.y)] =
          static_cast<int16_t>(i);
  }
  const auto inBoundsBox = [&](const size_t i, const Position p) {
    return p.x >= 0 && p.y >= 0 && p.x + grid_.boxWidth(static_cast<uint8_t>(i)) <= gridWidth_ &&
           p.y + grid_.boxHeight(static_cast<uint8_t>(i)) <= gridHeight_;
  };
  std::vector<bool> movable(n, false);
  bool changed = true;
  while (changed) {
    changed = false;
    for (size_t i = 0; i < n; i++) {
      if (movable[i])
        continue;
      const auto &a = anchors[i];
      bool canMove = false;
      for (int d = 0; d < 4 && !canMove; d++) {
        const Position newAnchor = {static_cast<int8_t>(a.x + BitGrid::DX[d]),
                                    static_cast<int8_t>(a.y + BitGrid::DY[d])};
        if (!inBoundsBox(i, newAnchor))
          continue;
        bool allFreeable = true;
        for (const auto &cell : shapes_[i]) {
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
    if (i == goalIndex_) continue;
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

NodeKey DragSolver::coarseSignature(
    const std::vector<Position> &anchors) const {
  const auto n = static_cast<uint8_t>(anchors.size());
  NodeKey key(n);
  uint16_t *d = key.data();
  for (uint8_t i = 0; i < n; i++) {
    const auto &a = anchors[i];
    d[i] = static_cast<uint16_t>(
        (static_cast<uint16_t>(static_cast<uint8_t>(a.x) >> 2) << 8) |
        (static_cast<uint8_t>(a.y) >> 2));
  }
  for (const auto &group : symmetryGroups_) {
    const size_t m = group.size();
    if (m > 64) continue;
    uint16_t vals[64];
    for (size_t k = 0; k < m; k++) vals[k] = d[group[k]];
    std::sort(vals, vals + m);
    for (size_t k = 0; k < m; k++) d[group[k]] = vals[k];
  }
  return key;
}

NodeKey DragSolver::childSignature(const NodeKey &parentKey,
                                   const uint8_t block, const Position oldPos,
                                   const Position newPos) const {
  const auto pack = [](const Position p) {
    return static_cast<uint16_t>(
        (static_cast<uint16_t>(static_cast<uint8_t>(p.x)) << 8) |
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
  uint16_t vals[64];
  for (size_t k = 0; k < m; k++) vals[k] = d[slots[k]];
  for (size_t k = 0; k < m; k++) {
    if (vals[k] == oldPacked) {
      vals[k] = newPacked;
      break;
    }
  }
  std::sort(vals, vals + m);
  for (size_t k = 0; k < m; k++) d[slots[k]] = vals[k];
  return key;
}

NodeKey DragSolver::signatureFromAnchors(
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
  if (!cfg_.canonicalizeSymmetry)
    return key;
  for (const auto &group : symmetryGroups_) {
    const size_t m = group.size();
    if (m > 64) continue;
    uint16_t vals[64];
    for (size_t k = 0; k < m; k++) vals[k] = d[group[k]];
    std::sort(vals, vals + m);
    for (size_t k = 0; k < m; k++) d[group[k]] = vals[k];
  }
  return key;
}

void DragSolver::computeDisplacementFields(const uint32_t maskIndex) {
  const auto &mask = cutSuffixRows_[maskIndex];
  dispField_.assign(shapes_.size(), {});

  std::vector<uint64_t> lockedRows(gridHeight_, 0);
  {
    std::vector<bool> isMovable(shapes_.size(), false);
    for (const uint8_t i : movableBlockIndices_) isMovable[i] = true;
    for (uint8_t i = 0; i < shapes_.size(); i++) {
      if (isMovable[i]) continue;
      const auto &rows = grid_.shapeRows(i);
      for (uint8_t r = 0; r < rows.size(); r++)
        lockedRows[initialAnchors_[i].y + r] |= rows[r]
                                                << initialAnchors_[i].x;
    }
  }

  const int H = gridHeight_;
  const int total = gridWidth_ * H;
  for (const uint8_t i : movableBlockIndices_) {
    if (i == goalIndex_) continue;
    const auto &rows = grid_.shapeRows(i);
    const int maxX = gridWidth_ - grid_.boxWidth(i);
    const int maxY = gridHeight_ - grid_.boxHeight(i);
    const auto valid = [&](const int x, const int y) {
      if (x < 0 || y < 0 || x > maxX || y > maxY)
        return false;
      for (uint8_t r = 0; r < rows.size(); r++)
        if ((rows[r] << x) & lockedRows[y + r])
          return false;
      return true;
    };
    auto &field = dispField_[i];
    field.assign(total, UINT16_MAX);
    std::vector<uint16_t> queue;
    queue.reserve(total);
    if (!packedSlot_.empty() && packedSlot_[i] >= 0) {
      // Packing guide: steer toward this block's assigned final slot.
      const auto s = static_cast<uint16_t>(packedSlot_[i]);
      if (valid(s / H, s % H)) {
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
            if ((rows[r] << x) & mask[y + r])
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

uint32_t DragSolver::displacementSum(
    const std::vector<Position> &anchors) const {
  uint32_t sum = 0;
  if (dispField_.size() < shapes_.size())
    return 0; // fields not computed yet
  for (const uint8_t i : movableBlockIndices_) {
    if (i == goalIndex_ || dispField_[i].empty())
      continue;
    const uint16_t d =
        dispField_[i][anchors[i].x * gridHeight_ + anchors[i].y];
    sum += d == UINT16_MAX ? 128 : std::min<uint32_t>(d, 64);
  }
  return sum;
}

uint32_t DragSolver::progressOf(const std::vector<Position> &anchors) const {
  const auto &g = anchors[goalIndex_];
  if (g.x == goalAnchor_.x && g.y == goalAnchor_.y)
    return middleCuts_ + 1;
  return progressIndex_[g.x * gridHeight_ + g.y];
}

DragSolver::SegmentResult
DragSolver::runAStarDrag(const std::vector<Position> &startAnchors,
                         const uint32_t targetProgress,
                         const BannedSet *bannedEnds, const uint64_t deadline,
                         const uint32_t nodeCap, const uint8_t collectEnds,
                         const uint32_t consolidationBelow) {
  const bool verbose = targetProgress > middleCuts_ && bannedEnds == nullptr;
  computeDisplacementFields(std::min(targetProgress, middleCuts_));
  // slotHeuristic drives toward the packing; make the flat search's root h
  // consistent with the candidate scoring by keeping heuristic() cut-based
  // (root ordering is irrelevant — there is only one root).
  SegmentResult result;
  BannedSet seenEnds; // coarse keys of ends already collected this call
  const auto finishResult = [&](const bool exhausted) {
    result.exhausted = exhausted && result.alts.empty();
    result.found = !result.alts.empty();
    if (result.found) {
      result.drags = result.alts.front().drags;
      result.endAnchors = result.alts.front().endAnchors;
    }
    return result;
  };

  StateMap states;
  std::unordered_map<NodeKey, Node, NodeKeyHash> nodeStore;
  std::priority_queue<DragHeapEntry, std::vector<DragHeapEntry>,
                      std::greater<>>
      openHeap;

  const NodeKey rootSig = signatureFromAnchors(startAnchors);
  states[rootSig] = {0, 0, {}, {}, 0, false, false};
  nodeStore.try_emplace(rootSig, Node(startAnchors));
  const uint32_t rootDisp = displacementSum(startAnchors);
  openHeap.push({cfg_.weight * heuristic(startAnchors) +
                     (cfg_.packingWeight * rootDisp) / 16,
                 0, 0, 16 * rootDisp, rootSig});

  uint32_t nodesExpanded = 0;
  uint64_t loopIters = 0;
  // Best jam-term expanded state (jam guide only): the drag chain to it is
  // returned as bestPartialDrags on failure — the restart driver's elite.
  NodeKey bestJamSig;
  uint32_t bestJamVal = UINT32_MAX;
  const auto finishStats = [&] {
    stats_.passes++;
    stats_.nodesExpanded += nodesExpanded;
    stats_.statesStored += states.size();
    if (result.alts.empty() && bestJamVal != UINT32_MAX &&
        bestJamSig.len != 0) {
      result.bestPartialJam = bestJamVal;
      NodeKey cur = bestJamSig;
      while (true) {
        auto it = states.find(cur);
        if (it == states.end() || !it->second.hasParent)
          break;
        result.bestPartialDrags.push_back(it->second.move);
        cur = it->second.parent;
      }
      std::reverse(result.bestPartialDrags.begin(),
                   result.bestPartialDrags.end());
    }
  };

  // sleepSets scratch: per-block interaction envelopes (row masks of every
  // cell the block occupies at its start or any reachable anchor) and the
  // per-block child sleep masks, rebuilt each expansion.
  const bool por = cfg_.sleepSets && shapes_.size() <= 32;
  std::vector<std::vector<uint64_t>> envRows;
  std::vector<uint32_t> sleptMaskOf;
  if (por) {
    envRows.assign(shapes_.size(), std::vector<uint64_t>(gridHeight_, 0));
    sleptMaskOf.assign(shapes_.size(), 0);
  }
  // relevantOnly: locked-only walls for the per-state goal-path BFS.
  std::vector<uint64_t> relevanceLocked;
  if (cfg_.relevantOnly) {
    relevanceLocked.assign(gridHeight_, 0);
    std::vector<bool> isMov(shapes_.size(), false);
    for (const uint8_t i : movableBlockIndices_) isMov[i] = true;
    for (uint8_t i = 0; i < shapes_.size(); i++) {
      if (isMov[i]) continue;
      const auto &rows = grid_.shapeRows(i);
      for (uint8_t r = 0; r < rows.size(); r++)
        relevanceLocked[initialAnchors_[i].y + r] |= rows[r]
                                                    << initialAnchors_[i].x;
    }
  }
  // Relevance mask: goal ∪ blocks on the goal's shortest-path sweep (R0) ∪
  // blocks touching R0's cells (R1) — the "unlock the path, then unlock the
  // unblockers" order. UINT32_MAX = no filtering (fallback).
  const auto relevantMaskOf =
      [&](const std::vector<Position> &anchors) -> uint32_t {
    const int H = gridHeight_;
    const int total = gridWidth_ * H;
    const auto &grows = grid_.shapeRows(goalIndex_);
    const int maxX = gridWidth_ - grid_.boxWidth(goalIndex_);
    const int maxY = gridHeight_ - grid_.boxHeight(goalIndex_);
    const auto valid = [&](const int x, const int y) {
      if (x < 0 || y < 0 || x > maxX || y > maxY)
        return false;
      for (uint8_t r = 0; r < grows.size(); r++)
        if ((grows[r] << x) & relevanceLocked[y + r])
          return false;
      return true;
    };
    const auto &g = anchors[goalIndex_];
    const auto startIdx = static_cast<uint16_t>(g.x * H + g.y);
    const auto targetIdx =
        static_cast<uint16_t>(goalAnchor_.x * H + goalAnchor_.y);
    if (startIdx == targetIdx)
      return UINT32_MAX;
    std::vector<int32_t> par(total, -2);
    std::vector<uint16_t> q{startIdx};
    par[startIdx] = -1;
    bool found = false;
    for (size_t head = 0; head < q.size() && !found; head++) {
      const uint16_t cur = q[head];
      const int cx = cur / H, cy = cur % H;
      for (int d = 0; d < 4; d++) {
        const int nx = cx + BitGrid::DX[d], ny = cy + BitGrid::DY[d];
        if (!valid(nx, ny))
          continue;
        const auto nIdx = static_cast<uint16_t>(nx * H + ny);
        if (par[nIdx] != -2)
          continue;
        par[nIdx] = cur;
        if (nIdx == targetIdx) {
          found = true;
          break;
        }
        q.push_back(nIdx);
      }
    }
    if (!found)
      return UINT32_MAX;
    std::vector<uint64_t> sweep(gridHeight_, 0);
    for (int32_t cur = targetIdx; cur != -1; cur = par[cur]) {
      const int cx = cur / H, cy = cur % H;
      for (uint8_t r = 0; r < grows.size(); r++)
        sweep[cy + r] |= grows[r] << cx;
    }
    uint32_t mask = uint32_t{1} << goalIndex_;
    std::vector<uint64_t> accum(gridHeight_, 0); // cells of relevant blocks
    for (const uint8_t b : movableBlockIndices_) {
      if (b == goalIndex_)
        continue;
      if (blockOnMask(b, anchors[b], sweep)) {
        mask |= uint32_t{1} << b;
        const auto &rows = grid_.shapeRows(b);
        for (uint8_t r = 0; r < rows.size(); r++)
          accum[anchors[b].y + r] |= rows[r] << anchors[b].x;
      }
    }
    // Ring k: dilate the accumulated relevant cells and absorb touching
    // blocks; repeat relevantRing_ times (the escalation search() drives
    // when a tighter ring's space exhausts without a solution).
    for (uint8_t ring = 0; ring < relevantRing_; ring++) {
      std::vector<uint64_t> dil(gridHeight_, 0);
      for (int y = 0; y < gridHeight_; y++) {
        uint64_t m = accum[y] | (accum[y] << 1) | (accum[y] >> 1);
        if (y > 0)
          m |= accum[y - 1];
        if (y + 1 < gridHeight_)
          m |= accum[y + 1];
        dil[y] = m;
      }
      bool grew = false;
      for (const uint8_t b : movableBlockIndices_) {
        if (mask >> b & 1)
          continue;
        if (blockOnMask(b, anchors[b], dil)) {
          mask |= uint32_t{1} << b;
          const auto &rows = grid_.shapeRows(b);
          for (uint8_t r = 0; r < rows.size(); r++)
            accum[anchors[b].y + r] |= rows[r] << anchors[b].x;
          grew = true;
        }
      }
      if (!grew)
        break;
    }
    return mask;
  };

  while (!openHeap.empty()) {
    loopIters++;
    if (cfg_.cancel && (loopIters & 0xFF) == 0 &&
        cfg_.cancel->load(std::memory_order_relaxed)) {
      if (verbose)
        std::cout << "DragSolver cancelled after " << nodesExpanded
                  << " drag expansions\n";
      finishStats();
      return finishResult(false);
    }
    if (deadline != 0 && (loopIters & 0xFF) == 0 && nowMs() > deadline) {
      if (verbose)
        std::cout << "DragSolver timed out after " << nodesExpanded
                  << " drag expansions\n";
      finishStats();
      return finishResult(false);
    }
    // Graceful memory stop — see Config::maxStatesStored. Same cadence and the
    // same unwind as the timeout above, so an out-of-memory search reports "no
    // solution" instead of aborting the (shared) wasm heap under everyone else.
    if (cfg_.maxStatesStored != 0 && (loopIters & 0xFF) == 0 &&
        states.size() >= cfg_.maxStatesStored) {
      if (verbose)
        std::cout << "DragSolver hit the state ceiling (" << states.size()
                  << " states) after " << nodesExpanded << " drag expansions\n";
      finishStats();
      return finishResult(false);
    }
    // Measured-memory ceiling. Same cadence deliberately: liveAllocatedBytes()
    // walks allocator structures under emscripten, so it must not run per node.
    if (cfg_.maxHeapBytes != 0 && (loopIters & 0xFF) == 0) {
      const uint64_t used = memprobe::liveAllocatedBytes();
      // 0 means the platform cannot measure — treat as "no information" and
      // keep searching rather than stopping a search that is perfectly fine.
      if (used != 0 && used >= cfg_.maxHeapBytes) {
        if (verbose)
          std::cout << "DragSolver hit the memory ceiling (" << (used >> 20)
                    << " MB of " << (cfg_.maxHeapBytes >> 20) << " MB) after "
                    << nodesExpanded << " drag expansions\n";
        stats_.stoppedOnMemory = true;
        finishStats();
        return finishResult(false);
      }
    }
    if (nodeCap != 0 && nodesExpanded >= nodeCap) {
      if (verbose)
        std::cout << "DragSolver hit node cap of " << nodeCap << "\n";
      finishStats();
      return finishResult(false);
    }

    DragHeapEntry current = openHeap.top();
    openHeap.pop();

    auto sit = states.find(current.signature);
    if (sit == states.end() || sit->second.closed ||
        sit->second.gScore < current.g ||
        (sit->second.gScore == current.g && sit->second.cells < current.cells))
      continue;

    auto nit = nodeStore.find(current.signature);
    if (nit == nodeStore.end()) {
      sit->second.closed = true;
      continue;
    }
    // Copied out: the node may stay live across PEA* batches while the store
    // takes inserts.
    const std::vector<Position> anchors = nit->second.anchors;

    bool qualifies =
        progressOf(anchors) >= targetProgress ||
        (consolidationBelow != 0 && current.g > 0 &&
         displacementSum(anchors) <= consolidationBelow);
    if (qualifies && cfg_.requireAllSlots && packingGuideActive_) {
      for (const uint8_t b : movableBlockIndices_) {
        if (b == goalIndex_ || packedSlot_[b] < 0) continue;
        if (anchors[b].x * gridHeight_ + anchors[b].y != packedSlot_[b]) {
          qualifies = false;
          break;
        }
      }
    }
    if (qualifies) {
      const NodeKey coarse = coarseSignature(anchors);
      if ((bannedEnds == nullptr || !bannedEnds->contains(coarse)) &&
          !seenEnds.contains(coarse)) {
        if (verbose)
          std::cout << "DragSolver (w=" << static_cast<int>(cfg_.weight)
                    << ") found solution in " << current.g
                    << " drags, expanded " << nodesExpanded << " nodes\n";
        // Walk the parent chain to collect the drag plan.
        SegmentAlt alt;
        alt.endAnchors = anchors;
        NodeKey cur = current.signature;
        while (true) {
          auto it = states.find(cur);
          if (it == states.end() || !it->second.hasParent)
            break;
          alt.drags.push_back(it->second.move);
          cur = it->second.parent;
        }
        std::reverse(alt.drags.begin(), alt.drags.end());
        seenEnds.insert(coarse);
        result.alts.push_back(std::move(alt));
        if (result.alts.size() >= collectEnds) {
          finishStats();
          return finishResult(false);
        }
      }
      // Qualifying states are recorded leaves — never expanded.
      sit->second.closed = true;
      nodeStore.erase(current.signature);
      continue;
    }

    // References into `states` stay valid across inserts (node-based map).
    StateInfo &info = sit->second;
    if (info.batchesEmitted == 0) {
      nodesExpanded++;
      // Report cumulatively across passes/segments so callers see a monotone
      // counter even in hierarchical mode.
      if (onProgress && nodesExpanded % 1000 == 0)
        onProgress(stats_.nodesExpanded + nodesExpanded);
      if (nodesExpanded % 100000 == 0) {
        std::cout << "  ... DragSolver working: " << nodesExpanded
                  << " nodes, heap=" << openHeap.size()
                  << ", states=" << states.size() << ", g=" << current.g
                  << "\n";
        std::cout.flush();
      }
      if (cfg_.deadlockPruning && isDeadlocked(anchors)) {
        info.closed = true;
        nodeStore.erase(current.signature);
        continue;
      }
    }

    // ---- Score every candidate drag incrementally (no per-candidate anchor
    // vectors or O(blocks) heuristic recomputation) ----
    // slotHeuristic mode swaps the cut-suffix mask terms for "blocks not at
    // their assigned packing slot" (onMaskScratch_ then holds off-slot
    // flags and baseCount the off-slot count). Non-admissible vs the bare
    // goal condition (which does not require clusters placed), by design:
    // it drives the pack-everything-first strategy.
    const bool useSlotH = cfg_.slotHeuristic && packingGuideActive_;
    const Position gPos = anchors[goalIndex_];
    const uint16_t gProg = progressIndex_[gPos.x * gridHeight_ + gPos.y];
    const auto &maskP =
        cutSuffixRows_[std::min<size_t>(gProg, cutSuffixRows_.size() - 1)];
    onMaskScratch_.assign(shapes_.size(), 0);
    dispContribScratch_.assign(shapes_.size(), 0);
    uint32_t baseCount = 0;
    uint32_t dispBase = 0;
    for (const uint8_t b : movableBlockIndices_) {
      if (b == goalIndex_) continue;
      if (useSlotH) {
        onMaskScratch_[b] =
            packedSlot_[b] >= 0 &&
                    anchors[b].x * gridHeight_ + anchors[b].y != packedSlot_[b]
                ? 1
                : 0;
      } else {
        onMaskScratch_[b] = blockOnMask(b, anchors[b], maskP) ? 1 : 0;
      }
      baseCount += onMaskScratch_[b];
      uint32_t contrib = 0;
      if (!dispField_[b].empty()) {
        const uint16_t dd =
            dispField_[b][anchors[b].x * gridHeight_ + anchors[b].y];
        contrib = dd == UINT16_MAX ? 128 : std::min<uint32_t>(dd, 64);
      }
      dispContribScratch_[b] = contrib;
      dispBase += contrib;
    }
    const uint32_t newG = current.g + 1;

    // Jam guide: one dig-Dijkstra per expansion; children read the field
    // (goal moves) or adjust the parent's term by their sweep-overlap delta
    // (non-goal moves). See Config::jamGuideWeight.
    const bool useJam = cfg_.jamGuideWeight != 0;
    uint32_t jamBase = 0;
    if (useJam) {
      jamBase = computeJamField(anchors);
      if (jamBase < stats_.minJamTerm)
        stats_.minJamTerm = jamBase;
      if (jamBase < bestJamVal) {
        bestJamVal = jamBase;
        bestJamSig = current.signature;
      }
    }
    if (gProg > stats_.maxProgress)
      stats_.maxProgress = gProg;
    // Clamped scaled jam contribution — keeps f finite when the field says
    // unreachable (locked-walls disconnection; the admissible h still owns
    // correctness, the guide only orders).
    const auto jamAdd = [&](const uint32_t term) -> uint32_t {
      const uint32_t t = std::min<uint32_t>(term, 1u << 20);
      return (cfg_.jamGuideWeight * t) / 16;
    };
    // Diversification jitter: replaces the deterministic tie field with a
    // seed-mixed candidate hash so equal-f plateaus break differently per
    // restart.
    const auto jitterTie = [&](const uint8_t block,
                               const uint16_t toIdx) -> uint32_t {
      uint32_t x = cfg_.tieBreakSeed ^ (static_cast<uint32_t>(block) << 16) ^
                   toIdx ^ (current.g * 0x9E3779B9u);
      x *= 0x85EBCA6Bu;
      x ^= x >> 13;
      x *= 0xC2B2AE35u;
      x ^= x >> 16;
      return x;
    };

    const uint32_t relevantMask =
        (cfg_.relevantOnly && shapes_.size() <= 32) ? relevantMaskOf(anchors)
                                                    : UINT32_MAX;
    uint32_t iterated = 0; // blocks that actually generated drags this pop
    if (por)
      for (const uint8_t b : movableBlockIndices_) {
        std::fill(envRows[b].begin(), envRows[b].end(), 0);
        sleptMaskOf[b] = 0;
      }
    candScratch_.clear();
    grid_.buildOccupancy(anchors);
    for (const uint8_t i : movableBlockIndices_) {
      const Position from = anchors[i];
      if (!(relevantMask >> i & 1))
        continue; // relevance-filtered
      if (por && (info.slept >> i & 1))
        continue; // commutes with the drag that created this node
      if (cfg_.lockOnSlot && packingGuideActive_ && i != goalIndex_ &&
          packedSlot_[i] >= 0 &&
          from.x * gridHeight_ + from.y == packedSlot_[i])
        continue; // ratcheted: this block reached its slot and stays
      if (std::find(cfg_.frozenBlocks.begin(), cfg_.frozenBlocks.end(), i) !=
          cfg_.frozenBlocks.end())
        continue; // parked for this search
      // Jam guide: this block's current overlap with the goal's argmin
      // route sweep — candidates re-add their overlap at the target spot.
      const uint32_t jamOldOverlap =
          useJam && i != goalIndex_
              ? cfg_.jamBlockerPenalty *
                    blockCellsOnMask(i, from, jamSweepRows_)
              : 0;
      grid_.removeBlock(i, from);
      const auto &reached = grid_.floodFill(i, from);
      stats_.floodFills++;
      if (por) {
        // Interaction envelope = the block's cells at start + every
        // reachable anchor. Independence needs a ONE-CELL BUFFER: i merely
        // vacating a cell adjacent to j's region lets j slide into space it
        // could not reach before — a drag with no (j, i) twin. Testing j's
        // envelope against the 1-dilation of i's covers both growth
        // directions (dilation is self-adjoint under intersection).
        auto &env = envRows[i];
        const auto &rows = grid_.shapeRows(i);
        for (uint8_t r = 0; r < rows.size(); r++)
          env[from.y + r] |= rows[r] << from.x;
        for (const uint16_t idx : reached) {
          const Position t = grid_.anchorFromIndex(idx);
          for (uint8_t r = 0; r < rows.size(); r++)
            env[t.y + r] |= rows[r] << t.x;
        }
        uint32_t sm = 0;
        if (i > 0 && iterated != 0) {
          std::vector<uint64_t> dil(gridHeight_);
          for (uint8_t y = 0; y < gridHeight_; y++) {
            uint64_t m = env[y] | (env[y] << 1) | (env[y] >> 1);
            if (y > 0)
              m |= env[y - 1];
            if (y + 1 < gridHeight_)
              m |= env[y + 1];
            dil[y] = m;
          }
          for (const uint8_t j : movableBlockIndices_) {
            if (j >= i)
              break;
            if (!(iterated >> j & 1))
              continue; // j generated nothing here — no (j, i) twin branch
            bool overlap = false;
            for (uint8_t y = 0; y < gridHeight_ && !overlap; y++)
              overlap = (dil[y] & envRows[j][y]) != 0;
            if (!overlap)
              sm |= uint32_t{1} << j;
          }
        }
        sleptMaskOf[i] = sm;
        iterated |= uint32_t{1} << i;
      }
      for (const uint16_t toIdx : reached) {
        const Position t = grid_.anchorFromIndex(toIdx);
        if (cfg_.settledOnly) {
          const bool blockedV = !grid_.canPlace(i, t.x, t.y - 1) ||
                                !grid_.canPlace(i, t.x, t.y + 1);
          const bool blockedH = !grid_.canPlace(i, t.x - 1, t.y) ||
                                !grid_.canPlace(i, t.x + 1, t.y);
          const bool advances =
              i == goalIndex_ && progressIndex_[toIdx] > gProg;
          if (!(blockedV && blockedH) && !advances)
            continue;
        }
        uint32_t h;
        uint32_t disp = dispBase;
        if (i == goalIndex_) {
          if (useSlotH) {
            h = baseCount +
                ((t.x == goalAnchor_.x && t.y == goalAnchor_.y) ? 0 : 1);
          } else if (t.x == goalAnchor_.x && t.y == goalAnchor_.y) {
            h = 0;
          } else {
            const auto &maskN =
                cutSuffixRows_[std::min<size_t>(progressIndex_[toIdx],
                                                cutSuffixRows_.size() - 1)];
            if (&maskN == &maskP) {
              h = 1 + baseCount;
            } else {
              uint32_t cnt = 0;
              for (const uint8_t b : movableBlockIndices_) {
                if (b == goalIndex_) continue;
                if (blockOnMask(b, anchors[b], maskN)) cnt++;
              }
              h = 1 + cnt;
            }
          }
        } else {
          uint32_t onNew;
          if (useSlotH) {
            onNew = packedSlot_[i] >= 0 &&
                            static_cast<int32_t>(toIdx) != packedSlot_[i]
                        ? 1
                        : 0;
          } else {
            onNew = blockOnMask(i, t, maskP) ? 1 : 0;
          }
          h = 1 + baseCount - onMaskScratch_[i] + onNew;
          uint32_t contribNew = 0;
          if (!dispField_[i].empty()) {
            const uint16_t dd = dispField_[i][toIdx];
            contribNew = dd == UINT16_MAX ? 128 : std::min<uint32_t>(dd, 64);
          }
          disp = dispBase - dispContribScratch_[i] + contribNew;
        }
        const uint32_t newCells = current.cells + grid_.distTo(toIdx);
        uint32_t f = newG + cfg_.weight * h + (cfg_.packingWeight * disp) / 16;
        if (useJam) {
          // Goal drags read the exact field at the target; non-goal drags
          // shift the parent's term by their sweep-overlap delta.
          const uint32_t jamChild =
              i == goalIndex_
                  ? jamField_[toIdx]
                  : jamBase - jamOldOverlap +
                        cfg_.jamBlockerPenalty *
                            blockCellsOnMask(i, t, jamSweepRows_);
          f += jamAdd(jamChild);
        }
        const uint32_t tieVal = cfg_.tieBreakSeed != 0
                                    ? jitterTie(i, toIdx)
                                    : newCells + 16 * disp;
        candScratch_.push_back({f, newCells, tieVal, toIdx, i});
      }
      grid_.addBlock(i, from);
    }

    std::sort(candScratch_.begin(), candScratch_.end(),
              [](const Cand &a, const Cand &b) {
                if (a.f != b.f) return a.f < b.f;
                if (a.tie != b.tie) return a.tie < b.tie;
                if (a.blockId != b.blockId) return a.blockId < b.blockId;
                return a.toIdx < b.toIdx;
              });

    // ---- Emit (PEA*: one batch, then requeue the parent at the next f) ----
    const uint16_t batch = cfg_.partialExpansionWidth;
    const size_t emitFrom =
        batch == 0 ? 0 : static_cast<size_t>(info.batchesEmitted) * batch;
    const size_t emitTo = batch == 0
                              ? candScratch_.size()
                              : std::min(emitFrom + batch, candScratch_.size());
    for (size_t ci = emitFrom; ci < emitTo; ci++) {
      const Cand &c = candScratch_[ci];
      const Position newPos = grid_.anchorFromIndex(c.toIdx);
      NodeKey newSig =
          childSignature(current.signature, c.blockId, anchors[c.blockId],
                         newPos);
      auto [newIt, inserted] = states.try_emplace(newSig);
      const bool better =
          inserted ||
          (!newIt->second.closed &&
           (newG < newIt->second.gScore ||
            (newG == newIt->second.gScore && c.cells < newIt->second.cells)));
      if (!better)
        continue;
      newIt->second = {newG,         c.cells, current.signature,
                       {c.blockId, c.toIdx}, 0,       true,
                       false};
      if (por)
        newIt->second.slept = sleptMaskOf[c.blockId];
      std::vector<Position> newAnchors = anchors;
      newAnchors[c.blockId] = newPos;
      nodeStore.insert_or_assign(newSig, Node(std::move(newAnchors)));
      openHeap.push({c.f, newG, c.cells, c.tie, std::move(newSig)});
    }
    if (batch != 0 && emitTo < candScratch_.size()) {
      info.batchesEmitted++;
      openHeap.push({candScratch_[emitTo].f, current.g, current.cells,
                     current.tie, current.signature});
    } else {
      info.closed = true;
      nodeStore.erase(current.signature);
    }
  }

  if (verbose && result.alts.empty())
    std::cout << "DragSolver found no solution, expanded " << nodesExpanded
              << " nodes\n";
  finishStats();
  return finishResult(true);
}

std::vector<Turn>
DragSolver::reconstructTurns(const std::vector<DragMove> &drags) {
  std::vector<Position> anchors = initialAnchors_;
  std::vector<Turn> turns;
  for (const auto &drag : drags) {
    const Position from = anchors[drag.blockId];
    grid_.buildOccupancy(anchors);
    grid_.removeBlock(drag.blockId, from);
    grid_.floodFill(drag.blockId, from);
    if (!grid_.wasReached(drag.toIdx))
      return {};
    // Walk parent directions target -> start, then emit forward.
    std::vector<Direction> path;
    uint16_t cur = drag.toIdx;
    const uint16_t startIdx = grid_.anchorIndex(from);
    while (cur != startIdx) {
      const int8_t d = grid_.parentDirOf(cur);
      path.push_back(BitGrid::DIRS[d]);
      const Position p = grid_.anchorFromIndex(cur);
      cur = grid_.anchorIndex({static_cast<int8_t>(p.x - BitGrid::DX[d]),
                               static_cast<int8_t>(p.y - BitGrid::DY[d])});
    }
    std::reverse(path.begin(), path.end());
    for (const Direction dir : path)
      turns.push_back({drag.blockId, dir});
    anchors[drag.blockId] = grid_.anchorFromIndex(drag.toIdx);
  }
  return turns;
}

bool DragSolver::replayIsValid(const std::vector<Turn> &turns) const {
  std::vector<Position> anchors = initialAnchors_;
  // Fresh BitGrid so this stays const-correct wrt the scratch state.
  BitGrid grid(gridWidth_, gridHeight_, shapes_);
  grid.buildOccupancy(anchors);
  for (const auto &[blockId, direction] : turns) {
    if (blockId >= anchors.size())
      return false;
    const Position from = anchors[blockId];
    const int d = static_cast<int>(direction);
    const Position to = {static_cast<int8_t>(from.x + BitGrid::DX[d]),
                         static_cast<int8_t>(from.y + BitGrid::DY[d])};
    grid.removeBlock(blockId, from);
    if (!grid.canPlace(blockId, to.x, to.y))
      return false;
    grid.addBlock(blockId, to);
    anchors[blockId] = to;
  }
  const auto &g = anchors[goalIndex_];
  return g.x == goalAnchor_.x && g.y == goalAnchor_.y;
}

std::vector<Turn> DragSolver::searchAssembly(const uint32_t maxMs,
                                             const uint32_t maxNodes) {
  stats_ = {};
  if (gridWidth_ > 64 || unsolvableAtStart_)
    return {};
  if (isGoal(initialAnchors_))
    return {};
  // Pack-off-the-corridor pipeline (test41-class): needs real cut
  // bottlenecks — on 0-cut boards a perfect packing does not clear the
  // goal's path home, so decline instantly. (A "jam mode" that morphed the
  // board toward a caller-supplied goal-home arrangement was tried and
  // refuted by ground truth: jam solutions are non-monotone, so sequential
  // ratcheted placement cannot express them even given the true target.)
  if (middleCuts_ == 0)
    return {};
  if (!packingGuideActive_)
    return {};

  const uint64_t deadline = maxMs == 0 ? 0 : nowMs() + maxMs;
  const int H = gridHeight_;
  std::vector<Position> anchors = initialAnchors_;
  std::vector<Turn> plan;

  const auto slotPos = [&](const uint8_t p) {
    return Position{static_cast<int8_t>(packedSlot_[p] / H),
                    static_cast<int8_t>(packedSlot_[p] % H)};
  };
  const auto remainingMs = [&]() -> uint32_t {
    if (deadline == 0) return 0;
    const uint64_t now = nowMs();
    return now >= deadline ? 1 : static_cast<uint32_t>(deadline - now);
  };

  std::vector<uint8_t> pieces;
  for (const uint8_t b : movableBlockIndices_)
    if (b != goalIndex_ && packedSlot_[b] >= 0)
      pieces.push_back(b);

  // Relaxed approachability: with the goal parked and placed pieces frozen
  // on their slots (everything else removed), the piece's slot must connect
  // to its current anchor or to a decently sized free region.
  const auto approachable = [&](const uint8_t piece,
                                const std::vector<uint8_t> &placed) {
    grid_.clearOccupancy();
    grid_.addBlock(goalIndex_, anchors[goalIndex_]);
    for (const uint8_t p : placed)
      grid_.addBlock(p, slotPos(p));
    const auto &reached = grid_.floodFill(piece, slotPos(piece));
    if (reached.size() >= 40)
      return true;
    const auto cur =
        static_cast<uint16_t>(anchors[piece].x * H + anchors[piece].y);
    return grid_.wasReached(cur);
  };

  const uint32_t roundBudget =
      maxMs == 0 ? 120000 : std::max<uint32_t>(15000, maxMs / 12);
  // Per-packing attempt budget: a hostile packing must not eat the whole
  // run — when its order space (or slice of time) is exhausted, the packer
  // produces a structurally different packing and assembly starts over.
  const uint32_t perPackingMs =
      maxMs == 0 ? 300000 : std::max<uint32_t>(120000, maxMs / 4);

  // DFS over placement ORDER with chronological backtracking: each frame
  // snapshots the arrangement before a round, remembers which pieces it has
  // already tried, and is popped (undoing its placement) when every
  // candidate's subtree fails. A greedy order can seal a lane many rounds
  // before the wedge becomes visible — this explores reorderings instead of
  // giving up (the shiftingMosaicTest41 ordering lesson, in-engine).
  struct AsmFrame {
    std::vector<Position> anchors; // arrangement entering this round
    size_t planLen;                // plan length entering this round
    std::vector<uint8_t> placed;   // pieces placed (incl. incidental)
    std::vector<uint8_t> tried;    // pieces already attempted from here
    bool jointTried = false;       // endgame joint solve attempted here
  };
  const auto absorbOnSlot = [&](AsmFrame &f) {
    for (const uint8_t p : pieces) {
      if (std::find(f.placed.begin(), f.placed.end(), p) != f.placed.end())
        continue;
      if (f.anchors[p].x * H + f.anchors[p].y == packedSlot_[p])
        f.placed.push_back(p);
    }
  };
  constexpr uint32_t MAX_BACKTRACKS = 80;

  // Endgame ratchet-relaxation. When only a few pieces remain and no single
  // one can reach its slot through the frozen packing (the classic 18/19
  // seal), the final slot is reachable only if a piece already placed and
  // frozen temporarily vacates. This runs one small JOINT search over the
  // remaining pieces plus the last few placed (unfrozen so they can shuffle
  // aside), with requireAllSlots forcing everyone back onto their slots by
  // the end — dissolving a seal that no packing choice or order can.
  constexpr size_t ENDGAME_K = 3;   // trigger when within K of complete
  constexpr size_t UNFREEZE_K = 4;  // last-placed pieces to set movable
  const auto jointEndgame = [&](const AsmFrame &f,
                                const uint32_t budgetMs) -> std::vector<Turn> {
    std::vector<uint8_t> remaining;
    for (const uint8_t p : pieces)
      if (std::find(f.placed.begin(), f.placed.end(), p) == f.placed.end())
        remaining.push_back(p);
    if (remaining.empty())
      return {};
    std::vector<uint8_t> unfrozen = remaining;
    const size_t take = std::min<size_t>(UNFREEZE_K, f.placed.size());
    for (size_t i = 0; i < take; i++)
      unfrozen.push_back(f.placed[f.placed.size() - 1 - i]);
    std::vector<uint8_t> frozen;
    frozen.push_back(goalIndex_);
    for (const uint8_t p : f.placed)
      if (std::find(unfrozen.begin(), unfrozen.end(), p) == unfrozen.end())
        frozen.push_back(p);

    Config c;
    c.weight = 3;
    c.settledOnly = false; // threading needs floating intermediates
    c.partialExpansionWidth = 48;
    c.lockOnSlot = false;      // unfrozen placed may leave their slots...
    c.requireAllSlots = true;  // ...but all must return by the end
    c.slotHeuristic = true;
    c.packingGuide = false;
    c.postProcess = false;
    c.cancel = cfg_.cancel;
    c.frozenBlocks = frozen;
    DragSolver child(gridWidth_, gridHeight_, shapes_, f.anchors,
                     remaining.front(), slotPos(remaining.front()), c);
    child.overrideSlots(packedSlot_);
    const auto turns = child.search(budgetMs, maxNodes);
    stats_.nodesExpanded += child.lastStats().nodesExpanded;
    stats_.passes++;
    return turns;
  };

  const auto slotSig = [&] {
    uint64_t h = 14695981039346656037ULL;
    for (const int32_t s : packedSlot_) {
      h ^= static_cast<uint64_t>(static_cast<int64_t>(s)) +
           0x9e3779b97f4a7c15ULL;
      h *= 1099511628211ULL;
    }
    return h;
  };
  std::unordered_set<uint64_t> triedPackings{slotSig()};
  std::vector<std::pair<int, int>> variants; // (cellOrder, demoted block id)
  for (int co = 0; co < 4; co++)
    for (int di = -1; di < static_cast<int>(pieces.size()); di++) {
      if (co == 0 && di == -1)
        continue; // the constructor's packing, already tried first
      variants.push_back({co, di < 0 ? -1 : pieces[di]});
    }
  size_t nextVariant = 0;
  bool packedAll = false;

  for (;;) {
    const uint64_t packDeadline =
        deadline == 0 ? nowMs() + perPackingMs
                      : std::min(deadline, nowMs() + perPackingMs);
    plan.clear();
    anchors = initialAnchors_;
    std::vector<AsmFrame> stack;
    stack.push_back({anchors, 0, {}, {}, false});
    absorbOnSlot(stack.back());
    uint32_t backtracks = 0;
    uint32_t jointAttempts = 0;
    constexpr uint32_t MAX_JOINT = 6; // bound joint time per packing
    bool attemptOver = false;

    while (!stack.empty() && !attemptOver) {
      if (cfg_.cancel && cfg_.cancel->load(std::memory_order_relaxed))
        return {};
      if (deadline != 0 && nowMs() > deadline) {
        std::cout << "assembly: out of time with "
                  << stack.back().placed.size() << "/" << pieces.size()
                  << " placed\n";
        return {};
      }
      if (nowMs() > packDeadline) {
        std::cout << "assembly: packing attempt budget spent at "
                  << stack.back().placed.size() << "/" << pieces.size()
                  << "\n";
        break;
      }
    AsmFrame &cur = stack.back();
    if (cur.placed.size() >= pieces.size()) {
      anchors = cur.anchors;
      plan.resize(cur.planLen);
      packedAll = true;
      break;
    }
    std::vector<uint8_t> candidates;
    for (const uint8_t p : pieces) {
      if (std::find(cur.placed.begin(), cur.placed.end(), p) != cur.placed.end())
        continue;
      if (std::find(cur.tried.begin(), cur.tried.end(), p) != cur.tried.end())
        continue;
      // approachable() reads the member grid against a hypothetical
      // arrangement; make it see this frame's goal/piece positions.
      anchors = cur.anchors;
      if (!approachable(p, cur.placed))
        continue;
      candidates.push_back(p);
    }
    // Endgame seal: no single piece advances but we are near completion —
    // try the bounded joint relaxation before giving up on this frame.
    if (candidates.empty() && !cur.jointTried &&
        cur.placed.size() + ENDGAME_K >= pieces.size() &&
        cur.placed.size() < pieces.size() && jointAttempts < MAX_JOINT) {
      cur.jointTried = true;
      jointAttempts++;
      const uint64_t nowJoint = nowMs();
      const uint32_t packRem = packDeadline > nowJoint
                                   ? static_cast<uint32_t>(packDeadline - nowJoint)
                                   : 1;
      const uint32_t jointBudget = std::min<uint32_t>(packRem, 90000);
      std::cout << "assembly: joint endgame at " << cur.placed.size() << "/"
                << pieces.size() << "\n";
      const auto jturns = jointEndgame(cur, jointBudget);
      if (!jturns.empty()) {
        anchors = cur.anchors;
        for (const auto &t : jturns)
          anchors[t.blockId] = {
              static_cast<int8_t>(anchors[t.blockId].x +
                                  BitGrid::DX[static_cast<int>(t.direction)]),
              static_cast<int8_t>(anchors[t.blockId].y +
                                  BitGrid::DY[static_cast<int>(t.direction)])};
        plan.resize(cur.planLen);
        plan.insert(plan.end(), jturns.begin(), jturns.end());
        std::cout << "assembly: joint endgame SOLVED the packing ("
                  << jturns.size() << " turns)\n";
        packedAll = true;
        break;
      }
      continue; // still cur; candidates recomputed next iteration (empty →
                // backtrack, since jointTried now blocks a re-attempt)
    }
    if (candidates.empty()) {
      // Exhausted this frame: undo its placement and let the parent try a
      // different piece.
      stack.pop_back();
      backtracks++;
      if (!stack.empty())
        std::cout << "assembly: backtrack to " << stack.back().placed.size()
                  << "/" << pieces.size() << " placed\n";
      if (backtracks > MAX_BACKTRACKS) {
        std::cout << "assembly: backtrack limit for this packing\n";
        attemptOver = true;
      }
      continue;
    }
    // Deepest slot first (farthest from where the goal parks), then the
    // piece nearest its slot — back columns fill before they get sealed.
    std::sort(candidates.begin(), candidates.end(),
              [&](const uint8_t a, const uint8_t b) {
                const auto sa = slotPos(a), sb = slotPos(b);
                const int da = std::abs(sa.x - cur.anchors[goalIndex_].x) +
                               std::abs(sa.y - cur.anchors[goalIndex_].y);
                const int db = std::abs(sb.x - cur.anchors[goalIndex_].x) +
                               std::abs(sb.y - cur.anchors[goalIndex_].y);
                if (da != db) return da > db;
                const int la = std::abs(sa.x - cur.anchors[a].x) +
                               std::abs(sa.y - cur.anchors[a].y);
                const int lb = std::abs(sb.x - cur.anchors[b].x) +
                               std::abs(sb.y - cur.anchors[b].y);
                return la < lb;
              });
    const uint8_t piece = candidates.front();
    cur.tried.push_back(piece);

    Config c;
    c.weight = 4;
    c.settledOnly = true;
    c.partialExpansionWidth = 48;
    c.lockOnSlot = true;
    c.packingGuide = false; // slots injected below
    c.postProcess = false;
    c.cancel = cfg_.cancel;
    c.frozenBlocks = {goalIndex_};
    DragSolver child(gridWidth_, gridHeight_, shapes_, cur.anchors, piece,
                     slotPos(piece), c);
    child.overrideSlots(packedSlot_);
    const uint64_t nowChild = nowMs();
    const uint32_t packRem =
        packDeadline > nowChild
            ? static_cast<uint32_t>(packDeadline - nowChild)
            : 1;
    const uint32_t budget = std::min(roundBudget, packRem);
    const auto turns = child.search(budget, maxNodes);
    stats_.nodesExpanded += child.lastStats().nodesExpanded;
    stats_.passes++;
    if (turns.empty())
      continue; // same frame, next candidate on the following iteration

    AsmFrame next;
    next.anchors = cur.anchors;
    for (const auto &t : turns) {
      next.anchors[t.blockId].x = static_cast<int8_t>(
          next.anchors[t.blockId].x + BitGrid::DX[static_cast<int>(t.direction)]);
      next.anchors[t.blockId].y = static_cast<int8_t>(
          next.anchors[t.blockId].y + BitGrid::DY[static_cast<int>(t.direction)]);
    }
    plan.resize(cur.planLen);
    plan.insert(plan.end(), turns.begin(), turns.end());
    next.planLen = plan.size();
    next.placed = cur.placed;
    next.placed.push_back(piece);
    next.tried = {};
    absorbOnSlot(next);
    std::cout << "assembly: placed block " << static_cast<int>(piece) << " ("
              << turns.size() << " turns), " << next.placed.size() << "/"
              << pieces.size() << "\n";
      stack.push_back(std::move(next));
    }

    if (packedAll)
      break;
    if (deadline != 0 && nowMs() >= deadline) {
      std::cout << "assembly: out of time across packings\n";
      return {};
    }
    // This packing's order space (or time slice) is spent — move to a
    // structurally different packing and start assembly over.
    bool advanced = false;
    while (nextVariant < variants.size()) {
      const auto [co, dp] = variants[nextVariant++];
      if (!tryComputePacking(co, dp))
        continue;
      if (triedPackings.insert(slotSig()).second) {
        advanced = true;
        break;
      }
    }
    if (!advanced) {
      std::cout << "assembly: packing variants exhausted — giving up\n";
      return {};
    }
    std::cout << "assembly: retrying with alternative packing #"
              << triedPackings.size() << "\n";
  }

  // Everything packed: bring the goal home, ratcheting the packing (its
  // slots are off the corridor by construction).
  {
    Config c;
    c.weight = 3;
    c.settledOnly = true;
    c.partialExpansionWidth = 48;
    c.lockOnSlot = true;
    c.requireAllSlots = false;
    c.slotHeuristic = false;
    c.packingGuide = false;
    c.postProcess = false;
    c.cancel = cfg_.cancel;
    DragSolver finalLeg(gridWidth_, gridHeight_, shapes_, anchors, goalIndex_,
                        goalAnchor_, c);
    finalLeg.overrideSlots(packedSlot_);
    const auto turns = finalLeg.search(deadline == 0 ? 0 : remainingMs(),
                                       maxNodes);
    stats_.nodesExpanded += finalLeg.lastStats().nodesExpanded;
    stats_.passes++;
    if (turns.empty()) {
      std::cout << "assembly: final goal leg failed\n";
      return {};
    }
    plan.insert(plan.end(), turns.begin(), turns.end());
  }

  if (!replayIsValid(plan)) {
    std::cout << "assembly: composed plan failed validation\n";
    return {};
  }
  std::cout << "assembly: solved — " << plan.size() << " turns\n";
  if (cfg_.postProcess && !plan.empty()) {
    // Give the optimizer the race's cancel flag: once another arm has won,
    // polishing a plan nobody will use only delays every other arm's join.
    AStar::Config oc;
    oc.cancel = cfg_.cancel;
    AStar optimizer(gridWidth_, gridHeight_, shapes_, initialAnchors_,
                    goalIndex_, goalAnchor_, oc);
    const size_t beforeMoves = plan.size();
    plan = optimizer.optimizeSolution(plan);
    std::cout << "post-process: " << beforeMoves << " -> " << plan.size()
              << " moves\n";
  }
  return plan;
}

// Reconstructs unit turns from a full drag plan, validates by replay, and
// runs the shared optimizer. Empty result = reconstruction/validation failed.
std::vector<Turn> DragSolver::finalizePlan(const std::vector<DragMove> &drags) {
  std::vector<Turn> turns = reconstructTurns(drags);
  if (turns.empty() || !replayIsValid(turns)) {
    std::cout << "DragSolver: reconstruction failed validation\n";
    return {};
  }
  if (cfg_.postProcess) {
    // Give the optimizer the race's cancel flag: once another arm has won,
    // polishing a plan nobody will use only delays every other arm's join.
    AStar::Config oc;
    oc.cancel = cfg_.cancel;
    AStar optimizer(gridWidth_, gridHeight_, shapes_, initialAnchors_,
                    goalIndex_, goalAnchor_, oc);
    const size_t beforeMoves = turns.size();
    turns = optimizer.optimizeSolution(turns);
    std::cout << "post-process: " << beforeMoves << " -> " << turns.size()
              << " moves\n";
  }
  return turns;
}

std::vector<Turn> DragSolver::search(const uint32_t maxMs,
                                     const uint32_t maxNodes) {
  stats_ = {};
  if (gridWidth_ > 64) {
    std::cout << "DragSolver: grid wider than 64 — not supported\n";
    return {};
  }
  if (unsolvableAtStart_) {
    std::cout << "DragSolver short-circuit: a permanently-locked block sits "
                 "on the goal block's final footprint — unsolvable\n";
    return {};
  }
  if (isGoal(initialAnchors_))
    return {};

  const uint64_t deadline = maxMs == 0 ? 0 : nowMs() + maxMs;
  jamPinned_ = false;
  SegmentResult res;
  if (cfg_.relevantOnly) {
    // Iterative ring widening: a too-tight relevance filter exhausts its
    // little space in milliseconds — widen and retry until a solution, a
    // genuine budget miss, or the widest ring also drains.
    for (relevantRing_ = 1; relevantRing_ <= 4; relevantRing_++) {
      res = runAStarDrag(initialAnchors_, middleCuts_ + 1, nullptr, deadline,
                         maxNodes);
      if (res.found || !res.exhausted ||
          (deadline != 0 && nowMs() >= deadline))
        break;
      std::cout << "DragSolver: relevance ring " << int(relevantRing_)
                << " exhausted — widening\n";
    }
    relevantRing_ = 1;
  } else {
    res = runAStarDrag(initialAnchors_, middleCuts_ + 1, nullptr, deadline,
                       maxNodes);
  }
  if (!res.found)
    return {};
  std::vector<Turn> turns = finalizePlan(res.drags);

  // Symmetry canonicalization can, in rare corner cases, record a drag under
  // a block label that a later, cheaper path realizes differently. Replay
  // catches it; retry once with canonicalization off (slower, label-exact).
  if (turns.empty() && cfg_.canonicalizeSymmetry) {
    std::cout << "DragSolver: retrying without symmetry canonicalization\n";
    cfg_.canonicalizeSymmetry = false;
    res = runAStarDrag(initialAnchors_, middleCuts_ + 1, nullptr, deadline,
                       maxNodes);
    cfg_.canonicalizeSymmetry = true;
    if (res.found)
      turns = finalizePlan(res.drags);
  }
  return turns;
}

std::vector<Turn> DragSolver::searchJamRestarts(const uint32_t maxMs,
                                                const uint32_t maxNodes) {
  stats_ = {};
  if (gridWidth_ > 64) {
    std::cout << "DragSolver: grid wider than 64 — not supported\n";
    return {};
  }
  if (unsolvableAtStart_ || isGoal(initialAnchors_))
    return {};

  const uint64_t deadline = maxMs == 0 ? 0 : nowMs() + maxMs;
  // Round configs, ordered by expected value on jam boards. Node caps keep
  // each round's state map small (~a few hundred MB peak) and freed on
  // return — wasm-heap-safe by construction.
  struct Round {
    uint8_t weight;
    bool settled;
    uint16_t pea;
    uint8_t jamGuide;
    uint8_t jamPenalty;
    bool por;
    bool relevant;
    uint32_t nodeCap;
    bool pin = false;
  };
  // Leading rounds are the configs that cracked real jam boards in the
  // IIT-21 campaign: jamg8/w4 (seed 10276), jamg16/w6 (seed 4722), and the
  // guide-free flat round that rides the corridor-band gradient when the
  // caller constructed with corridorBands (seed 9164). The pinned rounds
  // freeze their start state's argmin route as a hard corridor — the
  // wide-board diversification (multiple competing routes destabilize the
  // plain guide).
  static constexpr Round ROUNDS[] = {
      {4, true, 64, 8, 4, false, false, 1500000},
      {6, true, 64, 16, 4, false, false, 1500000},
      {4, true, 64, 0, 4, false, false, 1500000},
      {4, true, 64, 8, 8, false, false, 1500000, true},
      {6, true, 64, 16, 8, false, false, 1500000},
      {4, true, 64, 8, 4, true, true, 1500000},
      {2, true, 64, 8, 32, false, false, 1000000, true},
      {3, false, 64, 8, 4, false, false, 1000000},
  };
  const Config saved = cfg_;

  // Elite pool: deepest credible partials (lowest jam term) from failed
  // rounds. Odd rounds warm-start from an elite's end state instead of the
  // root — successive rounds resume where the best prior round got stuck,
  // with a different config/seed, instead of re-treading the whole prefix.
  struct Elite {
    std::vector<Position> anchors;
    std::vector<DragMove> prefix;
    uint32_t jam;
  };
  const size_t MAX_ELITES = std::max<size_t>(1, cfg_.jamMaxElites);
  std::vector<Elite> elites;
  const auto applyDrags = [&](std::vector<Position> a,
                              const std::vector<DragMove> &drags) {
    for (const auto &m : drags)
      a[m.blockId] = grid_.anchorFromIndex(m.toIdx);
    return a;
  };

  std::vector<Turn> turns;
  uint32_t restarts = 0;
  for (uint32_t r = 0;; r++) {
    if (deadline != 0 && nowMs() >= deadline)
      break;
    if (cfg_.cancel && cfg_.cancel->load(std::memory_order_relaxed))
      break;
    if (maxNodes != 0 && stats_.nodesExpanded >= maxNodes)
      break;
    const Round &rc = ROUNDS[r % std::size(ROUNDS)];
    cfg_.weight = rc.weight;
    cfg_.settledOnly = rc.settled;
    cfg_.partialExpansionWidth = rc.pea;
    cfg_.jamGuideWeight = rc.jamGuide;
    cfg_.jamBlockerPenalty = rc.jamPenalty;
    cfg_.sleepSets = rc.por;
    cfg_.relevantOnly = rc.relevant;
    cfg_.jamPinRoute = rc.pin || saved.jamPinRoute;
    jamPinned_ = false; // each round pins its own start's route
    // Round 0 of each config keeps the deterministic tie-break; later cycles
    // jitter it so plateaus break differently every time around.
    cfg_.tieBreakSeed =
        r < std::size(ROUNDS) ? 0 : 0x9E3779B9u * r + 1;
    restarts++;
    uint32_t cap = rc.nodeCap;
    if (saved.jamRoundNodeCap != 0) {
      const uint64_t unit =
          saved.jamLubyRestarts ? DragSolver::lubyUnit(restarts) : 1;
      const uint64_t scaled =
          static_cast<uint64_t>(saved.jamRoundNodeCap) * unit;
      cap = static_cast<uint32_t>(
          std::min<uint64_t>(cap, std::max<uint64_t>(1, scaled)));
    }
    if (maxNodes != 0)
      cap = std::min<uint32_t>(cap, maxNodes - stats_.nodesExpanded);
    // Alternate root rounds and elite warm-starts (elite rounds need the
    // guide on to keep producing partials; force it for the bands round).
    const Elite *from = nullptr;
    if (!elites.empty() && (r & 1) != 0) {
      from = &elites[(r >> 1) % elites.size()];
      if (cfg_.jamGuideWeight == 0)
        cfg_.jamGuideWeight = 8;
    }
    // Ridge hopper: some elite rounds first take a few RANDOM drags from the
    // elite state before the guided search re-engages. Boards whose solution
    // crosses a dig-cost ridge (every gradient search walls at the same
    // term — the seed-8697 signature) need blind sideways moves the guide
    // would never rank; the elites keep the lottery anchored deep.
    std::vector<DragMove> pert;
    std::vector<Position> pertAnchors;
    if (from != nullptr) {
      const uint32_t hops = (r / 2) % 4 * 3; // 0,3,6,9 random drags
      if (hops > 0) {
        pertAnchors = from->anchors;
        uint32_t rng = 0x243F6A88u ^ (r * 0x9E3779B9u);
        const auto rnd = [&rng](const size_t n) {
          rng = rng * 1664525u + 1013904223u;
          return static_cast<size_t>((rng >> 8) % n);
        };
        for (uint32_t p = 0; p < hops; p++) {
          grid_.buildOccupancy(pertAnchors);
          const uint8_t b =
              movableBlockIndices_[rnd(movableBlockIndices_.size())];
          const Position fromP = pertAnchors[b];
          grid_.removeBlock(b, fromP);
          const auto &reached = grid_.floodFill(b, fromP);
          if (!reached.empty()) {
            const uint16_t to = reached[rnd(reached.size())];
            pertAnchors[b] = grid_.anchorFromIndex(to);
            pert.push_back({b, to});
          }
          grid_.addBlock(b, pertAnchors[b]);
        }
      }
    }
    const std::vector<Position> &startAnchors =
        !pert.empty() ? pertAnchors
        : from        ? from->anchors
                      : initialAnchors_;
    const SegmentResult res = runAStarDrag(startAnchors, middleCuts_ + 1,
                                           nullptr, deadline, cap);
    const auto stitched = [&](const std::vector<DragMove> &suffix) {
      std::vector<DragMove> full;
      if (from != nullptr)
        full = from->prefix;
      full.insert(full.end(), pert.begin(), pert.end());
      full.insert(full.end(), suffix.begin(), suffix.end());
      return full;
    };
    if (res.found) {
      turns = finalizePlan(stitched(res.drags));
      if (turns.empty() && cfg_.canonicalizeSymmetry) {
        std::cout << "DragSolver(jam): retrying without symmetry "
                     "canonicalization\n";
        cfg_.canonicalizeSymmetry = false;
        const SegmentResult res2 = runAStarDrag(startAnchors, middleCuts_ + 1,
                                                nullptr, deadline, cap);
        cfg_.canonicalizeSymmetry = true;
        if (res2.found)
          turns = finalizePlan(stitched(res2.drags));
      }
      if (!turns.empty())
        break;
    } else if (res.bestPartialJam != UINT32_MAX &&
               !res.bestPartialDrags.empty()) {
      // Bank this round's deepest partial as an elite (crude diversity: one
      // elite per jam value; prefixes capped against runaway stitching).
      Elite e{applyDrags(startAnchors, res.bestPartialDrags),
              stitched(res.bestPartialDrags), res.bestPartialJam};
      if (e.prefix.size() <= 220 &&
          std::none_of(elites.begin(), elites.end(), [&](const Elite &x) {
            return x.jam == e.jam;
          })) {
        elites.push_back(std::move(e));
        std::sort(elites.begin(), elites.end(),
                  [](const Elite &a, const Elite &b) { return a.jam < b.jam; });
        if (elites.size() > MAX_ELITES)
          elites.resize(MAX_ELITES);
        std::cout << "DragSolver(jam): elite banked (jam "
                  << elites.front().jam << ".." << elites.back().jam << ", "
                  << elites.size() << " in pool)\n";
      }
    }
  }
  cfg_ = saved;
  // Expose the deepest elite so a stalled board can be decomposed (the pool is
  // kept sorted by jam term, so front() is the deepest).
  if (!elites.empty()) {
    lastEliteAnchors_ = elites.front().anchors;
    lastElitePrefix_ = elites.front().prefix;
  }
  std::cout << "DragSolver(jam): " << restarts << " restart rounds, "
            << stats_.nodesExpanded << " total expansions, "
            << (turns.empty() ? "no solution" : "SOLVED");
  if (turns.empty() && !elites.empty())
    std::cout << " (deepest elite jam " << elites.front().jam << ", "
              << elites.front().prefix.size() << " drags)";
  std::cout << "\n";
  return turns;
}

std::vector<Turn> DragSolver::searchBeamJam(const uint32_t maxMs,
                                            const uint32_t maxNodes) {
  stats_ = {};
  if (gridWidth_ > 64) {
    std::cout << "DragSolver: grid wider than 64 — not supported\n";
    return {};
  }
  if (unsolvableAtStart_ || isGoal(initialAnchors_))
    return {};

  const uint64_t deadline = maxMs == 0 ? 0 : nowMs() + maxMs;
  const size_t nBlocks = shapes_.size();
  const uint32_t W =
      cfg_.beamWidth != 0
          ? cfg_.beamWidth
          : std::clamp<uint32_t>(
                static_cast<uint32_t>(gridWidth_) * gridHeight_ * 400, 20000,
                150000);
  constexpr size_t MAX_DEPTH = 72;

  // Arena of every kept state across the current round's layers; parent is a
  // global arena index (-1 for the root).
  struct BeamState {
    NodeKey key;
    int32_t parent;
    DragMove move;
  };
  // Candidate before selection. Bounded selection: the scratch vector is
  // truncated to the best W by nth_element whenever it hits 2W, so peak
  // memory stays ~2W regardless of branching.
  struct BeamCand {
    uint64_t score; // (jamTerm << 20 | h) low bits jittered — smaller = better
    NodeKey key;
    int32_t parent;
    DragMove move;
  };

  std::vector<BeamState> arena;
  std::vector<int32_t> layer; // arena indices of the current layer
  std::vector<BeamCand> cands;
  std::unordered_set<NodeKey, NodeKeyHash> visited;
  std::vector<Position> anchors(nBlocks);
  const auto anchorsOf = [&](const NodeKey &key,
                             std::vector<Position> &out) {
    const uint16_t *d = key.data();
    for (size_t i = 0; i < nBlocks; i++)
      out[i] = {static_cast<int8_t>(d[i] >> 8),
                static_cast<int8_t>(d[i] & 0xFF)};
  };

  std::vector<bool> frozen(nBlocks, false);
  for (const uint8_t b : cfg_.frozenBlocks) frozen[b] = true;

  std::vector<Turn> turns;
  uint32_t round = 0;
  const uint32_t savedSeed = cfg_.tieBreakSeed;
  const bool savedCanon = cfg_.canonicalizeSymmetry;
  const bool savedPin = cfg_.jamPinRoute;
  for (; turns.empty(); round++) {
    if (deadline != 0 && nowMs() >= deadline)
      break;
    if (cfg_.cancel && cfg_.cancel->load(std::memory_order_relaxed))
      break;
    if (maxNodes != 0 && stats_.nodesExpanded >= maxNodes)
      break;
    const uint32_t seed = savedSeed + round * 0x9E3779B9u;
    // Odd beam rounds pin the root route (wide-board diversification).
    cfg_.jamPinRoute = savedPin || (round & 1) != 0;
    jamPinned_ = false;
    const auto jitter = [&](const NodeKey &k) -> uint32_t {
      uint32_t x = seed;
      const uint16_t *d = k.data();
      for (size_t i = 0; i < nBlocks; i++)
        x = (x ^ d[i]) * 0x85EBCA6Bu;
      x ^= x >> 15;
      return x & 0x3FF;
    };

    arena.clear();
    layer.clear();
    visited.clear();
    const NodeKey rootKey = signatureFromAnchors(initialAnchors_);
    arena.push_back({rootKey, -1, {}});
    layer.push_back(0);
    visited.insert(rootKey);

    int32_t goalArena = -1;
    for (size_t depth = 0; depth < MAX_DEPTH && goalArena < 0 &&
                           !layer.empty();
         depth++) {
      if (deadline != 0 && nowMs() >= deadline)
        break;
      if (cfg_.cancel && cfg_.cancel->load(std::memory_order_relaxed))
        break;
      cands.clear();
      const auto keepBestW = [&] {
        if (cands.size() <= 2 * static_cast<size_t>(W))
          return;
        std::nth_element(cands.begin(), cands.begin() + W, cands.end(),
                         [](const BeamCand &a, const BeamCand &b) {
                           return a.score < b.score;
                         });
        cands.resize(W);
      };
      for (const int32_t ai : layer) {
        // Copy: arena may reallocate while children are appended later.
        const NodeKey parentKey = arena[ai].key;
        anchorsOf(parentKey, anchors);
        stats_.nodesExpanded++;
        if (onProgress && (stats_.nodesExpanded % 4096) == 0)
          onProgress(stats_.nodesExpanded);
        const uint32_t jamBase = computeJamField(anchors);
        if (jamBase < stats_.minJamTerm)
          stats_.minJamTerm = jamBase;
        const Position gPos = anchors[goalIndex_];
        const uint16_t gProg = progressIndex_[gPos.x * gridHeight_ + gPos.y];
        if (gProg > stats_.maxProgress)
          stats_.maxProgress = gProg;
        grid_.buildOccupancy(anchors);
        for (const uint8_t i : movableBlockIndices_) {
          if (frozen[i])
            continue;
          const Position from = anchors[i];
          const uint32_t jamOldOverlap =
              i != goalIndex_ ? cfg_.jamBlockerPenalty *
                                    blockCellsOnMask(i, from, jamSweepRows_)
                              : 0;
          grid_.removeBlock(i, from);
          const auto &reached = grid_.floodFill(i, from);
          stats_.floodFills++;
          for (const uint16_t toIdx : reached) {
            const Position t = grid_.anchorFromIndex(toIdx);
            NodeKey ck = childSignature(parentKey, i, from, t);
            if (visited.contains(ck))
              continue;
            uint32_t jamChild;
            uint32_t h;
            if (i == goalIndex_) {
              jamChild = std::min<uint32_t>(jamField_[toIdx], 1u << 19);
              h = t.x == goalAnchor_.x && t.y == goalAnchor_.y ? 0 : 1;
              if (h == 0) {
                // Goal reached: commit this child immediately.
                arena.push_back({std::move(ck), ai, {i, toIdx}});
                goalArena = static_cast<int32_t>(arena.size()) - 1;
                break;
              }
            } else {
              jamChild = std::min<uint32_t>(
                  jamBase - jamOldOverlap +
                      cfg_.jamBlockerPenalty *
                          blockCellsOnMask(i, t, jamSweepRows_),
                  1u << 19);
              h = 1;
            }
            const uint64_t score =
                (static_cast<uint64_t>(jamChild) << 14) |
                (static_cast<uint64_t>(h) << 10) | jitter(ck);
            cands.push_back({score, std::move(ck), ai, {i, toIdx}});
            keepBestW();
          }
          grid_.addBlock(i, from);
          if (goalArena >= 0)
            break;
        }
        if (goalArena >= 0)
          break;
      }
      if (goalArena >= 0)
        break;
      // Select the next layer: best W distinct candidates.
      if (cands.size() > W) {
        std::nth_element(cands.begin(), cands.begin() + W, cands.end(),
                         [](const BeamCand &a, const BeamCand &b) {
                           return a.score < b.score;
                         });
        cands.resize(W);
      }
      std::sort(cands.begin(), cands.end(),
                [](const BeamCand &a, const BeamCand &b) {
                  return a.score < b.score;
                });
      layer.clear();
      for (auto &c : cands) {
        if (!visited.insert(c.key).second)
          continue;
        arena.push_back({std::move(c.key), c.parent, c.move});
        layer.push_back(static_cast<int32_t>(arena.size()) - 1);
      }
    }

    if (goalArena >= 0) {
      std::vector<DragMove> drags;
      for (int32_t cur = goalArena; cur >= 0 && arena[cur].parent >= 0;
           cur = arena[cur].parent)
        drags.push_back(arena[cur].move);
      std::reverse(drags.begin(), drags.end());
      std::cout << "DragSolver(beam): round " << round << " found goal at "
                << drags.size() << " drags (beam " << W << ")\n";
      turns = finalizePlan(drags);
      if (turns.empty() && cfg_.canonicalizeSymmetry) {
        // Rare symmetry label mix-up (same as search()): replay caught an
        // inconsistent drag label. Rerun the remaining rounds label-exact.
        std::cout << "DragSolver(beam): symmetry label mix-up — continuing "
                     "without canonicalization\n";
        cfg_.canonicalizeSymmetry = false;
      }
    }
    stats_.passes++;
    stats_.statesStored += visited.size();
  }
  cfg_.canonicalizeSymmetry = savedCanon;
  cfg_.jamPinRoute = savedPin;
  std::cout << "DragSolver(beam): " << round << " rounds, "
            << stats_.nodesExpanded << " expansions, "
            << (turns.empty() ? "no solution" : "SOLVED") << "\n";
  return turns;
}

std::vector<Turn> DragSolver::searchHierarchical(const uint32_t maxMs,
                                                 const uint32_t maxNodes) {
  stats_ = {};
  if (gridWidth_ > 64) {
    std::cout << "DragSolver: grid wider than 64 — not supported\n";
    return {};
  }
  if (unsolvableAtStart_) {
    std::cout << "DragSolver(hier) short-circuit: unsolvable\n";
    return {};
  }
  if (isGoal(initialAnchors_))
    return {};
  // Corridor arm: only run when the synthetic bands actually fired. With
  // real cuts present this would just re-run plain hier, so decline instantly
  // and let the portfolio's hier arm cover it.
  if (cfg_.corridorBands && !corridorBandsActive_) {
    std::cout << "DragSolver(corridor): no bands synthesized — declining\n";
    return {};
  }

  const uint64_t deadline = maxMs == 0 ? 0 : nowMs() + maxMs;
  // Per-segment expansion budget: start small so doomed choices fail fast
  // and backtracking explores alternatives. Escalate PER STACK DEPTH — a
  // depth that keeps failing marks a structurally hard segment (a deep
  // multi-block dance), and it keeps its earned budget across the parking
  // alternatives that backtracking cycles through.
  constexpr uint32_t SEG_NODE_CAP = 120000;
  constexpr uint32_t SEG_NODE_CAP_MAX = 3840000;
  constexpr uint32_t MAX_BACKTRACKS = 3000;

  struct Frame {
    std::vector<Position> anchors;
    std::vector<DragMove> drags; // segment that produced this frame
    BannedSet banned;            // coarse keys of failed/consumed end states
    std::vector<SegmentAlt> alts; // prefetched alternative next-segments
    size_t nextAlt = 0;
    // Consecutive consolidation commits without cut progress leading here.
    // Bounded so micro-consolidations cannot stack into a bottomless spiral
    // (observed with small gains: thousands of frames oscillating at one
    // cut) — after the cap the next segment must advance the goal.
    uint8_t consolidationRun = 0;
  };
  constexpr uint8_t MAX_CONSOLIDATION_RUN = 6;
  std::vector<Frame> stack;
  stack.push_back({initialAnchors_, {}, {}, {}, 0, 0});
  // The consolidation check reads displacement fields before the first
  // segment search populates them; with the packing guide active they are
  // slot-seeded and segment-independent, so computing them once here is
  // both safe and sufficient.
  if (cfg_.consolidationGain != 0 && packingGuideActive_)
    computeDisplacementFields(0);
  std::vector<uint32_t> failsAtDepth;
  uint32_t backtracks = 0;
  uint32_t segments = 0;
  // One search prefetches several coarse-distinct segment ends; backtracking
  // then cycles through them without re-searching.
  constexpr uint8_t SEG_ALTERNATIVES = 8;

  while (!stack.empty()) {
    if (cfg_.cancel && cfg_.cancel->load(std::memory_order_relaxed)) {
      std::cout << "DragSolver(hier): cancelled after " << segments
                << " segments\n";
      return {};
    }
    if (deadline != 0 && nowMs() > deadline) {
      std::cout << "DragSolver(hier): out of time after " << segments
                << " segments, " << backtracks << " backtracks\n";
      return {};
    }
    if (maxNodes != 0 && stats_.nodesExpanded >= maxNodes) {
      std::cout << "DragSolver(hier): node budget exhausted\n";
      return {};
    }

    Frame &cur = stack.back();
    const uint32_t p = progressOf(cur.anchors);
    if (p >= middleCuts_ + 1) {
      std::vector<DragMove> all;
      for (const auto &f : stack)
        all.insert(all.end(), f.drags.begin(), f.drags.end());
      std::cout << "DragSolver(hier): solved — " << all.size() << " drags, "
                << segments << " segments, " << backtracks
                << " backtracks, " << stats_.nodesExpanded
                << " nodes total\n";
      return finalizePlan(all);
    }

    const size_t depth = stack.size() - 1;
    // Consume a prefetched alternative before paying for any new search.
    if (cur.nextAlt < cur.alts.size()) {
      SegmentAlt &alt = cur.alts[cur.nextAlt++];
      segments++;
      const uint32_t altP = progressOf(alt.endAnchors);
      std::cout << "hier[d=" << depth << "] p=" << p << "->" << altP << " +"
                << alt.drags.size() << " drags (alt " << cur.nextAlt << "/"
                << cur.alts.size() << ")\n";
      const uint8_t run =
          altP > p ? 0 : static_cast<uint8_t>(cur.consolidationRun + 1);
      stack.push_back(
          {std::move(alt.endAnchors), std::move(alt.drags), {}, {}, 0, run});
      continue;
    }
    if (failsAtDepth.size() <= depth)
      failsAtDepth.resize(depth + 1, 0);
    // Exponential settled-first escalation: hard segments earn deep budgets
    // quickly; the settled filter is dropped only late (its branching cut is
    // what makes deep intra-segment dances findable at all).
    const uint32_t cap = std::min(
        SEG_NODE_CAP << std::min(failsAtDepth[depth], 5u), SEG_NODE_CAP_MAX);
    const uint32_t nodesBefore = stats_.nodesExpanded;
    const bool relaxSettled = cfg_.settledOnly && failsAtDepth[depth] >= 5;
    if (relaxSettled)
      cfg_.settledOnly = false;
    // With the packing guide active, also accept "consolidation" ends: no
    // cut progress, but the packing measurably closer to its final slots.
    // Field note: with the guide on, dispField_ is slot-seeded and thus
    // identical across segments, so comparing sums across calls is sound.
    uint32_t consolidationBelow = 0;
    if (cfg_.consolidationGain != 0 && packingGuideActive_ &&
        cur.consolidationRun < MAX_CONSOLIDATION_RUN) {
      const uint32_t curDisp = displacementSum(cur.anchors);
      if (curDisp > cfg_.consolidationGain)
        consolidationBelow = curDisp - cfg_.consolidationGain;
    }
    SegmentResult res =
        runAStarDrag(cur.anchors, p + 1, &cur.banned, deadline, cap,
                     SEG_ALTERNATIVES, consolidationBelow);
    if (relaxSettled)
      cfg_.settledOnly = true;
    if (res.found) {
      std::cout << "hier[d=" << depth << "] p=" << p << ": "
                << res.alts.size() << " segment ends ("
                << (stats_.nodesExpanded - nodesBefore) << " nodes)\n";
      // Ban all prefetched ends now so an eventual re-search here explores
      // genuinely new territory.
      for (const auto &a : res.alts)
        cur.banned.insert(coarseSignature(a.endAnchors));
      cur.alts = std::move(res.alts);
      cur.nextAlt = 0;
      continue;
    }
    std::cout << "hier[d=" << depth << "] p=" << p << " FAIL (cap=" << cap
              << (relaxSettled ? ", unsettled" : "")
              << (res.exhausted ? ", exhausted" : "") << ")\n";
    failsAtDepth[depth]++;
    backtracks++;
    if (backtracks > MAX_BACKTRACKS) {
      std::cout << "DragSolver(hier): backtrack limit reached\n";
      return {};
    }
    if (stack.size() == 1) {
      // Root segment: nothing to pop. A genuine exhaustion without the
      // settled restriction and with no banned ends means the puzzle has no
      // solution in the drag model — but ONLY when the segment search was
      // complete: the relevance filter is incomplete by design, so under it
      // exhaustion proves nothing (a jam fixture drained 828 filtered
      // states this way and was wrongly declared unsolvable).
      if (res.exhausted && cur.banned.empty() && !cfg_.relevantOnly &&
          (!cfg_.settledOnly || relaxSettled)) {
        std::cout << "DragSolver(hier): root exhausted — unsolvable\n";
        return {};
      }
      if (res.exhausted && cfg_.relevantOnly) {
        // The filtered space is drained — retrying with a bigger cap cannot
        // help. Give up as a budget-style failure, not an unsolvable proof.
        std::cout << "DragSolver(hier): relevance-filtered space exhausted "
                     "— giving up (not an unsolvability proof)\n";
        return {};
      }
      continue;
    }
    // Retire this frame's end choice (and its whole coarse parking region)
    // and try the next-best end from the previous frame.
    const Frame failed = std::move(stack.back());
    stack.pop_back();
    stack.back().banned.insert(coarseSignature(failed.anchors));
    // Persistent failure at one depth means sibling ends are all doomed the
    // same way — the fatal choice was made earlier. Jump well back instead
    // of grinding through near-identical alternatives; keep half the earned
    // escalation so a return to this depth resumes with a deep budget.
    if (failsAtDepth[depth] >= 6 && stack.size() > 1) {
      const size_t jump = std::min<size_t>(8, stack.size() - 1);
      for (size_t j = 0; j < jump; j++) {
        const Frame f2 = std::move(stack.back());
        stack.pop_back();
        if (!stack.empty())
          stack.back().banned.insert(coarseSignature(f2.anchors));
      }
      failsAtDepth[depth] /= 2;
      std::cout << "hier: backjump " << jump << " frames from d=" << depth
                << "\n";
    }
  }
  std::cout << "DragSolver(hier): search space exhausted, no solution\n";
  return {};
}
