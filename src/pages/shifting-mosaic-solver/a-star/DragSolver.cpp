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
#include <string_view>
#include <unordered_map>

namespace {
// Transparent, so a lookup can take a string_view without first materialising
// a std::string (cpp:S6045 wants an associative string container to say so).
// The grouping below only ever inserts owned keys, so nothing exploits it
// today — declaring it costs nothing and stops the container being the odd one
// out.
struct TransparentStringHash {
  using is_transparent = void;
  [[nodiscard]] size_t operator()(const std::string_view s) const noexcept {
    return std::hash<std::string_view>{}(s);
  }
};

// Scratch for the anchor-graph BFS below: which anchors were reached, and (when
// asked) how. One struct so the walk can be a function taking six arguments
// rather than eight (cpp:S107).
struct AnchorWalk {
  std::vector<int32_t> parent;
  std::vector<bool> seen;
};

// BFS over legal goal-block anchors from `source`, skipping `banned` (-1 =
// none). Fills `walk.seen` completely; optionally records parents.
//
// Templated on the predicate so it stays a plain lambda at the call site — it
// closes over the locked-row masks, which have no business in the header.
template <typename ValidAnchor>
void bfsAnchors(const ValidAnchor &validAnchor, AnchorWalk &walk,
                const uint16_t source, const int32_t banned, const bool track,
                const int H) {
  const auto totalAnchors = static_cast<int>(walk.parent.size());
  walk.seen.assign(totalAnchors, false);
  std::vector<uint16_t> queue;
  queue.reserve(totalAnchors);
  walk.seen[source] = true;
  if (track)
    walk.parent[source] = -1;
  queue.push_back(source);
  // A `while`, not a `for`: the body push_back()s into `queue`, so the stop
  // condition tests state the body writes. That trips S886 in a for-header and
  // a range-for over it would be undefined behaviour outright.
  size_t head = 0;
  while (head < queue.size()) {
    const uint16_t cur = queue[head++];
    const int cx = cur / H;
    const int cy = cur % H;
    for (int d = 0; d < 4; d++) {
      const int nx = cx + BitGrid::DX[d];
      const int ny = cy + BitGrid::DY[d];
      if (!validAnchor(nx, ny))
        continue;
      const auto nIdx = static_cast<uint16_t>(nx * H + ny);
      if (walk.seen[nIdx] || static_cast<int32_t>(nIdx) == banned)
        continue;
      walk.seen[nIdx] = true;
      if (track)
        walk.parent[nIdx] = cur;
      queue.push_back(nIdx);
    }
  }
}

// BFS distance from `target` to every anchor, -1 where unreachable. Separate
// from bfsAnchors because it carries distances rather than a parent tree.
template <typename ValidAnchor>
std::vector<int> anchorDistances(const ValidAnchor &validAnchor,
                                 const uint16_t target, const int H,
                                 const int totalAnchors) {
  std::vector dist(totalAnchors, -1);
  std::vector q{target};
  dist[target] = 0;
  // Same worklist shape as bfsAnchors — see the note there.
  size_t head = 0;
  while (head < q.size()) {
    const uint16_t c = q[head++];
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
  return dist;
}

// Turns those distances into progress bands, and lays one waypoint pseudo-cut
// per band along the shortest path. Returns whether any waypoint was laid.
//
// progressOf then rises as the goal advances, so hier can subgoal "push the
// goal one band closer" instead of solving the whole corridor at once. These
// pseudo-cuts are guidance, not constraints.
inline bool layBandWaypoints(const std::vector<int> &dist,
                             const uint16_t startIdx,
                             const std::vector<uint16_t> &path,
                             std::vector<uint16_t> &progressIndex,
                             std::vector<uint16_t> &cuts) {
  const int D = dist[startIdx];
  if (D <= 0)
    return false;
  const int numBands = std::clamp(D, 4, 20);
  const int bandWidth = (D + numBands - 1) / numBands; // ceil
  for (size_t a = 0; a < dist.size(); a++) {
    if (dist[a] < 0) {
      progressIndex[a] = 0;
      continue;
    }
    const int b = (D - dist[a]) / bandWidth;
    progressIndex[a] = static_cast<uint16_t>(std::clamp(b, 0, numBands));
  }
  // One waypoint per band: the first path anchor reaching that band.
  int nextBand = 1;
  for (const uint16_t v : path) {
    if (v == startIdx)
      continue;
    while (nextBand <= numBands &&
           progressIndex[v] >= static_cast<uint16_t>(nextBand)) {
      cuts.push_back(v);
      nextBand++;
    }
    if (nextBand > numBands)
      break;
  }
  return !cuts.empty();
}


// The exhaustive off-sweep packer.
//
// A struct rather than a recursive std::function closing over nine locals by
// reference: that shape is what made tryComputePacking the most complex
// function in the tree (cpp:S3776) and its body the longest lambda
// (cpp:S1188). The members are exactly the old captures.
struct Packer {
  const std::vector<std::vector<Position>> &shapes;
  const std::vector<uint8_t> &pieces;
  const std::vector<uint16_t> &cellList;
  const std::vector<uint8_t> &allowed;
  std::vector<uint8_t> occ;
  std::vector<bool> used;
  std::vector<int32_t> anchorOf;
  int gridWidth = 0;
  int H = 0;
  int holeBudget = 0;
  uint32_t nodes = 0;

  static constexpr uint32_t kNodeCap = 5000000;

  [[nodiscard]] bool canPlaceAt(const uint8_t id, const int ax,
                                const int ay) const {
    return std::ranges::all_of(shapes[id], [&](const Position &cell) {
      const int x = ax + cell.x;
      const int y = ay + cell.y;
      if (x < 0 || y < 0 || x >= gridWidth || y >= H)
        return false;
      const int idx = x * H + y;
      return allowed[idx] != 0 && occ[idx] == 0;
    });
  }

  void setCells(const uint8_t id, const int ax, const int ay,
                const uint8_t v) {
    for (const auto &[cx, cy] : shapes[id])
      occ[(ax + cx) * H + (ay + cy)] = v;
  }

  // Every placement of piece `pi` that covers the target cell, recursing into
  // each. Split from dfs so neither nests deeper than three (cpp:S134).
  bool placePieceOver(const size_t pi, const int tx, const int ty,
                      const size_t r) {
    for (const uint8_t id = pieces[pi];
         const auto &[coverX, coverY] : shapes[id]) {
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
      if (nodes > kNodeCap)
        return false;
    }
    return false;
  }

  bool dfs(const size_t fromRank) {
    if (++nodes > kNodeCap)
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
      if (placePieceOver(pi, tx, ty, r))
        return true;
      // Re-checked here, not only on entry: the old single-function form
      // returned straight out of the piece loop when the cap tripped, and
      // without this the split one would keep trying further pieces.
      if (nodes > kNodeCap)
        return false;
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
  }
};

} // namespace

// Same-shape symmetry groups (mirrors AStar's construction).
void DragSolver::buildSymmetryGroups() {
  std::unordered_map<std::string, std::vector<uint8_t>,
                     TransparentStringHash, std::equal_to<>>
      byShape;
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

  blockGroup_.assign(shapes_.size(), -1);
  for (size_t g = 0; g < symmetryGroups_.size(); g++)
    for (const uint8_t member : symmetryGroups_[g])
      blockGroup_[member] = static_cast<int16_t>(g);
}

DragSolver::DragSolver(const uint8_t gridWidth, const uint8_t gridHeight,
                       std::vector<std::vector<Position>> shapes,
                       std::vector<Position> initialAnchors,
                       const uint8_t goalIndex, const Position goalAnchor,
                       Config config)
    : gridWidth_(gridWidth), gridHeight_(gridHeight),
      shapes_(std::move(shapes)), initialAnchors_(std::move(initialAnchors)),
      goalIndex_(goalIndex), goalAnchor_(goalAnchor), cfg_(std::move(config)),
      grid_(gridWidth, gridHeight, shapes_) {
  buildSymmetryGroups();

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
// Row bitmask, per grid row, of every cell held by a block that can never
// move. Both callers below want exactly this; it was written out twice.
std::vector<uint64_t> DragSolver::buildLockedRows() const {
  std::vector<uint64_t> lockedRows(gridHeight_, 0);
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
  return lockedRows;
}

void DragSolver::computeFinalPacking() {
  packedSlot_.assign(shapes_.size(), -1);
  packingGuideActive_ = false;
  if (!cfg_.packing.guide || unsolvableAtStart_ || cutSuffixRows_.empty())
    return;
  tryComputePacking(0, -1);
}

// The cells a packing may use — everything neither locked nor on the goal's
// final sweep — in the scan order `cellOrderVariant` selects. That order is the
// main lever on packing shape, which is why the caller varies it.
//
// The four orders are WALKED rather than sorted into place, which is exactly
// equivalent and drops two sorts. A flat index is `x * H + y`, so the
// column-major walk already emits strictly ascending indices (variant 0) and
// variant 1 is that same list reversed; the row-major walks put the rows in
// order by construction, with x ascending inside a row supplying the ascending-
// index tie-break the old comparators spelled out. It is also why nothing here
// recovers y with `index % H` any more — Sonar reads that modulo as a possible
// division by zero, since it cannot prove `gridHeight_ != 0`, and the walk
// never needed it.
std::vector<uint16_t>
DragSolver::buildPackCells(const std::vector<uint64_t> &lockedRows,
                           const std::vector<uint64_t> &sweep,
                           const int cellOrderVariant,
                           std::vector<uint8_t> &allowed) const {
  const int H = gridHeight_;
  std::vector<uint16_t> cellList;

  // `allowed` is a flag set and so is order-independent; only `cellList`
  // carries the scan order, which is the whole of what the variants differ in.
  const auto take = [&lockedRows, &sweep, &allowed, &cellList,
                     H](const int x, const int y) {
    if (const uint64_t bit = uint64_t{1} << static_cast<unsigned>(x);
        lockedRows[y] & bit || sweep[y] & bit)
      return;
    allowed[x * H + y] = 1;
    cellList.push_back(static_cast<uint16_t>(x * H + y));
  };

  const unsigned variant = static_cast<unsigned>(cellOrderVariant) & 3u;
  if (variant >= 2) {
    for (int r = 0; r < H; r++) {
      const int y = variant == 2 ? r : H - 1 - r; // top-down, else bottom-up
      for (int x = 0; x < gridWidth_; x++)
        take(x, y);
    }
    return cellList;
  }
  for (int x = 0; x < gridWidth_; x++)
    for (int y = 0; y < H; y++)
      take(x, y);
  if (variant == 1)
    std::ranges::reverse(cellList);
  return cellList;
}

// The movable non-goal blocks, largest first, with `demotedPiece` (if given)
// pushed to last choice everywhere — the other lever on packing shape, since
// it steers the DFS into a structurally different packing.
std::vector<uint8_t> DragSolver::orderPackPieces(const int demotedPiece) const {
  std::vector<uint8_t> pieces;
  for (const uint8_t i : movableBlockIndices_)
    if (i != goalIndex_)
      pieces.push_back(i);
  std::ranges::sort(pieces, [&](const uint8_t a, const uint8_t b) {
    return shapes_[a].size() > shapes_[b].size();
  });
  if (demotedPiece >= 0) {
    const auto it =
        std::ranges::find(pieces, static_cast<uint8_t>(demotedPiece));
    if (it != pieces.end()) {
      pieces.erase(it);
      pieces.push_back(static_cast<uint8_t>(demotedPiece));
    }
  }
  return pieces;
}

// Same-shape blocks are interchangeable: greedily reassign each group's slots
// to minimise summed start-to-slot Manhattan distance.
void DragSolver::reassignSymmetrySlots(const int H) {
  for (const auto &group : symmetryGroups_) {
    std::vector<uint8_t> members;
    std::vector<int32_t> slots;
    for (const uint8_t m : group)
      if (packedSlot_[m] >= 0) {
        members.push_back(m);
        slots.push_back(packedSlot_[m]);
      }
    std::vector taken(slots.size(), false);
    for (const uint8_t m : members)
      claimNearestSlot(m, H, slots, taken);
  }
}

// The one greedy pick, lifted out so the loop above stays three deep
// (cpp:S134).
void DragSolver::claimNearestSlot(const uint8_t member, const int H,
                                  const std::vector<int32_t> &slots,
                                  std::vector<bool> &taken) {
  int best = -1;
  int bestDist = INT32_MAX;
  for (size_t s = 0; s < slots.size(); s++) {
    if (taken[s])
      continue;
    const int dx = std::abs(initialAnchors_[member].x - slots[s] / H);
    if (const int dy = std::abs(initialAnchors_[member].y - slots[s] % H);
        dx + dy < bestDist) {
      bestDist = dx + dy;
      best = static_cast<int>(s);
    }
  }
  if (best >= 0) {
    taken[best] = true;
    packedSlot_[member] = slots[best];
  }
}

bool DragSolver::tryComputePacking(const int cellOrderVariant,
                                   const int demotedPiece) {
  packedSlot_.assign(shapes_.size(), -1);
  packingGuideActive_ = false;
  if (cutSuffixRows_.empty())
    return false;

  const int H = gridHeight_;
  // A zero-height board has no cell to pack into, and the row-order scans
  // take `cell % H`. Bail out before either can matter.
  if (H <= 0)
    return false;
  const int total = gridWidth_ * H;

  std::vector<uint8_t> allowed(total, 0);
  const std::vector<uint16_t> cellList = buildPackCells(
      buildLockedRows(), cutSuffixRows_[0], cellOrderVariant, allowed);
  const std::vector<uint8_t> pieces = orderPackPieces(demotedPiece);

  size_t pieceCells = 0;
  for (const uint8_t i : pieces)
    pieceCells += shapes_[i].size();
  if (pieces.empty() || pieceCells > cellList.size())
    return false;

  Packer packer{.shapes = shapes_,
                .pieces = pieces,
                .cellList = cellList,
                .allowed = allowed,
                .occ = std::vector<uint8_t>(total, 0),
                .used = std::vector<bool>(pieces.size(), false),
                .anchorOf = std::vector<int32_t>(pieces.size(), -1),
                .gridWidth = gridWidth_,
                .H = H,
                .holeBudget = static_cast<int>(cellList.size() - pieceCells)};

  if (!packer.dfs(0)) {
    std::cout << "DragSolver: no off-sweep packing (variant "
              << cellOrderVariant << "/" << demotedPiece << ", "
              << (packer.nodes > Packer::kNodeCap ? "budget" : "exhausted")
              << ") — packing guide off\n";
    return false;
  }
  for (size_t pi = 0; pi < pieces.size(); pi++)
    packedSlot_[pieces[pi]] = packer.anchorOf[pi];

  reassignSymmetrySlots(H);
  packingGuideActive_ = true;
  std::cout << "DragSolver: packing guide on (" << pieces.size()
            << " blocks assigned, " << packer.nodes << " pack nodes, variant "
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

  const std::vector<uint64_t> lockedRows = buildLockedRows();

  const int maxX = gridWidth_ - grid_.boxWidth(gi);
  const int maxY = gridHeight_ - grid_.boxHeight(gi);
  const auto validAnchor = [this, &lockedRows, gi, maxX,
                            maxY](const int x, const int y) {
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

  AnchorWalk walk{.parent = std::vector<int32_t>(totalAnchors, -1), .seen = {}};
  const auto bfsFrom = [&](const uint16_t source, const int32_t banned,
                           const bool track) {
    bfsAnchors(validAnchor, walk, source, banned, track, H);
  };

  bfsFrom(startIdx, -1, true);
  if (!validAnchor(startX, startY) || !walk.seen[targetIdx]) {
    std::cout << "DragSolver: goal anchor unreachable even through locked "
                 "walls only — unsolvable\n";
    unsolvableAtStart_ = true;
    return;
  }

  // One shortest path start→target; cut anchors are a subset of it. Order it
  // start→target so cuts come out in crossing order.
  std::vector<uint16_t> path;
  for (int32_t cur = targetIdx; cur != -1; cur = walk.parent[cur])
    path.push_back(static_cast<uint16_t>(cur));
  std::ranges::reverse(path);

  // Middle cuts: banning them separates start from target. For each, the
  // target-side component marks anchors that have already crossed it.
  std::vector<uint16_t> cuts;
  for (const uint16_t v : path) {
    if (v == startIdx || v == targetIdx)
      continue;
    bfsFrom(startIdx, v, false);
    if (!walk.seen[targetIdx])
      cuts.push_back(v);
  }
  for (const uint16_t v : cuts) {
    bfsFrom(targetIdx, v, false);
    for (int a = 0; a < totalAnchors; a++)
      if (walk.seen[a])
        progressIndex_[a]++;
  }

  // Corridor mode: no unavoidable cuts, but a long goal journey still needs
  // receding-horizon decomposition. Assign each anchor a progress band from its
  // BFS distance to target, then lay one waypoint pseudo-cut per band along the
  // shortest path — see layBandWaypoints.
  if (cfg_.corridorBands && cuts.empty() &&
      path.size() >= cfg_.corridorBandMinPath) {
    const std::vector<int> dist =
        anchorDistances(validAnchor, targetIdx, H, totalAnchors);
    corridorBandsActive_ =
        layBandWaypoints(dist, startIdx, path, progressIndex_, cuts);
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
      hi * 16 > lo * cfg_.jam.aspect16)
    return false;
  size_t cells = 0;
  for (const auto &s : shapes_)
    cells += s.size();
  return cells * 100 >=
         static_cast<size_t>(gridWidth_) * gridHeight_ * cfg_.jam.densityPct;
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
