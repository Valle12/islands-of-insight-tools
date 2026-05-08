#include "AStar.h"

#include <emscripten/bind.h>
#include <emscripten/val.h>

using namespace emscripten;

val search(unsigned int gridWidth, unsigned int gridHeight, val cellsJs,
           val blocksJs, unsigned int weight) {
  // Convert flat cells array (JS number[] -> vector<Tile>)
  const auto numCells = cellsJs["length"].as<unsigned>();
  std::vector<Tile> cells(numCells);
  for (unsigned i = 0; i < numCells; i++) {
    cells[i] = static_cast<Tile>(cellsJs[i].as<unsigned int>());
  }

  // Convert blocks array (JS {id,x,y,width,depth,height}[] -> vector<Block>)
  const auto numBlocks = blocksJs["length"].as<unsigned>();
  std::vector<Block> blocks;
  blocks.reserve(numBlocks);
  for (unsigned i = 0; i < numBlocks; i++) {
    val b = blocksJs[i];
    blocks.emplace_back(
        static_cast<uint8_t>(b["id"].as<unsigned int>()),
        static_cast<int8_t>(b["x"].as<int>()),
        static_cast<int8_t>(b["y"].as<int>()),
        static_cast<uint8_t>(b["width"].as<unsigned int>()),
        static_cast<uint8_t>(b["depth"].as<unsigned int>()),
        static_cast<uint8_t>(b["height"].as<unsigned int>()));
  }

  Node root(std::move(blocks));
  AStar aStar(static_cast<uint8_t>(gridWidth), static_cast<uint8_t>(gridHeight),
              std::move(cells), static_cast<uint8_t>(weight));

  // Wire up progress callback to post messages to the worker's parent
  aStar.onProgress = [](uint32_t nodesExpanded) {
    val self = val::global("self");
    val msg = val::object();
    msg.set("type", val("progress"));
    msg.set("progress", nodesExpanded);
    self.call<void>("postMessage", msg);
  };

  auto turns = aStar.search(std::move(root));

  // Convert result to JS array of {blockId, direction}
  val result = val::array();
  for (size_t i = 0; i < turns.size(); i++) {
    val turn = val::object();
    turn.set("blockId", static_cast<unsigned int>(turns[i].blockId));
    turn.set("direction", static_cast<unsigned int>(turns[i].direction));
    result.call<void>("push", turn);
  }
  return result;
}

EMSCRIPTEN_BINDINGS(astar_module) { function("search", &search); }
