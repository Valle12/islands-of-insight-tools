// DragSolver: the drag-space A* itself, plus plan reconstruction.
//
// runAStarDrag is the hot loop every portfolio arm ultimately runs; the two
// functions after it turn its DragMove output back into unit Turns and
// re-validate the result against a fresh BitGrid.

#include "DragSolver.h"
#include "MemoryProbe.h"
#include "Node.h"
#include "SolverClock.h"

#include <algorithm>
#include <compare>
#include <concepts>
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
    if (const auto c = f <=> o.f; c != 0)
      return c;
    if (const auto c = o.g <=> g; c != 0)
      return c;
    return tie <=> o.tie;
  }
  bool operator==(const DragHeapEntry &o) const {
    return f == o.f && g == o.g && tie == o.tie;
  }
};

// As in AStarSearch.cpp: a user-written operator<=> does not synthesise ==, so
// this one is required rather than incidental, and it is hand-written because
// the struct holds raw pointers a defaulted == would compare by address. The
// assertion is what keeps cpp:S1144 from reading it as dead.
static_assert(std::equality_comparable<DragHeapEntry>);
} // namespace

// Shared by every exit path: promotes the first collected alternative to the
// flat-caller fields. Returns a reference — runAStarDrag copies once on the way
// out, exactly as the lambda this replaced did.
DragSolver::SegmentResult &DragSolver::finishSegment(SegmentResult &result,
                                                     const bool exhausted) {
  result.exhausted = exhausted && result.alts.empty();
  result.found = !result.alts.empty();
  if (result.found) {
    result.drags = result.alts.front().drags;
    result.endAnchors = result.alts.front().endAnchors;
  }
  return result;
}

void DragSolver::finishDragStats(SegmentResult &result,
                                 const uint32_t nodesExpanded,
                                 const size_t statesStored,
                                 const StateInfo *const bestJamState,
                                 const uint32_t bestJamVal) {
  stats_.passes++;
  stats_.nodesExpanded += nodesExpanded;
  stats_.statesStored += statesStored;
  if (!result.alts.empty() || bestJamVal == UINT32_MAX ||
      bestJamState == nullptr)
    return;
  result.bestPartialJam = bestJamVal;
  for (const StateInfo *cur = bestJamState; cur && cur->hasParent;
       cur = cur->parent)
    result.bestPartialDrags.push_back(cur->move);
  std::ranges::reverse(result.bestPartialDrags);
}

// sleepSets scratch: per-block interaction envelopes (row masks of every cell
// the block occupies at its start or any reachable anchor) and the per-block
// child sleep masks, rebuilt each expansion. relevantOnly additionally needs
// locked-only walls for the per-state goal-path BFS.
void DragSolver::initSearchScratch(DragScratch &scratch) const {
  scratch.por = cfg_.sleepSets && shapes_.size() <= 32;
  if (scratch.por) {
    scratch.envRows.assign(shapes_.size(),
                           std::vector<uint64_t>(gridHeight_, 0));
    scratch.sleptMaskOf.assign(shapes_.size(), 0);
  }
  if (cfg_.relevantOnly)
    scratch.relevanceLocked = lockedWallRows();
}

bool DragSolver::dragCapReached(const uint32_t nodeCap,
                                const uint32_t nodesExpanded,
                                const bool verbose) {
  if (nodeCap == 0 || nodesExpanded < nodeCap)
    return false;
  if (verbose)
    std::cout << "DragSolver hit node cap of " << nodeCap << "\n";
  return true;
}

bool DragSolver::isStaleDragEntry(const StateInfo *const info, const uint32_t g,
                                  const uint32_t cells) {
  return info == nullptr || info->closed || info->gScore < g ||
         (info->gScore == g && info->cells < cells);
}

bool DragSolver::qualifiesAsEnd(const std::vector<Position> &anchors,
                                const uint32_t g, const uint32_t targetProgress,
                                const uint32_t consolidationBelow) const {
  if (progressOf(anchors) < targetProgress &&
      (consolidationBelow == 0 || g == 0 ||
       displacementSum(anchors) > consolidationBelow))
    return false;
  if (!cfg_.packing.requireAllSlots || !packingGuideActive_)
    return true;
  return std::ranges::none_of(movableBlockIndices_, [&](const uint8_t b) {
    return b != goalIndex_ && packedSlot_[b] >= 0 &&
           anchors[b].x * gridHeight_ + anchors[b].y != packedSlot_[b];
  });
}

