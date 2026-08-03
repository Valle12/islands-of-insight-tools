// The logic-grid solver's command line.
//
// Protocol, shared with the other solvers' CLIs and with the bench and fuzz
// harnesses in src/util: the LAST stdout line starting with `{` is the
// machine-readable report; everything else is narration.

#include "FixtureIo.h"
#include "GenerateCommands.h"
#include "Puzzle.h"
#include "Reference.h"
#include "Search.h"
#include "SolverArms.h"
#include "SolverClock.h"
#include "Types.h"
#include "Verify.h"

#include <charconv>
#include <cstdint>
#include <iostream>
#include <nlohmann/json.hpp>
#include <string>
#include <string_view>
#include <system_error>

namespace {

using namespace lg;

struct CliOptions {
  std::string fixture;
  std::string generateOut;
  std::string engine = "cascade";
  std::string kind = "clued";
  uint32_t budgetMs = 60000;
  uint64_t maxNodes = 0;
  uint64_t maxHeapBytes = 0;
  uint32_t seed = 0;
  int width = 0;
  int height = 0;
  /// Roughly what percentage of a generated board's squares to fuse into
  /// merged cells. 0 leaves the main rng stream untouched.
  int shapes = 0;
  int rules = -1;
  bool quiet = false;
  bool brute = false;
};

/// Walks argv without the loop body touching the loop counter, which is what
/// makes an option that consumes the next element readable.
class ArgCursor {
public:
  ArgCursor(const int argc, char **argv) : argc_(argc), argv_(argv) {}

  [[nodiscard]] bool done() const { return index_ >= argc_; }

  std::string_view takeFlag() {
    const std::string_view flag = argv_[index_];
    index_++;
    return flag;
  }

