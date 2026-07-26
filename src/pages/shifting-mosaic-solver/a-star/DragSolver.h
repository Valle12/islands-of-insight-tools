#pragma once

#include "BitGrid.h"
#include "Node.h"
#include "NodeKey.h"
#include "Types.h"

#include <atomic>
#include <cstdint>
#include <functional>
#include <string>
#include <unordered_map>
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
  struct Config {
    uint8_t weight = 2;
    bool deadlockPruning = true;
    // Canonicalise same-shape block permutations in state signatures. On the
    // rare chance reconstruction detects a label mix-up (see search()), the
    // solver retries once with this off.
    bool canonicalizeSymmetry = true;
    // Only emit drag targets where the block ends "settled": flush against
    // something both vertically and horizontally (plus, for the goal block,
    // any progress-advancing anchor). Kills the explosion of floating
    // mid-air parking variants; human-style plans use settled spots. Not
    // provably complete — pair with a full-expansion arm in a portfolio.
    bool settledOnly = false;
    // Partial expansion (PEA*): emit only the best N successors per
    // expansion and re-queue the parent at the next-best child's f. Caps
    // heap/state growth on very wide nodes without losing completeness or
    // optimality (children are emitted in f order). 0 = full expansion.
    uint16_t partialExpansionWidth = 0;
    // Precompute a feasible final packing of the non-goal blocks into
    // anchors clear of the whole cut sweep, and use per-block distance to
    // the assigned slot as the search tie-break (instead of distance to any
    // off-mask anchor). Auto-disabled when no such packing exists or the
    // packing search exceeds its budget.
    bool packingGuide = true;
    // Weight of the displacement estimate INSIDE f (scaled /16). 0 keeps f
    // admissible; >0 trades optimality for a gradient toward the assigned
    // final packing — built for dense endgames where the admissible h is
    // nearly flat (shiftingMosaicTest41-class).
    uint8_t packingWeight = 0;
    // Hierarchical mode only: also accept segment ends whose packing-guide
    // displacement sum dropped by at least this much even without cut
    // progress ("the packing got meaningfully more assembled"). Chops a
    // giant repack-then-advance wall segment into several small commits.
    // 0 = off; requires the packing guide to have found slot assignments.
    uint8_t consolidationGain = 0;
    // Flat search: replace the cut-suffix heuristic with "number of blocks
    // not at their packing-guide slot, plus 1 if the goal is not home".
    // Admissible and consistent in drag space, and it rewards assembling
    // the final packing FIRST — the winning strategy when the goal's own
    // journey is trivial once everything else is packed (test41-class:
    // repack ~9 clusters, then one long goal drag). Requires the guide.
    bool slotHeuristic = false;
    // Strengthen the goal test: a state only counts as solved when every
    // movable non-goal block with an assigned slot is ON that slot (in
    // addition to the goal block reaching its anchor). Pairs with
    // slotHeuristic to solve "assemble the whole packing" sub-puzzles.
    bool requireAllSlots = false;
    // Ratchet assembly: a block standing on its assigned slot is frozen
    // (no drags generated for it). Collapses the search space as the
    // packing grows — the human strategy. Incomplete by design: plans that
    // must temporarily un-place a block are pruned.
    bool lockOnSlot = false;
    // Blocks that never move in this search (still collide). Used by the
    // assembly pipeline to park the real goal block during cluster
    // placement rounds.
    std::vector<uint8_t> frozenBlocks;
    // Commutativity pruning (one-step sleep sets): a child reached by
    // dragging block i skips generating drags for blocks j < i whose
    // interaction envelopes (cells sweepable by the block plus its start)
    // are disjoint from i's — those (i, j) orders duplicate the (j, i)
    // branch move-for-move. Sound and completeness/optimality-preserving;
    // costs an envelope mask per block per expansion.
    bool sleepSets = false;
    // Relevance filter: only generate drags for the goal block, blocks
    // whose cells intersect the goal's (locked-walls-only) shortest-path
    // sweep, and blocks adjacent to those — the human "unlock what blocks
    // the path, then what blocks the unblocker" order. Incomplete by
    // design (like settledOnly): a portfolio arm, not a default.
    bool relevantOnly = false;
    // Corridor mode: when the goal has NO unavoidable cut bottlenecks but a
    // long journey home (a narrow open corridor packed with movable blocks),
    // synthesize evenly-spaced waypoints along its shortest path as
    // pseudo-cuts, giving the hierarchical engine a graded progress signal
    // it otherwise lacks (0 real cuts → binary progress → flat search).
    // Guidance only (waypoints are not unavoidable); hier backtracks.
    bool corridorBands = false;
    // Minimum goal-path length (in anchors) that earns synthetic bands. The
    // guard exists so trivially-short journeys are not banded, but it is
    // length-based and length is NOT what makes a board hard: seeds 29534
    // (12x9 @ 63%), 39598 (12x9 @ 65%) and 39857 (21x6 @ 61%) all have 0 real
    // cuts and a 5-7 anchor path, so at the old value of 8 they got NO bands
    // at all. 0 real cuts AND no pseudo-cuts leaves progressOf binary — the
    // exact "flat search drowns" pathology bands were built to fix (seed
    // 1022) — and it also makes the corridor arm decline outright, so arm 3
    // of the browser race was a guaranteed no-op on that whole class.
    // Lowered to 3 after measuring the 8-arm race on all 44 production
    // fixtures: 44/44 still pass, total race time +0.26%, one fixture's plan
    // improves (14->12 moves) and one costs a move (test3, 10->11).
    uint8_t corridorBandMinPath = 3;
    // Jam guide: weight (scaled /16) of the dig-cost gradient INSIDE f. The
    // dig cost is a per-expansion Dijkstra of the goal's cheapest route to
    // the target where each newly swept movable-block cell costs
    // jamBlockerPenalty on top of the step cost — the only per-state signal
    // with a gradient on 0-cut compact jam boards, where the admissible
    // cut-suffix h is provably near-flat. Inadmissible (like packingWeight);
    // weighted/portfolio arms only. 0 = off (bit-identical search).
    uint8_t jamGuideWeight = 0;
    // Dig cost of one movable-block cell on the goal's route, in quarter-
    // steps (the step itself costs 4). 4 = one blocked cell ≈ one extra step.
    uint8_t jamBlockerPenalty = 4;
    // Beam width for searchBeamJam. 0 = auto (scaled to the board's anchor
    // count, capped for the wasm heap).
    uint32_t beamWidth = 0;
    // Ceiling on the LIVE state map of a single search pass. 0 = unlimited
    // (bit-identical to the historical behaviour).
    //
    // maxNodes bounds EXPANSIONS, which is not what consumes the heap: states
    // stored runs ~2.3x expansions, and on seed 45501 the flat drag arm held
    // 61.4M states for 26.8GB (~437 bytes/state). Until now nothing checked
    // the live set at all — statesStored was only summed into stats AFTER a
    // pass finished — so a search could only discover it was out of memory by
    // failing to allocate. Under wasm that ABORTS, and on the cross-origin
    // isolated path all 8 racing arms share ONE 8GB heap, so a single greedy
    // arm can take down arms that were about to win.
    //
    // Checked on the same cadence as the deadline and unwinds the same way, so
    // hitting it is an ordinary "no solution in budget", not a crash.
    // Per PASS, not cumulative: hierarchical searches free each segment's map
    // before the next, and peak memory is what matters.
    //
    // Deterministic, so this is the knob TESTS should use; maxHeapBytes below
    // is the production mechanism.
    uint64_t maxStatesStored = 0;
    // Aspect cutoff used by jamProfile(), as the ratio x16 (42 = 2.625). A
    // board whose longer side exceeds this multiple of its shorter side is
    // treated as "corridor territory" and the two jam specialists (arms 6 and
    // 7 of the race) decline on it.
    //
    // This leg has now excluded four boards the jam machinery can actually
    // handle: 41193 (37x9) is solved by the jam-restart arm in 12ms yet gated
    // out at aspect 4.1; 42889 (25x7, 3.6) likewise at 284s; and 39857 (21x6)
    // and 30033 (26x6) were excluded from band synthesis by the same test.
    // Relaxed from 42 (2.625x) to 66 (4.125x) after the full treatment:
    //   - bench diff, 56 fixtures: 0 regressions, 1 new solve
    //     (fuzz-3058-hard, 131.7s -> 11.2s), total wall -10%
    //   - paired fuzz, 2,000 boards: 0 regressions, 0 invalid, 1 new solve
    //   - campaign v5, 10,000 fresh seeds: 9,994/10,000, 0 invalid, and
    //     nothing exceeding the 300s budget (v4 had four such boards)
    // It also converts three previously-unsolvable boards into race wins:
    // 41193 (49s), 42889 (179s) and 45501 (201s) — the last being the board
    // once profiled at 26.8GB and written off.
    // Must move together with jamDensityPct: on 41193 relaxing either alone
    // changes nothing, because that board fails both legs.
    uint8_t jamAspect16 = 66;
    // Density floor used by jamProfile(), in percent of grid cells filled.
    // The other half of the same story: seed 41193 (37x9) sits at 39.04%, just
    // under the stock 40, so relaxing the aspect cutoff alone still leaves it
    // gated out even though the jam-restart arm solves it in 12ms.
    // Relaxed 40 -> 35 alongside jamAspect16; the two were validated together
    // (see there for the bench/fuzz/campaign evidence) and neither works
    // alone. 40 reproduces the historical behaviour.
    uint8_t jamDensityPct = 35;
    // Ceiling on MEASURED live allocated bytes (memprobe::liveAllocatedBytes).
    // 0 = unlimited. Checked on the same cadence as the deadline and unwinds
    // the same way, so running out of memory reports "no solution in budget"
    // rather than aborting — which on the shared-heap browser path would take
    // down the seven other arms with it.
    //
    // Preferred over maxStatesStored in production because a state count is a
    // board-dependent proxy for bytes (NodeKey heap-allocates past 16 blocks).
    // Process-wide, not per-arm: under emscripten pthreads every arm allocates
    // from ONE heap, so that is the quantity that actually runs out.
    uint64_t maxHeapBytes = 0;
    // Pin the jam guide to one corridor: the FIRST dig field's argmin route
    // (dilated by 2 cells) becomes a hard corridor for every later dig
    // Dijkstra — the goal must go that way and blockers must leave it.
    // Stabilizes the gradient on wide boards where several competing routes
    // otherwise make the guide chase alternating corridors (seed 8697
    // class). Wrong-corridor risk is real: use as a diversification arm.
    bool jamPinRoute = false;
    // Diversification: when non-zero, the heap tie-break field is replaced by
    // a per-state hash mixed with this seed — restarts with different seeds
    // explore genuinely different plateaus of equal-f states. 0 = the
    // deterministic cells+displacement tie-break.
    uint32_t tieBreakSeed = 0;
    // searchJamRestarts round shaping. The built-in rounds are node-CAPPED
    // (1.5M), not time-capped, so a round costs ~80s and an hour buys ~45
    // restarts. The elite ratchet is a lottery — seed 8697 needed 110 rounds
    // — so trading depth-per-round for MORE rounds is a real axis, not a
    // tuning detail. jamRoundNodeCap lowers the per-round cap (0 = per-round
    // default); jamMaxElites widens the retained pool, which otherwise
    // collapses onto the six lowest jam values (one lineage) and loses the
    // higher-jam states a ridge crossing has to pass through.
    uint32_t jamRoundNodeCap = 0;
    uint32_t jamMaxElites = 6;
    // Luby-sequence round caps (1,1,2,1,1,2,4,... × jamRoundNodeCap, clamped
    // to the round's own cap). A FIXED small cap buys many tickets but breaks
    // the boards that need one deep round (10276/4722 were cracked by a
    // single deep jamg round); Luby is the standard restart answer to exactly
    // that dilemma — mostly cheap rounds with periodic deep ones, near-optimal
    // without knowing the right cap in advance. Matters most in the browser,
    // where a 300s arm at the stock 1.5M cap gets only ~4 rounds.
    bool jamLubyRestarts = false;
    // Run AStar::optimizeSolution on the reconstructed unit-move plan.
    bool postProcess = true;
    // Cooperative cancellation: when set and it becomes true, the search
    // returns empty at the next budget checkpoint. Enables racing arms in
    // threads without killing whole workers.
    std::atomic<bool> *cancel = nullptr;
  };

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

  std::function<void(uint32_t)> onProgress;

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
  std::vector<Turn> search(uint32_t maxMs = 0, uint32_t maxNodes = 0);

  // Hierarchical receding-horizon variant: solves "advance the goal past the
  // next cut" as a sequence of small exact drag searches, committing each
  // segment and backtracking over alternative segment end states (tabu on
  // failed ends) when a later segment cannot be solved. Built for deep
  // multi-phase puzzles whose flat search drowns; not optimal (the optimizer
  // cleans up), not complete under tight budgets — portfolio arm.
  std::vector<Turn> searchHierarchical(uint32_t maxMs = 0,
                                       uint32_t maxNodes = 0);

  // Assembly pipeline: when the packer found an off-sweep final packing,
  // place the clusters one at a time (goal block parked, placed clusters
  // ratcheted, focused per-piece searches, relaxation-ordered with retries),
  // then move the goal home through the cleared sweep. Solves
  // pack-then-slide puzzles (shiftingMosaicTest41-class) in about a second
  // where every monolithic search drowns. Returns empty when no packing
  // exists or a round fails — portfolio arm, not a replacement.
  std::vector<Turn> searchAssembly(uint32_t maxMs = 0, uint32_t maxNodes = 0);

  // Jam restart driver: a loop of short diversified flat searches (weight ×
  // settled × jam-guide strength × POR/relevance × fresh tie seed), each
  // with a bounded node cap so state maps stay small and get freed between
  // rounds (browser-heap-safe). The jam guide gives each round a dig-cost
  // gradient; the seed jitter makes every round explore a different equal-f
  // plateau — an informed lottery for serial-unlock jams where one fixed
  // ordering drowns. Incomplete per round but returns the first valid plan;
  // runs until the budget expires. Portfolio arm.
  std::vector<Turn> searchJamRestarts(uint32_t maxMs = 0,
                                      uint32_t maxNodes = 0);

  // Guided beam search: per-depth keep the best beamWidth states by
  // (jam dig cost, admissible h, seed jitter), all layers held in RAM with
  // parent links for reconstruction. Breadth against gradient-blind jam
  // plateaus — the strategy exhaustive BFS proved necessary on this class,
  // truncated by the jam guide so it fits a browser heap instead of a
  // multi-gigabyte disk. Restarts with a fresh jitter seed when a round
  // exhausts its depth cap without finding the goal. Incomplete by design —
  // portfolio arm.
  std::vector<Turn> searchBeamJam(uint32_t maxMs = 0, uint32_t maxNodes = 0);

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
  [[nodiscard]] bool jamProfile() const {
    if (middleCuts_ != 0 && !corridorBandsActive_)
      return false; // real cuts → hier/assembly territory
    const int lo = std::min(gridWidth_, gridHeight_);
    const int hi = std::max(gridWidth_, gridHeight_);
    if (hi * 16 > lo * cfg_.jamAspect16) // too thin → corridor territory
      return false;
    size_t cells = 0;
    for (const auto &s : shapes_)
      cells += s.size();
    return cells * 100 >= static_cast<size_t>(gridWidth_) * gridHeight_ *
                              cfg_.jamDensityPct;
  }