bool DragSolver::recordEnd(const std::vector<Position> &anchors,
                           const StateInfo *const state, const uint32_t g,
                           const uint32_t nodesExpanded,
                           const EndContext &ctx) const {
  const NodeKey coarse = coarseSignature(anchors);
  if ((ctx.bannedEnds != nullptr && ctx.bannedEnds->contains(coarse)) ||
      ctx.seenEnds.contains(coarse))
    return false;
  if (ctx.verbose)
    std::cout << "DragSolver (w=" << static_cast<int>(cfg_.weight)
              << ") found solution in " << g << " drags, expanded "
              << nodesExpanded << " nodes\n";
  // Walk the parent chain to collect the drag plan.
  SegmentAlt alt;
  alt.endAnchors = anchors;
  for (const StateInfo *cur = state; cur && cur->hasParent; cur = cur->parent)
    alt.drags.push_back(cur->move);
  std::ranges::reverse(alt.drags);
  ctx.seenEnds.insert(coarse);
  ctx.result.alts.push_back(std::move(alt));
  return ctx.result.alts.size() >= ctx.collectEnds;
}

bool DragSolver::prepareExpansion(const StateInfo &info,
                                  const std::vector<Position> &anchors,
                                  const uint32_t g, uint32_t &nodesExpanded,
                                  const size_t heapSize,
                                  const size_t statesStored) const {
  if (info.batchesEmitted != 0)
    return true;
  nodesExpanded++;
  // Report cumulatively across passes/segments so callers see a monotone
  // counter even in hierarchical mode.
  if (onProgress && nodesExpanded % 1000 == 0)
    onProgress(stats_.nodesExpanded + nodesExpanded);
  if (nodesExpanded % 100000 == 0) {
    std::cout << "  ... DragSolver working: " << nodesExpanded
              << " nodes, heap=" << heapSize << ", states=" << statesStored
              << ", g=" << g << "\n";
    std::cout.flush();
  }
  return !cfg_.deadlockPruning || !isDeadlocked(anchors);
}

uint32_t DragSolver::dispContribution(const uint8_t b, const size_t idx) const {
  if (dispField_[b].empty())
    return 0;
  const uint16_t dd = dispField_[b][idx];
  return dd == UINT16_MAX ? 128 : std::min<uint32_t>(dd, 64);
}

// Scores the popped state once: onMaskScratch_ / dispContribScratch_ hold the
// per-block terms every candidate then adjusts by a single delta, which is why
// no candidate ever rebuilds an anchor vector or re-runs an O(blocks)
// heuristic. slotHeuristic mode swaps the cut-suffix mask terms for "blocks not
// at their assigned packing slot". That is non-admissible against the bare goal
// condition (which does not require clusters placed), by design: it drives the
// pack-everything-first strategy.
void DragSolver::computeBaseScratch(const std::vector<Position> &anchors,
                                    const bool useSlotH,
                                    const std::vector<uint64_t> &maskP,
                                    uint32_t &baseCount, uint32_t &dispBase) {
  onMaskScratch_.assign(shapes_.size(), 0);
  dispContribScratch_.assign(shapes_.size(), 0);
  baseCount = 0;
  dispBase = 0;
  for (const uint8_t b : movableBlockIndices_) {
    if (b == goalIndex_)
      continue;
    const int anchorIdx = anchors[b].x * gridHeight_ + anchors[b].y;
    if (useSlotH)
      onMaskScratch_[b] =
          packedSlot_[b] >= 0 && anchorIdx != packedSlot_[b] ? 1 : 0;
    else
      onMaskScratch_[b] = blockOnMask(b, anchors[b], maskP) ? 1 : 0;
    baseCount += onMaskScratch_[b];
    const uint32_t contrib =
        dispContribution(b, static_cast<size_t>(anchorIdx));
    dispContribScratch_[b] = contrib;
    dispBase += contrib;
  }
}

// Jam guide: one dig-Dijkstra per expansion; children read the field (goal
// moves) or adjust the parent's term by their sweep-overlap delta (non-goal
// moves). See Config::jamGuideWeight.
uint32_t DragSolver::updateJamGuide(const std::vector<Position> &anchors,
                                    const StateInfo *const state,
                                    const StateInfo *&bestJamState,
                                    uint32_t &bestJamVal) {
  if (cfg_.jam.guideWeight == 0)
    return 0;
  const uint32_t jamBase = computeJamField(anchors);
  if (jamBase < stats_.minJamTerm)
    stats_.minJamTerm = jamBase;
  if (jamBase < bestJamVal) {
    bestJamVal = jamBase;
    bestJamState = state;
  }
  return jamBase;
}

