// DragSolver: the flat and restart-driven portfolio arms.
//
// search() is the single exact drag search; searchJamRestarts() is the
// diversified restart lottery built on top of it. The breadth-first arms
// (guided beam, hierarchical) live in DragSolverBeam.cpp.
#include "DragSolver.h"
#include "MemoryProbe.h"
#include "SolverClock.h"

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
      if (res.found || !res.exhausted || (deadline != 0 && nowMs() >= deadline))
        break;
      std::cout << "DragSolver: relevance ring "
                << static_cast<int>(relevantRing_) << " exhausted — widening\n";
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

const std::array<DragSolver::Round, DragSolver::JAM_ROUND_COUNT> &
DragSolver::jamRounds() {
  // Round configs, ordered by expected value on jam boards.
  //
  // Leading rounds are the configs that cracked real jam boards in the
  // IIT-21 campaign: jamg8/w4 (seed 10276), jamg16/w6 (seed 4722), and the
  // guide-free flat round that rides the corridor-band gradient when the
  // caller constructed with corridorBands (seed 9164). The pinned rounds
  // freeze their start state's argmin route as a hard corridor — the
  // wide-board diversification (multiple competing routes destabilize the
  // plain guide).
  static constexpr std::array<Round, JAM_ROUND_COUNT> ROUNDS = {{
      {.weight = 4,
       .settled = true,
       .pea = 64,
       .jamGuide = 8,
       .jamPenalty = 4,
       .por = false,
       .relevant = false,
       .nodeCap = 1500000},
      {.weight = 6,
       .settled = true,
       .pea = 64,
       .jamGuide = 16,
       .jamPenalty = 4,
       .por = false,
       .relevant = false,
       .nodeCap = 1500000},
      {.weight = 4,
       .settled = true,
       .pea = 64,
       .jamGuide = 0,
       .jamPenalty = 4,
       .por = false,
       .relevant = false,
       .nodeCap = 1500000},
      {.weight = 4,
       .settled = true,
       .pea = 64,
       .jamGuide = 8,
       .jamPenalty = 8,
       .por = false,
       .relevant = false,
       .nodeCap = 1500000,
       .pin = true},
      {.weight = 6,
       .settled = true,
       .pea = 64,
       .jamGuide = 16,
       .jamPenalty = 8,
       .por = false,
       .relevant = false,
       .nodeCap = 1500000},
      {.weight = 4,
       .settled = true,
       .pea = 64,
       .jamGuide = 8,
       .jamPenalty = 4,
       .por = true,
       .relevant = true,
       .nodeCap = 1500000},
      {.weight = 2,
       .settled = true,
       .pea = 64,
       .jamGuide = 8,
       .jamPenalty = 32,
       .por = false,
       .relevant = false,
       .nodeCap = 1000000,
       .pin = true},
      {.weight = 3,
       .settled = false,
       .pea = 64,
       .jamGuide = 8,
       .jamPenalty = 4,
       .por = false,
       .relevant = false,
       .nodeCap = 1000000},
  }};
  return ROUNDS;
}

void DragSolver::applyRoundConfig(const Round &round, const uint32_t r,
                                  const Config &saved) {
  cfg_.weight = round.weight;
  cfg_.settledOnly = round.settled;
  cfg_.partialExpansionWidth = round.pea;
  cfg_.jamGuideWeight = round.jamGuide;
  cfg_.jamBlockerPenalty = round.jamPenalty;
  cfg_.sleepSets = round.por;
  cfg_.relevantOnly = round.relevant;
  cfg_.jamPinRoute = round.pin || saved.jamPinRoute;
  jamPinned_ = false; // each round pins its own start's route
  // Round 0 of each config keeps the deterministic tie-break; later cycles
  // jitter it so plateaus break differently every time around.
  cfg_.tieBreakSeed = r < JAM_ROUND_COUNT ? 0 : 0x9E3779B9u * r + 1;
}

uint32_t DragSolver::jamRoundCap(const Round &round, const Config &saved,
                                 const uint32_t restarts,
                                 const uint32_t maxNodes) const {
  uint32_t cap = round.nodeCap;
  if (saved.jamRoundNodeCap != 0) {
    const uint64_t unit = saved.jamLubyRestarts ? lubyUnit(restarts) : 1;
    const uint64_t scaled = static_cast<uint64_t>(saved.jamRoundNodeCap) * unit;
    cap = static_cast<uint32_t>(
        std::min<uint64_t>(cap, std::max<uint64_t>(1, scaled)));
  }
  if (maxNodes != 0)
    cap = std::min<uint32_t>(cap, maxNodes - stats_.nodesExpanded);
  return cap;
}

void DragSolver::perturbFrom(const uint32_t r, JamRound &jr) {
  // Ridge hopper: some elite rounds first take a few RANDOM drags from the
  // elite state before the guided search re-engages. Boards whose solution
  // crosses a dig-cost ridge (every gradient search walls at the same
  // term — the seed-8697 signature) need blind sideways moves the guide
  // would never rank; the elites keep the lottery anchored deep.
  const uint32_t hops = r / 2 % 4 * 3; // 0, 3, 6 or 9 drags
  if (hops == 0)
    return;
  jr.pertAnchors = jr.from->anchors;
  uint32_t rng = 0x243F6A88u ^ r * 0x9E3779B9u;
  const auto rnd = [&rng](const size_t n) {
    rng = rng * 1664525u + 1013904223u;
    return (rng >> 8u) % n;
  };
  for (uint32_t p = 0; p < hops; p++) {
    grid_.buildOccupancy(jr.pertAnchors);
    const uint8_t b = movableBlockIndices_[rnd(movableBlockIndices_.size())];
    const Position fromP = jr.pertAnchors[b];
    grid_.removeBlock(b, fromP);
    if (const auto &reached = grid_.floodFill(b, fromP); !reached.empty()) {
      const uint16_t to = reached[rnd(reached.size())];
      jr.pertAnchors[b] = grid_.anchorFromIndex(to);
      jr.pert.push_back({.blockId = b, .toIdx = to});
    }
    grid_.addBlock(b, jr.pertAnchors[b]);
  }
}