private:
  struct DragMove {
    uint8_t blockId = 0;
    uint16_t toIdx = 0; // anchor index (x * gridHeight + y)
  };

  struct StateInfo {
    uint32_t gScore = UINT32_MAX;
    uint32_t cells = UINT32_MAX; // cumulative unit cells traveled (tie-break)
    NodeKey parent;
    DragMove move{};
    uint16_t batchesEmitted = 0; // PEA*: successor batches already pushed
    bool hasParent = false;
    bool closed = false;
    // sleepSets: blocks whose drags this node skips (bit per block id) —
    // they commute with the move that created the node. Trailing member so
    // existing 7-element aggregate inits keep working (defaults to 0).
    uint32_t slept = 0;
  };

  using StateMap = std::unordered_map<NodeKey, StateInfo, NodeKeyHash>;

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
  // Deepest elite of the last searchJamRestarts run (see lastEliteAnchors).
  std::vector<Position> lastEliteAnchors_;
  std::vector<DragMove> lastElitePrefix_;

  [[nodiscard]] bool isGoal(const std::vector<Position> &anchors) const {
    const auto &a = anchors[goalIndex_];
    return a.x == goalAnchor_.x && a.y == goalAnchor_.y;
  }
  [[nodiscard]] uint32_t heuristic(const std::vector<Position> &anchors) const;
  [[nodiscard]] bool blockOnMask(uint8_t i, Position a,
                                 const std::vector<uint64_t> &mask) const;
  [[nodiscard]] uint32_t
  blockCellsOnMask(uint8_t i, Position a,
                   const std::vector<uint64_t> &mask) const;
  [[nodiscard]] bool blockOnGoalFootprint(uint8_t i, Position a) const;
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
  [[nodiscard]] uint32_t
  progressOf(const std::vector<Position> &anchors) const;

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