  /// The next element, or nullptr after complaining about its absence.
  const char *value(const std::string_view flag) {
    if (index_ >= argc_) {
      std::cerr << flag << " needs a value\n";
      return nullptr;
    }
    const char *found = argv_[index_];
    index_++;
    return found;
  }

private:
  int argc_;
  char **argv_;
  int index_ = 1;
};

void printUsage() {
  std::cerr << "usage: logic_grid --fixture <path> [--engine "
               "cascade|deduce|dfs|forced]\n"
               "                  [--budget-ms N] [--max-nodes N] "
               "[--max-heap-bytes N]\n"
               "                  [--seed N] [--brute] [--quiet] [--json]\n"
               "       logic_grid --generate <path> [--seed N] "
               "[--kind clued|underclued]\n"
               "                  [--width N] [--height N] [--rules MASK]\n"
               "                  [--shapes PERCENT]\n";
}

/**
 * A numeric flag value, or nothing when the text is not one.
 *
 * `strtoul` and friends answer 0 for text with no digits and report it only
 * through `errno`, so `--budget-ms abc` used to run with a zero budget and
 * `--max-nodes -1` used to wrap to the maximum. The bench and fuzz harnesses in
 * src/util drive this CLI, so a mistyped flag produced a plausible-looking
 * report rather than an error. `from_chars` refuses all of that, and requiring
 * it to consume the WHOLE argument is what rejects "12abc".
 */
template <typename T> bool readNumber(const std::string_view text, T &out) {
  const char *end = text.data() + text.size();
  T parsed{};
  const auto [stop, code] = std::from_chars(text.data(), end, parsed);
  if (code != std::errc{} || stop != end)
    return false;
  out = parsed;
  return true;
}

/// Reads a flag's value into `out`, naming the flag when it will not parse.
template <typename T>
bool readFlag(const std::string_view flag, const std::string_view value,
              T &out) {
  if (readNumber(value, out))
    return true;
  std::cerr << "Invalid value for " << flag << ": " << value << "\n";
  return false;
}

bool assignValue(CliOptions &opts, const std::string_view flag,
                 const char *value) {
  if (flag == "--fixture")
    opts.fixture = value;
  else if (flag == "--generate")
    opts.generateOut = value;
  else if (flag == "--engine")
    opts.engine = value;
  else if (flag == "--kind")
    opts.kind = value;
  else if (flag == "--budget-ms")
    return readFlag(flag, value, opts.budgetMs);
  else if (flag == "--max-nodes")
    return readFlag(flag, value, opts.maxNodes);
  else if (flag == "--max-heap-bytes")
    return readFlag(flag, value, opts.maxHeapBytes);
  else if (flag == "--seed")
    return readFlag(flag, value, opts.seed);
  else if (flag == "--width")
    return readFlag(flag, value, opts.width);
  else if (flag == "--height")
    return readFlag(flag, value, opts.height);
  else if (flag == "--rules")
    return readFlag(flag, value, opts.rules);
  else if (flag == "--shapes")
    return readFlag(flag, value, opts.shapes);
  else {
    std::cerr << "Unknown argument: " << flag << "\n";
    return false;
  }
  return true;
}

bool parseArgs(const int argc, char **argv, CliOptions &opts) {
  ArgCursor cursor(argc, argv);
  while (!cursor.done()) {
    const std::string_view flag = cursor.takeFlag();
    if (flag == "--quiet") {
      opts.quiet = true;
      continue;
    }
    if (flag == "--brute") {
      opts.brute = true;
      continue;
    }
    // Accepted and ignored: the report is always emitted, and the harnesses
    // pass it to every solver alike.
    if (flag == "--json")
      continue;
    if (const char *value = cursor.value(flag);
        value == nullptr || !assignValue(opts, flag, value))
      return false;
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

const char *statusName(const Status status) {
  using enum Status;
  switch (status) {
  case Solved:
    return "solved";
  case Deduced:
    return "deduced";
  case Unsolvable:
    return "unsolvable";
  case Unsolved:
    return "unsolved";
  }
  return "unknown";
}

/// The answer in the app's own layout, so a report can be diffed against a
/// fixture without another transposition step somewhere else.
nlohmann::json cellsToJson(const Model &model, const Colors &colors) {
  auto grid = nlohmann::json::array();
  for (int x = 0; x < model.width(); x++) {
    auto column = nlohmann::json::array();
    for (int y = 0; y < model.height(); y++)
      column.push_back(colors[slot(cellIndex(x, y))]);
    grid.push_back(column);
  }
  return grid;
}

bool sameOnBoard(const Model &model, const Colors &left, const Colors &right) {
  for (int i = model.playable.nextSet(0); i >= 0;
       i = model.playable.nextSet(i + 1)) {
    if (left[slot(i)] != right[slot(i)])
      return false;
  }
  return true;
}

/**
 * Brute force beside the engine.
 *
 * Two claims are checked, and they are the two that matter: the engine must
 * agree about whether the board is solvable at all, and — the sharp one — the
 * cells it says are forced must be exactly the cells every solution agrees on.
 */
void addBruteForce(nlohmann::json &report, const Model &model,
                   const Outcome &outcome) {
  const reference::Answer truth = reference::enumerate(model);
  report["referenceRan"] = truth.ranToCompletion;
  if (!truth.ranToCompletion)
    return;
  report["referenceSolutions"] = truth.solutionCount;
  const bool solvable = truth.solutionCount > 0;
  report["referenceAgreesOnSolvability"] =
      solvable != (outcome.status == Status::Unsolvable);
  if (outcome.status == Status::Deduced && outcome.proven)
    report["referenceForcedMatches"] =
        sameOnBoard(model, outcome.colors, truth.forced);
}

void addWitnesses(nlohmann::json &report, const Model &model,
                  const Outcome &outcome) {
  bool allLegal = true;
  for (const Colors &witness : outcome.witnesses)
    allLegal = allLegal && verify::check(model, witness) ==
                               verify::Violation::None;
  report["witnesses"] = outcome.witnesses.size();
  report["witnessesLegal"] = allLegal;
}

void fillReport(nlohmann::json &report, const Model &model,
                const Outcome &outcome, const uint64_t searchMs) {
  const bool complete = outcome.status == Status::Solved;
  report["status"] = statusName(outcome.status);
  report["solved"] = complete;
  report["proven"] = outcome.proven;
  report["decided"] = outcome.decided;
  report["playable"] = model.playableCount;
  report["valid"] =
      !complete || verify::check(model, outcome.colors) ==
                       verify::Violation::None;
  report["cells"] = cellsToJson(model, outcome.colors);
  report["arm"] = outcome.arm;
  report["nodes"] = outcome.stats.nodesExpanded;
  report["refutations"] = outcome.stats.refutations;
  report["oracleRejections"] = outcome.stats.oracleRejections;
  report["stoppedOnMemory"] = outcome.stats.stoppedOnMemory;
  report["searchMs"] = searchMs;
  addWitnesses(report, model, outcome);
}

int solveAndReport(const CliOptions &opts, const Model &model,
                   nlohmann::json &report, const uint64_t startMs) {
  Config cfg;
  cfg.maxMs = opts.budgetMs;
  cfg.maxNodes = opts.maxNodes;
  cfg.maxHeapBytes = opts.maxHeapBytes;
  cfg.seed = opts.seed;

  Callbacks callbacks;
  if (!opts.quiet) {
    callbacks.onArmStart = [](const char *name) {
      std::cout << "arm: " << name << "\n";
    };
    cfg.callbacks = &callbacks;
  }

  const arms::ArmSpec spec{.engine = opts.engine.c_str(), .seed = opts.seed};
  const uint64_t searchStart = nowMs();
  const Outcome outcome = arms::solve(model, spec, cfg);
  fillReport(report, model, outcome, nowMs() - searchStart);
  if (opts.brute)
    addBruteForce(report, model, outcome);
  report["wallMs"] = nowMs() - startMs;
  emitReport(report);
  return 0;
}

} // namespace

int main(const int argc, char **argv) {
  CliOptions opts;
  if (!parseArgs(argc, argv, opts)) {
    printUsage();
    return 2;
  }

  if (!opts.generateOut.empty()) {
    const generate::Options genOpts{.out = opts.generateOut,
                                    .seed = opts.seed,
                                    .width = opts.width,
                                    .height = opts.height,
                                    .rules = opts.rules,
                                    .kind = opts.kind,
                                    .shapes = opts.shapes};
    return generate::run(genOpts);
  }

  if (!arms::isEngine(opts.engine.c_str())) {
    std::cerr << "Unknown engine: " << opts.engine << "\n";
    printUsage();
    return 2;
  }

  const uint64_t startMs = nowMs();
  nlohmann::json report;
  report["fixture"] = opts.fixture;
  report["engine"] = opts.engine;

  fixtureio::Fixture fixture;
  try {
    fixture = fixtureio::load(opts.fixture);
  } catch (const fixtureio::FixtureError &error) {
    report["error"] = error.what();
    report["wallMs"] = nowMs() - startMs;
    emitReport(report);
    return 1;
  } catch (const nlohmann::json::exception &error) {
    report["error"] = error.what();
    report["wallMs"] = nowMs() - startMs;
    emitReport(report);
    return 1;
  }

  if (const Problem problem = structureProblem(fixture.puzzle);
      problem != Problem::None) {
    report["error"] = describe(problem);
    report["wallMs"] = nowMs() - startMs;
    emitReport(report);
    return 1;
  }

  const Model model = buildModel(fixture.puzzle);
  if (const Problem problem = contradiction(model); problem != Problem::None) {
    report["status"] = "unsolvable";
    report["reason"] = describe(problem);
    report["wallMs"] = nowMs() - startMs;
    emitReport(report);
    return 0;
  }
  return solveAndReport(opts, model, report, startMs);
}
