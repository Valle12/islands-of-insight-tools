// DragSolver: the breadth-first portfolio arms.
//
// searchBeamJam keeps the best W states per depth against a jam dig-cost
// gradient; searchHierarchical solves "advance the goal past the next cut"
// as a backtracking sequence of small exact searches. Both are incomplete
// by design and exist for boards where the flat search drowns.
#include "DragSolver.h"
#include "MemoryProbe.h"
#include "SolverClock.h"

#include <algorithm>
#include <array>
#include <iostream>

std::vector<Turn> DragSolver::searchBeamJam(const uint32_t maxMs,
                                            const uint32_t maxNodes) {
  stats_ = {};
  if (gridWidth_ > 64) {
    std::cout << "DragSolver: grid wider than 64 — not supported\n";
    return {};
  }
  if (unsolvableAtStart_ || isGoal(initialAnchors_))
    return {};

  const uint64_t deadline = deadlineFrom(maxMs);
  const size_t nBlocks = shapes_.size();
  const uint32_t W =
      cfg_.beamWidth != 0
          ? cfg_.beamWidth
          : std::clamp<uint32_t>(static_cast<uint32_t>(gridWidth_) *
                                     gridHeight_ * 400,
                                 20000, 150000);
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
    // (jamTerm << 20 | h) low bits jittered — smaller = better
    uint64_t score = 0;
    NodeKey key;
    int32_t parent = -1;
    DragMove move;
  };

  std::vector<BeamState> arena;
  std::vector<int32_t> layer; // arena indices of the current layer
  std::vector<BeamCand> cands;
  std::unordered_set<NodeKey, NodeKeyHash> visited;
  std::vector<Position> anchors(nBlocks);
  const auto anchorsOf = [&](const NodeKey &key, std::vector<Position> &out) {
    const uint16_t *d = key.data();
    for (size_t i = 0; i < nBlocks; i++)
      out[i] = {.x = static_cast<int8_t>(d[i] >> 8u),
                .y = static_cast<int8_t>(d[i] & 0xFFu)};
  };

  std::vector frozen(nBlocks, false);
  for (const uint8_t b : cfg_.frozenBlocks)
    frozen[b] = true;

  std::vector<Turn> turns;
  uint32_t round = 0;
  const uint32_t savedSeed = cfg_.tieBreakSeed;
  const bool savedCanon = cfg_.canonicalizeSymmetry;
  // anchorsOf() above decodes per-block anchors straight out of the NodeKey,
  // but signatureFromAnchors SORTS each symmetry group's packed anchors, so on
  // a board with same-shape blocks d[i] is not block i's anchor. Every drag
  // recorded in round 0 then named a permuted label, reconstructTurns failed
  // its reachability check and finalizePlan returned {} — so round 0 was
  // systematically thrown away (odds of the root already being canonical are
  // 1/k! per group), and the retry below treated a structural bug as a "rare"
  // mix-up. Only round 1+ could ever return a plan.
  //
  // Canonicalisation only buys state-space collapsing, and only groups make it
  // differ from the identity, so drop it up front exactly when it would break
  // the decode. Boards without same-shape blocks are unaffected.
  if (!symmetryGroups_.empty())
    cfg_.canonicalizeSymmetry = false;
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
    cfg_.jamPinRoute = savedPin || (round & 1u) != 0;
    jamPinned_ = false;
    const auto jitter = [&](const NodeKey &k) -> uint32_t {
      uint32_t x = seed;
      const uint16_t *d = k.data();
      for (size_t i = 0; i < nBlocks; i++)
        x = (x ^ d[i]) * 0x85EBCA6Bu;
      x ^= x >> 15u;
      return x & 0x3FFu;
    };

    arena.clear();
    layer.clear();
    visited.clear();
    const NodeKey rootKey = signatureFromAnchors(initialAnchors_);
    arena.push_back({.key = rootKey, .parent = -1, .move = {}});
    layer.push_back(0);
    visited.insert(rootKey);

    int32_t goalArena = -1;
    constexpr size_t MAX_DEPTH = 72;
    for (size_t depth = 0; depth < MAX_DEPTH && goalArena < 0 && !layer.empty();
         depth++) {
      if (deadline != 0 && nowMs() >= deadline)
        break;
      if (cfg_.cancel && cfg_.cancel->load(std::memory_order_relaxed))
        break;
      // Memory ceiling. The beam keeps EVERY layer of the round resident
      // (`arena` is cleared per round, not per depth) plus a `visited` set of
      // the same keys, so at W up to 150k x MAX_DEPTH it is the hungriest arm
      // there is — yet it was the only search entry point that never consulted
      // cfg_.maxHeapBytes. On the isolated build all 8 arms share ONE wasm
      // heap and exhausting it ABORTS the module rather than retiring one arm.
      if (cfg_.maxHeapBytes != 0) {
        if (const uint64_t used = memprobe::liveAllocatedBytes();
            used != 0 && used >= cfg_.maxHeapBytes) {
          std::cout << "beam-jam hit memory ceiling (" << (used >> 20u)
                    << " MB of " << (cfg_.maxHeapBytes >> 20u) << " MB)\n";
          stats_.stoppedOnMemory = true;
          break;
        }
      }
      cands.clear();
      const auto keepBestW = [&] {
        if (cands.size() <= 2 * static_cast<size_t>(W))
          return;
        std::ranges::nth_element(cands, cands.begin() + W,
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
        if (onProgress && stats_.nodesExpanded % 4096 == 0)
          onProgress(stats_.nodesExpanded);
        const uint32_t jamBase = computeJamField(anchors);
        if (jamBase < stats_.minJamTerm)
          stats_.minJamTerm = jamBase;
        const auto [gPosX, gPosY] = anchors[goalIndex_];
        if (const uint16_t gProg = progressIndex_[gPosX * gridHeight_ + gPosY];
            gProg > stats_.maxProgress)
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
              jamChild = std::min<uint32_t>(jamField_[toIdx], 1u << 19u);
              h = t.x == goalAnchor_.x && t.y == goalAnchor_.y ? 0 : 1;
              if (h == 0) {
                // Goal reached: commit this child immediately.
                arena.push_back({.key = std::move(ck),
                                 .parent = ai,
                                 .move = {.blockId = i, .toIdx = toIdx}});
                goalArena = static_cast<int32_t>(arena.size()) - 1;
                break;
              }
            } else {
              jamChild = std::min<uint32_t>(
                  jamBase - jamOldOverlap +
                      cfg_.jamBlockerPenalty *
                          blockCellsOnMask(i, t, jamSweepRows_),
                  1u << 19u);
              h = 1;
            }
            const uint64_t score = static_cast<uint64_t>(jamChild) << 14u |
                                   static_cast<uint64_t>(h) << 10u | jitter(ck);
            cands.push_back({.score = score,
                             .key = std::move(ck),
                             .parent = ai,
                             .move = {.blockId = i, .toIdx = toIdx}});
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
        std::ranges::nth_element(cands, cands.begin() + W,
                                 [](const BeamCand &a, const BeamCand &b) {
                                   return a.score < b.score;
                                 });
        cands.resize(W);
      }
      std::ranges::sort(cands, [](const BeamCand &a, const BeamCand &b) {
        return a.score < b.score;
      });
      layer.clear();
      for (auto &c : cands) {
        if (!visited.insert(c.key).second)
          continue;
        arena.push_back(
            {.key = std::move(c.key), .parent = c.parent, .move = c.move});
        layer.push_back(static_cast<int32_t>(arena.size()) - 1);
      }
    }

    if (goalArena >= 0) {
      std::vector<DragMove> drags;
      for (int32_t cur = goalArena; cur >= 0 && arena[cur].parent >= 0;
           cur = arena[cur].parent)
        drags.push_back(arena[cur].move);
      std::ranges::reverse(drags);
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

  const uint64_t deadline = deadlineFrom(maxMs);

  struct Frame {
    std::vector<Position> anchors;
    std::vector<DragMove> drags;  // segment that produced this frame
    BannedSet banned;             // coarse keys of failed/consumed end states
    std::vector<SegmentAlt> alts; // prefetched alternative next-segments
    size_t nextAlt = 0;
    // Consecutive consolidation commits without cut progress leading here.
    // Bounded so micro-consolidations cannot stack into a bottomless spiral
    // (observed with small gains: thousands of frames oscillating at one
    // cut) — after the cap the next segment must advance the goal.
    uint8_t consolidationRun = 0;
  };
  std::vector<Frame> stack;
  stack.push_back({.anchors = initialAnchors_,
                   .drags = {},
                   .banned = {},
                   .alts = {},
                   .nextAlt = 0,
                   .consolidationRun = 0});
  // The consolidation check reads displacement fields before the first
  // segment search populates them; with the packing guide active they are
  // slot-seeded and segment-independent, so computing them once here is
  // both safe and sufficient.
  if (cfg_.consolidationGain != 0 && packingGuideActive_)
    computeDisplacementFields(0);
  std::vector<uint32_t> failsAtDepth;
  uint32_t backtracks = 0;
  uint32_t segments = 0;

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
                << segments << " segments, " << backtracks << " backtracks, "
                << stats_.nodesExpanded << " nodes total\n";
      return finalizePlan(all);
    }

    const size_t depth = stack.size() - 1;
    // Consume a prefetched alternative before paying for any new search.
    if (cur.nextAlt < cur.alts.size()) {
      auto &[altDrags, altEndAnchors] = cur.alts[cur.nextAlt++];
      segments++;
      const uint32_t altP = progressOf(altEndAnchors);
      std::cout << "hier[d=" << depth << "] p=" << p << "->" << altP << " +"
                << altDrags.size() << " drags (alt " << cur.nextAlt << "/"
                << cur.alts.size() << ")\n";
      const uint8_t run =
          altP > p ? 0 : static_cast<uint8_t>(cur.consolidationRun + 1);
      stack.push_back({.anchors = std::move(altEndAnchors),
                       .drags = std::move(altDrags),
                       .banned = {},
                       .alts = {},
                       .nextAlt = 0,
                       .consolidationRun = run});
      continue;
    }
    if (failsAtDepth.size() <= depth)
      failsAtDepth.resize(depth + 1, 0);
    // Per-segment expansion budget: start small so doomed choices fail fast
    // and backtracking explores alternatives. Escalate PER STACK DEPTH — a
    // depth that keeps failing marks a structurally hard segment (a deep
    // multi-block dance), and it keeps its earned budget across the parking
    // alternatives that backtracking cycles through.
    //
    // Exponential settled-first escalation: hard segments earn deep budgets
    // quickly; the settled filter is dropped only late (its branching cut is
    // what makes deep intra-segment dances findable at all).
    constexpr uint32_t SEG_NODE_CAP = 120000;
    constexpr uint32_t SEG_NODE_CAP_MAX = 3840000;
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
    if (constexpr uint8_t MAX_CONSOLIDATION_RUN = 6;
        cfg_.consolidationGain != 0 && packingGuideActive_ &&
        cur.consolidationRun < MAX_CONSOLIDATION_RUN) {
      if (const uint32_t curDisp = displacementSum(cur.anchors);
          curDisp > cfg_.consolidationGain)
        consolidationBelow = curDisp - cfg_.consolidationGain;
    }
    // One search prefetches several coarse-distinct segment ends;
    // backtracking then cycles through them without re-searching.
    constexpr uint8_t SEG_ALTERNATIVES = 8;
    SegmentResult res = runAStarDrag(cur.anchors, p + 1, &cur.banned, deadline,
                                     cap, SEG_ALTERNATIVES, consolidationBelow);
    if (relaxSettled)
      cfg_.settledOnly = true;
    if (res.found) {
      std::cout << "hier[d=" << depth << "] p=" << p << ": " << res.alts.size()
                << " segment ends (" << (stats_.nodesExpanded - nodesBefore)
                << " nodes)\n";
      // Ban all prefetched ends now so an eventual re-search here explores
      // genuinely new territory.
      for (const auto &[drags, endAnchors] : res.alts)
        cur.banned.insert(coarseSignature(endAnchors));
      cur.alts = std::move(res.alts);
      cur.nextAlt = 0;
      continue;
    }
    std::cout << "hier[d=" << depth << "] p=" << p << " FAIL (cap=" << cap
              << (relaxSettled ? ", unsettled" : "")
              << (res.exhausted ? ", exhausted" : "") << ")\n";
    failsAtDepth[depth]++;
    backtracks++;
    if (constexpr uint32_t MAX_BACKTRACKS = 3000; backtracks > MAX_BACKTRACKS) {
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
