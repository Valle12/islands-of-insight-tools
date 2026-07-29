// Native CLI for the rolling-blocks solver: solve a fixture under explicit
// budgets and report the outcome as one JSON line — the interface the bench
// and fuzz harnesses drive. Protocol (shared with the shifting-mosaic CLI):
// the LAST stdout line starting with '{' is the machine-readable report;
// everything else is narration.

#include "AStar.h"
#include "FixtureIo.h"
#include "Node.h"
#include "Replay.h"
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
  std::string engine = "wastar";
  uint8_t weight = 2;
  uint32_t budgetMs = 60000;
  uint64_t maxNodes = 0;
  uint64_t maxStates = 0;
  uint64_t maxHeapBytes = 0;
  uint32_t seed = 0;
  bool postProcess = true;
};

void printUsage() {
  std::cout
      << "Usage: a_star --fixture <path> [--engine wastar] [--weight N]\n"
         "              [--budget-ms N] [--max-nodes N] [--max-states N]\n"
         "              [--max-heap-bytes N] [--seed N] [--no-post] [--json]\n"
         "The last stdout line starting with '{' is the JSON report.\n";
}

bool parseArgs(const int argc, char **argv, CliOptions &opts) {
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
    if (i + 1 >= argc) {
      std::cerr << arg << " needs a value\n";
      return false;
    }
    const char *value = argv[++i];
    if (arg == "--fixture") {
      opts.fixture = value;
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
    } else {
      std::cerr << "Unknown argument: " << arg << "\n";
      return false;
    }
  }
  if (opts.fixture.empty()) {
    std::cerr << "--fixture is required\n";
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
  if (opts.engine != "wastar") {
    std::cerr << "Unknown engine '" << opts.engine
              << "' (available: wastar)\n";
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

  const uint64_t constructStart = nowMs();
  AStar solver(puzzle.gridWidth, puzzle.gridHeight, puzzle.cells, cfg);
  const uint64_t searchStart = nowMs();
  std::vector<Turn> turns = solver.search(Node(puzzle.blocks));
  const uint64_t searchEnd = nowMs();

  if (opts.postProcess && !turns.empty()) {
    turns = replay::truncateToEarliestSolve(puzzle, turns);
  }

  const replay::Outcome outcome = replay::replayTurns(puzzle, turns);
  const bool valid = outcome.legal && outcome.solvedAtEnd;

  report["solved"] = !turns.empty() && valid;
  report["valid"] = valid;
  report["turns"] = turns.size();
  report["nodesExpanded"] = solver.stats().nodesExpanded;
  report["statesStored"] = solver.stats().statesStored;
  report["stoppedOnMemory"] = solver.stats().stoppedOnMemory;
  report["constructMs"] = searchStart - constructStart;
  report["searchMs"] = searchEnd - searchStart;
  report["wallMs"] = nowMs() - constructStart;
  emitReport(report);
  return 0;
}
