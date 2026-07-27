// Bench CLI for the shifting-mosaic solver. Runs one fixture under a chosen
// engine/config and reports machine-readable stats, so configs can be swept
// and compared across engines (see src/util/benchShiftingMosaic.ts and
// src/util/fuzzShiftingMosaic.ts).
//
//   shifting_mosaic_a_star --fixture <path>
//       [--engine unit|drag|hier|assembly|corridor|jam|beam|cascade|
//                parallel|sequential|twophase|arm]
//       [--arm N] [--arm-gated] [--jam-aspect N] [--jam-density N]
//       [--weight N] [--budget-ms N] [--max-nodes N] [--stride N]
//       [--no-post] [--settled] [--pea N] [--ratchet] [--max-states N]
//       [--max-heap-bytes N]
//       [--json]
//
//   shifting_mosaic_a_star --generate <outPath> --seed N [--shuffle N]
//       [--json]
//     Builds a random solvable fixture: random grid (4..60 square-ish),
//     random polyomino blocks (1..20), the goal block STARTING on its goal
//     anchor, then shuffled by a long random walk — the reverse walk is a
//     solution, so the instance is solvable by construction.
//
// With --json the LAST stdout line is a single JSON object (search progress
// chatter precedes it); consumers should parse the final line only.

#include "ClangdCompat.h" // must stay first; see the header

#include "AStar.h"
#include "BenchCommands.h"
#include "BenchFixture.h"
#include "DragSolver.h"
#include "ParallelCascade.h"
#include "Types.h"

#include <cerrno>
#include <cstdint>
#include <cstdlib>
#include <exception>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <nlohmann/json.hpp>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

using json = nlohmann::json;

