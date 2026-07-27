// DragSolver: the flat and restart-driven portfolio arms.
//
// search() is the single exact drag search; searchJamRestarts() is the
// diversified restart lottery built on top of it. The breadth-first arms
// (guided beam, hierarchical) live in DragSolverBeam.cpp.
#include "DragSolver.h"
#include "Node.h"
#include "SolverClock.h"
#include "MemoryProbe.h"

#include <algorithm>
#include <array>
#include <iostream>

std::vector<Turn> DragSolver::search(const uint32_t maxMs,
                                     const uint32_t maxNodes) {
  stats_ = {};
  if (gridWidth_ > 64) {
    std::cout << "DragSolver: grid wider than 64 — not supported\n";
    return {};
  }
  if (unsolvableAtStart_) {
    std::cout << "DragSolver short-circuit: a permanently-locked block sits "
                 "on the goal block's final footprint — unsolvable\n";
    return {};
  }
  if (isGoal(initialAnchors_))
    return {};

  const uint64_t deadline = deadlineFrom(maxMs);
  jamPinned_ = false;
  SegmentResult res;
  if (cfg_.relevantOnly) {
    // Iterative ring widening: a too-tight relevance filter exhausts its
    // little space in milliseconds — widen and retry until a solution, a
    // genuine budget miss, or the widest ring also drains.
    for (relevantRing_ = 1; relevantRing_ <= 4; relevantRing_++) {
      res = runAStarDrag(initialAnchors_, middleCuts_ + 1, nullptr, deadline,
                         maxNodes);
      if (res.found || !res.exhausted ||
          (deadline != 0 && nowMs() >= deadline))
        break;
      std::cout << "DragSolver: relevance ring "
                << static_cast<int>(relevantRing_)
                << " exhausted — widening\n";
    }
    relevantRing_ = 1;
  } else {
    res = runAStarDrag(initialAnchors_, middleCuts_ + 1, nullptr, deadline,
                       maxNodes);
  }
  if (!res.found)
    return {};
  std::vector<Turn> turns = finalizePlan(res.drags);

  // Symmetry canonicalization can, in rare corner cases, record a drag under
  // a block label that a later, cheaper path realizes differently. Replay
  // catches it; retry once with canonicalization off (slower, label-exact).
  if (turns.empty() && cfg_.canonicalizeSymmetry) {
    std::cout << "DragSolver: retrying without symmetry canonicalization\n";
    cfg_.canonicalizeSymmetry = false;
    res = runAStarDrag(initialAnchors_, middleCuts_ + 1, nullptr, deadline,
                       maxNodes);
    cfg_.canonicalizeSymmetry = true;
    if (res.found)
      turns = finalizePlan(res.drags);
  }
  return turns;
}

