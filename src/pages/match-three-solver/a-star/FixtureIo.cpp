#include "FixtureIo.h"

#include <fstream>
#include <nlohmann/json.hpp>

namespace mt::fixtureio {

Board load(const std::string &path) {
  std::ifstream file(path);
  if (!file.is_open())
    throw FixtureError("Cannot open " + path);
  const nlohmann::json parsed = nlohmann::json::parse(file);

  Board board;
  board.width = parsed.at("gridWidth").get<int>();
  board.height = parsed.at("gridHeight").get<int>();
  if (board.width < 1 || board.width > kMaxSide || board.height < 1 ||
      board.height > kMaxSide)
    throw FixtureError("Grid out of range in " + path);

  const auto &cells = parsed.at("cells");
  for (int x = 0; x < board.width; x++) {
    for (int y = 0; y < board.height; y++) {
      const auto value = cells.at(x).at(y).get<int>();
      if (value < 0 || value >= kFirstSymbol + kSymbolCount)
        throw FixtureError("Cell value out of range in " + path);
      board.cells[slot(y * board.width + x)] =
          static_cast<uint8_t>(value);
    }
  }
  return board;
}

void save(const std::string &path, const Board &board) {
  nlohmann::json parsed;
  parsed["gridWidth"] = board.width;
  parsed["gridHeight"] = board.height;
  auto columns = nlohmann::json::array();
  for (int x = 0; x < board.width; x++) {
    auto column = nlohmann::json::array();
    for (int y = 0; y < board.height; y++)
      column.push_back(board.at(x, y));
    columns.push_back(column);
  }
  parsed["cells"] = columns;

  std::ofstream file(path);
  if (!file.is_open())
    throw FixtureError("Cannot write " + path);
  file << parsed.dump(2) << "\n";
}

} // namespace mt::fixtureio
