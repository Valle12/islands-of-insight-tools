#ifdef __EMSCRIPTEN__

#include "MemoryProbe.h"
#include "Replay.h"
#include "Rules.h"
#include "SolverArms.h"
#include "SolverClock.h"

#include <emscripten/bind.h>
#include <emscripten/val.h>
#include <string>

using emscripten::val;

namespace {

/// Every config field is optional with its default resolved here, so adding a
/// knob never grows a positional argument list.
template <typename T> T opt(const val &object, const char *key, const T def) {
  const val held = object[key];
  return held.isUndefined() || held.isNull() ? def : held.as<T>();
}

/// A board from the puzzle object the bridge posts: `cells` flat row-major,
/// exactly the integers src/pages/match-three-solver/cell.ts defines.
mt::Board boardFromVal(const val &puzzle, const char *&error) {
  mt::Board board;
  board.width = opt(puzzle, "gridWidth", 0);
  board.height = opt(puzzle, "gridHeight", 0);
  if (board.width < 1 || board.width > mt::kMaxSide || board.height < 1 ||
      board.height > mt::kMaxSide) {
    error = "Grid must be between 1 and 32 on each side";
    return board;
  }

  const val cells = puzzle["cells"];
  const int count = cells["length"].as<int>();
  if (count != board.cellCount()) {
    error = "cells must hold gridWidth * gridHeight entries";
    return board;
  }
  const int limit = mt::kFirstSymbol + mt::kSymbolCount;
  for (int i = 0; i < count; i++) {
    const int value = cells[i].as<int>();
    if (value < 0 || value >= limit) {
      error = "A cell value is outside the known symbols";
      return board;
    }
    board.cells[mt::slot(i)] = static_cast<uint8_t>(value);
  }
  return board;
}

val movesToVal(const mt::Moves &moves) {
  val array = val::array();
  for (int i = 0; i < static_cast<int>(moves.size()); i++) {
    const mt::Move &move = moves[mt::slot(i)];
    val a = val::object();
    a.set("x", move.ax);
    a.set("y", move.ay);
    val b = val::object();
    b.set("x", move.bx);
    b.set("y", move.by);
    val entry = val::object();
    entry.set("a", a);
    entry.set("b", b);
    array.set(i, entry);
  }
  return array;
}

mt::Moves movesFromVal(const val &value) {
  mt::Moves moves;
  const int count = value["length"].as<int>();
  moves.reserve(mt::slot(count));
  for (int i = 0; i < count; i++) {
    const val entry = value[i];
    const val a = entry["a"];
    const val b = entry["b"];
    moves.push_back({.ax = a["x"].as<uint8_t>(),
                     .ay = a["y"].as<uint8_t>(),
                     .bx = b["x"].as<uint8_t>(),
                     .by = b["y"].as<uint8_t>()});
  }
  return moves;
}

/// Posts one message to the worker that hosts this module. `self` is the worker
/// scope, so this reaches the bridge's own onmessage with nothing to relay.
void post(const val &message) {
  val self = val::global("self");
  self.call<void>("postMessage", message);
}

val errorResult(const char *message) {
  val result = val::object();
  result.set("moves", val::array());
  result.set("error", val(std::string(message)));
  return result;
}

/// Config the caller may set, all optional.
struct Spec {
  std::string engine;
  uint32_t maxMs;
  uint64_t tableBytes;
  uint64_t maxHeapBytes;
  uint32_t seed;
  int beamWidth;
  int nrpaLevel;
  int nrpaIterations;
};

Spec specFrom(const val &config) {
  return {.engine = opt(config, "engine", std::string("cascade")),
          .maxMs = static_cast<uint32_t>(
              opt(config, "maxMs", static_cast<double>(300000))),
          .tableBytes = static_cast<uint64_t>(opt(
              config, "tableBytes",
              static_cast<double>(mt::kDefaultTableBytes))),
          .maxHeapBytes = static_cast<uint64_t>(
              opt(config, "maxHeapBytes", static_cast<double>(0))),
          .seed = static_cast<uint32_t>(opt(config, "seed", 0)),
          .beamWidth = opt(config, "beamWidth", 0),
          .nrpaLevel = opt(config, "nrpaLevel", 0),
          .nrpaIterations = opt(config, "nrpaIterations", 0)};
}

/// The best-so-far and progress stream. Called only from the module's own
/// thread — under the in-module race that is the polling thread, and without
/// pthreads there is only one thread to begin with.
class Reporter {
public:
  explicit Reporter(mt::Bounds &bounds) : bounds_(bounds) {}

