#include "FixtureIo.h"

#include <fstream>
#include <nlohmann/json.hpp>
#include <stdexcept>
#include <string_view>

namespace {

Tile parseTile(const std::string_view s) {
  using enum Tile;
  if (s == "mustTouch")
    return MustTouch;
  if (s == "goal")
    return Goal;
  if (s == "unplayable")
    return Unplayable;
  return Regular;
}

} // namespace

namespace fixtureio {

replay::Puzzle load(const std::string &path) {
  std::ifstream f(path);
  if (!f.is_open()) {
    throw std::runtime_error("Cannot open " + path);
  }
  const nlohmann::json j = nlohmann::json::parse(f);

  replay::Puzzle puzzle;
  puzzle.gridWidth = j.at("gridWidth").get<uint8_t>();
  puzzle.gridHeight = j.at("gridHeight").get<uint8_t>();

  // JSON cells is [x][y] — outer array index = x, inner = y.
  const auto &jsonCells = j.at("cells");
  puzzle.cells.resize(static_cast<size_t>(puzzle.gridWidth) *
                          puzzle.gridHeight,
                      Tile::Regular);
  for (uint8_t x = 0; x < puzzle.gridWidth; x++) {
    for (uint8_t y = 0; y < puzzle.gridHeight; y++) {
      puzzle.cells[x + y * puzzle.gridWidth] =
          parseTile(jsonCells.at(x).at(y).get<std::string>());
    }
  }

  puzzle.blocks.reserve(j.at("blocks").size());
  for (const auto &jb : j.at("blocks")) {
    puzzle.blocks.emplace_back(
        jb.at("id").get<uint8_t>(), static_cast<int8_t>(jb.at("x").get<int>()),
        static_cast<int8_t>(jb.at("y").get<int>()),
        jb.at("width").get<uint8_t>(), jb.at("depth").get<uint8_t>(),
        jb.at("height").get<uint8_t>());
  }

  return puzzle;
}

} // namespace fixtureio