std::vector<Turn> DragSolver::searchJamRestarts(const uint32_t maxMs,
                                                const uint32_t maxNodes) {
  stats_ = {};
  if (gridWidth_ > 64) {
    std::cout << "DragSolver: grid wider than 64 — not supported\n";
    return {};
  }
  if (unsolvableAtStart_ || isGoal(initialAnchors_))
    return {};

  const uint64_t deadline = deadlineFrom(maxMs);
  // Round configs, ordered by expected value on jam boards. Node caps keep
  // each round's state map small (~a few hundred MB peak) and freed on
  // return — wasm-heap-safe by construction.
  struct Round {
    uint8_t weight = 0;
    bool settled = false;
    uint16_t pea = 0;
    uint8_t jamGuide = 0;
    uint8_t jamPenalty = 0;
    bool por = false;
    bool relevant = false;
    uint32_t nodeCap = 0;
    bool pin = false;
  };
  // Leading rounds are the configs that cracked real jam boards in the
  // IIT-21 campaign: jamg8/w4 (seed 10276), jamg16/w6 (seed 4722), and the
  // guide-free flat round that rides the corridor-band gradient when the
  // caller constructed with corridorBands (seed 9164). The pinned rounds
  // freeze their start state's argmin route as a hard corridor — the
  // wide-board diversification (multiple competing routes destabilize the
  // plain guide).
  static constexpr Round ROUNDS[] = {
      {4, true, 64, 8, 4, false, false, 1500000},
      {6, true, 64, 16, 4, false, false, 1500000},
      {4, true, 64, 0, 4, false, false, 1500000},
      {4, true, 64, 8, 8, false, false, 1500000, true},
      {6, true, 64, 16, 8, false, false, 1500000},
      {4, true, 64, 8, 4, true, true, 1500000},
      {2, true, 64, 8, 32, false, false, 1000000, true},
      {3, false, 64, 8, 4, false, false, 1000000},
  };
  const Config saved = cfg_;

  // Elite pool: deepest credible partials (lowest jam term) from failed
  // rounds. Odd rounds warm-start from an elite's end state instead of the
  // root — successive rounds resume where the best prior round got stuck,
  // with a different config/seed, instead of re-treading the whole prefix.
  struct Elite {
    std::vector<Position> anchors;
    std::vector<DragMove> prefix;
    uint32_t jam = 0;
  };
  const size_t MAX_ELITES = std::max<size_t>(1, cfg_.jamMaxElites);
  std::vector<Elite> elites;
  const auto applyDrags = [&](std::vector<Position> a,
                              const std::vector<DragMove> &drags) {
    for (const auto &[blockId, toIdx] : drags)
      a[blockId] = grid_.anchorFromIndex(toIdx);
    return a;
  };

  std::vector<Turn> turns;
  uint32_t restarts = 0;
  for (uint32_t r = 0;; r++) {
    if (deadline != 0 && nowMs() >= deadline)
      break;
    if (cfg_.cancel && cfg_.cancel->load(std::memory_order_relaxed))
      break;
    if (maxNodes != 0 && stats_.nodesExpanded >= maxNodes)
      break;
    const auto &[rWeight, rSettled, rPea, rJamGuide, rJamPenalty, rPor,
                 rRelevant, rNodeCap, rPin] = ROUNDS[r % std::size(ROUNDS)];
    cfg_.weight = rWeight;
    cfg_.settledOnly = rSettled;
    cfg_.partialExpansionWidth = rPea;
    cfg_.jamGuideWeight = rJamGuide;
    cfg_.jamBlockerPenalty = rJamPenalty;
    cfg_.sleepSets = rPor;
    cfg_.relevantOnly = rRelevant;
    cfg_.jamPinRoute = rPin || saved.jamPinRoute;
    jamPinned_ = false; // each round pins its own start's route
    // Round 0 of each config keeps the deterministic tie-break; later cycles
    // jitter it so plateaus break differently every time around.
    cfg_.tieBreakSeed =
        r < std::size(ROUNDS) ? 0 : 0x9E3779B9u * r + 1;
    restarts++;
    uint32_t cap = rNodeCap;
    if (saved.jamRoundNodeCap != 0) {
      const uint64_t unit =
          saved.jamLubyRestarts ? lubyUnit(restarts) : 1;
      const uint64_t scaled =
          static_cast<uint64_t>(saved.jamRoundNodeCap) * unit;
      cap = static_cast<uint32_t>(
          std::min<uint64_t>(cap, std::max<uint64_t>(1, scaled)));
    }
    if (maxNodes != 0)
      cap = std::min<uint32_t>(cap, maxNodes - stats_.nodesExpanded);
    // Alternate root rounds and elite warm-starts (elite rounds need the
    // guide on to keep producing partials; force it for the bands round).
    const Elite *from = nullptr;
    if (!elites.empty() && (r & 1) != 0) {
      from = &elites[(r >> 1) % elites.size()];
      if (cfg_.jamGuideWeight == 0)
        cfg_.jamGuideWeight = 8;
    }
    // Ridge hopper: some elite rounds first take a few RANDOM drags from the
    // elite state before the guided search re-engages. Boards whose solution
    // crosses a dig-cost ridge (every gradient search walls at the same
    // term — the seed-8697 signature) need blind sideways moves the guide
    // would never rank; the elites keep the lottery anchored deep.
    std::vector<DragMove> pert;
    std::vector<Position> pertAnchors;
    if (from != nullptr) {
      if (const uint32_t hops = r / 2 % 4 * 3; hops > 0) { // 0,3,6,9 drags
        pertAnchors = from->anchors;
        uint32_t rng = 0x243F6A88u ^ (r * 0x9E3779B9u);
        const auto rnd = [&rng](const size_t n) {
          rng = rng * 1664525u + 1013904223u;
          return (rng >> 8) % n;
        };
        for (uint32_t p = 0; p < hops; p++) {
          grid_.buildOccupancy(pertAnchors);
          const uint8_t b =
              movableBlockIndices_[rnd(movableBlockIndices_.size())];
          const Position fromP = pertAnchors[b];
          grid_.removeBlock(b, fromP);
          if (const auto &reached = grid_.floodFill(b, fromP);
              !reached.empty()) {
            const uint16_t to = reached[rnd(reached.size())];
            pertAnchors[b] = grid_.anchorFromIndex(to);
            pert.push_back({b, to});
          }
          grid_.addBlock(b, pertAnchors[b]);
        }
      }
    }
    const std::vector<Position> &startAnchors =
        !pert.empty() ? pertAnchors
        : from        ? from->anchors
                      : initialAnchors_;
    const SegmentResult res = runAStarDrag(startAnchors, middleCuts_ + 1,
                                           nullptr, deadline, cap);
    const auto stitched = [&](const std::vector<DragMove> &suffix) {
      std::vector<DragMove> full;
      if (from != nullptr)
        full = from->prefix;
      full.insert(full.end(), pert.begin(), pert.end());
      full.insert(full.end(), suffix.begin(), suffix.end());
      return full;
    };
    if (res.found) {
      turns = finalizePlan(stitched(res.drags));
      if (turns.empty() && cfg_.canonicalizeSymmetry) {
        std::cout << "DragSolver(jam): retrying without symmetry "
                     "canonicalization\n";
        cfg_.canonicalizeSymmetry = false;
        const SegmentResult res2 = runAStarDrag(startAnchors, middleCuts_ + 1,
                                                nullptr, deadline, cap);
        cfg_.canonicalizeSymmetry = true;
        if (res2.found)
          turns = finalizePlan(stitched(res2.drags));
      }
      if (!turns.empty())
        break;
    } else if (res.bestPartialJam != UINT32_MAX &&
               !res.bestPartialDrags.empty()) {
      // Bank this round's deepest partial as an elite (crude diversity: one
      // elite per jam value; prefixes capped against runaway stitching).
      Elite e{applyDrags(startAnchors, res.bestPartialDrags),
              stitched(res.bestPartialDrags), res.bestPartialJam};
      if (e.prefix.size() <= 220 &&
          std::ranges::none_of(elites, [&](const Elite &x) {
            return x.jam == e.jam;
          })) {
        elites.push_back(std::move(e));
        std::ranges::sort(elites,
                  [](const Elite &a, const Elite &b) { return a.jam < b.jam; });
        if (elites.size() > MAX_ELITES)
          elites.resize(MAX_ELITES);
        std::cout << "DragSolver(jam): elite banked (jam "
                  << elites.front().jam << ".." << elites.back().jam << ", "
                  << elites.size() << " in pool)\n";
      }
    }
  }
  cfg_ = saved;
  // Expose the deepest elite so a stalled board can be decomposed (the pool is
  // kept sorted by jam term, so front() is the deepest).
  if (!elites.empty()) {
    lastEliteAnchors_ = elites.front().anchors;
    lastElitePrefix_ = elites.front().prefix;
  }
  std::cout << "DragSolver(jam): " << restarts << " restart rounds, "
            << stats_.nodesExpanded << " total expansions, "
            << (turns.empty() ? "no solution" : "SOLVED");
  if (turns.empty() && !elites.empty())
    std::cout << " (deepest elite jam " << elites.front().jam << ", "
              << elites.front().prefix.size() << " drags)";
  std::cout << "\n";
  return turns;
}