  void onProgress(const mt::Progress &progress) {
    val message = val::object();
    message.set("type", val("progress"));
    message.set("progress", static_cast<double>(progress.nodes));
    message.set("bestLength", progress.bestLength);
    post(message);
    // Streaming the whole move list on every improvement is what lets the page
    // offer "stop and take the best so far" at any moment.
    if (progress.bestLength == reported_ || progress.bestLength == mt::kNoLength)
      return;
    reported_ = progress.bestLength;
    val best = val::object();
    best.set("type", val("best"));
    best.set("length", progress.bestLength);
    best.set("moves", movesToVal(bounds_.best()));
    post(best);
  }

  static void onArmStart(const char *arm) {
    val message = val::object();
    message.set("type", val("phase"));
    message.set("arm", val(std::string(arm)));
    post(message);
  }

private:
  mt::Bounds &bounds_;
  int reported_ = mt::kNoLength;
};

val statsToVal(const mt::Outcome &outcome, const uint64_t wallMs) {
  val stats = val::object();
  stats.set("nodesExpanded", static_cast<double>(outcome.stats.nodesExpanded));
  stats.set("statesStored", static_cast<double>(outcome.stats.statesStored));
  stats.set("stoppedOnMemory", outcome.stats.stoppedOnMemory);
  stats.set("wallMs", static_cast<double>(wallMs));
  stats.set("engine", val(outcome.arm));
  return stats;
}

mt::Outcome dispatch(const mt::Board &board, const Spec &spec,
                     const mt::Config &cfg, mt::Bounds &bounds) {
#ifdef __EMSCRIPTEN_PTHREADS__
  // On the threads build the cascade becomes a real race; the single-arm names
  // stay sequential so the tests can still measure one strategy at a time.
  if (spec.engine == "cascade")
    return mt::arms::solveParallel(board, cfg, bounds);
#endif
  const mt::arms::ArmSpec armSpec{.engine = spec.engine.c_str(),
                                  .beamWidth = spec.beamWidth,
                                  .seed = spec.seed,
                                  .nrpaLevel = spec.nrpaLevel,
                                  .nrpaIterations = spec.nrpaIterations};
  return mt::arms::solve(board, armSpec, cfg, bounds);
}

} // namespace

/// Solves a board. Errors come back IN BAND on the result object: the build is
/// exception-free, and a throw would surface to the page as an aborted module
/// rather than as a message it can show.
val solve(const val puzzleVal, const val configVal) {
  const char *error = nullptr;
  const mt::Board board = boardFromVal(puzzleVal, error);
  if (error != nullptr)
    return errorResult(error);

  const mt::rules::BoardProblem problem = mt::rules::boardProblem(board);
  if (problem != mt::rules::BoardProblem::None)
    return errorResult(mt::rules::describe(problem));

  const Spec spec = specFrom(configVal);
  if (!mt::arms::isEngine(spec.engine.c_str()))
    return errorResult("Unknown engine");

  mt::Bounds bounds;
  Reporter reporter(bounds);
  mt::Callbacks callbacks;
  callbacks.onProgress = [&reporter](const mt::Progress &progress) {
    reporter.onProgress(progress);
  };
  callbacks.onArmStart = &Reporter::onArmStart;

  mt::Config cfg;
  cfg.maxMs = spec.maxMs;
  cfg.tableBytes = spec.tableBytes;
  cfg.seed = spec.seed;
  cfg.beamWidth = spec.beamWidth;
  cfg.nrpaLevel = spec.nrpaLevel;
  cfg.nrpaIterations = spec.nrpaIterations;
  cfg.callbacks = &callbacks;
  // Nearly the whole heap, but NEVER unlimited: an allocation the module cannot
  // satisfy aborts it outright, and the page loses the solve rather than being
  // told the board was too big.
  cfg.maxHeapBytes = spec.maxHeapBytes != 0
                         ? spec.maxHeapBytes
                         : memprobe::heapCeilingBytes() / 100 * 90;

  const uint64_t startMs = nowMs();
  const mt::Outcome outcome = dispatch(board, spec, cfg, bounds);
  const uint64_t wallMs = nowMs() - startMs;

  val result = val::object();
  result.set("moves", movesToVal(outcome.moves));
  result.set("unsolvable", outcome.unsolvable);
  result.set("stats", statsToVal(outcome, wallMs));
  return result;
}

/// The replay oracle, exported so a test can check a witness without trusting
/// the search that produced it. Used by test/match-three-solver/mem64.node.test.mjs.
bool verify(const val puzzleVal, const val movesVal) {
  const char *error = nullptr;
  const mt::Board board = boardFromVal(puzzleVal, error);
  if (error != nullptr)
    return false;
  const mt::replay::Verdict verdict =
      mt::replay::replayMoves(board, movesFromVal(movesVal));
  return verdict.legal && verdict.clearedAtEnd;
}

EMSCRIPTEN_BINDINGS(match_three_module) {
  emscripten::function("solve", &solve);
  emscripten::function("verify", &verify);
}

#endif // __EMSCRIPTEN__
