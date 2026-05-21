#ifdef __EMSCRIPTEN__

#include "AStar.h"

#include <emscripten/bind.h>
#include <emscripten/val.h>

using namespace emscripten;

namespace {

std::vector<std::vector<Position>> parseShapes(val shapesJs) {
  const auto numShapes = shapesJs["length"].as<unsigned>();
  std::vector<std::vector<Position>> shapes(numShapes);
  for (unsigned i = 0; i < numShapes; i++) {
    val shape = shapesJs[i];
    const auto numCells = shape["length"].as<unsigned>();
    shapes[i].reserve(numCells);
    for (unsigned j = 0; j < numCells; j++) {
      val cell = shape[j];
      shapes[i].push_back({static_cast<int8_t>(cell["x"].as<int>()),
                            static_cast<int8_t>(cell["y"].as<int>())});
    }
  }
  return shapes;
}

std::vector<Position> parseAnchors(val anchorsJs) {
  const auto n = anchorsJs["length"].as<unsigned>();
  std::vector<Position> anchors;
  anchors.reserve(n);
  for (unsigned i = 0; i < n; i++) {
    val a = anchorsJs[i];
    anchors.push_back({static_cast<int8_t>(a["x"].as<int>()),
                        static_cast<int8_t>(a["y"].as<int>())});
  }
  return anchors;
}

val turnsToJs(const std::vector<Turn> &turns) {
  val result = val::array();
  for (const auto &t : turns) {
    val turn = val::object();
    turn.set("blockId", static_cast<unsigned int>(t.blockId));
    turn.set("direction", static_cast<unsigned int>(t.direction));
    result.call<void>("push", turn);
  }
  return result;
}

} // namespace

val search(unsigned int gridWidth, unsigned int gridHeight, val shapesJs,
           val initialAnchorsJs, unsigned int goalIndex, val goalAnchorJs,
           unsigned int weight, bool deadlockPruning, unsigned int maxMs,
           unsigned int maxNodes, bool useIda,
           unsigned int pathBlockerWeight, unsigned int boundaryWeight,
           bool allWallsBfsBase, bool macroMoves,
           unsigned int axisAwareWeight,
           unsigned int lpDisplacementWeight,
           unsigned int strideOverride, bool postProcess) {
  std::vector<std::vector<Position>> shapes = parseShapes(shapesJs);
  std::vector<Position> initialAnchors = parseAnchors(initialAnchorsJs);
  const Position goalAnchor{static_cast<int8_t>(goalAnchorJs["x"].as<int>()),
                             static_cast<int8_t>(goalAnchorJs["y"].as<int>())};

  AStar::Config cfg;
  cfg.weight = static_cast<uint8_t>(weight);
  cfg.deadlockPruning = deadlockPruning;
  cfg.pathBlockerWeight = static_cast<uint8_t>(pathBlockerWeight);
  cfg.boundaryDistanceWeight = static_cast<uint8_t>(boundaryWeight);
  cfg.allWallsBfsBase = allWallsBfsBase;
  cfg.macroMoves = macroMoves;
  cfg.axisAwareWeight = static_cast<uint8_t>(axisAwareWeight);
  cfg.lpDisplacementWeight = static_cast<uint8_t>(lpDisplacementWeight);
  cfg.strideOverride = static_cast<uint8_t>(strideOverride);
  cfg.postProcess = postProcess;

  AStar aStar(static_cast<uint8_t>(gridWidth), static_cast<uint8_t>(gridHeight),
              std::move(shapes), std::move(initialAnchors),
              static_cast<uint8_t>(goalIndex), goalAnchor, cfg);

  aStar.onProgress = [](uint32_t nodesExpanded) {
    val self = val::global("self");
    val msg = val::object();
    msg.set("type", val("progress"));
    msg.set("progress", nodesExpanded);
    self.call<void>("postMessage", msg);
  };

  auto turns = useIda ? aStar.searchIDAStar(maxMs, maxNodes)
                      : aStar.search(maxMs, maxNodes);
  return turnsToJs(turns);
}

// Standalone post-processor: takes a found solution and returns a shortened,
// still-valid one. Lets callers measure the raw search output (run search with
// postProcess=false) and the optimized output independently.
val optimize(unsigned int gridWidth, unsigned int gridHeight, val shapesJs,
             val initialAnchorsJs, unsigned int goalIndex, val goalAnchorJs,
             val turnsJs) {
  std::vector<std::vector<Position>> shapes = parseShapes(shapesJs);
  std::vector<Position> initialAnchors = parseAnchors(initialAnchorsJs);
  const Position goalAnchor{static_cast<int8_t>(goalAnchorJs["x"].as<int>()),
                             static_cast<int8_t>(goalAnchorJs["y"].as<int>())};

  const auto numTurns = turnsJs["length"].as<unsigned>();
  std::vector<Turn> turns;
  turns.reserve(numTurns);
  for (unsigned i = 0; i < numTurns; i++) {
    val t = turnsJs[i];
    turns.push_back(
        {static_cast<uint8_t>(t["blockId"].as<unsigned>()),
         static_cast<Direction>(t["direction"].as<unsigned>())});
  }

  AStar aStar(static_cast<uint8_t>(gridWidth), static_cast<uint8_t>(gridHeight),
              std::move(shapes), std::move(initialAnchors),
              static_cast<uint8_t>(goalIndex), goalAnchor, AStar::Config{});
  return turnsToJs(aStar.optimizeSolution(turns));
}

EMSCRIPTEN_BINDINGS(shifting_mosaic_astar_module) {
  function("search", &search);
  function("optimize", &optimize);
}

#endif // __EMSCRIPTEN__