// Clamped scaled jam contribution — keeps f finite when the field says
// unreachable (locked-walls disconnection; the admissible h still owns
// correctness, the guide only orders).
uint32_t DragSolver::jamAdd(const uint32_t term) const {
  const uint32_t t = std::min<uint32_t>(term, 1u << 20u);
  return cfg_.jam.guideWeight * t / 16;
}

// Diversification jitter: replaces the deterministic tie field with a
// seed-mixed candidate hash so equal-f plateaus break differently per restart.
uint32_t DragSolver::jitterTie(const uint8_t block, const uint16_t toIdx,
                               const uint32_t g) const {
  uint32_t x = cfg_.tieBreakSeed ^ (static_cast<uint32_t>(block) << 16u) ^
               toIdx ^ g * 0x9E3779B9u;
  x *= 0x85EBCA6Bu;
  x ^= x >> 13u;
  x *= 0xC2B2AE35u;
  x ^= x >> 16u;
  return x;
}

// The four reasons a block generates no drags from this state.
bool DragSolver::blockIsParked(const uint8_t i, const Position from,
                               const uint32_t relevantMask,
                               const uint32_t slept, const bool por) const {
  // Both masks are uint32_t, so both shifts are only defined for i < 32.
  // relevantMask is UINT32_MAX (= "no filtering") whenever shapes_.size() > 32,
  // so a large i really does reach here; x86/wasm happen to mask the shift
  // count to 5 bits today, but a compiler that folded the shift to 0 would
  // silently skip every block with index >= 32. `por` additionally implies
  // shapes_.size() <= 32, so it can never be true for i >= 32 and sharing the
  // one guard leaves its behaviour unchanged.
  if (i < 32) {
    if (!(relevantMask >> i & 1u))
      return true; // relevance-filtered
    if (por && slept >> i & 1u)
      return true; // commutes with the drag that created this node
  }
  if (cfg_.packing.lockOnSlot && packingGuideActive_ && i != goalIndex_ &&
      packedSlot_[i] >= 0 && from.x * gridHeight_ + from.y == packedSlot_[i])
    return true; // ratcheted: this block reached its slot and stays
  return std::ranges::find(cfg_.packing.frozenBlocks, i) != cfg_.packing.frozenBlocks.end();
}

bool DragSolver::isSettledDrag(const uint8_t i, const Position t,
                               const uint16_t toIdx,
                               const uint16_t gProg) const {
  const bool blockedV =
      !grid_.canPlace(i, t.x, t.y - 1) || !grid_.canPlace(i, t.x, t.y + 1);
  const bool blockedH =
      !grid_.canPlace(i, t.x - 1, t.y) || !grid_.canPlace(i, t.x + 1, t.y);
  // Must mirror progressOf(), which treats the exact target as middleCuts_ + 1
  // — reading the RAW progressIndex_ table instead silently dropped the winning
  // move. On a 0-cut board with no corridor bands that table is all zeros, so
  // gProg and progressIndex_[targetIdx] are both 0, `advances` was false for
  // the drag home, and if goalAnchor_ is not flush both ways the caller
  // discarded it — no state satisfying isGoal() could ever be created. That
  // silently crippled every settledOnly arm (hier, flat drag, corridor,
  // jam-filtered = 4 of the 8 racing arms) and searchAssembly's final goal leg,
  // whose entire job is that drag.
  const bool reachesTarget = t.x == goalAnchor_.x && t.y == goalAnchor_.y;
  const bool advances =
      i == goalIndex_ && (reachesTarget || progressIndex_[toIdx] > gProg);
  return (blockedV && blockedH) || advances;
}

