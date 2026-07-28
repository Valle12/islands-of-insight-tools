// DragSolver: per-expansion helpers lifted out of runAStarDrag.
//
// Three self-contained steps the drag search runs around each pop — the
// relevance mask that filters which blocks may move, the sleep-set
// interaction envelope that proves two drags commute, and the combined
// budget checkpoint. Kept out of DragSolverSearch.cpp so the A* loop there
// reads as the loop rather than as its bookkeeping.

#include "DragSolver.h"
#include "MemoryProbe.h"
#include "SolverClock.h"

#include <iostream>
#include <tuple>
#include <vector>

std::vector<int32_t>
DragSolver::goalRoutePredecessors(const uint16_t startIdx,
                                  const uint16_t targetIdx,
                                  const DispGeometry &geo) const {
  const int H = gridHeight_;
  std::vector<int32_t> par(static_cast<size_t>(gridWidth_) * H, -2);
  std::vector q{startIdx};
  par[startIdx] = -1;
  // Worklist BFS: the body pushes onto `q` while it is being walked, so this
  // is an index walk rather than a range-for.
  size_t head = 0;
  while (head < q.size()) {
    const uint16_t cur = q[head];
    head++;
    const int cx = cur / H;
    const int cy = cur % H;
    for (int d = 0; d < 4; d++) {
      const int nx = cx + BitGrid::DX[d];
      const int ny = cy + BitGrid::DY[d];
      if (!anchorClearOfWalls(nx, ny, geo))
        continue;
      const auto nIdx = static_cast<uint16_t>(nx * H + ny);
      if (par[nIdx] != -2)
        continue;
      par[nIdx] = cur;
      if (nIdx == targetIdx)
        return par;
      q.push_back(nIdx);
    }
  }
  return {}; // no walls-only route to the target
}

void DragSolver::accumulatePathFootprint(const int32_t from,
                                         const std::vector<int32_t> &parent,
                                         const std::vector<uint64_t> &rows,
                                         std::vector<uint64_t> &out) const {
  const int H = gridHeight_;
  for (int32_t cur = from; cur != -1; cur = parent[cur]) {
    const int cx = cur / H;
    const int cy = cur % H;
    for (size_t r = 0; r < rows.size(); r++)
      out[cy + r] |= rows[r] << static_cast<unsigned>(cx);
  }
}

bool DragSolver::absorbBlocksOnMask(const std::vector<Position> &anchors,
                                    const std::vector<uint64_t> &probe,
                                    uint32_t &mask,
                                    std::vector<uint64_t> &accum) const {
  bool grew = false;
  for (const uint8_t b : movableBlockIndices_) {
    // The goal's own bit is pre-set by the caller, so this subsumes the
    // explicit `b == goalIndex_` skip the ring-0 pass used to carry.
    if (mask >> b & 1u)
      continue;
    if (!blockOnMask(b, anchors[b], probe))
      continue;
    mask |= uint32_t{1} << b;
    const auto &rows = grid_.shapeRows(b);
    for (size_t r = 0; r < rows.size(); r++)
      accum[anchors[b].y + r] |= rows[r] << static_cast<unsigned>(anchors[b].x);
    grew = true;
  }
  return grew;
}

uint32_t
DragSolver::relevanceMaskOf(const std::vector<Position> &anchors,
                            const std::vector<uint64_t> &lockedRows) const {
  const int H = gridHeight_;
  const DispGeometry geo{.rows = grid_.shapeRows(goalIndex_),
                         .lockedRows = lockedRows,
                         .maxX = gridWidth_ - grid_.boxWidth(goalIndex_),
                         .maxY = gridHeight_ - grid_.boxHeight(goalIndex_)};
  const auto &[gx, gy] = anchors[goalIndex_];
  const auto startIdx = static_cast<uint16_t>(gx * H + gy);
  const auto targetIdx =
      static_cast<uint16_t>(goalAnchor_.x * H + goalAnchor_.y);
  if (startIdx == targetIdx)
    return UINT32_MAX;

  const std::vector<int32_t> par =
      goalRoutePredecessors(startIdx, targetIdx, geo);
  if (par.empty())
    return UINT32_MAX;

  std::vector<uint64_t> sweep(gridHeight_, 0);
  accumulatePathFootprint(targetIdx, par, geo.rows, sweep);

  uint32_t mask = uint32_t{1} << goalIndex_;
  std::vector<uint64_t> accum(gridHeight_, 0); // cells of relevant blocks
  // Ring 0 only seeds `accum`; whether it grew is irrelevant, because an empty
  // seed dilates to nothing and the ring loop below breaks on its own test.
  std::ignore = absorbBlocksOnMask(anchors, sweep, mask, accum);
  // Ring k: dilate the accumulated relevant cells and absorb touching
  // blocks; repeat relevantRing_ times (the escalation search() drives
  // when a tighter ring's space exhausts without a solution).
  for (uint8_t ring = 0; ring < relevantRing_; ring++) {
    std::vector<uint64_t> dil(gridHeight_, 0);
    for (int y = 0; y < gridHeight_; y++)
      dil[y] = dilateRow(accum, y);
    if (!absorbBlocksOnMask(anchors, dil, mask, accum))
      break;
  }
  return mask;
}