const std::vector<Position> &
DragSolver::jamStartAnchors(const JamRound &jr) const {
  if (!jr.pert.empty())
    return jr.pertAnchors;
  if (jr.from != nullptr)
    return jr.from->anchors;
  return initialAnchors_;
}

std::vector<DragSolver::DragMove>
DragSolver::stitchPlan(const JamRound &jr,
                       const std::vector<DragMove> &suffix) {
  std::vector<DragMove> full;
  if (jr.from != nullptr)
    full = jr.from->prefix;
  full.insert(full.end(), jr.pert.begin(), jr.pert.end());
  full.insert(full.end(), suffix.begin(), suffix.end());
  return full;
}

std::vector<Position>
DragSolver::applyDrags(std::vector<Position> anchors,
                       const std::vector<DragMove> &drags) const {
  for (const auto &[blockId, toIdx] : drags)
    anchors[blockId] = grid_.anchorFromIndex(toIdx);
  return anchors;
}

std::vector<Turn> DragSolver::finalizeJamRound(const SegmentResult &res,
                                               const JamRound &jr,
                                               const uint64_t deadline,
                                               const uint32_t cap) {
  std::vector<Turn> turns = finalizePlan(stitchPlan(jr, res.drags));
  if (!turns.empty() || !cfg_.canonicalizeSymmetry)
    return turns;
  std::cout << "DragSolver(jam): retrying without symmetry "
               "canonicalization\n";
  cfg_.canonicalizeSymmetry = false;
  const SegmentResult res2 = runAStarDrag(jamStartAnchors(jr), middleCuts_ + 1,
                                          nullptr, deadline, cap);
  cfg_.canonicalizeSymmetry = true;
  if (res2.found)
    turns = finalizePlan(stitchPlan(jr, res2.drags));
  return turns;
}

void DragSolver::bankElite(const SegmentResult &res, const JamRound &jr,
                           std::vector<Elite> &elites,
                           const size_t maxElites) const {
  if (res.bestPartialJam == UINT32_MAX || res.bestPartialDrags.empty())
    return;
  // Bank this round's deepest partial as an elite (crude diversity: one
  // elite per jam value; prefixes capped against runaway stitching).
  // Everything reading jr.from happens here, BEFORE the push_back that would
  // invalidate it.
  Elite e{.anchors = applyDrags(jamStartAnchors(jr), res.bestPartialDrags),
          .prefix = stitchPlan(jr, res.bestPartialDrags),
          .jam = res.bestPartialJam};
  if (e.prefix.size() > 220 ||
      std::ranges::any_of(elites,
                          [&](const Elite &x) { return x.jam == e.jam; }))
    return;
  elites.push_back(std::move(e));
  std::ranges::sort(
      elites, [](const Elite &a, const Elite &b) { return a.jam < b.jam; });
  if (elites.size() > maxElites)
    elites.resize(maxElites);
  std::cout << "DragSolver(jam): elite banked (jam " << elites.front().jam
            << ".." << elites.back().jam << ", " << elites.size()
            << " in pool)\n";
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
  const Config saved = cfg_;
  // Elite pool: deepest credible partials (lowest jam term) from failed
  // rounds. Odd rounds warm-start from an elite's end state instead of the
  // root — successive rounds resume where the best prior round got stuck,
  // with a different config/seed, instead of re-treading the whole prefix.
  const size_t maxElites = std::max<size_t>(1, cfg_.jamMaxElites);
  std::vector<Elite> elites;

  std::vector<Turn> turns;
  uint32_t restarts = 0;
  // A while, not `for (uint32_t r = 0;; r++)` with four breaks: the stop
  // conditions all belong in the condition (S135).
  uint32_t r = 0;
  while (turns.empty() && !roundBudgetSpent(deadline, maxNodes)) {
    const Round &round = jamRounds()[r % JAM_ROUND_COUNT];
    applyRoundConfig(round, r, saved);
    restarts++;
    const uint32_t cap = jamRoundCap(round, saved, restarts, maxNodes);
    // Alternate root rounds and elite warm-starts (elite rounds need the
    // guide on to keep producing partials; force it for the bands round).
    JamRound jr;
    if (!elites.empty() && (r & 1u) != 0) {
      jr.from = &elites[(r >> 1u) % elites.size()];
      if (cfg_.jamGuideWeight == 0)
        cfg_.jamGuideWeight = 8;
      perturbFrom(r, jr);
    }
    if (const SegmentResult res = runAStarDrag(jamStartAnchors(jr),
                                               middleCuts_ + 1, nullptr,
                                               deadline, cap);
        res.found)
      turns = finalizeJamRound(res, jr, deadline, cap);
    else
      bankElite(res, jr, elites, maxElites);
    r++;
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