uint32_t DragSolver::goalDragH(const Position t, const uint16_t toIdx,
                               const DragExpansion &exp) const {
  const bool atTarget = t.x == goalAnchor_.x && t.y == goalAnchor_.y;
  if (exp.useSlotH)
    return exp.baseCount + (atTarget ? 0 : 1);
  if (atTarget)
    return 0;
  const auto &maskN = cutSuffixRows_[std::min<size_t>(
      progressIndex_[toIdx], cutSuffixRows_.size() - 1)];
  if (&maskN == &exp.maskP)
    return 1 + exp.baseCount;
  uint32_t cnt = 0;
  for (const uint8_t b : movableBlockIndices_) {
    if (b == goalIndex_)
      continue;
    if (blockOnMask(b, exp.anchors[b], maskN))
      cnt++;
  }
  return 1 + cnt;
}

uint32_t DragSolver::offGoalDragH(const uint8_t i, const Position t,
                                  const uint16_t toIdx,
                                  const DragExpansion &exp) const {
  uint32_t onNew = 0;
  if (exp.useSlotH)
    onNew = packedSlot_[i] >= 0 && static_cast<int32_t>(toIdx) != packedSlot_[i]
                ? 1
                : 0;
  else
    onNew = blockOnMask(i, t, exp.maskP) ? 1 : 0;
  return 1 + exp.baseCount - onMaskScratch_[i] + onNew;
}

uint32_t DragSolver::jamChildTerm(const uint8_t i, const Position t,
                                  const uint16_t toIdx,
                                  const DragExpansion &exp,
                                  const uint32_t jamOldOverlap) const {
  // Goal drags read the exact field at the target; non-goal drags shift the
  // parent's term by their sweep-overlap delta.
  if (i == goalIndex_)
    return jamField_[toIdx];
  return exp.jamBase - jamOldOverlap +
         cfg_.jam.blockerPenalty * blockCellsOnMask(i, t, jamSweepRows_);
}

// Scores every anchor block `i` can reach from this state. Must run with block
// i removed from the occupancy and its flood fill still the latest one, since
// isSettledDrag() probes canPlace() and the cell cost reads grid_.distTo().
void DragSolver::scoreDrags(const uint8_t i,
                            const std::vector<uint16_t> &reached,
                            const uint32_t jamOldOverlap,
                            const DragExpansion &exp) {
  const uint32_t newG = exp.g + 1;
  for (const uint16_t toIdx : reached) {
    const Position t = grid_.anchorFromIndex(toIdx);
    if (cfg_.settledOnly && !isSettledDrag(i, t, toIdx, exp.gProg))
      continue;
    uint32_t h = 0;
    uint32_t disp = exp.dispBase;
    if (i == goalIndex_) {
      h = goalDragH(t, toIdx, exp);
    } else {
      h = offGoalDragH(i, t, toIdx, exp);
      disp = exp.dispBase - dispContribScratch_[i] + dispContribution(i, toIdx);
    }
    const uint32_t newCells = exp.cells + grid_.distTo(toIdx);
    uint32_t f = newG + cfg_.weight * h + cfg_.packing.weight * disp / 16;
    if (cfg_.jam.guideWeight != 0)
      f += jamAdd(jamChildTerm(i, t, toIdx, exp, jamOldOverlap));
    const uint32_t tieVal = cfg_.tieBreakSeed != 0
                                ? jitterTie(i, toIdx, exp.g)
                                : newCells + 16 * disp;
    candScratch_.push_back({.f = f,
                            .cells = newCells,
                            .tie = tieVal,
                            .toIdx = toIdx,
                            .blockId = i});
  }
}

void DragSolver::generateCandidates(const DragExpansion &exp,
                                    DragScratch &scratch) {
  const uint32_t relevantMask =
      cfg_.relevantOnly && shapes_.size() <= 32
          ? relevanceMaskOf(exp.anchors, scratch.relevanceLocked)
          : UINT32_MAX;
  uint32_t iterated = 0; // blocks that actually generated drags this pop
  if (scratch.por)
    for (const uint8_t b : movableBlockIndices_) {
      std::ranges::fill(scratch.envRows[b], 0);
      scratch.sleptMaskOf[b] = 0;
    }
  candScratch_.clear();
  grid_.buildOccupancy(exp.anchors);
  for (const uint8_t i : movableBlockIndices_) {
    const Position from = exp.anchors[i];
    if (blockIsParked(i, from, relevantMask, exp.slept, scratch.por))
      continue;
    // Jam guide: this block's current overlap with the goal's argmin route
    // sweep — candidates re-add their overlap at the target spot.
    const uint32_t jamOldOverlap =
        cfg_.jam.guideWeight != 0 && i != goalIndex_
            ? cfg_.jam.blockerPenalty * blockCellsOnMask(i, from, jamSweepRows_)
            : 0;
    grid_.removeBlock(i, from);
    const auto &reached = grid_.floodFill(i, from);
    stats_.floodFills++;
    if (scratch.por)
      updateSleepEnvelope(i, from, reached, scratch.envRows,
                          scratch.sleptMaskOf, iterated);
    scoreDrags(i, reached, jamOldOverlap, exp);
    grid_.addBlock(i, from);
  }

  std::ranges::sort(candScratch_, [](const Cand &a, const Cand &b) {
    if (a.f != b.f)
      return a.f < b.f;
    if (a.tie != b.tie)
      return a.tie < b.tie;
    if (a.blockId != b.blockId)
      return a.blockId < b.blockId;
    return a.toIdx < b.toIdx;
  });
}

