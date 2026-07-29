// Native CLI for the rolling-blocks solver: solve a fixture under explicit
// budgets and report the outcome as one JSON line — the interface the bench
// and fuzz harnesses drive. Protocol (shared with the shifting-mosaic CLI):
// the LAST stdout line starting with '{' is the machine-readable report;
// everything else is narration.

#include "AStar.h"
#include "AStarOptimizer.h"
#include "FixtureIo.h"
#include "GenerateCommands.h"
#include "SolverArms.h"
#include "SolverClock.h"

#include <cstdint>
#include <cstdlib>
#include <iostream>
#include <nlohmann/json.hpp>
#include <string>
#include <string_view>
#include <vector>

namespace {

struct CliOptions {
  std::string fixture;
  std::string generateOut;
  std::string kind = "goal";
  std::string engine = "cascade";
  uint8_t weight = 2;
  uint32_t budgetMs = 60000;
  uint64_t maxNodes = 0;
  uint64_t maxStates = 0;
  uint64_t maxHeapBytes = 0;
  uint32_t seed = 0;
  uint32_t shuffle = 100000;
  uint32_t beamWidth = 0;
  bool gated = false;
  bool postProcess = true;
};

void printUsage() {
  std::cout
      << "Usage: a_star --fixture <path>\n"
         "              [--engine cascade|wastar|exact|cracker|beam|greedy]\n"
         "              [--weight N] [--budget-ms N] [--max-nodes N]\n"
         "              [--max-states N] [--max-heap-bytes N] [--seed N]\n"
         "              [--beam N] [--gated] [--no-post] [--json]\n"
         "       a_star --generate <path> --seed N [--shuffle N]\n"
         "              [--kind goal|coverage|mixed]\n"
         "The last stdout line starting with '{' is the JSON report.\n";
}

bool parseArgs(const int argc, char * const*argv, CliOptions &opts) {
  for (int i = 1; i < argc; i++) {
    const std::string_view arg = argv[i];
    if (arg == "--json") {
      // Accepted for harness compatibility; the report is always emitted.
      continue;
    }
    if (arg == "--no-post") {
      opts.postProcess = false;
      continue;
    }
    if (arg == "--gated") {
      opts.gated = true;
      continue;
    }
    if (i + 1 >= argc) {
      std::cerr << arg << " needs a value\n";
      return false;
    }
    const char *value = argv[++i];
    if (arg == "--fixture") {
      opts.fixture = value;
    } else if (arg == "--generate") {
      opts.generateOut = value;
    } else if (arg == "--kind") {
      opts.kind = value;
    } else if (arg == "--shuffle") {
      opts.shuffle = static_cast<uint32_t>(std::strtoul(value, nullptr, 10));
    } else if (arg == "--engine") {
      opts.engine = value;
    } else if (arg == "--weight") {
      opts.weight = static_cast<uint8_t>(std::strtoul(value, nullptr, 10));
    } else if (arg == "--budget-ms") {
      opts.budgetMs = static_cast<uint32_t>(std::strtoul(value, nullptr, 10));
    } else if (arg == "--max-nodes") {
      opts.maxNodes = std::strtoull(value, nullptr, 10);
    } else if (arg == "--max-states") {
      opts.maxStates = std::strtoull(value, nullptr, 10);
    } else if (arg == "--max-heap-bytes") {
      opts.maxHeapBytes = std::strtoull(value, nullptr, 10);
    } else if (arg == "--seed") {
      opts.seed = static_cast<uint32_t>(std::strtoul(value, nullptr, 10));
    } else if (arg == "--beam") {
      opts.beamWidth = static_cast<uint32_t>(std::strtoul(value, nullptr, 10));
    } else {
      std::cerr << "Unknown argument: " << arg << "\n";
      return false;
    }
  }
  if (opts.fixture.empty() && opts.generateOut.empty()) {
    std::cerr << "--fixture or --generate is required\n";
    return false;
  }
  return true;
}

void emitReport(const nlohmann::json &report) {
  std::cout << report.dump() << "\n";
}

} // namespace

int main(const int argc, char **argv) {
  CliOptions opts;
  if (!parseArgs(argc, argv, opts)) {
    printUsage();
    return 2;
  }
  if (!opts.generateOut.empty()) {
    return generate::run(opts.generateOut, opts.seed, opts.shuffle, opts.kind);
  }
  if (!arms::knownEngine(opts.engine)) {
    std::cerr << "Unknown engine '" << opts.engine
              << "' (available: cascade, wastar, exact, cracker, beam, "
                 "greedy)\n";
    return 2;
  }

  nlohmann::json report;
  report["fixture"] = opts.fixture;
  report["engine"] = opts.engine;
  report["weight"] = opts.weight;

  replay::Puzzle puzzle;
  try {
    puzzle = fixtureio::load(opts.fixture);
  } catch (const std::exception &e) {
    report["error"] = e.what();
    emitReport(report);
    return 1;
  }

  AStar::Config cfg;
  cfg.weight = opts.weight;
  cfg.maxMs = opts.budgetMs;
  cfg.maxNodes = opts.maxNodes;
  cfg.maxStatesStored = opts.maxStates;
  cfg.maxHeapBytes = opts.maxHeapBytes;
  cfg.seed = opts.seed;

  arms::ArmSpec spec;
  spec.engine = opts.engine;
  spec.beamWidth = opts.beamWidth;
  spec.gated = opts.gated;

  const uint64_t searchStart = nowMs();
  arms::Outcome outcome = arms::solve(
      puzzle, spec, cfg, {},
      [](const std::string &arm) { std::cout << "arm: " << arm << "\n"; });
  std::vector<Turn> turns = std::move(outcome.turns);
  const uint64_t searchEnd = nowMs();

  if (opts.postProcess && !turns.empty()) {
    turns = optimizer::optimize(puzzle, std::move(turns), 30000);
  }

  const replay::Outcome replayed = replay::replayTurns(puzzle, turns);
  // A board that is solved before any move legitimately gets an empty plan;
  // report it as solved so harnesses can score it trivial, not failed.
  const bool alreadySolved =
      turns.empty() && replay::replayTurns(puzzle, {}).solvedAtEnd;
  // `valid` judges a RETURNED plan. An empty plan on an unsolved board is
  // "no solution found", not an invalid one — harnesses distinguish the two.
  const bool valid =
      turns.empty() ? true : replayed.legal && replayed.solvedAtEnd;

  report["solved"] =
      (!turns.empty() && replayed.legal && replayed.solvedAtEnd) ||
      alreadySolved;
  report["alreadySolved"] = alreadySolved;
  report["valid"] = valid;
  report["turns"] = turns.size();
  report["stage"] = outcome.arm;
  report["nodesExpanded"] = outcome.stats.nodesExpanded;
  report["statesStored"] = outcome.stats.statesStored;
  report["stoppedOnMemory"] = outcome.stats.stoppedOnMemory;
  report["searchMs"] = searchEnd - searchStart;
  report["wallMs"] = nowMs() - searchStart;
  emitReport(report);
  return 0;
}
