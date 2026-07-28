#pragma once

#include "BitGrid.h"
#include "DragSolverConfig.h"
#include "NodeKey.h"
#include "StateTable.h"
#include "Types.h"

#include <cstdint>
#include <functional>
#include <unordered_set>
#include <vector>

// Drag-space solver. One search move ("drag") relocates a single block to ANY
// anchor reachable via 4-directional unit slides while all other blocks stay
// fixed — exactly one player step as the UI counts them (solutionView.ts
// folds all consecutive turns of one block into one step). Solutions that
// take hundreds of unit moves are often only a handful of drags deep, which
// is what makes the two giant fixtures tractable.
//
// Search is weighted A* over drags: g = number of drags, tie-broken toward
// deeper g and then fewer total cells traveled. The returned plan is expanded
// back into unit-move Turns (via each drag's flood-fill path), so callers,
// the optimizer and the UI see the same format as the unit-move engine.
//
// Requires gridWidth <= 64 (row-bitboard model); callers should fall back to
// the unit-move engine beyond that.
class DragSolver {
public:
  // Defined in DragSolverConfig.h; aliased here so every existing
  // DragSolver::Config spelling keeps working.
  using Config = DragSolverConfig;

  struct SearchStats {
    uint32_t nodesExpanded = 0;
    uint64_t statesStored = 0;
    // True when the search stopped because it hit maxHeapBytes rather than
    // exhausting the space or the clock — distinguishes "too big for this heap"
    // from "genuinely searched out", which the two need different responses to.
    bool stoppedOnMemory = false;
    uint64_t floodFills = 0;
    uint8_t passes = 0;
    // Jam telemetry: best (lowest) jam dig cost and deepest cut/band progress
    // any expanded state reached — "how close did a failed search get".
    uint32_t minJamTerm = UINT32_MAX;
    uint32_t maxProgress = 0;
  };

  // Optional per-expansion progress callback (throttled by the search).
  void setOnProgress(std::function<void(uint32_t)> cb) {
    onProgress = std::move(cb);
  }

  DragSolver(uint8_t gridWidth, uint8_t gridHeight,
             std::vector<std::vector<Position>> shapes,
             std::vector<Position> initialAnchors, uint8_t goalIndex,
             Position goalAnchor, Config config);

  // Replace the packer's slot assignment (packing guide) with an external
  // one: `slots[i]` = anchor index (x * gridHeight + y) for block i, or -1.
  // Lets callers race searches across enumerated alternative packings.
  void overrideSlots(const std::vector<int32_t> &slots) {
    packedSlot_ = slots;
    packedSlot_.resize(shapes_.size(), -1);
    packingGuideActive_ = true;
  }

  // maxMs == 0: no wall-clock budget; maxNodes == 0: no expansion budget.
  //
  // Both budgets are spelled out at every call site rather than defaulted. An
  // unbudgeted portfolio arm is never what a caller wants — it hangs the
  // browser instead of losing a race — and defaulting them also made CLion's
  // data-flow analysis fold `deadline` to 0 inside the entry points below,
  // reporting every budget guard as dead code (18 findings).
  std::vector<Turn> search(uint32_t maxMs, uint32_t maxNodes);

  // Hierarchical receding-horizon variant: solves "advance the goal past the
  // next cut" as a sequence of small exact drag searches, committing each
  // segment and backtracking over alternative segment end states (tabu on
  // failed ends) when a later segment cannot be solved. Built for deep
  // multi-phase puzzles whose flat search drowns; not optimal (the optimizer
  // cleans up), not complete under tight budgets — portfolio arm.
  std::vector<Turn> searchHierarchical(uint32_t maxMs, uint32_t maxNodes);

  // Assembly pipeline: when the packer found an off-sweep final packing,
  // place the clusters one at a time (goal block parked, placed clusters
  // ratcheted, focused per-piece searches, relaxation-ordered with retries),
  // then move the goal home through the cleared sweep. Solves
  // pack-then-slide puzzles (shiftingMosaicTest41-class) in about a second
  // where every monolithic search drowns. Returns empty when no packing
  // exists or a round fails — portfolio arm, not a replacement.
  std::vector<Turn> searchAssembly(uint32_t maxMs, uint32_t maxNodes);