int main(int argc, char **argv) {
  std::string fixturePath;
  std::string engine = "unit";
  std::string dumpPath;
  std::string generatePath;
  uint32_t seed = 0;
  uint32_t shuffleMoves = 100000;
  bool emitJson = false;
  bool settledOnly = false;
  uint16_t pea = 0;
  uint8_t packingWeight = 0;
  uint8_t consolidationGain = 0;
  bool slotHeuristic = false;
  bool requireAllSlots = false;
  bool lockOnSlot = false;
  bool sleepSets = false;
  bool relevantOnly = false;
  bool bands = false;
  uint8_t bandMinPath = DragSolver::Config{}.corridorBandMinPath;
  uint64_t maxStates = 0;    // 0 = unlimited (unchanged behaviour)
  uint64_t maxHeapBytes = 0; // 0 = unlimited; measured bytes, not a proxy
  uint32_t seqTotalMs = 0;   // total cap for the sequential phase; 0 = none
  uint8_t jamAspect16 = DragSolver::Config{}.jamAspect16;     // x16 ratio
  uint8_t jamDensityPct = DragSolver::Config{}.jamDensityPct; // percent
  int armIndex = -1;     // --engine arm: which race arm to run alone
  bool armGated = false; // apply jamProfile() to arms 6/7 (phase 2 does not)
  std::vector<cascade::ArmOutcome> armOutcomes;
  // Decomposition of a stalled jam board: dump the deepest elite as a residual
  // fixture (+ the root→elite prefix) so the remainder can be solved
  // separately and the two halves stitched.
  std::string dumpElitePath;
  std::string dumpEliteTurnsPath;
  std::string verifyPath;
  uint8_t jamPenalty = 4;
  uint8_t jamGuide = 0;
  bool jamPin = false;
  uint32_t jamRoundCap = 0;
  uint32_t jamElites = 6;
  bool jamLuby = false;
  uint32_t tieSeed = 0;
  uint32_t beamWidth = 0;

  // Production defaults (mirrors wasmBridge.ts SOLVER_CONFIG).
  AStar::Config cfg;
  cfg.weight = 3;
  cfg.pathBlockerWeight = 1;
  cfg.boundaryDistanceWeight = 1;
  cfg.axisAwareWeight = 1;
  cfg.lpDisplacementWeight = 1;
  cfg.postProcess = true;
  uint32_t budgetMs = 60000;
  uint32_t maxNodes = 20000000;

  for (int i = 1; i < argc; i++) {
    const std::string_view arg = argv[i];
    const auto next = [&]() -> const char * {
      if (i + 1 >= argc) {
        std::cerr << "Missing value for " << arg << "\n";
        std::exit(2);
      }
      return argv[++i];
    };
    // atoi()/atoll() report nothing: a typo'd or out-of-range value silently
    // becomes 0 and the sweep looks like it honoured the flag while measuring
    // something else. Every numeric option goes through this instead.
    const auto nextU = [&]() -> uint64_t {
      const char *const raw = next();
      char *end = nullptr;
      errno = 0;
      const unsigned long long v = std::strtoull(raw, &end, 10);
      // strtoull happily wraps a leading '-' into a huge value, so reject the
      // sign explicitly rather than letting "-1" mean 18446744073709551615.
      if (end == raw || *end != '\0' || errno == ERANGE || raw[0] == '-') {
        std::cerr << "Invalid number for " << arg << ": " << raw << "\n";
        std::exit(2);
      }
      return v;
    };
    if (arg == "--fixture")
      fixturePath = next();
    else if (arg == "--engine")
      engine = next();
    else if (arg == "--weight")
      cfg.weight = static_cast<uint8_t>(nextU());
    else if (arg == "--budget-ms")
      budgetMs = static_cast<uint32_t>(nextU());
    else if (arg == "--max-nodes")
      maxNodes = static_cast<uint32_t>(nextU());
    else if (arg == "--stride")
      cfg.strideOverride = static_cast<uint8_t>(nextU());
    else if (arg == "--settled")
      settledOnly = true;
    else if (arg == "--pea")
      pea = static_cast<uint16_t>(nextU());
    else if (arg == "--packing-weight")
      packingWeight = static_cast<uint8_t>(nextU());
    else if (arg == "--consolidation")
      consolidationGain = static_cast<uint8_t>(nextU());
    else if (arg == "--slot-h")
      slotHeuristic = true;
    else if (arg == "--dump")
      dumpPath = next();
    else if (arg == "--all-slots")
      requireAllSlots = true;
    else if (arg == "--ratchet")
      lockOnSlot = true;
    else if (arg == "--por")
      sleepSets = true;
    else if (arg == "--relevant")
      relevantOnly = true;
    else if (arg == "--bands")
      bands = true;
    else if (arg == "--band-min-path")
      bandMinPath = static_cast<uint8_t>(nextU());
    else if (arg == "--max-states") {
      maxStates = nextU();
      cfg.maxStatesStored = maxStates;
    } else if (arg == "--arm")
      armIndex = static_cast<int>(nextU());
    else if (arg == "--arm-gated")
      armGated = true;
    else if (arg == "--jam-density")
      jamDensityPct = static_cast<uint8_t>(nextU());
    else if (arg == "--jam-aspect")
      jamAspect16 = static_cast<uint8_t>(nextU());
    else if (arg == "--seq-total-ms")
      seqTotalMs = static_cast<uint32_t>(nextU());
    else if (arg == "--max-heap-bytes") {
      maxHeapBytes = nextU();
      cfg.maxHeapBytes = maxHeapBytes;
    } else if (arg == "--dump-elite")
      dumpElitePath = next();
    else if (arg == "--dump-elite-turns")
      dumpEliteTurnsPath = next();
    else if (arg == "--verify")
      verifyPath = next();
    else if (arg == "--jam-penalty")
      jamPenalty = static_cast<uint8_t>(nextU());
    else if (arg == "--jam-guide")
      jamGuide = static_cast<uint8_t>(nextU());
    else if (arg == "--jam-pin")
      jamPin = true;
    else if (arg == "--jam-round-cap")
      jamRoundCap = static_cast<uint32_t>(nextU());
    else if (arg == "--jam-elites")
      jamElites = static_cast<uint32_t>(nextU());
    else if (arg == "--jam-luby")
      jamLuby = true;
    else if (arg == "--tie-seed")
      tieSeed = static_cast<uint32_t>(nextU());
    else if (arg == "--beam")
      beamWidth = static_cast<uint32_t>(nextU());
    else if (arg == "--generate")
      generatePath = next();
    else if (arg == "--seed")
      seed = static_cast<uint32_t>(nextU());
    else if (arg == "--shuffle")
      shuffleMoves = static_cast<uint32_t>(nextU());
    else if (arg == "--no-post")
      cfg.postProcess = false;
    else if (arg == "--json")
      emitJson = true;
    else {
      std::cerr << "Unknown argument: " << arg << "\n";
      return usage(argv[0]);
    }
  }
  if (!generatePath.empty())
    return runGenerate(generatePath, seed, shuffleMoves, emitJson);
  if (fixturePath.empty())
    return usage(argv[0]);
  if (engine != "unit" && engine != "drag" && engine != "hier" &&
      engine != "assembly" && engine != "corridor" && engine != "jam" &&
      engine != "beam" && engine != "cascade" && engine != "parallel" &&
      engine != "sequential" && engine != "twophase" && engine != "arm") {
    std::cerr << "Unknown engine '" << engine << "'\n";
    return 2;
  }
  Fixture data;
  try {
    data = loadFixture(fixturePath);
  } catch (const std::exception &e) {
    std::cerr << e.what() << "\n";
    return 1;
  }
  if (!verifyPath.empty())
    return runVerify(data, verifyPath);

  uint64_t t0 = 0;
  uint64_t t1 = 0;
  uint64_t t2 = 0;
  std::vector<Turn> turns;
  uint32_t nodesExpanded = 0;
  uint64_t statesStored = 0;
  uint8_t passes = 0;
  uint32_t minJamTerm = UINT32_MAX;
  uint32_t maxProgress = 0;
  // True when any search stopped on the measured-memory ceiling rather than
  // the clock or exhaustion — the stdout message is verbose-gated, so the stat
  // is the only reliable signal.
  bool stoppedOnMemory = false;
  std::string stage = engine;
  if (engine == "parallel") {
    // THE SHIPPED PATH. solveArmsParallel is the exact function the threaded
    // wasm build calls for a cross-origin-isolated page (wasm_bindings.cpp
    // under __EMSCRIPTEN_PTHREADS__): 8 arms racing on real threads, first
    // non-empty plan wins and cancels the rest. --engine cascade is the
    // SEQUENTIAL chain and answers a different question — use this one to
    // measure what a browser actually does.
    t0 = nowMs();
    t1 = t0;
    turns = solveArmsParallel(
        data.gridWidth, data.gridHeight, data.shapes, data.initialAnchors,
        data.goalIndex, data.goalAnchor, budgetMs, maxNodes, cfg.postProcess,
        [](uint32_t) {}, maxHeapBytes, jamAspect16, jamDensityPct,
        &armOutcomes);
    t2 = nowMs();
  } else if (engine == "arm") {
    // Runs ONE race arm with its REAL configuration, via the same runArm the
    // race and the sequential phase use. Necessary because --engine jam/beam
    // build their own default configs and are NOT arms 6/7 — measuring those
    // and calling the result "per-arm" silently compares the wrong solver
    // (it is why an earlier study concluded no arm could solve seed 45501,
    // which arm 6 in fact wins). Ungated by default, matching phase 2.
    if (armIndex < 0 || armIndex >= cascade::ARMS) {
      std::cerr << "--engine arm needs --arm 0.." << (cascade::ARMS - 1)
                << "\n";
      return 2;
    }
    t0 = nowMs();
    t1 = t0;
    turns = cascade::runArm(
        armIndex, data.gridWidth, data.gridHeight, data.shapes,
        data.initialAnchors, data.goalIndex, data.goalAnchor, budgetMs,
        maxNodes, cfg.postProcess, maxHeapBytes, nullptr, [](uint32_t) {},
        armGated, jamAspect16, jamDensityPct);
    t2 = nowMs();
    stage = cascade::armName(armIndex);
  } else if (engine == "sequential" || engine == "twophase") {
    // "sequential" = phase 2 alone (each arm gets the whole heap, ungated).
    // "twophase"   = what the browser will do: race first, fall back second.
    t0 = nowMs();
    t1 = t0;
    if (engine == "twophase")
      turns = solveArmsParallel(
          data.gridWidth, data.gridHeight, data.shapes, data.initialAnchors,
          data.goalIndex, data.goalAnchor, budgetMs, maxNodes, cfg.postProcess,
          [](uint32_t) {}, maxHeapBytes, jamAspect16, jamDensityPct,
          &armOutcomes);
    if (turns.empty()) {
      if (engine == "twophase")
        std::cout << "cascade: parallel race found nothing - falling back to "
                     "sequential arms (slower; each arm gets the whole heap)\n";
      turns = solveArmsSequential(
          data.gridWidth, data.gridHeight, data.shapes, data.initialAnchors,
          data.goalIndex, data.goalAnchor, budgetMs, seqTotalMs, maxNodes,
          cfg.postProcess, [](uint32_t) {}, maxHeapBytes, nullptr, jamAspect16,
          jamDensityPct, &armOutcomes);
      if (!turns.empty())
        stage = "sequential";
    } else {
      stage = "parallel";
    }
    t2 = nowMs();
  } else if (engine == "cascade") {
    // The production chain (mirrors wasm_bindings' cascade): assembly →
    // hier → deep flat drag → unit, each with the full per-stage budget.
    t0 = nowMs();
    t1 = t0;
    const auto accumulate = [&](const DragSolver &s) {
      nodesExpanded += s.lastStats().nodesExpanded;
      statesStored += s.lastStats().statesStored;
      stoppedOnMemory = stoppedOnMemory || s.lastStats().stoppedOnMemory;
      passes = static_cast<uint8_t>(passes + s.lastStats().passes);
    };
    {
      DragSolver::Config c;
      c.postProcess = cfg.postProcess;
      DragSolver s(data.gridWidth, data.gridHeight, data.shapes,
                   data.initialAnchors, data.goalIndex, data.goalAnchor, c);
      turns = s.searchAssembly(budgetMs, maxNodes);
      accumulate(s);
      if (!turns.empty())
        stage = "assembly";
    }
    if (turns.empty()) {
      // Corridor arm: instant-declines unless the goal has no real cuts but a
      // long journey (then synthetic bands make hier decompose the corridor).
      DragSolver::Config c;
      c.weight = 3;
      c.settledOnly = true;
      c.partialExpansionWidth = 48;
      c.corridorBands = true;
      c.postProcess = cfg.postProcess;
      DragSolver s(data.gridWidth, data.gridHeight, data.shapes,
                   data.initialAnchors, data.goalIndex, data.goalAnchor, c);
      turns = s.searchHierarchical(budgetMs, maxNodes);
      accumulate(s);
      if (!turns.empty())
        stage = "corridor";
    }
    if (turns.empty()) {
      DragSolver::Config c;
      c.weight = 3;
      c.settledOnly = true;
      c.partialExpansionWidth = 48;
      c.postProcess = cfg.postProcess;
      DragSolver s(data.gridWidth, data.gridHeight, data.shapes,
                   data.initialAnchors, data.goalIndex, data.goalAnchor, c);
      turns = s.searchHierarchical(budgetMs, maxNodes);
      accumulate(s);
      if (!turns.empty())
        stage = "hier";
    }
    if (turns.empty()) {
      DragSolver::Config c;
      c.weight = 4;
      c.settledOnly = true;
      c.partialExpansionWidth = 64;
      c.postProcess = cfg.postProcess;
      DragSolver s(data.gridWidth, data.gridHeight, data.shapes,
                   data.initialAnchors, data.goalIndex, data.goalAnchor, c);
      turns = s.search(budgetMs, maxNodes);
      accumulate(s);
      if (!turns.empty())
        stage = "drag";
    }
    if (turns.empty()) {
      // Jam arm: relevance filter + commutativity pruning for compact dense
      // boards where the unrestricted searches drown.
      DragSolver::Config c;
      c.weight = 4;
      c.settledOnly = true;
      c.partialExpansionWidth = 64;
      c.sleepSets = true;
      c.relevantOnly = true;
      c.postProcess = cfg.postProcess;
      DragSolver s(data.gridWidth, data.gridHeight, data.shapes,
                   data.initialAnchors, data.goalIndex, data.goalAnchor, c);
      turns = s.search(budgetMs, maxNodes);
      accumulate(s);
      if (!turns.empty())
        stage = "relevant";
    }
    if (turns.empty()) {
      // Jam-restart arm: dig-cost-guided diversified rounds for compact
      // dense 0-cut boards; declines instantly outside the jam profile.
      // Luby-shaped caps (20k base / 64 elites): -46% ratchet depth vs stock
      // at the 300s browser budget on the hard-instance family
      // (HARD-BOARDS.md).
      DragSolver::Config c;
      c.corridorBands = true;
      c.jamRoundNodeCap = 20000;
      c.jamMaxElites = 64;
      c.jamLubyRestarts = true;
      c.postProcess = cfg.postProcess;
      DragSolver s(data.gridWidth, data.gridHeight, data.shapes,
                   data.initialAnchors, data.goalIndex, data.goalAnchor, c);
      if (s.jamProfile()) {
        turns = s.searchJamRestarts(budgetMs, maxNodes);
        accumulate(s);
        if (!turns.empty())
          stage = "jamrestart";
      }
    }
    if (turns.empty()) {
      // Guided-beam arm: breadth against the jam plateaus the restart
      // rounds dive past. Same gate. The wide-beam/heavy-penalty config is
      // the one that cracked seed 3870 (own process — can afford the RAM).
      DragSolver::Config c;
      c.corridorBands = true;
      c.jamGuideWeight = 8;
      c.jamBlockerPenalty = 8;
      c.beamWidth = 500000;
      c.postProcess = cfg.postProcess;
      DragSolver s(data.gridWidth, data.gridHeight, data.shapes,
                   data.initialAnchors, data.goalIndex, data.goalAnchor, c);
      if (s.jamProfile()) {
        turns = s.searchBeamJam(budgetMs, maxNodes);
        accumulate(s);
        if (!turns.empty())
          stage = "jambeam";
      }
    }
    if (turns.empty()) {
      AStar s(data.gridWidth, data.gridHeight, data.shapes, data.initialAnchors,
              data.goalIndex, data.goalAnchor, cfg);
      turns = s.search(budgetMs, maxNodes);
      nodesExpanded += s.lastStats().nodesExpanded;
      statesStored += s.lastStats().statesStored;
      stoppedOnMemory = stoppedOnMemory || s.lastStats().stoppedOnMemory;
      passes = static_cast<uint8_t>(passes + s.lastStats().passes);
      if (!turns.empty())
        stage = "unit";
    }
    if (turns.empty())
      stage = "none";
    t2 = nowMs();
  } else if (engine == "drag" || engine == "hier" || engine == "assembly" ||
             engine == "corridor" || engine == "jam" || engine == "beam") {
    DragSolver::Config dcfg;
    dcfg.weight = cfg.weight;
    dcfg.postProcess = cfg.postProcess;
    dcfg.settledOnly = settledOnly;
    dcfg.partialExpansionWidth = pea;
    dcfg.packingWeight = packingWeight;
    dcfg.consolidationGain = consolidationGain;
    dcfg.slotHeuristic = slotHeuristic;
    dcfg.requireAllSlots = requireAllSlots;
    dcfg.lockOnSlot = lockOnSlot;
    dcfg.sleepSets = sleepSets;
    dcfg.relevantOnly = relevantOnly;
    dcfg.corridorBands = engine == "corridor" || bands;
    dcfg.corridorBandMinPath = bandMinPath;
    dcfg.maxStatesStored = maxStates;
    dcfg.maxHeapBytes = maxHeapBytes;
    dcfg.jamAspect16 = jamAspect16;
    dcfg.jamDensityPct = jamDensityPct;
    dcfg.jamGuideWeight = jamGuide;
    dcfg.jamPinRoute = jamPin;
    dcfg.jamRoundNodeCap = jamRoundCap;
    dcfg.jamMaxElites = jamElites;
    dcfg.jamLubyRestarts = jamLuby;
    dcfg.jamBlockerPenalty = jamPenalty;
    dcfg.tieBreakSeed = tieSeed;
    dcfg.beamWidth = beamWidth;
    t0 = nowMs();
    DragSolver solver(data.gridWidth, data.gridHeight, data.shapes,
                      data.initialAnchors, data.goalIndex, data.goalAnchor,
                      dcfg);
    t1 = nowMs();
    turns = engine == "hier" || engine == "corridor"
                ? solver.searchHierarchical(budgetMs, maxNodes)
            : engine == "assembly" ? solver.searchAssembly(budgetMs, maxNodes)
            : engine == "jam"  ? solver.searchJamRestarts(budgetMs, maxNodes)
            : engine == "beam" ? solver.searchBeamJam(budgetMs, maxNodes)
                               : solver.search(budgetMs, maxNodes);
    t2 = nowMs();
    nodesExpanded = solver.lastStats().nodesExpanded;
    statesStored = solver.lastStats().statesStored;
    stoppedOnMemory = solver.lastStats().stoppedOnMemory;
    passes = solver.lastStats().passes;
    minJamTerm = solver.lastStats().minJamTerm;
    maxProgress = solver.lastStats().maxProgress;
    // Decomposition hand-off: on a stalled jam run, write the deepest elite as
    // a residual fixture and its root→elite prefix, so the remainder can be
    // attacked separately and the halves stitched (verify with --verify).
    if (!solver.lastEliteAnchors().empty()) {
      if (!dumpElitePath.empty()) {
        if (writeFixtureAt(data, solver.lastEliteAnchors(), dumpElitePath))
          std::cerr << "elite residual fixture dumped to " << dumpElitePath
                    << "\n";
        else
          std::cerr << "cannot write " << dumpElitePath << "\n";
      }
      if (!dumpEliteTurnsPath.empty()) {
        const auto prefix = solver.lastElitePrefixTurns();
        writeTurnsFile(prefix, dumpEliteTurnsPath);
        std::cerr << "elite prefix (" << prefix.size() << " turns) dumped to "
                  << dumpEliteTurnsPath << "\n";
      }
    }
  } else {
    t0 = nowMs();
    AStar solver(data.gridWidth, data.gridHeight, data.shapes,
                 data.initialAnchors, data.goalIndex, data.goalAnchor, cfg);
    t1 = nowMs();
    turns = solver.search(budgetMs, maxNodes);
    t2 = nowMs();
    nodesExpanded = solver.lastStats().nodesExpanded;
    statesStored = solver.lastStats().statesStored;
    stoppedOnMemory = solver.lastStats().stoppedOnMemory;
    passes = solver.lastStats().passes;
  }

  const auto &[startX, startY] = data.initialAnchors[data.goalIndex];
  const bool alreadySolved =
      startX == data.goalAnchor.x && startY == data.goalAnchor.y;
  const bool solved = !turns.empty() || alreadySolved;
  // No `|| alreadySolved` short-circuit: a board whose goal block starts home
  // can still be handed a non-empty plan, and skipping the replay meant even
  // the weak goal check never ran on it.
  const bool valid = !solved || replaySolves(data, turns);

  json out = {
      {"fixture", std::filesystem::path(fixturePath).filename().string()},
      {"engine", engine},
      {"solved", solved},
      {"valid", valid},
      {"turns", turns.size()},
      {"steps", countPlayerSteps(turns)},
      {"dirRuns", countDirRuns(turns)},
      {"stage", stage},
      {"nodesExpanded", nodesExpanded},
      {"statesStored", statesStored},
      {"passes", passes},
      {"constructMs", t1 - t0},
      {"searchMs", t2 - t1},
      {"wallMs", t2 - t0},
      {"weight", cfg.weight},
      {"minJamTerm",
       minJamTerm == UINT32_MAX ? -1 : static_cast<int64_t>(minJamTerm)},
      {"maxProgress", maxProgress},
      {"stoppedOnMemory", stoppedOnMemory},
      {"jamAspect16", jamAspect16},
      {"jamDensityPct", jamDensityPct},
  };

  // Per-arm telemetry (parallel/sequential/twophase only): which arms solved,
  // which won, and how long each took. Feeds the fuzz aggregation that decides
  // the sequential phase's arm ORDER — without it that order is guesswork.
  if (!armOutcomes.empty()) {
    json arms = json::array();
    for (const auto &[arm, solvedArm, won, declined, wallMs] : armOutcomes)
      arms.push_back({{"arm", arm},
                      {"name", cascade::armName(arm)},
                      {"solved", solvedArm},
                      {"won", won},
                      {"declined", declined},
                      {"wallMs", wallMs}});
    out["arms"] = arms;
  }

  if (!dumpPath.empty() && !turns.empty()) {
    json turnsJson = json::array();
    for (const auto &[blockId, direction] : turns)
      turnsJson.push_back(
          {{"blockId", blockId},
           {"direction", static_cast<int>(std::to_underlying(direction))}});
    std::ofstream dump(dumpPath);
    dump << turnsJson.dump();
    std::cerr << "turns dumped to " << dumpPath << "\n";
  }

  if (emitJson) {
    std::cout << out.dump() << "\n";
  } else {
    std::cout << out["fixture"].get<std::string>() << ": "
              << (solved ? "SOLVED" : "unsolved") << (valid ? "" : " (INVALID)")
              << ", " << turns.size() << " turns, " << countPlayerSteps(turns)
              << " steps, " << nodesExpanded << " nodes, " << (t2 - t0)
              << " ms\n";
  }
  return 0;
}
