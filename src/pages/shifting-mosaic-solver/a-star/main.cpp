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
//
// The flag table lives in BenchOptions.cpp and the engine setups in
// BenchEngines.cpp; main() below is only the order those run in.

#include "ClangdCompat.h" // must stay first; see the header

#include "BenchCommands.h"
#include "BenchEngines.h"
#include "BenchFixture.h"
#include "BenchOptions.h"
#include "Types.h"

#include <cstdint>
#include <exception>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <nlohmann/json.hpp>
#include <string>
#include <utility>
#include <vector>

using json = nlohmann::json;

namespace {

void writeTurnsDump(const std::vector<Turn> &turns,
                    const std::filesystem::path &dumpPath) {
  json turnsJson = json::array();
  for (const auto &[blockId, direction] : turns)
    turnsJson.push_back(
        {{"blockId", blockId},
         {"direction", static_cast<int>(std::to_underlying(direction))}});
  std::ofstream dump(dumpPath);
  dump << turnsJson.dump();
  std::cerr << "turns dumped to " << dumpPath.string() << "\n";
}

// Per-arm telemetry (parallel/sequential/twophase only): which arms solved,
// which won, and how long each took. Feeds the fuzz aggregation that decides
// the sequential phase's arm ORDER — without it that order is guesswork.
json armsReport(const std::vector<cascade::ArmOutcome> &armOutcomes) {
  json arms = json::array();
  for (const auto &[arm, solvedArm, won, declined, wallMs] : armOutcomes)
    arms.push_back({{"arm", arm},
                    {"name", cascade::armName(arm)},
                    {"solved", solvedArm},
                    {"won", won},
                    {"declined", declined},
                    {"wallMs", wallMs}});
  return arms;
}

void emitReport(const BenchOptions &opt, const Fixture &data,
                const SolveResult &res) {
  const auto &[startX, startY] = data.initialAnchors[data.goalIndex];
  const bool alreadySolved =
      startX == data.goalAnchor.x && startY == data.goalAnchor.y;
  const bool solved = !res.turns.empty() || alreadySolved;
  // No `|| alreadySolved` short-circuit: a board whose goal block starts home
  // can still be handed a non-empty plan, and skipping the replay meant even
  // the weak goal check never ran on it.
  const bool valid = !solved || replaySolves(data, res.turns);

  json out = {
      {"fixture", opt.fixturePath.filename().string()},
      {"engine", opt.engine},
      {"solved", solved},
      {"valid", valid},
      {"turns", res.turns.size()},
      {"steps", countPlayerSteps(res.turns)},
      {"dirRuns", countDirRuns(res.turns)},
      {"stage", res.stage},
      {"nodesExpanded", res.nodesExpanded},
      {"statesStored", res.statesStored},
      {"passes", res.passes},
      {"constructMs", res.t1 - res.t0},
      {"searchMs", res.t2 - res.t1},
      {"wallMs", res.t2 - res.t0},
      {"weight", opt.cfg.weight},
      {"minJamTerm", res.minJamTerm == UINT32_MAX
                         ? -1
                         : static_cast<int64_t>(res.minJamTerm)},
      {"maxProgress", res.maxProgress},
      {"stoppedOnMemory", res.stoppedOnMemory},
      {"jamAspect16", opt.jamAspect16},
      {"jamDensityPct", opt.jamDensityPct},
  };

  if (!res.armOutcomes.empty())
    out["arms"] = armsReport(res.armOutcomes);

  if (!opt.dumpPath.empty() && !res.turns.empty())
    writeTurnsDump(res.turns, opt.dumpPath);

  if (opt.emitJson) {
    std::cout << out.dump() << "\n";
    return;
  }
  std::cout << out["fixture"].get<std::string>() << ": "
            << (solved ? "SOLVED" : "unsolved") << (valid ? "" : " (INVALID)")
            << ", " << res.turns.size() << " turns, "
            << countPlayerSteps(res.turns) << " steps, " << res.nodesExpanded
            << " nodes, " << (res.t2 - res.t0) << " ms\n";
}

} // namespace

int main(const int argc, char **argv) {
  BenchOptions opt;
  if (!parseBenchOptions(argc, argv, opt))
    return usage(argv[0]);
  if (!opt.generatePath.empty())
    return runGenerate(opt.generatePath.string(), opt.seed, opt.shuffleMoves,
                       opt.emitJson);
  if (opt.fixturePath.empty())
    return usage(argv[0]);
  if (!isKnownEngine(opt.engine)) {
    std::cerr << "Unknown engine '" << opt.engine << "'\n";
    return 2;
  }

  Fixture data;
  try {
    data = loadFixture(opt.fixturePath.string());
  } catch (const std::exception &e) {
    std::cerr << e.what() << "\n";
    return 1;
  }
  if (!opt.verifyPath.empty())
    return runVerify(data, opt.verifyPath.string());

  SolveResult res;
  if (!runBenchEngine(opt, data, res))
    return 2;

  emitReport(opt, data, res);
  return 0;
}
