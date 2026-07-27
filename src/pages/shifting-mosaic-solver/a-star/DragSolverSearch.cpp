// DragSolver: the drag-space A* itself, plus plan reconstruction.
//
// runAStarDrag is the hot loop every portfolio arm ultimately runs; the two
// functions after it turn its DragMove output back into unit Turns and
// re-validate the result against a fresh BitGrid.

#include "DragSolver.h"
#include "Node.h"
#include "SolverClock.h"
#include "MemoryProbe.h"

#include <algorithm>
#include <compare>
#include <functional>
#include <iostream>
#include <queue>
#include <unordered_map>
#include <utility>

namespace {
struct DragHeapEntry {
  uint32_t f;
  uint32_t g;
  uint32_t cells;
  // NOTE: `signature` below is a POINTER pair, not a NodeKey copy. See the
  // struct tail.
  // cells + scaled remaining-displacement estimate (see dispField_): among
  // equal (f, g), prefer states whose mask-blockers are closest to viable
  // parking. Pure ordering hint — never enters f.
  uint32_t tie;
  // Was a 48-byte NodeKey copy. The heap holds MORE entries than there are
  // states (PEA* re-queues a parent for each successor batch), so this was the
  // single largest consumer after the state map itself: 64 -> 32 bytes here.
  // Both pointers are stable for the life of the search — `states` is never
  // erased and unordered_map does not move its elements — so `key` addresses
  // the map's own key and `info` its value. Carrying both means popping a
  // state no longer costs a states.find().
  const NodeKey *key = nullptr;
  DragSolver::StateInfo *info = nullptr;
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
  auto *rootEntry = states.emplace(rootSig).first;
  rootEntry->value = {0, 0, nullptr, {}, 0, false, false};
  nodeStore.try_emplace(rootSig, Node(startAnchors));
  const uint32_t rootDisp = displacementSum(startAnchors);
  openHeap.push({cfg_.weight * heuristic(startAnchors) +
                     cfg_.packingWeight * rootDisp / 16,
                 0, 0, 16 * rootDisp, &rootEntry->key, &rootEntry->value});

