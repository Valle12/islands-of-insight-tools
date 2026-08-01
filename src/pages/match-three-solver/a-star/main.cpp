// Native CLI for the match-three solver: solve a fixture under explicit
// budgets and report the outcome as one JSON line — the interface the bench and
// fuzz harnesses drive. Protocol (shared with the other two solvers' CLIs): the
// LAST stdout line starting with '{' is the machine-readable report; everything
// else is narration.

#include "FixtureIo.h"
#include "GenerateCommands.h"
#include "Replay.h"
#include "Rules.h"
#include "SolverArms.h"
#include "SolverClock.h"

#include <cstdlib>
#include <exception>
#include <iostream>
#include <nlohmann/json.hpp>
#include <string>
#include <string_view>

namespace {

struct CliOptions {
  std::string fixture;
  std::string generateOut;
  std::string kind = "random";
  std::string engine = "cascade";
  uint32_t budgetMs = 60000;
  uint64_t maxNodes = 0;
  uint64_t tableBytes = mt::kDefaultTableBytes;
  uint64_t maxHeapBytes = 0;
  uint32_t seed = 0;
  int beamWidth = 0;
  int nrpaLevel = 0;
  int nrpaIterations = 0;
  int width = 0;
  int height = 0;
  int symbols = 0;
  bool quiet = false;
};

void printUsage() {
  std::cout << "Usage: match_three --fixture <path>\n"
               "                   [--engine cascade|exhaustive|greedy|beam|nrpa]\n"
               "                   [--budget-ms N] [--max-nodes N]\n"
               "                   [--table-bytes N] [--max-heap-bytes N]\n"
               "                   [--seed N] [--beam N] [--nrpa-level N]\n"
               "                   [--nrpa-iterations N] [--quiet] [--json]\n"
               "       match_three --generate <path> --seed N\n"
               "                   [--kind random|cluster] [--width N]\n"
               "                   [--height N] [--symbols N]\n"
               "The last stdout line starting with '{' is the JSON report.\n";
}

// Walks argv. The index lives here rather than in a for-loop counter that the
// body also advances: an option with a value has to consume the next element,
// and a loop whose counter is written inside it is exactly the shape static
// analysis (and readers) trip over. Same idea as the other two solvers' CLIs.
class ArgCursor {
public:
  ArgCursor(const int argc, char *const *const argv)
      : argc_(argc), argv_(argv) {}

  [[nodiscard]] bool hasMore() const { return index_ < argc_; }

  std::string_view takeFlag() {
    flag_ = argv_[index_];
    index_++;
    return flag_;
  }