void DragSolver::updateSleepEnvelope(
    const uint8_t i, const Position from, const std::vector<uint16_t> &reached,
    std::vector<std::vector<uint64_t>> &envRows,
    std::vector<uint32_t> &sleptMaskOf, uint32_t &iterated) const {
  // Interaction envelope = the block's cells at start + every
  // reachable anchor. Independence needs a ONE-CELL BUFFER: i merely
  // vacating a cell adjacent to j's region lets j slide into space it
  // could not reach before — a drag with no (j, i) twin. Testing j's
  // envelope against the 1-dilation of i's covers both growth
  // directions (dilation is self-adjoint under intersection).
  auto &env = envRows[i];
  const auto &rows = grid_.shapeRows(i);
  for (size_t r = 0; r < rows.size(); r++)
    env[from.y + r] |= rows[r] << static_cast<unsigned>(from.x);
  for (const uint16_t idx : reached) {
    const auto [tx, ty] = grid_.anchorFromIndex(idx);
    for (size_t r = 0; r < rows.size(); r++)
      env[ty + r] |= rows[r] << static_cast<unsigned>(tx);
  }
  sleptMaskOf[i] = commutingBlocks(i, envRows, iterated);
  iterated |= uint32_t{1} << i;
}

bool DragSolver::envelopesOverlap(const std::vector<uint64_t> &a,
                                  const std::vector<uint64_t> &b) const {
  for (int y = 0; y < gridHeight_; y++)
    if ((a[y] & b[y]) != 0)
      return true;
  return false;
}

uint32_t DragSolver::commutingBlocks(
    const uint8_t i, const std::vector<std::vector<uint64_t>> &envRows,
    const uint32_t iterated) const {
  if (i == 0 || iterated == 0)
    return 0;
  std::vector<uint64_t> dil(gridHeight_);
  for (int y = 0; y < gridHeight_; y++)
    dil[y] = dilateRow(envRows[i], y);
  uint32_t sm = 0;
  for (const uint8_t j : movableBlockIndices_) {
    if (j >= i)
      break;
    if (!(iterated >> j & 1u))
      continue; // j generated nothing here — no (j, i) twin branch
    if (!envelopesOverlap(dil, envRows[j]))
      sm |= uint32_t{1} << j;
  }
  return sm;
}

// Only reached on the caller's 1-in-256 cadence — see the call site, which
// keeps that mask test and the bare node-cap compare inline so the fast path
// stays two predictable branches rather than a call.
bool DragSolver::dragBudgetExhausted(const uint64_t deadline,
                                     const uint32_t nodesExpanded,
                                     const size_t statesStored,
                                     const bool verbose) {
  if (cfg_.cancel && cfg_.cancel->load(std::memory_order_relaxed)) {
    if (verbose)
      std::cout << "DragSolver cancelled after " << nodesExpanded
                << " drag expansions\n";
    return true;
  }
  if (deadline != 0 && nowMs() > deadline) {
    if (verbose)
      std::cout << "DragSolver timed out after " << nodesExpanded
                << " drag expansions\n";
    return true;
  }
  // Graceful memory stop — see Config::maxStatesStored. An out-of-memory
  // search must report "no solution" rather than abort the (shared) wasm
  // heap under every other arm.
  if (cfg_.maxStatesStored != 0 && statesStored >= cfg_.maxStatesStored) {
    if (verbose)
      std::cout << "DragSolver hit the state ceiling (" << statesStored
                << " states) after " << nodesExpanded << " drag expansions\n";
    return true;
  }
  // Last-resort abort tripwire — see the twin in AStarSearch.cpp. Wasm-only
  // by #if rather than `if constexpr`: natively nearHeapLimit() is
  // `return false;`, so the guarded block really is dead code there and
  // `if constexpr` did not stop the analyser saying so.
#if defined(__EMSCRIPTEN__)
  if (memprobe::nearHeapLimit()) {
    // Independent of maxHeapBytes: an aborting module takes every other arm
    // with it, so this fires even when no budget was configured.
    if (verbose)
      std::cout << "DragSolver stopped at the heap limit after "
                << nodesExpanded << " drag expansions\n";
    stats_.stoppedOnMemory = true;
    return true;
  }
#endif
  if (cfg_.maxHeapBytes != 0) {
    // 0 means the platform cannot measure — treat as "no information" and
    // keep searching rather than stopping a search that is perfectly fine.
    if (const uint64_t used = memprobe::liveAllocatedBytes();
        used != 0 && used >= cfg_.maxHeapBytes) {
      if (verbose)
        std::cout << "DragSolver hit the memory ceiling (" << (used >> 20u)
                  << " MB of " << (cfg_.maxHeapBytes >> 20u) << " MB) after "
                  << nodesExpanded << " drag expansions\n";
      stats_.stoppedOnMemory = true;
      return true;
    }
  }
  return false;
}