  uint32_t nodesExpanded = 0;
  uint64_t loopIters = 0;
  // Best jam-term expanded state (jam guide only): the drag chain to it is
  // returned as bestPartialDrags on failure — the restart driver's elite.
  const StateInfo *bestJamState = nullptr;
  uint32_t bestJamVal = UINT32_MAX;
  const auto finishStats = [&] {
    stats_.passes++;
    stats_.nodesExpanded += nodesExpanded;
    stats_.statesStored += states.size();
    if (result.alts.empty() && bestJamVal != UINT32_MAX &&
        bestJamState != nullptr) {
      result.bestPartialJam = bestJamVal;
      for (const StateInfo *cur = bestJamState; cur && cur->hasParent;
           cur = cur->parent)
        result.bestPartialDrags.push_back(cur->move);
      std::ranges::reverse(result.bestPartialDrags);
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
    std::vector isMov(shapes_.size(), false);
    for (const uint8_t i : movableBlockIndices_) isMov[i] = true;
    for (size_t i = 0; i < shapes_.size(); i++) {
      if (isMov[i]) continue;
      const auto &rows = grid_.shapeRows(static_cast<uint8_t>(i));
      for (size_t r = 0; r < rows.size(); r++)
        relevanceLocked[initialAnchors_[i].y + r] |= rows[r]
                                                    << initialAnchors_[i].x;
    }
  }

  while (!openHeap.empty()) {
    loopIters++;
    if (nodeCap != 0 && nodesExpanded >= nodeCap) {
      if (verbose)
        std::cout << "DragSolver hit node cap of " << nodeCap << "\n";
      finishStats();
      return finishResult(false);
    }
    // Everything else is checked on a 1-in-256 cadence; keeping the mask
    // test here means the common iteration never pays for the call.
    if ((loopIters & 0xFF) == 0 &&
        dragBudgetExhausted(deadline, nodesExpanded, states.size(),
                            verbose)) {
      finishStats();
      return finishResult(false);
    }

    DragHeapEntry current = openHeap.top();
    openHeap.pop();

    // The heap entry carries the map node directly, so popping no longer
    // costs a hash lookup (this used to be states.find on every pop).
    StateInfo *const sit = current.info;
    if (sit == nullptr || sit->closed ||
        sit->gScore < current.g ||
        (sit->gScore == current.g && sit->cells < current.cells))
      continue;

    auto nit = nodeStore.find(*current.key);
    if (nit == nodeStore.end()) {
      sit->closed = true;
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
      if (const NodeKey coarse = coarseSignature(anchors);
          (bannedEnds == nullptr || !bannedEnds->contains(coarse)) &&
          !seenEnds.contains(coarse)) {
        if (verbose)
          std::cout << "DragSolver (w=" << static_cast<int>(cfg_.weight)
                    << ") found solution in " << current.g
                    << " drags, expanded " << nodesExpanded << " nodes\n";
        // Walk the parent chain to collect the drag plan.
        SegmentAlt alt;
        alt.endAnchors = anchors;
        for (const StateInfo *cur = current.info; cur && cur->hasParent;
             cur = cur->parent)
          alt.drags.push_back(cur->move);
        std::ranges::reverse(alt.drags);
        seenEnds.insert(coarse);
        result.alts.push_back(std::move(alt));
        if (result.alts.size() >= collectEnds) {
          finishStats();
          return finishResult(false);
        }
      }
      // Qualifying states are recorded leaves — never expanded.
      sit->closed = true;
      nodeStore.erase(*current.key);
      continue;
    }

    // References into `states` stay valid across inserts (node-based map).
    StateInfo &info = *sit;
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
        nodeStore.erase(*current.key);
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
    const auto [gPosX, gPosY] = anchors[goalIndex_];
    const uint16_t gProg = progressIndex_[gPosX * gridHeight_ + gPosY];
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
        bestJamState = current.info;
      }
    }
    if (gProg > stats_.maxProgress)
      stats_.maxProgress = gProg;
    // Clamped scaled jam contribution — keeps f finite when the field says
    // unreachable (locked-walls disconnection; the admissible h still owns
    // correctness, the guide only orders).
    const auto jamAdd = [&](const uint32_t term) -> uint32_t {
      const uint32_t t = std::min<uint32_t>(term, 1u << 20);
      return cfg_.jamGuideWeight * t / 16;
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
        cfg_.relevantOnly && shapes_.size() <= 32
            ? relevanceMaskOf(anchors, relevanceLocked)
            : UINT32_MAX;
    uint32_t iterated = 0; // blocks that actually generated drags this pop
    if (por)
      for (const uint8_t b : movableBlockIndices_) {
        std::ranges::fill(envRows[b], 0);
        sleptMaskOf[b] = 0;
      }
    candScratch_.clear();
    grid_.buildOccupancy(anchors);
    for (const uint8_t i : movableBlockIndices_) {
      const Position from = anchors[i];
      // `i < 32` guard: relevantMask is a uint32_t and is set to UINT32_MAX
      // (= "no filtering") whenever shapes_.size() > 32, but `UINT32_MAX >> i`
      // with i >= 32 is undefined. x86/wasm happen to mask the count to 5 bits
      // today; a compiler that folds the shift to 0 would silently skip every
      // block with index >= 32. The sibling shifts below are already gated on
      // `por` (which requires shapes_.size() <= 32); this one was not.
      if (i < 32 && !(relevantMask >> i & 1))
        continue; // relevance-filtered
      if (por && info.slept >> i & 1)
        continue; // commutes with the drag that created this node
      if (cfg_.lockOnSlot && packingGuideActive_ && i != goalIndex_ &&
          packedSlot_[i] >= 0 &&
          from.x * gridHeight_ + from.y == packedSlot_[i])
        continue; // ratcheted: this block reached its slot and stays
      if (std::ranges::find(cfg_.frozenBlocks, i) != cfg_.frozenBlocks.end())
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
      if (por)
        updateSleepEnvelope(i, from, reached, envRows, sleptMaskOf, iterated);
      for (const uint16_t toIdx : reached) {
        const Position t = grid_.anchorFromIndex(toIdx);
        if (cfg_.settledOnly) {
          const bool blockedV = !grid_.canPlace(i, t.x, t.y - 1) ||
                                !grid_.canPlace(i, t.x, t.y + 1);
          const bool blockedH = !grid_.canPlace(i, t.x - 1, t.y) ||
                                !grid_.canPlace(i, t.x + 1, t.y);
          // Must mirror progressOf(), which treats the exact target as
          // middleCuts_ + 1 — reading the RAW progressIndex_ table instead
          // silently dropped the winning move. On a 0-cut board with no
          // corridor bands that table is all zeros, so gProg and
          // progressIndex_[targetIdx] are both 0, `advances` was false for the
          // drag home, and if goalAnchor_ is not flush both ways the `continue`
          // below discarded it — no state satisfying isGoal() could ever be
          // created. That silently crippled every settledOnly arm (hier, flat
          // drag, corridor, jam-filtered = 4 of the 8 racing arms) and
          // searchAssembly's final goal leg, whose entire job is that drag.
          const bool reachesTarget =
              t.x == goalAnchor_.x && t.y == goalAnchor_.y;
          const bool advances =
              i == goalIndex_ &&
              (reachesTarget || progressIndex_[toIdx] > gProg);
          if (!(blockedV && blockedH) && !advances)
            continue;
        }
        uint32_t h;
        uint32_t disp = dispBase;
        if (i == goalIndex_) {
          if (useSlotH) {
            h = baseCount +
                (t.x == goalAnchor_.x && t.y == goalAnchor_.y ? 0 : 1);
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
        uint32_t f = newG + cfg_.weight * h + cfg_.packingWeight * disp / 16;
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

    std::ranges::sort(candScratch_,
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
      const auto &[candF, candCells, candTie, candToIdx, candBlockId] =
          candScratch_[ci];
      const Position newPos = grid_.anchorFromIndex(candToIdx);
      const NodeKey newSig = childSignature(*current.key, candBlockId,
                                            anchors[candBlockId], newPos);
      auto [newEntry, inserted] = states.emplace(newSig);
      StateInfo &child = newEntry->value;
      const bool better =
          inserted ||
          (!child.closed &&
           (newG < child.gScore ||
            (newG == child.gScore && candCells < child.cells)));
      if (!better)
        continue;
      child = {newG,  candCells, current.info, {candBlockId, candToIdx}, 0,
               true, false};
      if (por)
        child.slept = sleptMaskOf[candBlockId];
      std::vector<Position> newAnchors = anchors;
      newAnchors[candBlockId] = newPos;
      nodeStore.insert_or_assign(newSig, Node(std::move(newAnchors)));
      openHeap.push(
          {candF, newG, candCells, candTie, &newEntry->key, &child});
    }
    if (batch != 0 && emitTo < candScratch_.size()) {
      info.batchesEmitted++;
      openHeap.push({candScratch_[emitTo].f, current.g, current.cells,
                     current.tie, current.key, current.info});
    } else {
      info.closed = true;
      nodeStore.erase(*current.key);
    }
  }

  if (verbose && result.alts.empty())
    std::cout << "DragSolver found no solution, expanded " << nodesExpanded
              << " nodes\n";
  finishStats();
  return finishResult(true);
}