  // Jam restart driver: a loop of short diversified flat searches (weight ×
  // settled × jam-guide strength × POR/relevance × fresh tie seed), each
  // with a bounded node cap so state maps stay small and get freed between
  // rounds (browser-heap-safe). The jam guide gives each round a dig-cost
  // gradient; the seed jitter makes every round explore a different equal-f
  // plateau — an informed lottery for serial-unlock jams where one fixed
  // ordering drowns. Incomplete per round but returns the first valid plan;
  // runs until the budget expires. Portfolio arm.
  std::vector<Turn> searchJamRestarts(uint32_t maxMs, uint32_t maxNodes);

  // Guided beam search: per-depth keep the best beamWidth states by
  // (jam dig cost, admissible h, seed jitter), all layers held in RAM with
  // parent links for reconstruction. Breadth against gradient-blind jam
  // plateaus — the strategy exhaustive BFS proved necessary on this class,
  // truncated by the jam guide so it fits a browser heap instead of a
  // multi-gigabyte disk. Restarts with a fresh jitter seed when a round
  // exhausts its depth cap without finding the goal. Incomplete by design —
  // portfolio arm.
  std::vector<Turn> searchBeamJam(uint32_t maxMs, uint32_t maxNodes);

  [[nodiscard]] const SearchStats &lastStats() const { return stats_; }

  // After a searchJamRestarts run that found no solution: the DEEPEST banked
  // elite (lowest jam term) — its board state, and the drag chain reaching it
  // from the root. Lets a caller DECOMPOSE a stalled board: the ratchet often
  // clears the goal's dig route (low jam) without ever committing the goal
  // along it, and the residual "finish from here" problem is far shallower
  // than the original. Every reachable state of a solvable board is itself
  // solvable (drags are reversible), so the residual is always well-posed;
  // stitching prefix + residual solution yields a full plan.
  [[nodiscard]] const std::vector<Position> &lastEliteAnchors() const {
    return lastEliteAnchors_;
  }
  // Root → elite as unit-move turns (empty when no elite was banked).
  [[nodiscard]] std::vector<Turn> lastElitePrefixTurns() {
    return lastElitePrefix_.empty() ? std::vector<Turn>{}
                                    : reconstructTurns(lastElitePrefix_);
  }

  // Luby restart sequence unit for 1-based round index i:
  // 1,1,2,1,1,2,4,1,1,2,1,1,2,4,8,... Multiplies jamRoundNodeCap when
  // jamLubyRestarts is set. Public for direct testing.
  [[nodiscard]] static constexpr uint64_t lubyUnit(uint32_t i) {
    if (i == 0)
      return 1;
    // u_i = 2^(k-1) when i = 2^k - 1; otherwise the sequence repeats its own
    // prefix, so fold i into that prefix and re-derive k (re-deriving is the
    // easy step to miss — without it k underflows past zero).
    uint64_t k = 1;
    while ((1ull << k) - 1 < i)
      k++;
    while ((1ull << k) - 1 != i) {
      k--;
      i -= static_cast<uint32_t>((1ull << k) - 1);
      k = 1;
      while ((1ull << k) - 1 < i)
        k++;
    }
    return 1ull << (k - 1);
  }

  // Cheap jam-class predicate for portfolio gating: no REAL cut bottlenecks,
  // compact aspect (≤ 2.6), dense (≥ 40%) — the serial-unlock profile the jam
  // arms are built for. Calibrated on the banked fuzz boards: fires on the jam
  // class (10276/12366/3870/...), not on thin-corridor boards (1022/3086) or
  // cut-structured puzzles. Constant-time after construction.
  // Defined in DragSolver.cpp, not here: middleCuts_ and corridorBandsActive_
  // are written only by computeCutSchedule(), so in any translation unit that
  // sees this header without that .cpp the analyser reads their in-class
  // initialisers as the only possible values and calls the first test dead.
  [[nodiscard]] bool jamProfile() const;

  // DragMove and StateInfo are implementation details, but the search's
  // priority-queue entry (DragHeapEntry, file-scope in DragSolver.cpp) now
  // carries a StateInfo* instead of copying a 48-byte NodeKey, so it has to be
  // able to name the type. Nothing outside the solver uses these.
  struct DragMove {
    uint8_t blockId = 0;
    uint16_t toIdx = 0; // anchor index (x * gridHeight + y)
  };

