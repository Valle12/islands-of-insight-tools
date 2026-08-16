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

uint32_t DragSolver::beamWidth() const {
  if (cfg_.jam.beamWidth != 0)
    return cfg_.jam.beamWidth;
  return std::clamp<uint32_t>(
      static_cast<uint32_t>(gridWidth_) * gridHeight_ * 400, 20000, 150000);
}

void DragSolver::decodeAnchors(const NodeKey &key,
                               std::vector<Position> &out) const {
  const uint16_t *d = key.data();
  for (size_t i = 0; i < shapes_.size(); i++)
    out[i] = {.x = static_cast<int8_t>(d[i] >> 8u),
              .y = static_cast<int8_t>(d[i] & 0xFFu)};
}

uint32_t DragSolver::beamJitter(const NodeKey &key, const uint32_t seed) const {
  uint32_t x = seed;
  const uint16_t *d = key.data();
  for (size_t i = 0; i < shapes_.size(); i++)
    x = (x ^ d[i]) * 0x85EBCA6Bu;
  x ^= x >> 15u;
  return x & 0x3FFu;
}

bool DragSolver::roundBudgetSpent(const uint64_t deadline,
                                      const uint32_t maxNodes) const {
  if (deadline != 0 && nowMs() >= deadline)
    return true;
  if (cfg_.stop.cancel && cfg_.stop.cancel->load(std::memory_order_relaxed))
    return true;
  return maxNodes != 0 && stats_.nodesExpanded >= maxNodes;
}

bool DragSolver::beamRoundExhausted(const uint64_t deadline) {
  if (deadline != 0 && nowMs() >= deadline)
    return true;
  if (cfg_.stop.cancel && cfg_.stop.cancel->load(std::memory_order_relaxed))
    return true;
  // Memory ceiling. The beam keeps EVERY layer of the round resident
  // (`arena` is cleared per round, not per depth) plus a `visited` set of
  // the same keys, so at W up to 150k x MAX_DEPTH it is the hungriest arm
  // there is — yet it was the only search entry point that never consulted
  // cfg_.stop.maxHeapBytes. On the isolated build all 8 arms share ONE wasm
  // heap and exhausting it ABORTS the module rather than retiring one arm.
  if (cfg_.stop.maxHeapBytes == 0)
    return false;
  // 0 means the platform cannot measure — treat as "no information".
  const uint64_t used = memprobe::liveAllocatedBytes();
  if (used == 0 || used < cfg_.stop.maxHeapBytes)
    return false;
  std::cout << "beam-jam hit memory ceiling (" << (used >> 20u) << " MB of "
            << (cfg_.stop.maxHeapBytes >> 20u) << " MB)\n";
  stats_.stoppedOnMemory = true;
  return true;
}

void DragSolver::keepBestBeamCands(BeamRound &rd) {
  if (rd.cands.size() <= 2 * static_cast<size_t>(rd.width))
    return;
  std::ranges::nth_element(
      rd.cands, rd.cands.begin() + rd.width,
      [](const BeamCand &a, const BeamCand &b) { return a.score < b.score; });
  rd.cands.resize(rd.width);
}

void DragSolver::selectNextBeamLayer(BeamRound &rd) {
  // Select the next layer: best W distinct candidates.
  if (rd.cands.size() > rd.width) {
    std::ranges::nth_element(
        rd.cands, rd.cands.begin() + rd.width,
        [](const BeamCand &a, const BeamCand &b) { return a.score < b.score; });
    rd.cands.resize(rd.width);
  }
  std::ranges::sort(rd.cands, [](const BeamCand &a, const BeamCand &b) {
    return a.score < b.score;
  });
  rd.layer.clear();
  for (auto &c : rd.cands) {
    if (!rd.visited.insert(c.key).second)
      continue;
    rd.arena.push_back(
        {.key = std::move(c.key), .parent = c.parent, .move = c.move});
    rd.layer.push_back(static_cast<int32_t>(rd.arena.size()) - 1);
  }
}

