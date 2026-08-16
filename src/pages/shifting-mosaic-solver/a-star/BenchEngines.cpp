#include "BenchEngines.h"

#include "AStar.h"
#include "DragSolver.h"
#include "SolverClock.h"

#include <algorithm>
#include <array>
#include <iostream>
#include <string_view>
#include <vector>

namespace {

void ignoreProgress(uint32_t) {
  // Deliberately empty: the bench reports totals at the end, so per-node
  // progress is of no interest to it and every engine passes this rather than
  // a reporter.
}

void accumulateFrom(SolveResult &res, const DragSolver &solver) {
  const auto &stats = solver.lastStats();
  res.nodesExpanded += stats.nodesExpanded;
  res.statesStored += stats.statesStored;
  res.stoppedOnMemory = res.stoppedOnMemory || stats.stoppedOnMemory;
  res.passes = static_cast<uint8_t>(res.passes + stats.passes);
}

// One rung of the production chain. Config and search entry point are function
// pointers so the chain below is a table: as an if-chain each rung costs a
// branch, and the seven of them plus their inner "did it solve" tests were the
// bulk of main()'s complexity.
struct CascadeStage {
  std::string_view name;
  bool jamGated; // only run when the board matches the jam profile
  DragSolver::Config (*config)(bool postProcess);
  std::vector<Turn> (*run)(DragSolver &solver, uint32_t budgetMs,
                           uint32_t maxNodes);
};

constexpr std::array<CascadeStage, 7> CASCADE{{
    {.name = "assembly",
     .jamGated = false,
     .config =
         [](const bool pp) {
           DragSolver::Config c;
           c.postProcess = pp;
           return c;
         },
     .run =
         [](DragSolver &s, const uint32_t budgetMs, const uint32_t maxNodes) {
           return s.searchAssembly(budgetMs, maxNodes);
         }},
    // Corridor arm: instant-declines unless the goal has no real cuts but a
    // long journey (then synthetic bands make hier decompose the corridor).
    {.name = "corridor",
     .jamGated = false,
     .config =
         [](const bool pp) {
           DragSolver::Config c;
           c.weight = 3;
           c.settledOnly = true;
           c.partialExpansionWidth = 48;
           c.corridorBands = true;
           c.postProcess = pp;
           return c;
         },
     .run =
         [](DragSolver &s, const uint32_t budgetMs, const uint32_t maxNodes) {
           return s.searchHierarchical(budgetMs, maxNodes);
         }},
    {.name = "hier",
     .jamGated = false,
     .config =
         [](const bool pp) {
           DragSolver::Config c;
           c.weight = 3;
           c.settledOnly = true;
           c.partialExpansionWidth = 48;
           c.postProcess = pp;
           return c;
         },
     .run =
         [](DragSolver &s, const uint32_t budgetMs, const uint32_t maxNodes) {
           return s.searchHierarchical(budgetMs, maxNodes);
         }},
    {.name = "drag",
     .jamGated = false,
     .config =
         [](const bool pp) {
           DragSolver::Config c;
           c.weight = 4;
           c.settledOnly = true;
           c.partialExpansionWidth = 64;
           c.postProcess = pp;
           return c;
         },
     .run =
         [](DragSolver &s, const uint32_t budgetMs, const uint32_t maxNodes) {
           return s.search(budgetMs, maxNodes);
         }},
    // Jam arm: relevance filter + commutativity pruning for compact dense
    // boards where the unrestricted searches drown.
    {.name = "relevant",
     .jamGated = false,
     .config =
         [](const bool pp) {
           DragSolver::Config c;
           c.weight = 4;
           c.settledOnly = true;
           c.partialExpansionWidth = 64;
           c.sleepSets = true;
           c.relevantOnly = true;
           c.postProcess = pp;
           return c;
         },
     .run =
         [](DragSolver &s, const uint32_t budgetMs, const uint32_t maxNodes) {
           return s.search(budgetMs, maxNodes);
         }},
    // Jam-restart arm: dig-cost-guided diversified rounds for compact dense
    // 0-cut boards; declines instantly outside the jam profile. Luby-shaped
    // caps (20k base / 64 elites): -46% ratchet depth vs stock at the 300s
    // browser budget on the hard-instance family (HARD-BOARDS.md).
    {.name = "jamrestart",
     .jamGated = true,
     .config =
         [](const bool pp) {
           DragSolver::Config c;
           c.corridorBands = true;
           c.jam.roundNodeCap = 20000;
           c.jam.maxElites = 64;
           c.jam.lubyRestarts = true;
           c.postProcess = pp;
           return c;
         },
     .run =
         [](DragSolver &s, const uint32_t budgetMs, const uint32_t maxNodes) {
           return s.searchJamRestarts(budgetMs, maxNodes);
         }},
    // Guided-beam arm: breadth against the jam plateaus the restart rounds
    // dive past. Same gate. The wide-beam/heavy-penalty config is the one that
    // cracked seed 3870 (own process — can afford the RAM).
    {.name = "jambeam",
     .jamGated = true,
     .config =
         [](const bool pp) {
           DragSolver::Config c;
           c.corridorBands = true;
           c.jam.guideWeight = 8;
           c.jam.blockerPenalty = 8;
           c.jam.beamWidth = 500000;
           c.postProcess = pp;
           return c;
         },
     .run =
         [](DragSolver &s, const uint32_t budgetMs, const uint32_t maxNodes) {
           return s.searchBeamJam(budgetMs, maxNodes);
         }},
}};

constexpr std::array<std::string_view, 12> ENGINES{
    "unit", "drag",    "hier",     "assembly",   "corridor", "jam",
    "beam", "cascade", "parallel", "sequential", "twophase", "arm"};

// The engines that drive DragSolver directly from the command-line options,
// as opposed to the fixed configurations the cascade and the race use.
bool isDragFamily(const std::string_view engine) {
  return engine == "drag" || engine == "hier" || engine == "assembly" ||
         engine == "corridor" || engine == "jam" || engine == "beam";
}

// The two grouped arguments every cascade entry point takes, built once from
// the bench's own option bag so the four call sites below cannot drift.
cascade::Board boardOf(const Fixture &data) {
  return {.gridWidth = data.gridWidth,
          .gridHeight = data.gridHeight,
          .shapes = data.shapes,
          .initialAnchors = data.initialAnchors,
          .goalIndex = data.goalIndex,
          .goalAnchor = data.goalAnchor};
}

cascade::Budget budgetOf(const BenchOptions &opt) {
  return {.maxMs = opt.limits.budgetMs,
          .maxNodes = opt.limits.maxNodes,
          .postProcess = opt.cfg.postProcess,
          .maxHeapBytes = opt.limits.maxHeapBytes,
          .totalMaxMs = opt.limits.seqTotalMs,
          .jamAspect16 = opt.jam.aspect16,
          .jamDensityPct = opt.jam.densityPct};
}

// THE SHIPPED PATH. solveArmsParallel is the exact function the threaded wasm
// build calls for a cross-origin-isolated page (wasm_bindings.cpp under
// __EMSCRIPTEN_PTHREADS__): 8 arms racing on real threads, first non-empty plan
// wins and cancels the rest. --engine cascade is the SEQUENTIAL chain and
// answers a different question — use this one to measure what a browser does.
void runParallel(const BenchOptions &opt, const Fixture &data,
                 SolveResult &res) {
  res.t0 = nowMs();
  res.t1 = res.t0;
  res.turns = solveArmsParallel(boardOf(data), budgetOf(opt), ignoreProgress,
                                &res.armOutcomes);
  res.t2 = nowMs();
}

// Runs ONE race arm with its REAL configuration, via the same runArm the race
// and the sequential phase use. Necessary because --engine jam/beam build their
// own default configs and are NOT arms 6/7 — measuring those and calling the
// result "per-arm" silently compares the wrong solver (it is why an earlier
// study concluded no arm could solve seed 45501, which arm 6 in fact wins).
// Ungated by default, matching phase 2.
bool runSingleArm(const BenchOptions &opt, const Fixture &data,
                  SolveResult &res) {
  if (opt.armIndex < 0 || opt.armIndex >= cascade::ARMS) {
    std::cerr << "--engine arm needs --arm 0.." << (cascade::ARMS - 1) << "\n";
    return false;
  }
  res.t0 = nowMs();
  res.t1 = res.t0;
  res.turns = cascade::runArm(opt.armIndex, boardOf(data), budgetOf(opt),
                              nullptr, ignoreProgress, opt.armGated);
  res.t2 = nowMs();
  res.stage = cascade::armName(opt.armIndex);
  return true;
}

// "sequential" = phase 2 alone (each arm gets the whole heap, ungated).
// "twophase"   = what the browser will do: race first, fall back second.
void runSequential(const BenchOptions &opt, const Fixture &data,
                   SolveResult &res) {
  const bool twoPhase = opt.engine == "twophase";
  res.t0 = nowMs();
  res.t1 = res.t0;
  if (twoPhase)
    res.turns = solveArmsParallel(boardOf(data), budgetOf(opt), ignoreProgress,
                                  &res.armOutcomes);
  if (!res.turns.empty()) {
    res.stage = "parallel";
    res.t2 = nowMs();
    return;
  }
  if (twoPhase)
    std::cout << "cascade: parallel race found nothing - falling back to "
                 "sequential arms (slower; each arm gets the whole heap)\n";
  res.turns = solveArmsSequential(boardOf(data), budgetOf(opt), ignoreProgress,
                                  /*cancel=*/nullptr, &res.armOutcomes);
  if (!res.turns.empty())
    res.stage = "sequential";
  res.t2 = nowMs();
}

// The production chain (mirrors wasm_bindings' cascade): assembly → hier →
// deep flat drag → unit, each with the full per-stage budget.
void runCascade(const BenchOptions &opt, const Fixture &data,
                SolveResult &res) {
  res.t0 = nowMs();
  res.t1 = res.t0;
  for (const auto &[name, jamGated, config, run] : CASCADE) {
    if (!res.turns.empty())
      break;
    DragSolver solver(data.gridWidth, data.gridHeight, data.shapes,
                      data.initialAnchors, data.goalIndex, data.goalAnchor,
                      config(opt.cfg.postProcess));
    if (jamGated && !solver.jamProfile())
      continue;
    res.turns = run(solver, opt.limits.budgetMs, opt.limits.maxNodes);
    accumulateFrom(res, solver);
    if (!res.turns.empty())
      res.stage = name;
  }
  if (res.turns.empty()) {
    AStar solver(data.gridWidth, data.gridHeight, data.shapes,
                 data.initialAnchors, data.goalIndex, data.goalAnchor, opt.cfg);
    res.turns = solver.search(opt.limits.budgetMs, opt.limits.maxNodes);
    const auto &[nodesExpanded, statesStored, stoppedOnMemory, passes] =
        solver.lastStats();
    res.nodesExpanded += nodesExpanded;
    res.statesStored += statesStored;
    res.stoppedOnMemory = res.stoppedOnMemory || stoppedOnMemory;
    res.passes = static_cast<uint8_t>(res.passes + passes);
    if (!res.turns.empty())
      res.stage = "unit";
  }
  if (res.turns.empty())
    res.stage = "none";
  res.t2 = nowMs();
}

// Decomposition hand-off: on a stalled jam run, write the deepest elite as a
// residual fixture and its root→elite prefix, so the remainder can be attacked
// separately and the halves stitched (verify with --verify).
// Non-const solver: lastElitePrefixTurns() reconstructs the prefix on demand
// rather than returning a stored one, so it is not a const accessor.
void dumpEliteArtifacts(const BenchOptions &opt, const Fixture &data,
                        DragSolver &solver) {
  if (solver.lastEliteAnchors().empty())
    return;
  if (!opt.paths.dumpElite.empty()) {
    if (const std::string path = opt.paths.dumpElite.string();
        writeFixtureAt(data, solver.lastEliteAnchors(), path))
      std::cerr << "elite residual fixture dumped to " << path << "\n";
    else
      std::cerr << "cannot write " << path << "\n";
  }
  if (opt.paths.dumpEliteTurns.empty())
    return;
  const auto prefix = solver.lastElitePrefixTurns();
  writeTurnsFile(prefix, opt.paths.dumpEliteTurns.string());
  std::cerr << "elite prefix (" << prefix.size() << " turns) dumped to "
            << opt.paths.dumpEliteTurns.string() << "\n";
}

DragSolver::Config dragConfigFrom(const BenchOptions &opt) {
  DragSolver::Config dcfg;
  dcfg.weight = opt.cfg.weight;
  dcfg.postProcess = opt.cfg.postProcess;
  dcfg.settledOnly = opt.drag.settledOnly;
  dcfg.partialExpansionWidth = opt.drag.pea;
  dcfg.packing.weight = opt.drag.packingWeight;
  dcfg.packing.consolidationGain = opt.drag.consolidationGain;
  dcfg.packing.slotHeuristic = opt.drag.slotHeuristic;
  dcfg.packing.requireAllSlots = opt.drag.requireAllSlots;
  dcfg.packing.lockOnSlot = opt.drag.lockOnSlot;
  dcfg.sleepSets = opt.drag.sleepSets;
  dcfg.relevantOnly = opt.drag.relevantOnly;
  dcfg.corridorBands = opt.engine == "corridor" || opt.drag.bands;
  dcfg.corridorBandMinPath = opt.drag.bandMinPath;
  dcfg.stop.maxStatesStored = opt.limits.maxStates;
  dcfg.stop.maxHeapBytes = opt.limits.maxHeapBytes;
  dcfg.jam.aspect16 = opt.jam.aspect16;
  dcfg.jam.densityPct = opt.jam.densityPct;
  dcfg.jam.guideWeight = opt.jam.guide;
  dcfg.jam.pinRoute = opt.jam.pin;
  dcfg.jam.roundNodeCap = opt.jam.roundCap;
  dcfg.jam.maxElites = opt.jam.elites;
  dcfg.jam.lubyRestarts = opt.jam.luby;
  dcfg.jam.blockerPenalty = opt.jam.penalty;
  dcfg.tieBreakSeed = opt.tieSeed;
  dcfg.jam.beamWidth = opt.beamWidth;
  return dcfg;
}

void runDragFamily(const BenchOptions &opt, const Fixture &data,
                   SolveResult &res) {
  res.t0 = nowMs();
  DragSolver solver(data.gridWidth, data.gridHeight, data.shapes,
                    data.initialAnchors, data.goalIndex, data.goalAnchor,
                    dragConfigFrom(opt));
  res.t1 = nowMs();
  if (opt.engine == "hier" || opt.engine == "corridor")
    res.turns = solver.searchHierarchical(opt.limits.budgetMs, opt.limits.maxNodes);
  else if (opt.engine == "assembly")
    res.turns = solver.searchAssembly(opt.limits.budgetMs, opt.limits.maxNodes);
  else if (opt.engine == "jam")
    res.turns = solver.searchJamRestarts(opt.limits.budgetMs, opt.limits.maxNodes);
  else if (opt.engine == "beam")
    res.turns = solver.searchBeamJam(opt.limits.budgetMs, opt.limits.maxNodes);
  else
    res.turns = solver.search(opt.limits.budgetMs, opt.limits.maxNodes);
  res.t2 = nowMs();

  const auto &stats = solver.lastStats();
  res.nodesExpanded = stats.nodesExpanded;
  res.statesStored = stats.statesStored;
  res.stoppedOnMemory = stats.stoppedOnMemory;
  res.passes = stats.passes;
  res.minJamTerm = stats.minJamTerm;
  res.maxProgress = stats.maxProgress;
  dumpEliteArtifacts(opt, data, solver);
}

void runUnit(const BenchOptions &opt, const Fixture &data, SolveResult &res) {
  res.t0 = nowMs();
  AStar solver(data.gridWidth, data.gridHeight, data.shapes,
               data.initialAnchors, data.goalIndex, data.goalAnchor, opt.cfg);
  res.t1 = nowMs();
  res.turns = solver.search(opt.limits.budgetMs, opt.limits.maxNodes);
  res.t2 = nowMs();
  const auto &[nodesExpanded, statesStored, stoppedOnMemory, passes] =
      solver.lastStats();
  res.nodesExpanded = nodesExpanded;
  res.statesStored = statesStored;
  res.stoppedOnMemory = stoppedOnMemory;
  res.passes = passes;
}

} // namespace

bool isKnownEngine(const std::string_view engine) {
  return std::ranges::find(ENGINES, engine) != ENGINES.end();
}

bool runBenchEngine(const BenchOptions &opt, const Fixture &data,
                    SolveResult &res) {
  res.stage = opt.engine;
  if (opt.engine == "parallel")
    runParallel(opt, data, res);
  else if (opt.engine == "arm")
    return runSingleArm(opt, data, res);
  else if (opt.engine == "sequential" || opt.engine == "twophase")
    runSequential(opt, data, res);
  else if (opt.engine == "cascade")
    runCascade(opt, data, res);
  else if (isDragFamily(opt.engine))
    runDragFamily(opt, data, res);
  else
    runUnit(opt, data, res);
  return true;
}
