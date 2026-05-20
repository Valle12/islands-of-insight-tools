#ifdef __EMSCRIPTEN__

#include "AStar.h"

#include <emscripten/bind.h>
#include <emscripten/val.h>

using namespace emscripten;

val search(unsigned int gridWidth, unsigned int gridHeight, val shapesJs,
           val initialAnchorsJs, unsigned int goalIndex, val goalAnchorJs,
           unsigned int weight, bool deadlockPruning, unsigned int maxMs,
           unsigned int maxNodes, bool useIda,
           unsigned int pathBlockerWeight, unsigned int boundaryWeight,
           bool allWallsBfsBase, bool macroMoves,
           unsigned int axisAwareWeight,
           unsigned int lpDisplacementWeight) {
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

  const auto numAnchors = initialAnchorsJs["length"].as<unsigned>();
  std::vector<Position> initialAnchors;
  initialAnchors.reserve(numAnchors);
  for (unsigned i = 0; i < numAnchors; i++) {
    val a = initialAnchorsJs[i];
    initialAnchors.push_back({static_cast<int8_t>(a["x"].as<int>()),
                               static_cast<int8_t>(a["y"].as<int>())});
  }

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

  val result = val::array();
  for (size_t i = 0; i < turns.size(); i++) {
    val turn = val::object();
    turn.set("blockId", static_cast<unsigned int>(turns[i].blockId));
    turn.set("direction", static_cast<unsigned int>(turns[i].direction));
    result.call<void>("push", turn);
  }
  return result;
}

EMSCRIPTEN_BINDINGS(shifting_mosaic_astar_module) {
  function("search", &search);
}

#endif // __EMSCRIPTEN__