  struct StateInfo {
    uint32_t gScore = UINT32_MAX;
    uint32_t cells = UINT32_MAX; // cumulative unit cells traveled (tie-break)
    // Parent link as a POINTER, not a copy of the parent's NodeKey. A NodeKey
    // is 48 bytes and used to be two thirds of this struct; every stored state
    // paid it, and memory is what bounds this solver (the browser races 8 arms
    // inside one 8GB heap). 72 -> 32 bytes per state.
    //
    // Safe because std::unordered_map guarantees that references and pointers
    // to elements survive inserts and rehashes, and `states` is never erased —
    // the same guarantee runAStarDrag already relies on when it holds
    // `StateInfo &info` across successor inserts. nullptr = root.
    //
    // The parent chain is only ever walked for `move`, never for an ancestor's
    // key, so following pointers also removes a hash lookup per step.
    const StateInfo *parent = nullptr;
    DragMove move{};
    uint16_t batchesEmitted = 0; // PEA*: successor batches already pushed
    bool hasParent = false;
    bool closed = false;
    // sleepSets: blocks whose drags this node skips (bit per block id) —
    // they commute with the move that created the node. Trailing member so
    // existing 7-element aggregate inits keep working (defaults to 0).
    uint32_t slept = 0;
  };

private:
  using StateMap = StateTable<StateInfo>;

  uint8_t gridWidth_;
  uint8_t gridHeight_;
  std::vector<std::vector<Position>> shapes_;
  std::vector<Position> initialAnchors_;
  uint8_t goalIndex_;
  Position goalAnchor_;
  Config cfg_;

  BitGrid grid_;
  std::vector<std::vector<uint8_t>> symmetryGroups_;
  std::vector<uint8_t> movableBlockIndices_;
  bool unsolvableAtStart_ = false;
  // Goal block's final footprint as row masks (heuristic + deadlock checks).
  std::vector<uint64_t> goalFinalRows_;
  // Cut schedule — the workhorse of the drag heuristic. The goal block's
  // static anchor graph (locked blocks as the only walls) has a totally
  // ordered set of start→target cut anchors v_1..v_k: every solution's goal
  // trajectory visits them in that order. progressIndex_[anchor] = number of
  // cuts already crossed when the goal sits at `anchor`; cutSuffixRows_[p] =
  // union of the goal footprints of the still-ahead cuts v_{p+1}..v_k. Any
  // movable block intersecting that suffix mask must move at least once in
  // any remaining solution (the goal must pass through it), so counting them
  // is admissible AND consistent in drag space — and, unlike a static mask,
  // it lets blocks re-park behind the goal without phantom penalties.
  std::vector<uint16_t> progressIndex_;
  std::vector<std::vector<uint64_t>> cutSuffixRows_;
  // Number of middle cuts; "progress == middleCuts_ + 1" means the goal
  // anchor sits exactly on the target.
  uint32_t middleCuts_ = 0;
  // True when computeCutSchedule synthesized corridor bands (0 real cuts +
  // long path + cfg_.corridorBands). Lets the corridor arm decline instantly
  // when it would just duplicate plain hier (real cuts present).
  bool corridorBandsActive_ = false;
  void computeCutSchedule();
  // Per-block BFS distance (over anchor moves, locked blocks as the only
  // obstacles) to the nearest anchor whose footprint clears a given suffix
  // mask. Recomputed per runAStarDrag call for its target progress; used
  // ONLY as a heap tie-break (a drag reaches any distance for cost 1, so
  // distance may not enter the admissible h). UINT16_MAX = no such anchor.
  std::vector<std::vector<uint16_t>> dispField_;
  void computeDisplacementFields(uint32_t maskIndex);
  // Feasible final anchors, one per non-goal movable block (empty when no
  // packing was found). Computed once at construction when packingGuide is
  // on; dispField_ then measures distance to the assigned slot.
  std::vector<int32_t> packedSlot_;
  bool packingGuideActive_ = false;
  void computeFinalPacking();
  // Packing variant generator: cellOrderVariant selects one of four
  // first-empty-cell scan orders, demotedPiece (block id, or -1) is tried
  // last at every cell — together they steer the DFS toward structurally
  // different packings. Fills packedSlot_ and returns success.
  bool tryComputePacking(int cellOrderVariant, int demotedPiece);
  [[nodiscard]] uint32_t
  displacementSum(const std::vector<Position> &anchors) const;
  SearchStats stats_{};
  // Kept out of the hot scalar block above deliberately — this is cold state.
  std::function<void(uint32_t)> onProgress;
  // Deepest elite of the last searchJamRestarts run (see lastEliteAnchors).
  std::vector<Position> lastEliteAnchors_;
  std::vector<DragMove> lastElitePrefix_;