void DragSolver::scoreBeamChildren(const uint8_t i, const BeamParent &parent,
                                   const uint32_t jamOldOverlap,
                                   const std::vector<uint16_t> &reached,
                                   BeamRound &rd) const {
  const Position from = rd.anchors[i];
  for (const uint16_t toIdx : reached) {
    const Position t = grid_.anchorFromIndex(toIdx);
    NodeKey ck = childSignature(parent.key, i, from, t);
    if (rd.visited.contains(ck))
      continue;
    uint32_t jamChild = 0;
    uint32_t h = 1;
    if (i == goalIndex_) {
      jamChild = std::min<uint32_t>(jamField_[toIdx], 1u << 19u);
      h = t.x == goalAnchor_.x && t.y == goalAnchor_.y ? 0 : 1;
      if (h == 0) {
        // Goal reached: commit this child immediately.
        rd.arena.push_back({.key = std::move(ck),
                            .parent = parent.arenaIndex,
                            .move = {.blockId = i, .toIdx = toIdx}});
        rd.goalArena = static_cast<int32_t>(rd.arena.size()) - 1;
        break;
      }
    } else {
      jamChild = std::min<uint32_t>(
          parent.jamBase - jamOldOverlap +
              cfg_.jam.blockerPenalty * blockCellsOnMask(i, t, jamSweepRows_),
          1u << 19u);
    }
    const uint64_t score = static_cast<uint64_t>(jamChild) << 14u |
                           static_cast<uint64_t>(h) << 10u |
                           beamJitter(ck, rd.seed);
    rd.cands.push_back({.score = score,
                        .key = std::move(ck),
                        .parent = parent.arenaIndex,
                        .move = {.blockId = i, .toIdx = toIdx}});
    keepBestBeamCands(rd);
  }
}

void DragSolver::expandBeamState(const int32_t ai, BeamRound &rd) {
  // Copy: arena may reallocate while children are appended later.
  const NodeKey parentKey = rd.arena[ai].key;
  decodeAnchors(parentKey, rd.anchors);
  stats_.nodesExpanded++;
  if (onProgress && stats_.nodesExpanded % 4096 == 0)
    onProgress(stats_.nodesExpanded);
  const uint32_t jamBase = computeJamField(rd.anchors);
  if (jamBase < stats_.minJamTerm)
    stats_.minJamTerm = jamBase;
  const auto [gPosX, gPosY] = rd.anchors[goalIndex_];
  if (const uint16_t gProg = progressIndex_[gPosX * gridHeight_ + gPosY];
      gProg > stats_.maxProgress)
    stats_.maxProgress = gProg;
  grid_.buildOccupancy(rd.anchors);
  const BeamParent parent{
      .key = parentKey, .arenaIndex = ai, .jamBase = jamBase};
  for (const uint8_t i : movableBlockIndices_) {
    if (rd.frozen[i])
      continue;
    const Position from = rd.anchors[i];
    const uint32_t jamOldOverlap =
        i != goalIndex_
            ? cfg_.jam.blockerPenalty * blockCellsOnMask(i, from, jamSweepRows_)
            : 0;
    grid_.removeBlock(i, from);
    const auto &reached = grid_.floodFill(i, from);
    stats_.floodFills++;
    scoreBeamChildren(i, parent, jamOldOverlap, reached, rd);
    grid_.addBlock(i, from);
    if (rd.goalArena >= 0)
      break;
  }
}

void DragSolver::expandBeamLayer(BeamRound &rd) {
  for (const int32_t ai : rd.layer) {
    expandBeamState(ai, rd);
    if (rd.goalArena >= 0)
      break;
  }
}

void DragSolver::runBeamRound(BeamRound &rd, const uint64_t deadline) {
  rd.arena.clear();
  rd.layer.clear();
  rd.visited.clear();
  rd.goalArena = -1;
  const NodeKey rootKey = signatureFromAnchors(initialAnchors_);
  rd.arena.push_back({.key = rootKey, .parent = -1, .move = {}});
  rd.layer.push_back(0);
  rd.visited.insert(rootKey);

  constexpr size_t MAX_DEPTH = 72;
  // A while, not a for: the stop conditions read state the body writes, which
  // is exactly what S1994 objects to in a for header.
  size_t depth = 0;
  while (depth < MAX_DEPTH && rd.goalArena < 0 && !rd.layer.empty() &&
         !beamRoundExhausted(deadline)) {
    rd.cands.clear();
    expandBeamLayer(rd);
    if (rd.goalArena < 0)
      selectNextBeamLayer(rd);
    depth++;
  }
}

