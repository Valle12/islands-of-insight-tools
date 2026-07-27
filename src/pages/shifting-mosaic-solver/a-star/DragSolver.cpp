// DragSolver: construction, final-packing search and cut-schedule analysis.
// The board-shaping half of the solver — everything here runs once per
// DragSolver instance, before any search does. The search itself lives in
// DragSolverSearch.cpp; the portfolio entry points in DragSolverArms.cpp and
// DragSolverAssembly.cpp; the per-node cost functions in
// DragSolverHeuristics.cpp.

#include "DragSolver.h"

#include <algorithm>
#include <bit>
#include <cstdlib>
#include <functional>
#include <iostream>
#include <ranges>
#include <string>
#include <unordered_map>

DragSolver::DragSolver(const uint8_t gridWidth, const uint8_t gridHeight,
                       std::vector<std::vector<Position>> shapes,
                       std::vector<Position> initialAnchors,
                       const uint8_t goalIndex, const Position goalAnchor,
                       Config config)
    : gridWidth_(gridWidth), gridHeight_(gridHeight),
      shapes_(std::move(shapes)), initialAnchors_(std::move(initialAnchors)),
      goalIndex_(goalIndex), goalAnchor_(goalAnchor), cfg_(std::move(config)),
      grid_(gridWidth, gridHeight, shapes_) {
  // Same-shape symmetry groups (mirrors AStar's construction).
  {
    std::unordered_map<std::string, std::vector<uint8_t>> byShape;
    for (size_t i = 0; i < shapes_.size(); i++) {
      if (i == goalIndex_)
        continue;
      std::vector<Position> cells = shapes_[i];
      // See AStar's copy of this loop: an empty shape has no origin to
      // normalise against, and cells[0] on it is undefined behaviour.
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
    for (auto &group : byShape | std::views::values)
      if (group.size() >= 2)
        symmetryGroups_.push_back(std::move(group));
  }
  blockGroup_.assign(shapes_.size(), -1);
  for (size_t g = 0; g < symmetryGroups_.size(); g++)
    for (const uint8_t member : symmetryGroups_[g])
      blockGroup_[member] = static_cast<int16_t>(g);

  goalFinalRows_.assign(gridHeight_, 0);
  for (const auto &[cx, cy] : shapes_[goalIndex_])
    goalFinalRows_[goalAnchor_.y + cy] |=
        uint64_t{1} << static_cast<unsigned>(goalAnchor_.x + cx);

  const auto movableFromStart = computeMovableSet(initialAnchors_);
  movableBlockIndices_.reserve(shapes_.size());
  for (size_t i = 0; i < shapes_.size(); i++) {
    if (movableFromStart[i] || i == goalIndex_) {
      movableBlockIndices_.push_back(static_cast<uint8_t>(i));
    } else if (blockOnGoalFootprint(static_cast<uint8_t>(i),
                                    initialAnchors_[i])) {
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
  const auto &sweep = cutSuffixRows_[0];

  std::vector<uint8_t> allowed(total, 0);
  std::vector<uint16_t> cellList;
  for (int x = 0; x < gridWidth_; x++)
    for (int y = 0; y < H; y++) {
      if (const uint64_t bit = uint64_t{1} << static_cast<unsigned>(x);
          lockedRows[y] & bit || sweep[y] & bit)
        continue;
      allowed[x * H + y] = 1;
      cellList.push_back(static_cast<uint16_t>(x * H + y));
    }
  // First-empty-cell scan order — the main packing-shape lever.
  switch (static_cast<unsigned>(cellOrderVariant) & 3u) {
  case 0:
    std::ranges::sort(cellList);
    break;
  case 1:
    std::ranges::sort(cellList, std::greater());
    break;
  case 2:
    std::ranges::sort(cellList, [H](const uint16_t a, const uint16_t b) {
      const int ya = a % H;
      const int yb = b % H;
      return ya != yb ? ya < yb : a < b;
    });
    break;
  default:
    std::ranges::sort(cellList, [H](const uint16_t a, const uint16_t b) {
      const int ya = a % H;
      const int yb = b % H;
      return ya != yb ? ya > yb : a < b;
    });
    break;
  }

  std::vector<uint8_t> pieces;
  size_t pieceCells = 0;
  for (const uint8_t i : movableBlockIndices_) {
    if (i == goalIndex_)
      continue;
    pieces.push_back(i);
    pieceCells += shapes_[i].size();
  }
  std::ranges::sort(pieces, [&](const uint8_t a, const uint8_t b) {
    return shapes_[a].size() > shapes_[b].size();
  });
  if (demotedPiece >= 0) {
    // Demote one piece to last choice everywhere — steers the DFS into a
    // structurally different packing.
    const auto it =
        std::ranges::find(pieces, static_cast<uint8_t>(demotedPiece));
    if (it != pieces.end()) {
      pieces.erase(it);
      pieces.push_back(static_cast<uint8_t>(demotedPiece));
    }
  }
  if (pieces.empty() || pieceCells > cellList.size())
    return false;
  auto holeBudget = static_cast<int>(cellList.size() - pieceCells);

  std::vector<uint8_t> occ(total, 0);
  std::vector used(pieces.size(), false);
  std::vector anchorOf(pieces.size(), -1);
  uint32_t nodes = 0;
  constexpr uint32_t PACK_NODE_CAP = 5000000;

  const auto canPlaceAt = [&](const uint8_t id, const int ax, const int ay) {
    for (const auto &[cx, cy] : shapes_[id]) {
      const int x = ax + cx;
      const int y = ay + cy;
      if (x < 0 || y < 0 || x >= gridWidth_ || y >= H)
        return false;
      if (const int idx = x * H + y; !allowed[idx] || occ[idx])
        return false;
    }
    return true;
  };
  const auto setCells = [&](const uint8_t id, const int ax, const int ay,
                            const uint8_t v) {
    for (const auto &[cx, cy] : shapes_[id])
      occ[(ax + cx) * H + (ay + cy)] = v;
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
      if (used[pi])
        continue;
      for (const uint8_t id = pieces[pi];
           const auto &[coverX, coverY] : shapes_[id]) {
        const int ax = tx - coverX;
        const int ay = ty - coverY;
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
    std::vector taken(slots.size(), false);
    for (const uint8_t m : members) {
      int best = -1;
      int bestDist = INT32_MAX;
      for (size_t s = 0; s < slots.size(); s++) {
        if (taken[s])
          continue;
        const int dx = std::abs(initialAnchors_[m].x - slots[s] / H);
        if (const int dy = std::abs(initialAnchors_[m].y - slots[s] % H);
            dx + dy < bestDist) {
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
  const auto &[startX, startY] = initialAnchors_[gi];
  if (startX == goalAnchor_.x && startY == goalAnchor_.y)
    return;

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

  const int maxX = gridWidth_ - grid_.boxWidth(gi);
  const int maxY = gridHeight_ - grid_.boxHeight(gi);
  const auto validAnchor = [&](const int x, const int y) {
    if (x < 0 || y < 0 || x > maxX || y > maxY)
      return false;
    const auto &rows = grid_.shapeRows(gi);
    for (size_t r = 0; r < rows.size(); r++)
      if (rows[r] << static_cast<unsigned>(x) & lockedRows[y + r])
        return false;
    return true;
  };

  const int H = gridHeight_;
  const auto startIdx = static_cast<uint16_t>(startX * H + startY);
  const auto targetIdx =
      static_cast<uint16_t>(goalAnchor_.x * H + goalAnchor_.y);

  // BFS over valid anchors from `source`, skipping `banned` (-1 = none).
  // Fills `seen` completely; optionally records parents.
  std::vector parent(totalAnchors, -1);
  std::vector<bool> seen;
  const auto bfsFrom = [&](const uint16_t source, const int32_t banned,
                           const bool track) {
    seen.assign(totalAnchors, false);
    std::vector<uint16_t> queue;
    queue.reserve(totalAnchors);
    seen[source] = true;
    if (track)
      parent[source] = -1;
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
        if (track)
          parent[nIdx] = cur;
        queue.push_back(nIdx);
      }
    }
  };

  bfsFrom(startIdx, -1, true);
  if (!validAnchor(startX, startY) || !seen[targetIdx]) {
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
  std::ranges::reverse(path);

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
    std::vector dist(totalAnchors, -1);
    std::vector q{targetIdx};
    dist[targetIdx] = 0;
    for (size_t head = 0; head < q.size(); head++) {
      const uint16_t c = q[head];
      const int cx = c / H;
      const int cy = c % H;
      for (int d = 0; d < 4; d++) {
        const int nx = cx + BitGrid::DX[d];
        const int ny = cy + BitGrid::DY[d];
        if (!validAnchor(nx, ny))
          continue;
        const auto n = static_cast<uint16_t>(nx * H + ny);
        if (dist[n] != -1)
          continue;
        dist[n] = dist[c] + 1;
        q.push_back(n);
      }
    }
    if (const int D = dist[startIdx]; D > 0) {
      const int numBands = std::clamp(D, 4, 20);
      const int bandWidth = (D + numBands - 1) / numBands; // ceil
      for (int a = 0; a < totalAnchors; a++) {
        if (dist[a] < 0) {
          progressIndex_[a] = 0;
          continue;
        }
        const int b = (D - dist[a]) / bandWidth;
        progressIndex_[a] = static_cast<uint16_t>(std::clamp(b, 0, numBands));
      }
      // One waypoint per band: the first path anchor reaching that band.
      int nextBand = 1;
      for (const uint16_t v : path) {
        if (v == startIdx)
          continue;
        while (nextBand <= numBands &&
               progressIndex_[v] >= static_cast<uint16_t>(nextBand)) {
          cuts.push_back(v);
          nextBand++;
        }
        if (nextBand > numBands)
          break;
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
    for (size_t r = 0; r < rows.size(); r++)
      acc[vy + r] |= rows[r] << static_cast<unsigned>(vx);
    cutSuffixRows_[i] = acc;
  }
  std::cout << "DragSolver: cut schedule — " << (k - 1) << " of "
            << path.size() - 2 << " middle path anchors are cuts\n";
}

bool DragSolver::jamProfile() const {
  if (middleCuts_ != 0 && !corridorBandsActive_)
    return false; // real cuts → hier/assembly territory
  const int lo = std::min(gridWidth_, gridHeight_);
  // too thin → corridor territory
  if (const int hi = std::max(gridWidth_, gridHeight_);
      hi * 16 > lo * cfg_.jamAspect16)
    return false;
  size_t cells = 0;
  for (const auto &s : shapes_)
    cells += s.size();
  return cells * 100 >=
         static_cast<size_t>(gridWidth_) * gridHeight_ * cfg_.jamDensityPct;
}

bool DragSolver::blockOnMask(const uint8_t i, const Position a,
                             const std::vector<uint64_t> &mask) const {
  const auto &rows = grid_.shapeRows(i);
  for (size_t r = 0; r < rows.size(); r++)
    if (rows[r] << static_cast<unsigned>(a.x) & mask[a.y + r])
      return true;
  return false;
}

bool DragSolver::blockOnGoalFootprint(const uint8_t i, const Position a) const {
  return blockOnMask(i, a, goalFinalRows_);
}

uint32_t DragSolver::blockCellsOnMask(const uint8_t i, const Position a,
                                      const std::vector<uint64_t> &mask) const {
  const auto &rows = grid_.shapeRows(i);
  uint32_t n = 0;
  for (size_t r = 0; r < rows.size(); r++)
    n += static_cast<uint32_t>(
        std::popcount(rows[r] << static_cast<unsigned>(a.x) & mask[a.y + r]));
  return n;
}