  [[nodiscard]] bool isGoal(const std::vector<Position> &anchors) const {
    const auto &[ax, ay] = anchors[goalIndex_];
    return ax == goalAnchor_.x && ay == goalAnchor_.y;
  }
  [[nodiscard]] uint32_t heuristic(const std::vector<Position> &anchors) const;
  [[nodiscard]] bool blockOnMask(uint8_t i, Position a,
                                 const std::vector<uint64_t> &mask) const;
  [[nodiscard]] uint32_t
  blockCellsOnMask(uint8_t i, Position a,
                   const std::vector<uint64_t> &mask) const;
  [[nodiscard]] bool blockOnGoalFootprint(uint8_t i, Position a) const;

  // Relevance mask: goal ∪ blocks on the goal's shortest-path sweep (R0) ∪
  // blocks touching R0's cells, dilated relevantRing_ times. UINT32_MAX means
  // "no filtering" — either the goal is already home or no walls-only path
  // exists. `lockedRows` is the locked-block wall mask the caller built once.
  [[nodiscard]] uint32_t
  relevanceMaskOf(const std::vector<Position> &anchors,
                  const std::vector<uint64_t> &lockedRows) const;

  // sleepSets bookkeeping for one expanded block: records its interaction
  // envelope (its cells at `from` plus at every reachable anchor) into
  // `envRows[i]`, derives which earlier-indexed blocks it provably commutes
  // with into `sleptMaskOf[i]`, and marks bit i in `iterated`.
  void updateSleepEnvelope(uint8_t i, Position from,
                           const std::vector<uint16_t> &reached,
                           std::vector<std::vector<uint64_t>> &envRows,
                           std::vector<uint32_t> &sleptMaskOf,
                           uint32_t &iterated) const;

  // One combined budget checkpoint for the drag search: cancellation, wall
  // clock, state ceiling, measured heap and node cap. Reports the reason on
  // `verbose` and sets stats_.stoppedOnMemory for the two memory cases; the
  // caller unwinds. Cheap checks are gated on the loop counter by the caller.
  [[nodiscard]] bool dragBudgetExhausted(uint64_t deadline,
                                         uint32_t nodesExpanded,
                                         size_t statesStored, bool verbose);
  [[nodiscard]] std::vector<bool>
  computeMovableSet(const std::vector<Position> &anchors) const;
  [[nodiscard]] bool isDeadlocked(const std::vector<Position> &anchors) const;
  [[nodiscard]] NodeKey
  signatureFromAnchors(const std::vector<Position> &anchors) const;
  // Region-quantized signature (anchors >> 2): near-identical parking
  // variants collapse to one key. Used for hierarchical backtracking bans so
  // one failure retires a whole doomed parking choice, not one micro-variant.
  [[nodiscard]] NodeKey
  coarseSignature(const std::vector<Position> &anchors) const;
  // Parent signature + one block's move, without rebuilding the anchor
  // vector. Handles the same-shape group re-sort.
  [[nodiscard]] NodeKey childSignature(const NodeKey &parentKey, uint8_t block,
                                       Position oldPos, Position newPos) const;
  // blockGroup_[i] = index into symmetryGroups_, or -1.
  std::vector<int16_t> blockGroup_;
  // relevantOnly: current dependency-ring depth (1 = path blockers + blocks
  // touching them). search() widens it when the filtered space exhausts
  // without a solution — exhaustion is fast, so escalation is nearly free.
  uint8_t relevantRing_ = 1;

  // Jam guide scratch (cfg_.jamGuideWeight > 0): jamField_[anchor] = dig cost
  // of the goal's cheapest route anchor → target under the CURRENT occupancy
  // (step 4 + jamBlockerPenalty per newly swept movable cell; locked cells
  // are walls), rebuilt once per expansion. jamSweepRows_ = the argmin
  // route's swept footprint from the goal's current anchor — non-goal
  // candidate drags adjust the parent's term by their footprint's sweep
  // overlap delta instead of re-running the Dijkstra.
  std::vector<uint32_t> jamField_;
  std::vector<int32_t> jamNextHop_;
  std::vector<uint64_t> jamSweepRows_;
  std::vector<uint64_t> jamMovRows_;
  std::vector<uint64_t> jamLockRows_;
  // jamPinRoute: 2-dilated footprint of the first dig field's argmin route;
  // later Dijkstras only traverse anchors whose footprint stays inside it.
  std::vector<uint64_t> jamPinRows_;
  bool jamPinned_ = false;
  // Rebuilds jamField_/jamSweepRows_ for `anchors`. Returns the goal's own
  // term, UINT32_MAX when the target is unreachable even through walls-only.
  uint32_t computeJamField(const std::vector<Position> &anchors);

