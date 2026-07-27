#pragma once

#include <atomic>
#include <cstdint>
#include <vector>

// Tuning knobs for DragSolver, split out of DragSolver.h purely for size —
// the rationale comments on these fields are most of what that header used
// to be. Spelled DragSolver::Config at every call site (the class aliases it
// back in), so nothing outside this file needs to know the name changed.

struct DragSolverConfig {
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
