#include "FixtureIo.h"

#include <fstream>
#include <nlohmann/json.hpp>
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

Direction parseDirection(const std::string_view s) {
  using enum Direction;
  if (s == "UP")
    return UP;
  if (s == "RIGHT")
    return RIGHT;
  if (s == "DOWN")
    return DOWN;
  return LEFT;
}

} // namespace

namespace fixtureio {

replay::Puzzle load(const std::string &path, std::vector<Turn> *turnsOut) {
  std::ifstream f(path);
  if (!f.is_open()) {
    throw FixtureError("Cannot open " + path);
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

  if (turnsOut != nullptr) {
    turnsOut->clear();
    if (j.contains("turns") && j.at("turns").is_array()) {
      for (const auto &jt : j.at("turns")) {
        turnsOut->push_back(
            {.blockId = jt.at("blockId").get<uint8_t>(),
             .direction = parseDirection(jt.at("direction").get<std::string>())});
      }
    }
  }

  return puzzle;
}

} // namespace fixtureio
