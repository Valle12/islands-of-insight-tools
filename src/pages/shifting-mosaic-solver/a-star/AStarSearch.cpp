// AStar: the unit-move search.
//
// search() drives the stride fallback around runAStar(), which is the A*
// loop itself. The post-processor that shortens what it returns lives in
// AStarOptimizer.cpp.

#include "ClangdCompat.h" // must stay first; see the header

#include "AStar.h"
#include "MemoryProbe.h"
#include "SolverClock.h"

#include <algorithm>
#include <compare>
#include <functional>
#include <iostream>
#include <queue>
#include <unordered_map>
#include <utility>

namespace {
// Runs a callback on scope exit — used to accumulate SearchStats on every
// return path of a search pass.
template <typename F> struct ScopeExit {
  F fn;
  explicit ScopeExit(F f) : fn(std::move(f)) {}
  ~ScopeExit() { fn(); }
  // Owns a side effect, not a resource: copying or moving one would run `fn`
  // more than once. Scope guards are always used as immovable locals.
  ScopeExit(const ScopeExit &) = delete;
  ScopeExit(ScopeExit &&) = delete;
  ScopeExit &operator=(const ScopeExit &) = delete;
  ScopeExit &operator=(ScopeExit &&) = delete;
};
template <typename F> ScopeExit(F) -> ScopeExit<F>;
} // namespace

namespace {
struct HeapEntry {
  uint32_t f;
  uint32_t g;
  // Pointers into the state map instead of a 48-byte NodeKey copy: 56 -> 24
  // bytes per queued entry. `key` addresses the map's own key, `info` its
  // value; both stay valid because the map is never erased from. Popping a
  // state therefore costs no states.find().
  const NodeKey *key = nullptr;
  AStar::StateInfo *info = nullptr;
  // Order by f; on ties, prefer the deeper node (larger g) so the search
  // dives toward goals instead of fanning out across an f-plateau.
  auto operator<=>(const HeapEntry &o) const {
    if (const auto c = f <=> o.f; c != 0)
      return c;
    return o.g <=> g;
  }
  bool operator==(const HeapEntry &o) const = default;
};
} // namespace

std::vector<Turn> AStar::reconstructPath(const StateInfo *goal) {
  // Walk cameFrom backward, collect macro moves, then expand each macro into
  // (slideDistance) 1-cell Turns.
  std::vector<InternalMove> moves;
  for (const StateInfo *cur = goal; cur && cur->hasParent; cur = cur->parent)
    moves.push_back(cur->move);
  std::ranges::reverse(moves);

  std::vector<Turn> turns;
  for (const auto &[blockId, direction, slideDistance] : moves) {
    const uint8_t d = slideDistance == 0 ? 1 : slideDistance;
    for (uint8_t k = 0; k < d; k++) {
      turns.push_back({.blockId = blockId, .direction = direction});
    }
  }
  return turns;
}

// Public entry: runs A* at the detected/forced move stride, and — when the
// stride was auto-detected (strideOverride==0) — falls back to stride-1 if
// the quantized search genuinely exhausts without a solution. Stride
// quantization is sound but not provably complete for every layout, so the
// fallback guarantees we never lose a puzzle that stride-1 could solve.
std::vector<Turn> AStar::search(const uint32_t maxMs, const uint32_t maxNodes) {
  stats_ = {};
  // ONE deadline for the whole entry point. runAStar takes a RELATIVE budget
  // and restarts its own clock, so handing each fallback pass the full maxMs
  // silently tripled the caller's budget (guided → stride-1 → BFS). That is
  // how a 300s browser solve reached 13 minutes: solveArmsParallel joins every
  // arm, so one arm overrunning holds the whole race open. Mirrors the
  // absolute-deadline convention DragSolver::search already follows.
  const uint64_t deadline = deadlineFrom(maxMs);
  const auto remainingMs = [deadline]() -> uint32_t {
    if (deadline == 0)
      return 0; // 0 == unlimited, preserved
    const uint64_t now = nowMs();
    return now >= deadline ? 1u : static_cast<uint32_t>(deadline - now);
  };
  const auto outOfTime = [deadline] {
    return deadline != 0 && nowMs() >= deadline;
  };

  std::vector<Turn> result = runAStar(maxMs, maxNodes);
  if (result.empty() && searchExhausted_ && moveStride_ > 1 &&
      cfg_.strideOverride == 0 && !outOfTime()) {
    std::cout << "A*: stride-" << static_cast<int>(moveStride_)
              << " search exhausted with no solution — falling back to "
                 "stride-1\n";
    const uint8_t saved = moveStride_;
    moveStride_ = 1;
    result = runAStar(remainingMs(), maxNodes);
    moveStride_ = saved;
  }
  // Last resort: if the guided search came up empty, retry as pure BFS
  // (weight 0, stride 1). BFS can't be led astray by a weak heuristic, so it
  // cracks dense puzzles where weighted A* just wanders. This only ever runs
  // when A* already failed, so it cannot regress a puzzle A* can solve.
  if (result.empty() && cfg_.bfsFallback && cfg_.weight != 0 && !outOfTime()) {
    std::cout << "A*: guided search found nothing — retrying as pure BFS\n";
    const uint8_t savedWeight = cfg_.weight;
    const uint8_t savedStride = moveStride_;
    cfg_.weight = 0;
    moveStride_ = 1;
    result = runAStar(remainingMs(), maxNodes);
    cfg_.weight = savedWeight;
    moveStride_ = savedStride;
  }
  if (cfg_.postProcess && !result.empty()) {
    const size_t beforeMoves = result.size();
    const size_t beforeSteps = countSteps(result);
    result = optimizeSolution(result);
    std::cout << "post-process: " << beforeMoves << " -> " << result.size()
              << " moves, " << beforeSteps << " -> " << countSteps(result)
              << " steps\n";
  }
  return result;
}

