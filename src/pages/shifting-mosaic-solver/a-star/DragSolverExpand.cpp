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
#include <vector>

uint32_t
DragSolver::relevanceMaskOf(const std::vector<Position> &anchors,
                            const std::vector<uint64_t> &lockedRows) const {
  const int H = gridHeight_;
  const int total = gridWidth_ * H;
  const auto &grows = grid_.shapeRows(goalIndex_);
  const int maxX = gridWidth_ - grid_.boxWidth(goalIndex_);
  const int maxY = gridHeight_ - grid_.boxHeight(goalIndex_);
  const auto valid = [&](const int x, const int y) {
    if (x < 0 || y < 0 || x > maxX || y > maxY)
      return false;
    for (size_t r = 0; r < grows.size(); r++)
      if (grows[r] << x & lockedRows[y + r])
        return false;
    return true;
  };
  const auto &[gx, gy] = anchors[goalIndex_];
  const auto startIdx = static_cast<uint16_t>(gx * H + gy);
  const auto targetIdx =
      static_cast<uint16_t>(goalAnchor_.x * H + goalAnchor_.y);
  if (startIdx == targetIdx)
    return UINT32_MAX;
  std::vector par(total, -2);
  std::vector q{startIdx};
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
    for (size_t r = 0; r < grows.size(); r++)
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
      for (size_t r = 0; r < rows.size(); r++)
        accum[anchors[b].y + r] |= rows[r] << anchors[b].x;
    }
  }
  // Ring k: dilate the accumulated relevant cells and absorb touching
  // blocks; repeat relevantRing_ times (the escalation search() drives
  // when a tighter ring's space exhausts without a solution).
  for (uint8_t ring = 0; ring < relevantRing_; ring++) {
    std::vector<uint64_t> dil(gridHeight_, 0);
    for (int y = 0; y < gridHeight_; y++) {
      uint64_t m = accum[y] | accum[y] << 1 | accum[y] >> 1;
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
        for (size_t r = 0; r < rows.size(); r++)
          accum[anchors[b].y + r] |= rows[r] << anchors[b].x;
        grew = true;
      }
    }
    if (!grew)
      break;
  }
  return mask;
}

void DragSolver::updateSleepEnvelope(
    const uint8_t i, const Position from,
    const std::vector<uint16_t> &reached,
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
    env[from.y + r] |= rows[r] << from.x;
  for (const uint16_t idx : reached) {
    const auto [tx, ty] = grid_.anchorFromIndex(idx);
    for (size_t r = 0; r < rows.size(); r++)
      env[ty + r] |= rows[r] << tx;
  }
  uint32_t sm = 0;
  if (i > 0 && iterated != 0) {
    std::vector<uint64_t> dil(gridHeight_);
    for (uint8_t y = 0; y < gridHeight_; y++) {
      uint64_t m = env[y] | env[y] << 1 | env[y] >> 1;
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
        std::cout << "DragSolver hit the memory ceiling (" << (used >> 20)
                  << " MB of " << (cfg_.maxHeapBytes >> 20) << " MB) after "
                  << nodesExpanded << " drag expansions\n";
      stats_.stoppedOnMemory = true;
      return true;
    }
  }
  return false;
}