  // Successor candidate before any map/heap work is spent on it.
  struct Cand {
    uint32_t f;
    uint32_t cells;
    uint32_t tie;
    uint16_t toIdx;
    uint8_t blockId;
  };
  // Per-expansion scratch (avoids re-allocation).
  std::vector<Cand> candScratch_;
  std::vector<uint8_t> onMaskScratch_;
  std::vector<uint32_t> dispContribScratch_;

  // Progress of a state: middle cuts crossed, +1 once exactly on target.
  [[nodiscard]] uint32_t progressOf(const std::vector<Position> &anchors) const;

  struct SegmentAlt {
    std::vector<DragMove> drags;
    std::vector<Position> endAnchors;
  };
  struct SegmentResult {
    bool found = false;
    // Open list drained without hitting a node/time cap: a genuine "no
    // solution from here", not a budget artifact.
    bool exhausted = false;
    // On a jam-guided failure: the drag chain to the expanded state with the
    // lowest jam term seen — the deepest credible progress this round made.
    // searchJamRestarts feeds these back as warm-start elites, so successive
    // rounds resume where the best prior round got stuck instead of
    // re-treading from the root. Empty when the guide is off or nothing beat
    // the root.
    std::vector<DragMove> bestPartialDrags;
    uint32_t bestPartialJam = UINT32_MAX;
    // Qualifying end states in f order, pairwise coarse-distinct. One search
    // can hand the hierarchical driver several structurally different
    // parking outcomes; cycling them on backtrack costs nothing.
    std::vector<SegmentAlt> alts;
    std::vector<DragMove> drags; // == alts[0].drags (flat-search callers)
    std::vector<Position> endAnchors;
  };
  using BannedSet = std::unordered_set<NodeKey, NodeKeyHash>;

  // ---- runAStarDrag phases -------------------------------------------------
  // runAStarDrag was one 460-line function; these carry its phases. Every one
  // is defined in DragSolverSearch.cpp beside its only caller, so the compiler
  // still sees the definitions and inlines the hot ones as before — the split
  // is for readability, not linkage.

  // Search-lifetime scratch: the sleep-set envelopes and the locked-only wall
  // mask the per-state relevance BFS runs against.
  struct DragScratch {
    std::vector<std::vector<uint64_t>> envRows;
    std::vector<uint32_t> sleptMaskOf;
    std::vector<uint64_t> relevanceLocked;
    bool por = false;
  };
  // Everything one expansion's candidate scoring reads: the popped state plus
  // the base heuristic and displacement terms computed once for it. `anchors`
  // and `maskP` are references into runAStarDrag's frame, and no instance
  // outlives the iteration that built it.
  struct DragExpansion {
    const std::vector<Position> &anchors;
    const std::vector<uint64_t> &maskP;
    uint32_t baseCount;
    uint32_t dispBase;
    uint32_t jamBase;
    uint32_t g;     // popped state's g
    uint32_t cells; // popped state's cumulative cells traveled
    uint32_t slept;
    uint16_t gProg;
    bool useSlotH;
  };
  // The collect-ends bookkeeping recordEnd needs beyond the solver's members.
  struct EndContext {
    const BannedSet *bannedEnds;
    BannedSet &seenEnds;
    SegmentResult &result;
    uint8_t collectEnds;
    bool verbose;
  };