std::vector<Turn> DragSolver::finalizeBeamPlan(const BeamRound &rd,
                                               const uint32_t round) {
  std::vector<DragMove> drags;
  for (int32_t cur = rd.goalArena; cur >= 0 && rd.arena[cur].parent >= 0;
       cur = rd.arena[cur].parent)
    drags.push_back(rd.arena[cur].move);
  std::ranges::reverse(drags);
  std::cout << "DragSolver(beam): round " << round << " found goal at "
            << drags.size() << " drags (beam " << rd.width << ")\n";
  std::vector<Turn> turns = finalizePlan(drags);
  if (turns.empty() && cfg_.canonicalizeSymmetry) {
    // Rare symmetry label mix-up (same as search()): replay caught an
    // inconsistent drag label. Rerun the remaining rounds label-exact.
    std::cout << "DragSolver(beam): symmetry label mix-up — continuing "
                 "without canonicalization\n";
    cfg_.canonicalizeSymmetry = false;
  }
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

  const uint64_t deadline = deadlineFrom(maxMs);
  BeamRound rd;
  rd.width = beamWidth();
  rd.anchors.resize(shapes_.size());
  rd.frozen.assign(shapes_.size(), false);
  for (const uint8_t b : cfg_.packing.frozenBlocks)
    rd.frozen[b] = true;

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
  const bool savedPin = cfg_.jam.pinRoute;
  // Both budgets zero means "no budget" (DragSolver.h), and roundBudgetSpent
  // then only ever fires on cancel. Every round is incomplete by design, so on
  // an unsolvable board an unbudgeted call would restart rounds forever — the
  // heap ceiling ends the ROUND, not the loop. `--budget-ms 0 --max-nodes 0`
  // on the bench CLI reaches exactly that. Diversification is long spent by
  // this many restarts anyway.
  constexpr uint32_t MAX_UNBUDGETED_ROUNDS = 64;
  const bool unbudgeted = deadline == 0 && maxNodes == 0;
  // A while, not `for (; turns.empty(); round++)`: that header tested a value
  // the body writes (S1994). `round` is stepped at the end of the body so the
  // stop conditions still skip it, exactly as the for's increment did.
  //
  // Both of those conditions live in the header rather than as breaks in the
  // body (cpp:S924 allows one): the round cap is a predicate so its diagnostic
  // can be printed AFTER the loop, where it needs no second exit.
  const auto roundCapHit = [&] {
    return unbudgeted && round >= MAX_UNBUDGETED_ROUNDS;
  };
  while (turns.empty() && !roundBudgetSpent(deadline, maxNodes) &&
         !roundCapHit()) {
    rd.seed = savedSeed + round * 0x9E3779B9u;
    // Odd beam rounds pin the root route (wide-board diversification).
    cfg_.jam.pinRoute = savedPin || (round & 1u) != 0;
    jamPinned_ = false;
    runBeamRound(rd, deadline);
    if (rd.goalArena >= 0)
      turns = finalizeBeamPlan(rd, round);
    stats_.passes++;
    stats_.statesStored += rd.visited.size();
    round++;
  }
  if (roundCapHit())
    std::cout << "DragSolver(beam): no budget given — stopping after "
              << MAX_UNBUDGETED_ROUNDS << " rounds\n";
  cfg_.canonicalizeSymmetry = savedCanon;
  cfg_.jam.pinRoute = savedPin;
  std::cout << "DragSolver(beam): " << round << " rounds, "
            << stats_.nodesExpanded << " expansions, "
            << (turns.empty() ? "no solution" : "SOLVED") << "\n";
  return turns;
}

bool DragSolver::hierPreconditionsOk() const {
  if (gridWidth_ > 64) {
    std::cout << "DragSolver: grid wider than 64 — not supported\n";
    return false;
  }
  if (unsolvableAtStart_) {
    std::cout << "DragSolver(hier) short-circuit: unsolvable\n";
    return false;
  }
  if (isGoal(initialAnchors_))
    return false;
  // Corridor arm: only run when the synthetic bands actually fired. With
  // real cuts present this would just re-run plain hier, so decline instantly
  // and let the portfolio's hier arm cover it.
  if (cfg_.corridorBands && !corridorBandsActive_) {
    std::cout << "DragSolver(corridor): no bands synthesized — declining\n";
    return false;
  }
  return true;
}

