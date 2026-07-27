// DragSolver: the pack-then-slide assembly pipeline.
//
// Places clusters one at a time against a precomputed packing, then brings
// the goal home through the cleared sweep. finalizePlan lives here because
// it is the shared tail every arm funnels through, and it needs AStar for
// the post-processor.

#include "DragSolver.h"
#include "SolverClock.h"

#include "AStar.h"

#include <algorithm>
#include <cstdlib>
#include <iostream>
#include <utility>

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

  const uint64_t deadline = deadlineFrom(maxMs);
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
    if (const auto &reached = grid_.floodFill(piece, slotPos(piece));
        reached.size() >= 40)
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
    size_t planLen = 0;            // plan length entering this round
    std::vector<uint8_t> placed;   // pieces placed (incl. incidental)
    std::vector<uint8_t> tried;    // pieces already attempted from here
    bool jointTried = false;       // endgame joint solve attempted here
  };
  const auto absorbOnSlot = [&](AsmFrame &f) {
    for (const uint8_t p : pieces) {
      if (std::ranges::find(f.placed, p) != f.placed.end())
        continue;
      if (f.anchors[p].x * H + f.anchors[p].y == packedSlot_[p])
        f.placed.push_back(p);
    }
  };
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
      if (std::ranges::find(f.placed, p) == f.placed.end())
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
      if (std::ranges::find(unfrozen, p) == unfrozen.end())
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
    // Inherit the resource ceilings. ALL of the assembly arm's actual search
    // happens in these children — the outer solver only orchestrates — so
    // leaving them at 0 (unlimited) meant maxHeapBytes was silently ignored by
    // the whole arm. On the isolated build all 8 arms share ONE wasm heap and
    // exhausting it ABORTS the module, killing every other arm.
    c.maxHeapBytes = cfg_.maxHeapBytes;
    c.maxStatesStored = cfg_.maxStatesStored;
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
  std::unordered_set triedPackings{slotSig()};
  std::vector<std::pair<int, int>> variants; // (cellOrder, demoted block id)
  for (int co = 0; co < 4; co++)
    for (int di = -1; di < static_cast<int>(pieces.size()); di++) {
      if (co == 0 && di == -1)
        continue; // the constructor's packing, already tried first
      variants.emplace_back(co, di < 0 ? -1 : pieces[di]);
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
      if (std::ranges::find(cur.placed, p) != cur.placed.end())
        continue;
      if (std::ranges::find(cur.tried, p) != cur.tried.end())
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
      if (const auto jturns = jointEndgame(cur, jointBudget);
          !jturns.empty()) {
        anchors = cur.anchors;
        for (const auto &[blockId, direction] : jturns)
          anchors[blockId] = {
              static_cast<int8_t>(anchors[blockId].x +
                                  BitGrid::DX[std::to_underlying(direction)]),
              static_cast<int8_t>(anchors[blockId].y +
                                  BitGrid::DY[std::to_underlying(direction)])};
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
      if (constexpr uint32_t MAX_BACKTRACKS = 80;
          backtracks > MAX_BACKTRACKS) {
        std::cout << "assembly: backtrack limit for this packing\n";
        attemptOver = true;
      }
      continue;
    }
    // Deepest slot first (farthest from where the goal parks), then the
    // piece nearest its slot — back columns fill before they get sealed.
    std::ranges::sort(candidates,
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
    // See jointEndgame: the child does the searching, so it must inherit the
    // heap/state ceilings or the arm has none.
    c.maxHeapBytes = cfg_.maxHeapBytes;
    c.maxStatesStored = cfg_.maxStatesStored;
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
    for (const auto &[blockId, direction] : turns) {
      next.anchors[blockId].x = static_cast<int8_t>(
          next.anchors[blockId].x + BitGrid::DX[std::to_underlying(direction)]);
      next.anchors[blockId].y = static_cast<int8_t>(
          next.anchors[blockId].y + BitGrid::DY[std::to_underlying(direction)]);
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
      if (const auto [co, dp] = variants[nextVariant++]; !tryComputePacking(co, dp))
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
    // See jointEndgame: inherit the heap/state ceilings.
    c.maxHeapBytes = cfg_.maxHeapBytes;
    c.maxStatesStored = cfg_.maxStatesStored;
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
    const AStar optimizer(gridWidth_, gridHeight_, shapes_, initialAnchors_,
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
    const AStar optimizer(gridWidth_, gridHeight_, shapes_, initialAnchors_,
                          goalIndex_, goalAnchor_, oc);
    const size_t beforeMoves = turns.size();
    turns = optimizer.optimizeSolution(turns);
    std::cout << "post-process: " << beforeMoves << " -> " << turns.size()
              << " moves\n";
  }
  return turns;
}

std::vector<Turn>
DragSolver::reconstructTurns(const std::vector<DragMove> &drags) {
  std::vector<Position> anchors = initialAnchors_;
  std::vector<Turn> turns;
  for (const auto &[dragBlockId, dragToIdx] : drags) {
    const Position from = anchors[dragBlockId];
    grid_.buildOccupancy(anchors);
    grid_.removeBlock(dragBlockId, from);
    grid_.floodFill(dragBlockId, from);
    if (!grid_.wasReached(dragToIdx))
      return {};
    // Walk parent directions target -> start, then emit forward.
    std::vector<Direction> path;
    uint16_t cur = dragToIdx;
    const uint16_t startIdx = grid_.anchorIndex(from);
    while (cur != startIdx) {
      const int8_t d = grid_.parentDirOf(cur);
      path.push_back(BitGrid::DIRS[d]);
      const auto [px, py] = grid_.anchorFromIndex(cur);
      cur = grid_.anchorIndex({static_cast<int8_t>(px - BitGrid::DX[d]),
                               static_cast<int8_t>(py - BitGrid::DY[d])});
    }
    std::ranges::reverse(path);
    for (const Direction dir : path)
      turns.push_back({dragBlockId, dir});
    anchors[dragBlockId] = grid_.anchorFromIndex(dragToIdx);
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
    const auto d = std::to_underlying(direction);
    const Position to = {static_cast<int8_t>(from.x + BitGrid::DX[d]),
                         static_cast<int8_t>(from.y + BitGrid::DY[d])};
    grid.removeBlock(blockId, from);
    if (!grid.canPlace(blockId, to.x, to.y))
      return false;
    grid.addBlock(blockId, to);
    anchors[blockId] = to;
  }
  const auto &[gx, gy] = anchors[goalIndex_];
  return gx == goalAnchor_.x && gy == goalAnchor_.y;
}