  void initSearchScratch(DragScratch &scratch) const;
  [[nodiscard]] static bool dragCapReached(uint32_t nodeCap,
                                           uint32_t nodesExpanded,
                                           bool verbose);
  [[nodiscard]] static bool isStaleDragEntry(const StateInfo *info, uint32_t g,
                                             uint32_t cells);
  [[nodiscard]] bool qualifiesAsEnd(const std::vector<Position> &anchors,
                                    uint32_t g, uint32_t targetProgress,
                                    uint32_t consolidationBelow) const;
  // Records one qualifying end unless it is banned or coarse-duplicate.
  // Returns true once `collectEnds` distinct ends have been collected. `ctx` is
  // const because its two mutable targets are references — the struct itself is
  // never reseated.
  [[nodiscard]] bool recordEnd(const std::vector<Position> &anchors,
                               const StateInfo *state, uint32_t g,
                               uint32_t nodesExpanded,
                               const EndContext &ctx) const;
  // First visit of a state: counts it, reports progress, prunes deadlocks.
  // Returns false when the state must be closed instead of expanded.
  [[nodiscard]] bool prepareExpansion(const StateInfo &info,
                                      const std::vector<Position> &anchors,
                                      uint32_t g, uint32_t &nodesExpanded,
                                      size_t heapSize, size_t statesStored) const;
  void computeBaseScratch(const std::vector<Position> &anchors, bool useSlotH,
                          const std::vector<uint64_t> &maskP,
                          uint32_t &baseCount, uint32_t &dispBase);
  [[nodiscard]] uint32_t dispContribution(uint8_t b, size_t idx) const;
  // Rebuilds the jam field for `anchors` and tracks the best jam-term state.
  // Returns the state's own jam term, or 0 when the guide is off.
  uint32_t updateJamGuide(const std::vector<Position> &anchors,
                          const StateInfo *state,
                          const StateInfo *&bestJamState, uint32_t &bestJamVal);
  [[nodiscard]] uint32_t jamAdd(uint32_t term) const;
  [[nodiscard]] uint32_t jitterTie(uint8_t block, uint16_t toIdx,
                                   uint32_t g) const;
  [[nodiscard]] bool blockIsParked(uint8_t i, Position from,
                                   uint32_t relevantMask, uint32_t slept,
                                   bool por) const;
  [[nodiscard]] bool isSettledDrag(uint8_t i, Position t, uint16_t toIdx,
                                   uint16_t gProg) const;
  [[nodiscard]] uint32_t goalDragH(Position t, uint16_t toIdx,
                                   const DragExpansion &exp) const;
  [[nodiscard]] uint32_t offGoalDragH(uint8_t i, Position t, uint16_t toIdx,
                                      const DragExpansion &exp) const;
  [[nodiscard]] uint32_t jamChildTerm(uint8_t i, Position t, uint16_t toIdx,
                                      const DragExpansion &exp,
                                      uint32_t jamOldOverlap) const;
  void scoreDrags(uint8_t i, const std::vector<uint16_t> &reached,
                  uint32_t jamOldOverlap, const DragExpansion &exp);
  void generateCandidates(const DragExpansion &exp, DragScratch &scratch);
  [[nodiscard]] static bool isBetterChild(const StateInfo &child, bool inserted,
                                          uint32_t newG, uint32_t cells);
  // Templated on the node store, open heap and heap entry: DragHeapEntry is
  // file-scope in DragSolverSearch.cpp and this header must not name it.
  template <typename NodeStoreT, typename OpenHeapT, typename EntryT>
  void emitBatch(const DragExpansion &exp, const DragScratch &scratch,
                 const EntryT &current, StateMap &states, NodeStoreT &nodeStore,
                 OpenHeapT &openHeap);
  void finishDragStats(SegmentResult &result, uint32_t nodesExpanded,
                       size_t statesStored, const StateInfo *bestJamState,
                       uint32_t bestJamVal);
  static SegmentResult &finishSegment(SegmentResult &result, bool exhausted);

  // Weighted A* over drags from `startAnchors` until progressOf(state) >=
  // targetProgress (and the state's coarse signature is not in
  // `bannedEnds`). Collects up to `collectEnds` coarse-distinct qualifying
  // ends before returning (budget-hits still return what was collected).
  // consolidationBelow != 0 additionally accepts states whose
  // displacementSum() is <= that value (packing-consolidation ends).
  // deadline: absolute nowMs() limit (0 = none); nodeCap: expansions.
  SegmentResult runAStarDrag(const std::vector<Position> &startAnchors,
                             uint32_t targetProgress,
                             const BannedSet *bannedEnds, uint64_t deadline,
                             uint32_t nodeCap, uint8_t collectEnds = 1,
                             uint32_t consolidationBelow = 0);
  // Expands the drag plan into unit-move turns by replaying each drag's flood
  // fill from the initial state. Returns an empty vector if any drag turns
  // out inconsistent (symmetry label mix-up) — the caller then retries.
  std::vector<Turn> reconstructTurns(const std::vector<DragMove> &drags);
  // reconstructTurns + replay validation + optimizer.
  std::vector<Turn> finalizePlan(const std::vector<DragMove> &drags);
  [[nodiscard]] bool replayIsValid(const std::vector<Turn> &turns) const;
};