bool DragSolver::hierBudgetSpent(const uint64_t deadline,
                                 const uint32_t maxNodes,
                                 const uint32_t segments,
                                 const uint32_t backtracks) const {
  if (cfg_.stop.cancel && cfg_.stop.cancel->load(std::memory_order_relaxed)) {
    std::cout << "DragSolver(hier): cancelled after " << segments
              << " segments\n";
    return true;
  }
  if (deadline != 0 && nowMs() > deadline) {
    std::cout << "DragSolver(hier): out of time after " << segments
              << " segments, " << backtracks << " backtracks\n";
    return true;
  }
  if (maxNodes != 0 && stats_.nodesExpanded >= maxNodes) {
    std::cout << "DragSolver(hier): node budget exhausted\n";
    return true;
  }
  return false;
}

std::vector<DragSolver::DragMove>
DragSolver::concatDrags(const std::vector<Frame> &stack) {
  std::vector<DragMove> all;
  for (const auto &f : stack)
    all.insert(all.end(), f.drags.begin(), f.drags.end());
  return all;
}

void DragSolver::pushAltFrame(std::vector<Frame> &stack, const uint32_t p,
                              const size_t depth) const {
  Frame &cur = stack.back();
  auto &[altDrags, altEndAnchors] = cur.alts[cur.nextAlt++];
  const uint32_t altP = progressOf(altEndAnchors);
  std::cout << "hier[d=" << depth << "] p=" << p << "->" << altP << " +"
            << altDrags.size() << " drags (alt " << cur.nextAlt << "/"
            << cur.alts.size() << ")\n";
  const uint8_t run =
      altP > p ? 0 : static_cast<uint8_t>(cur.consolidationRun + 1);
  // Built as a named local so the moved-from members are read out here,
  // before push_back can reallocate; `cur` dangling afterwards is then
  // harmless, and the caller continues immediately.
  Frame next(std::move(altEndAnchors), std::move(altDrags), run);
  stack.push_back(std::move(next));
}

uint32_t DragSolver::consolidationTargetFor(const Frame &cur) const {
  // With the packing guide active, also accept "consolidation" ends: no cut
  // progress, but the packing measurably closer to its final slots. Field
  // note: with the guide on, dispField_ is slot-seeded and thus identical
  // across segments, so comparing sums across calls is sound.
  if (constexpr uint8_t MAX_CONSOLIDATION_RUN = 6;
      cfg_.packing.consolidationGain == 0 || !packingGuideActive_ ||
      cur.consolidationRun >= MAX_CONSOLIDATION_RUN)
    return 0;
  const uint32_t curDisp = displacementSum(cur.anchors);
  return curDisp > cfg_.packing.consolidationGain ? curDisp - cfg_.packing.consolidationGain
                                          : 0;
}

DragSolver::HierStep
DragSolver::searchHierSegment(Frame &cur, std::vector<uint32_t> &failsAtDepth,
                              const size_t depth, const uint32_t p,
                              const uint64_t deadline) {
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
  const uint32_t consolidationBelow = consolidationTargetFor(cur);
  // One search prefetches several coarse-distinct segment ends;
  // backtracking then cycles through them without re-searching.
  constexpr uint8_t SEG_ALTERNATIVES = 8;
  SegmentResult res =
      runAStarDrag(cur.anchors, p + 1, &cur.banned, deadline, cap,
                   SEG_ALTERNATIVES, consolidationBelow);
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
    return {.found = true,
            .exhausted = res.exhausted,
            .relaxSettled = relaxSettled};
  }
  std::cout << "hier[d=" << depth << "] p=" << p << " FAIL (cap=" << cap
            << (relaxSettled ? ", unsettled" : "")
            << (res.exhausted ? ", exhausted" : "") << ")\n";
  failsAtDepth[depth]++;
  return {.found = false,
          .exhausted = res.exhausted,
          .relaxSettled = relaxSettled};
}

bool DragSolver::hierRootIsFinal(const HierStep &step,
                                 const BannedSet &banned) const {
  // Root segment: nothing to pop. A genuine exhaustion without the
  // settled restriction and with no banned ends means the puzzle has no
  // solution in the drag model — but ONLY when the segment search was
  // complete: the relevance filter is incomplete by design, so under it
  // exhaustion proves nothing (a jam fixture drained 828 filtered
  // states this way and was wrongly declared unsolvable).
  if (step.exhausted && banned.empty() && !cfg_.relevantOnly &&
      (!cfg_.settledOnly || step.relaxSettled)) {
    std::cout << "DragSolver(hier): root exhausted — unsolvable\n";
    return true;
  }
  if (step.exhausted && cfg_.relevantOnly) {
    // The filtered space is drained — retrying with a bigger cap cannot
    // help. Give up as a budget-style failure, not an unsolvable proof.
    std::cout << "DragSolver(hier): relevance-filtered space exhausted "
                 "— giving up (not an unsolvability proof)\n";
    return true;
  }
  return false;
}

