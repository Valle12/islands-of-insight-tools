#ifdef __EMSCRIPTEN__

#include "AStar.h"
#include "Node.h"
#include "Replay.h"

#include <emscripten/bind.h>
#include <emscripten/val.h>

using namespace emscripten;

namespace {

// Every config field is optional with its default resolved here, so adding a
// knob never grows a positional argument list (same pattern as the
// shifting-mosaic bindings).
template <typename T> T opt(const val &obj, const char *key, const T def) {
  const val v = obj[key];
  return v.isUndefined() || v.isNull() ? def : v.as<T>();
}

replay::Puzzle puzzleFromVal(const val &puzzleVal) {
  replay::Puzzle puzzle;
  puzzle.gridWidth =
      static_cast<uint8_t>(puzzleVal["gridWidth"].as<unsigned>());
  puzzle.gridHeight =
      static_cast<uint8_t>(puzzleVal["gridHeight"].as<unsigned>());

  const val cellsJs = puzzleVal["cells"];
  const auto numCells = cellsJs["length"].as<unsigned>();
  puzzle.cells.resize(numCells);
  for (unsigned i = 0; i < numCells; i++) {
    puzzle.cells[i] = static_cast<Tile>(cellsJs[i].as<unsigned>());
  }

  const val blocksJs = puzzleVal["blocks"];
  const auto numBlocks = blocksJs["length"].as<unsigned>();
  puzzle.blocks.reserve(numBlocks);
  for (unsigned i = 0; i < numBlocks; i++) {
    const val b = blocksJs[i];
    puzzle.blocks.emplace_back(static_cast<uint8_t>(b["id"].as<unsigned>()),
                               static_cast<int8_t>(b["x"].as<int>()),
                               static_cast<int8_t>(b["y"].as<int>()),
                               static_cast<uint8_t>(b["width"].as<unsigned>()),
                               static_cast<uint8_t>(b["depth"].as<unsigned>()),
                               static_cast<uint8_t>(
                                   b["height"].as<unsigned>()));
  }
  return puzzle;
}

val turnsToVal(const std::vector<Turn> &turns) {
  val result = val::array();
  for (const auto &turn : turns) {
    val t = val::object();
    t.set("blockId", static_cast<unsigned>(turn.blockId));
    t.set("direction", static_cast<unsigned>(turn.direction));
    result.call<void>("push", t);
  }
  return result;
}

std::vector<Turn> turnsFromVal(const val &turnsVal) {
  std::vector<Turn> turns;
  const auto n = turnsVal["length"].as<unsigned>();
  turns.reserve(n);
  for (unsigned i = 0; i < n; i++) {
    const val t = turnsVal[i];
    turns.push_back({static_cast<uint8_t>(t["blockId"].as<unsigned>()),
                     static_cast<Direction>(t["direction"].as<unsigned>())});
  }
  return turns;
}

// Cap validation with a readable message; the engine also guards internally,
// but a silent empty result is indistinguishable from "no solution".
const char *capsError(const replay::Puzzle &puzzle) {
  if (puzzle.gridWidth == 0 || puzzle.gridWidth > AStar::MaxGridSide ||
      puzzle.gridHeight == 0 || puzzle.gridHeight > AStar::MaxGridSide) {
    return "Grid exceeds the 64x64 cap";
  }
  if (puzzle.blocks.empty()) {
    return "The puzzle has no blocks";
  }
  if (puzzle.blocks.size() > AStar::MaxBlocks) {
    return "More than 255 blocks";
  }
  for (const auto &b : puzzle.blocks) {
    if (b.width < 1 || b.width > AStar::MaxBlockDim || b.depth < 1 ||
        b.depth > AStar::MaxBlockDim || b.height < 1 ||
        b.height > AStar::MaxBlockDim) {
      return "Block dimensions must be within 1..64";
    }
  }
  return nullptr;
}

val solve(const val puzzleVal, const val configVal) {
  const replay::Puzzle puzzle = puzzleFromVal(puzzleVal);

  val result = val::object();
  if (const char *error = capsError(puzzle)) {
    result.set("turns", val::array());
    result.set("error", val(error));
    return result;
  }

  AStar::Config cfg;
  cfg.weight = static_cast<uint8_t>(
      opt<unsigned>(configVal, "weight", cfg.weight));
  cfg.maxMs = opt<uint32_t>(configVal, "maxMs", 60000);
  cfg.maxNodes = static_cast<uint64_t>(
      opt<double>(configVal, "maxNodes", 0));
  cfg.maxStatesStored = static_cast<uint64_t>(
      opt<double>(configVal, "maxStatesStored", 0));
  cfg.maxHeapBytes = static_cast<uint64_t>(
      opt<double>(configVal, "maxHeapBytes", 0));
  const bool postProcess = opt<bool>(configVal, "postProcess", true);

  AStar solver(puzzle.gridWidth, puzzle.gridHeight, puzzle.cells, cfg);
  solver.setOnProgress([](uint32_t nodesExpanded) {
    val self = val::global("self");
    val msg = val::object();
    msg.set("type", val("progress"));
    msg.set("progress", nodesExpanded);
    self.call<void>("postMessage", msg);
  });

  std::vector<Turn> turns = solver.search(Node(puzzle.blocks));
  if (postProcess && !turns.empty()) {
    turns = replay::truncateToEarliestSolve(puzzle, turns);
  }

  result.set("turns", turnsToVal(turns));
  val stats = val::object();
  stats.set("nodesExpanded",
            static_cast<double>(solver.stats().nodesExpanded));
  stats.set("statesStored", static_cast<double>(solver.stats().statesStored));
  stats.set("stoppedOnMemory", solver.stats().stoppedOnMemory);
  stats.set("wallMs", solver.stats().wallMs);
  result.set("stats", stats);
  return result;
}

// Standalone post-processor: replays the given turns and cuts them at the
// earliest solving prefix. Grows into the full optimizer later; exported now
// so its interface (and tests against it) are stable.
val optimize(const val puzzleVal, const val turnsVal) {
  const replay::Puzzle puzzle = puzzleFromVal(puzzleVal);
  const std::vector<Turn> turns = turnsFromVal(turnsVal);
  return turnsToVal(replay::truncateToEarliestSolve(puzzle, turns));
}

} // namespace

EMSCRIPTEN_BINDINGS(astar_module) {
  function("solve", &solve);
  function("optimize", &optimize);
}

#endif // __EMSCRIPTEN__