bool DragSolver::isBetterChild(const StateInfo &child, const bool inserted,
                               const uint32_t newG, const uint32_t cells) {
  return inserted ||
         (!child.closed &&
          (newG < child.gScore ||
           (newG == child.gScore && cells < child.cells)));
}

// PEA*: push one batch of successors, then requeue the parent at the next f.
template <typename NodeStoreT, typename OpenHeapT, typename EntryT>
void DragSolver::emitBatch(const DragExpansion &exp, const DragScratch &scratch,
                           const EntryT &current, StateMap &states,
                           NodeStoreT &nodeStore, OpenHeapT &openHeap) {
  StateInfo &info = *current.info;
  const uint32_t newG = exp.g + 1;
  const uint16_t batch = cfg_.partialExpansionWidth;
  const size_t emitFrom =
      batch == 0 ? 0 : static_cast<size_t>(info.batchesEmitted) * batch;
  const size_t emitTo = batch == 0
                            ? candScratch_.size()
                            : std::min(emitFrom + batch, candScratch_.size());
  for (size_t ci = emitFrom; ci < emitTo; ++ci) {
    const auto &[candF, candCells, candTie, candToIdx, candBlockId] =
        candScratch_[ci];
    const Position newPos = grid_.anchorFromIndex(candToIdx);
    const NodeKey newSig = childSignature(*current.key, candBlockId,
                                          exp.anchors[candBlockId], newPos);
    auto [newEntry, inserted] = states.emplace(newSig);
    StateInfo &child = newEntry->value;
    if (!isBetterChild(child, inserted, newG, candCells))
      continue;
    child = {.gScore = newG,
             .cells = candCells,
             .parent = current.info,
             .move = {.blockId = candBlockId, .toIdx = candToIdx},
             .batchesEmitted = 0,
             .hasParent = true,
             .closed = false};
    if (scratch.por)
      child.slept = scratch.sleptMaskOf[candBlockId];
    std::vector<Position> newAnchors = exp.anchors;
    newAnchors[candBlockId] = newPos;
    nodeStore.insert_or_assign(newSig, Node(std::move(newAnchors)));
    openHeap.emplace(candF, newG, candCells, candTie, &newEntry->key, &child);
  }
  if (batch != 0 && emitTo < candScratch_.size()) {
    ++info.batchesEmitted;
    openHeap.emplace(candScratch_[emitTo].f, exp.g, exp.cells, current.tie,
                     current.key, current.info);
  } else {
    info.closed = true;
    nodeStore.erase(*current.key);
  }
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
  EndContext endCtx{.bannedEnds = bannedEnds,
                    .seenEnds = seenEnds,
                    .result = result,
                    .collectEnds = collectEnds,
                    .verbose = verbose};

  StateMap states;
  std::unordered_map<NodeKey, Node, NodeKeyHash> nodeStore;
  std::priority_queue<DragHeapEntry, std::vector<DragHeapEntry>, std::greater<>>
      openHeap;

  const NodeKey rootSig = signatureFromAnchors(startAnchors);
  auto *rootEntry = states.emplace(rootSig).first;
  rootEntry->value = {.gScore = 0,
                      .cells = 0,
                      .parent = nullptr,
                      .move = {},
                      .batchesEmitted = 0,
                      .hasParent = false,
                      .closed = false};
  nodeStore.try_emplace(rootSig, startAnchors);
  const uint32_t rootDisp = displacementSum(startAnchors);
  openHeap.push({.f = cfg_.weight * heuristic(startAnchors) +
                      cfg_.packing.weight * rootDisp / 16,
                 .g = 0,
                 .cells = 0,
                 .tie = 16 * rootDisp,
                 .key = &rootEntry->key,
                 .info = &rootEntry->value});

  uint32_t nodesExpanded = 0;
  uint64_t loopIters = 0;
  // Best jam-term expanded state (jam guide only): the drag chain to it is
  // returned as bestPartialDrags on failure — the restart driver's elite.
  const StateInfo *bestJamState = nullptr;
  uint32_t bestJamVal = UINT32_MAX;

  DragScratch scratch;
  initSearchScratch(scratch);

  while (!openHeap.empty()) {
    loopIters++;
    if (dragCapReached(nodeCap, nodesExpanded, verbose)) {
      finishDragStats(result, nodesExpanded, states.size(), bestJamState,
                      bestJamVal);
      return finishSegment(result, false);
    }
    // Everything else is checked on a 1-in-256 cadence; keeping the mask
    // test here means the common iteration never pays for the call.
    if ((loopIters & 0xFFu) == 0 &&
        dragBudgetExhausted(deadline, nodesExpanded, states.size(), verbose)) {
      finishDragStats(result, nodesExpanded, states.size(), bestJamState,
                      bestJamVal);
      return finishSegment(result, false);
    }

    const DragHeapEntry current = openHeap.top();
    openHeap.pop();

    // The heap entry carries the map node directly, so popping no longer
    // costs a hash lookup (this used to be states.find on every pop).
    StateInfo *const sit = current.info;
    if (isStaleDragEntry(sit, current.g, current.cells))
      continue;

    auto nit = nodeStore.find(*current.key);
    if (nit == nodeStore.end()) {
      sit->closed = true;
      continue;
    }
    // Copied out: the node may stay live across PEA* batches while the store
    // takes inserts.
    const std::vector<Position> anchors = nit->second.anchors;

    if (qualifiesAsEnd(anchors, current.g, targetProgress,
                       consolidationBelow)) {
      if (recordEnd(anchors, current.info, current.g, nodesExpanded, endCtx)) {
        finishDragStats(result, nodesExpanded, states.size(), bestJamState,
                        bestJamVal);
        return finishSegment(result, false);
      }
      // Qualifying states are recorded leaves — never expanded.
      sit->closed = true;
      nodeStore.erase(*current.key);
      continue;
    }

    // References into `states` stay valid across inserts (node-based map).
    if (!prepareExpansion(*sit, anchors, current.g, nodesExpanded,
                          openHeap.size(), states.size())) {
      sit->closed = true;
      nodeStore.erase(*current.key);
      continue;
    }

    // ---- Score every candidate drag incrementally (no per-candidate anchor
    // vectors or O(blocks) heuristic recomputation) ----
    const bool useSlotH = cfg_.packing.slotHeuristic && packingGuideActive_;
    const auto [gPosX, gPosY] = anchors[goalIndex_];
    const uint16_t gProg = progressIndex_[gPosX * gridHeight_ + gPosY];
    const auto &maskP =
        cutSuffixRows_[std::min<size_t>(gProg, cutSuffixRows_.size() - 1)];
    uint32_t baseCount = 0;
    uint32_t dispBase = 0;
    computeBaseScratch(anchors, useSlotH, maskP, baseCount, dispBase);
    // Must precede generateCandidates: it rebuilds jamSweepRows_, which the
    // per-candidate overlap deltas read.
    const uint32_t jamBase =
        updateJamGuide(anchors, current.info, bestJamState, bestJamVal);
    if (gProg > stats_.maxProgress)
      stats_.maxProgress = gProg;

    const DragExpansion exp{.anchors = anchors,
                            .maskP = maskP,
                            .baseCount = baseCount,
                            .dispBase = dispBase,
                            .jamBase = jamBase,
                            .g = current.g,
                            .cells = current.cells,
                            .slept = sit->slept,
                            .gProg = gProg,
                            .useSlotH = useSlotH};
    generateCandidates(exp, scratch);
    emitBatch(exp, scratch, current, states, nodeStore, openHeap);
  }

  if (verbose && result.alts.empty())
    std::cout << "DragSolver found no solution, expanded " << nodesExpanded
              << " nodes\n";
  finishDragStats(result, nodesExpanded, states.size(), bestJamState,
                  bestJamVal);
  return finishSegment(result, true);
}