void DragSolver::backjumpFrames(std::vector<Frame> &stack,
                                std::vector<uint32_t> &failsAtDepth,
                                const size_t depth) const {
  // Persistent failure at one depth means sibling ends are all doomed the
  // same way — the fatal choice was made earlier. Jump well back instead
  // of grinding through near-identical alternatives; keep half the earned
  // escalation so a return to this depth resumes with a deep budget.
  if (failsAtDepth[depth] < 6 || stack.size() <= 1)
    return;
  const size_t jump = std::min<size_t>(8, stack.size() - 1);
  for (size_t j = 0; j < jump; j++) {
    // Only the anchors are needed to ban the region; moving the whole Frame
    // would drag its banned set's owning pointer along for nothing.
    const std::vector<Position> popped = std::move(stack.back().anchors);
    stack.pop_back();
    if (!stack.empty())
      stack.back().banned.insert(coarseSignature(popped));
  }
  failsAtDepth[depth] /= 2;
  std::cout << "hier: backjump " << jump << " frames from d=" << depth << "\n";
}

std::vector<Turn> DragSolver::searchHierarchical(const uint32_t maxMs,
                                                 const uint32_t maxNodes) {
  stats_ = {};
  if (!hierPreconditionsOk())
    return {};

  const uint64_t deadline = deadlineFrom(maxMs);

  std::vector<Frame> stack;
  stack.emplace_back(initialAnchors_, std::vector<DragMove>{}, uint8_t{0});
  // The consolidation check reads displacement fields before the first
  // segment search populates them; with the packing guide active they are
  // slot-seeded and segment-independent, so computing them once here is
  // both safe and sufficient.
  if (cfg_.packing.consolidationGain != 0 && packingGuideActive_)
    computeDisplacementFields(0);
  std::vector<uint32_t> failsAtDepth;
  uint32_t backtracks = 0;
  uint32_t segments = 0;

  while (!stack.empty()) {
    if (hierBudgetSpent(deadline, maxNodes, segments, backtracks))
      return {};

    Frame &cur = stack.back();
    const uint32_t p = progressOf(cur.anchors);
    if (p >= middleCuts_ + 1) {
      const std::vector<DragMove> all = concatDrags(stack);
      std::cout << "DragSolver(hier): solved — " << all.size() << " drags, "
                << segments << " segments, " << backtracks << " backtracks, "
                << stats_.nodesExpanded << " nodes total\n";
      return finalizePlan(all);
    }

    const size_t depth = stack.size() - 1;
    // Consume a prefetched alternative before paying for any new search.
    if (cur.nextAlt < cur.alts.size()) {
      segments++;
      pushAltFrame(stack, p, depth);
      continue;
    }
    if (failsAtDepth.size() <= depth)
      failsAtDepth.resize(depth + 1, 0);
    const HierStep step =
        searchHierSegment(cur, failsAtDepth, depth, p, deadline);
    if (step.found)
      continue;

    backtracks++;
    if (constexpr uint32_t MAX_BACKTRACKS = 3000; backtracks > MAX_BACKTRACKS) {
      std::cout << "DragSolver(hier): backtrack limit reached\n";
      return {};
    }
    if (stack.size() == 1) {
      if (hierRootIsFinal(step, cur.banned))
        return {};
      continue;
    }
    // Retire this frame's end choice (and its whole coarse parking region)
    // and try the next-best end from the previous frame. Only the anchors are
    // needed for the ban, so the rest of the frame is simply dropped.
    const std::vector<Position> failedAnchors =
        std::move(stack.back().anchors);
    stack.pop_back();
    stack.back().banned.insert(coarseSignature(failedAnchors));
    backjumpFrames(stack, failsAtDepth, depth);
  }
  std::cout << "DragSolver(hier): search space exhausted, no solution\n";
  return {};
}