std::vector<Turn> AStar::runAStar(const uint32_t maxMs,
                                  const uint32_t maxNodes) {
  searchExhausted_ = false;
  if (unsolvableAtStart_) {
    std::cout << "A* short-circuit: a permanently-locked block sits on the "
                 "goal block's final footprint — puzzle is unsolvable\n";
    searchExhausted_ = true;
    return {};
  }

  const uint64_t deadline = deadlineFrom(maxMs);

  Node root(initialAnchors_);
  if (isGoalState(root))
    return {};

  const NodeKey rootSig = nodeSignature(root);

  StateMap states;
  std::unordered_map<NodeKey, Node, NodeKeyHash> nodeStore;
  std::priority_queue<HeapEntry, std::vector<HeapEntry>, std::greater<>>
      openHeap;

  auto *rootEntry = states.emplace(rootSig).first;
  rootEntry->value = {.gScore = 0,
                      .parent = nullptr,
                      .move = {},
                      .hasParent = false,
                      .closed = false};
  nodeStore.try_emplace(rootSig, root);
  openHeap.emplace(cfg_.weight * heuristic(root), 0, &rootEntry->key,
                   &rootEntry->value);

  uint32_t nodesExpanded = 0;
  // Checkpoint cadence counter. It must count LOOP ITERATIONS, not expansions:
  // the two `continue`s below (stale heap entry, missing nodeStore entry) skip
  // nodesExpanded++, so a long drain of stale/closed duplicates — routine for
  // weighted A* with re-openings, and guaranteed at the tail of a large search
  // — freezes nodesExpanded. If its value is not a multiple of the mask, the
  // deadline, the cancel flag, the state ceiling and the memory ceiling are all
  // never re-evaluated again for the rest of the drain: the arm overruns its
  // budget, ignores a winner's cancel, and blows past the shared-heap cap that
  // exists to stop one arm aborting the whole module. DragSolver::runAStarDrag
  // already uses this exact pattern (`loopIters`).
  uint64_t loopIters = 0;
  const ScopeExit statsGuard{[this, &nodesExpanded, &states] {
    stats_.passes++;
    stats_.nodesExpanded += nodesExpanded;
    stats_.statesStored += states.size();
  }};

  while (!openHeap.empty()) {
    loopIters++;
    if (cfg_.cancel && (loopIters & 0xFFu) == 0 &&
        cfg_.cancel->load(std::memory_order_relaxed)) {
      std::cout << "A* cancelled after " << nodesExpanded << " nodes\n";
      return {};
    }
    if (deadline != 0 && (loopIters & 0xFFFu) == 0 && nowMs() > deadline) {
      std::cout << "A* timed out after " << nodesExpanded << " nodes (budget "
                << maxMs << "ms)\n";
      return {};
    }
    if (maxNodes != 0 && nodesExpanded >= maxNodes) {
      std::cout << "A* hit node cap of " << maxNodes
                << " (open=" << openHeap.size() << ", states=" << states.size()
                << ", store=" << nodeStore.size() << ")\n";
      return {};
    }
    // Graceful memory stop — see Config::maxStatesStored. maxNodes above bounds
    // EXPANSIONS, which is not what fills the heap; this bounds the live set.
    if (cfg_.maxStatesStored != 0 && (loopIters & 0xFFu) == 0 &&
        states.size() >= cfg_.maxStatesStored) {
      std::cout << "A* hit state ceiling of " << cfg_.maxStatesStored
                << " (states=" << states.size()
                << ", store=" << nodeStore.size() << ") after " << nodesExpanded
                << " nodes\n";
      return {};
    }
    // Last-resort abort tripwire. Only wasm has a ceiling that kills the
    // module rather than failing an allocation, so this exists only there —
    // a real #if, not `if constexpr`, because natively nearHeapLimit() is
    // `return false;` and every analyser correctly reports the guarded block
    // as dead code (2 findings that `if constexpr` did not silence).
#if defined(__EMSCRIPTEN__)
    if ((loopIters & 0xFF) == 0 && memprobe::nearHeapLimit()) {
      std::cout << "A* stopped at the heap limit after " << nodesExpanded
                << " nodes\n";
      stats_.stoppedOnMemory = true;
      return {};
    }
#endif
    if (cfg_.maxHeapBytes != 0 && (loopIters & 0xFFu) == 0) {
      if (const uint64_t used = memprobe::liveAllocatedBytes();
          used != 0 && used >= cfg_.maxHeapBytes) {
        std::cout << "A* hit memory ceiling (" << (used >> 20u) << " MB of "
                  << (cfg_.maxHeapBytes >> 20u) << " MB) after "
                  << nodesExpanded << " nodes\n";
        stats_.stoppedOnMemory = true;
        return {};
      }
    }
    const HeapEntry current = openHeap.top();
    openHeap.pop();

    // The heap entry carries the map node, so no states.find() per pop.
    StateInfo *const sit = current.info;
    if (sit == nullptr || sit->closed || sit->gScore < current.g)
      continue;

    sit->closed = true;
    auto nit = nodeStore.find(*current.key);
    if (nit == nodeStore.end())
      continue;
    Node node = std::move(nit->second);
    nodeStore.erase(nit);

    if (isGoalState(node)) {
      std::cout << "A* (w=" << static_cast<int>(cfg_.weight)
                << ") found solution in " << current.g << " moves, expanded "
                << nodesExpanded << " nodes\n";
      return reconstructPath(current.info);
    }

    nodesExpanded++;
    if (onProgress && nodesExpanded % 10000 == 0)
      onProgress(nodesExpanded);
    if (nodesExpanded % 2000000 == 0) {
      std::cout << "  ... A* working: " << nodesExpanded
                << " nodes, heap=" << openHeap.size()
                << ", states=" << states.size() << ", g=" << current.g << "\n";
      std::cout.flush();
    }

    if (cfg_.deadlockPruning && isDeadlocked(node.anchors))
      continue;

    for (const uint8_t i : movableBlockIndices_) {
      for (int d = 0; d < 4; d++) {
        // Slide block i in direction d until the first stride-aligned cell,
        // which is the only real search state in that direction; the cells
        // skipped on the way are valid 1-cell hops but never branched on.
        Position cursor = node.anchors[i];
        std::vector<Position> newAnchors = node.anchors;
        for (uint8_t k = 1;; k++) {
          const Position next = {.x = static_cast<int8_t>(cursor.x + DX[d]),
                                 .y = static_cast<int8_t>(cursor.y + DY[d])};
          if (!inBounds(i, next))
            break;
          // Restore previous slot then test collision against the rest.
          newAnchors[i] = next;
          if (collidesWithOthers(i, next, newAnchors))
            break;
          cursor = next;
          // Only stride-aligned cells are real search states; the cells in
          // between are valid 1-cell hops but never branched on.
          if (k % moveStride_ != 0)
            continue;

          Node newNode(newAnchors);
          const NodeKey newSig = signatureFromAnchors(newAnchors);

          const uint32_t newG = current.g + k;

          auto [newEntry, inserted] = states.emplace(newSig);
          if (StateInfo &child = newEntry->value;
              inserted || (!child.closed && newG < child.gScore)) {
            child = {.gScore = newG,
                     .parent = current.info,
                     .move = {.blockId = i,
                              .direction = DIRS[d],
                              .slideDistance = k},
                     .hasParent = true,
                     .closed = false};
            // Reuse insert_or_assign's iterator instead of a second find():
            // NodeKeyHash is a byte-at-a-time FNV-1a over 2*nBlocks bytes, so
            // the discarded lookup was a full re-hash plus a bucket probe on
            // every generated successor.
            const auto [storedIt, storedInserted] =
                nodeStore.insert_or_assign(newSig, std::move(newNode));
            openHeap.emplace(newG + cfg_.weight * heuristic(storedIt->second),
                             newG, &newEntry->key, &child);
          }

          break;
        }
      }
    }
  }

  std::cout << "A* found no solution, expanded " << nodesExpanded << " nodes\n";
  searchExhausted_ = true;
  return {};
}