  // Consumes the current option's value, or nullptr when there is none — the
  // message is emitted here so every call site is one early return.
  const char *value() {
    if (index_ >= argc_) {
      std::cerr << flag_ << " needs a value\n";
      return nullptr;
    }
    const char *const held = argv_[index_];
    index_++;
    return held;
  }

private:
  int argc_;
  char *const *argv_;
  int index_ = 1;
  std::string_view flag_;
};

bool assignValue(const std::string_view arg, const char *const value,
                 CliOptions &opts) {
  if (arg == "--fixture")
    opts.fixture = value;
  else if (arg == "--generate")
    opts.generateOut = value;
  else if (arg == "--kind")
    opts.kind = value;
  else if (arg == "--engine")
    opts.engine = value;
  else if (arg == "--budget-ms")
    opts.budgetMs = static_cast<uint32_t>(std::strtoul(value, nullptr, 10));
  else if (arg == "--max-nodes")
    opts.maxNodes = std::strtoull(value, nullptr, 10);
  else if (arg == "--table-bytes")
    opts.tableBytes = std::strtoull(value, nullptr, 10);
  else if (arg == "--max-heap-bytes")
    opts.maxHeapBytes = std::strtoull(value, nullptr, 10);
  else if (arg == "--seed")
    opts.seed = static_cast<uint32_t>(std::strtoul(value, nullptr, 10));
  else if (arg == "--beam")
    opts.beamWidth = static_cast<int>(std::strtol(value, nullptr, 10));
  else if (arg == "--nrpa-level")
    opts.nrpaLevel = static_cast<int>(std::strtol(value, nullptr, 10));
  else if (arg == "--nrpa-iterations")
    opts.nrpaIterations = static_cast<int>(std::strtol(value, nullptr, 10));
  else if (arg == "--width")
    opts.width = static_cast<int>(std::strtol(value, nullptr, 10));
  else if (arg == "--height")
    opts.height = static_cast<int>(std::strtol(value, nullptr, 10));
  else if (arg == "--symbols")
    opts.symbols = static_cast<int>(std::strtol(value, nullptr, 10));
  else {
    std::cerr << "Unknown argument: " << arg << "\n";
    return false;
  }
  return true;
}

bool parseArgs(const int argc, char *const *argv, CliOptions &opts) {
  ArgCursor cursor(argc, argv);
  while (cursor.hasMore()) {
    const std::string_view arg = cursor.takeFlag();
    if (arg == "--json") {
      // Accepted for harness compatibility; the report is always emitted.
      continue;
    }
    if (arg == "--quiet") {
      opts.quiet = true;
      continue;
    }
    const char *const value = cursor.value();
    if (value == nullptr)
      return false;
    if (!assignValue(arg, value, opts))
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

nlohmann::json movesToJson(const mt::Moves &moves) {
  auto array = nlohmann::json::array();
  // By name, not by position: a structured binding over Move's four uint8_t
  // fields would keep compiling — and silently swap x with y — if they were
  // ever reordered.
  for (const mt::Move &move : moves)
    array.push_back({{"a", {{"x", move.ax}, {"y", move.ay}}},
                     {"b", {{"x", move.bx}, {"y", move.by}}}});
  return array;
}

int generate(const CliOptions &opts) {
  const mt::generate::Options genOpts{.seed = opts.seed,
                                      .kind = opts.kind,
                                      .width = opts.width,
                                      .height = opts.height,
                                      .symbols = opts.symbols};
  return mt::generate::run(opts.generateOut, genOpts);
}

/// Loads the fixture, reporting the two failure modes distinctly: an
/// unreadable or out-of-range file is an environment problem (FixtureError), a
/// malformed document is a broken fixture (nlohmann). Those are the only two
/// `fixtureio::load` raises, so catching them by name rather than as
/// `std::exception` loses nothing and leaves a genuine surprise unswallowed.
bool loadFixture(const CliOptions &opts, mt::Board &board,
                 nlohmann::json &report) {
  const auto fail = [&report](const char *const what) {
    report["error"] = what;
    emitReport(report);
    return false;
  };
  try {
    board = mt::fixtureio::load(opts.fixture);
    return true;
  } catch (const mt::fixtureio::FixtureError &error) {
    return fail(error.what());
  } catch (const nlohmann::json::exception &error) {
    return fail(error.what());
  }
}

mt::Config configFrom(const CliOptions &opts, const mt::Callbacks &callbacks) {
  return {.maxMs = opts.budgetMs,
          .maxNodes = opts.maxNodes,
          .tableBytes = opts.tableBytes,
          .maxHeapBytes = opts.maxHeapBytes,
          .seed = opts.seed,
          .beamWidth = opts.beamWidth,
          .nrpaLevel = opts.nrpaLevel,
          .nrpaIterations = opts.nrpaIterations,
          .cancel = nullptr,
          .callbacks = &callbacks};
}

/// Builds the report from a finished search. Split out so `solveAndReport`
/// below is the try block and nothing else.
void fillReport(const mt::Board &board, const mt::Outcome &outcome,
                const uint64_t searchMs, nlohmann::json &report) {
  // Never the search's own word for it: the oracle re-derives every match from
  // scratch.
  const mt::replay::Verdict verdict =
      mt::replay::replayMoves(board, outcome.moves);
  const bool alreadySolved = mt::rules::blockCount(board) == 0;
  const bool solved = alreadySolved || verdict.clearedAtEnd;

  report["solved"] = solved;
  report["alreadySolved"] = alreadySolved;
  // An empty result on an unsolved board is "no solution found", not
  // "invalid" — only a move list that fails to replay is invalid.
  report["valid"] = outcome.moves.empty() ? solved : verdict.legal;
  report["unsolvable"] = outcome.unsolvable;
  report["turns"] = outcome.moves.size();
  report["moves"] = movesToJson(outcome.moves);
  report["stage"] = outcome.arm;
  report["nodesExpanded"] = outcome.stats.nodesExpanded;
  report["statesStored"] = outcome.stats.statesStored;
  report["stoppedOnMemory"] = outcome.stats.stoppedOnMemory;
  report["searchMs"] = searchMs;
}

/// Runs the search and emits the report. The try block is what makes the
/// protocol at the top of this file hold: the LAST stdout line starting with
/// '{' is the machine-readable report, and every harness in src/util reads it
/// that way. An exception escaping here — an allocation failure under
/// `--max-heap-bytes` pressure, say — would terminate the process with no JSON
/// line at all, which those harnesses cannot tell from a crash.
int solveAndReport(const CliOptions &opts, const mt::Board &board,
                   const mt::Callbacks &callbacks, nlohmann::json &report) {
  const mt::Config cfg = configFrom(opts, callbacks);
  const mt::arms::ArmSpec spec{.engine = opts.engine.c_str(),
                               .beamWidth = opts.beamWidth,
                               .seed = opts.seed,
                               .nrpaLevel = opts.nrpaLevel,
                               .nrpaIterations = opts.nrpaIterations};

  const uint64_t startMs = nowMs();
  try {
    const mt::Outcome outcome = mt::arms::solve(board, spec, cfg);
    fillReport(board, outcome, nowMs() - startMs, report);
  } catch (const std::exception &error) {
    report["error"] = error.what();
    report["wallMs"] = nowMs() - startMs;
    emitReport(report);
    return 1;
  }
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
  if (!opts.generateOut.empty())
    return generate(opts);

  if (!mt::arms::isEngine(opts.engine.c_str())) {
    std::cerr << "Unknown engine: " << opts.engine << "\n";
    printUsage();
    return 2;
  }

  nlohmann::json report;
  report["fixture"] = opts.fixture;
  report["engine"] = opts.engine;

  mt::Board board;
  if (!loadFixture(opts, board, report))
    return 1;

  if (const mt::rules::BoardProblem problem = mt::rules::boardProblem(board);
      problem != mt::rules::BoardProblem::None) {
    report["error"] = mt::rules::describe(problem);
    emitReport(report);
    return 1;
  }

  mt::Callbacks callbacks;
  if (!opts.quiet) {
    callbacks.onArmStart = [](const char *arm) {
      std::cout << "arm: " << arm << "\n";
    };
  }
  return solveAndReport(opts, board, callbacks, report);
}
