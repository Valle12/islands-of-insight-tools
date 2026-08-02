#include "FixtureIo.h"

#include "Puzzle.h"
#include "Rules.h"
#include "Types.h"

#include <cstdint>
#include <fstream>
#include <nlohmann/json.hpp>
#include <string>

namespace lg::fixtureio {
namespace {

nlohmann::json readDocument(const std::string &path) {
  std::ifstream input(path);
  if (!input)
    throw FixtureError("Could not open " + path);
  return nlohmann::json::parse(input);
}

/// The colour layer, which the app stores COLUMN-major (`cells[x][y]`) while
/// the solver indexes rows at a fixed pitch.
void readCells(const nlohmann::json &document, Puzzle &puzzle,
               const std::string &path) {
  const auto &cells = document.at("cells");
  if (static_cast<int>(cells.size()) != puzzle.width)
    throw FixtureError("cells must hold one column per gridWidth in " + path);
  puzzle.givens.fill(kUnplayable);
  for (int x = 0; x < puzzle.width; x++) {
    const auto &column = cells.at(slot(x));
    if (static_cast<int>(column.size()) != puzzle.height)
      throw FixtureError("A cells column is the wrong length in " + path);
    for (int y = 0; y < puzzle.height; y++) {
      const auto value = column.at(slot(y)).get<int>();
      if (value < 0 || value >= kColorLimit)
        throw FixtureError("Cell value out of range in " + path);
      puzzle.givens[slot(cellIndex(x, y))] = static_cast<uint8_t>(value);
    }
  }
}

void readRules(const nlohmann::json &document, Puzzle &puzzle,
               const std::string &path) {
  for (const auto &entry : document.at("rules")) {
    const auto index = entry.get<int>();
    if (index < 0 || index >= rules::kRuleCount)
      throw FixtureError("Unknown rule index in " + path);
    puzzle.ruleMask |= rules::RuleMask{1} << index;
  }
}

int letterFrom(const nlohmann::json &value, const std::string &path) {
  const auto text = value.get<std::string>();
  if (text.size() != 1 || text.front() < 'A' || text.front() > 'Z')
    throw FixtureError("A letter clue is not a single A-Z in " + path);
  return text.front() - 'A';
}

void readClues(const nlohmann::json &document, Puzzle &puzzle,
               const std::string &path) {
  if (!document.contains("symbols"))
    return;
  for (const auto &entry : document.at("symbols")) {
    const auto x = entry.at("x").get<int>();
    const auto y = entry.at("y").get<int>();
    const auto kind = entry.at("type").get<int>();
    if (x < 0 || x >= puzzle.width || y < 0 || y >= puzzle.height)
      throw FixtureError("A clue sits outside the board in " + path);
    if (kind < 0 || kind >= kClueKindCount)
      throw FixtureError("Unknown clue kind in " + path);
    const int value = kind == kClueLetter
                          ? letterFrom(entry.at("value"), path)
                          : entry.at("value").get<int>();
    puzzle.clues.push_back({.index = cellIndex(x, y),
                            .kind = static_cast<uint8_t>(kind),
                            .value = value});
  }
}

void readSolution(const nlohmann::json &document, Fixture &fixture,
                  const std::string &path) {
  if (!document.contains("solution"))
    return;
  const auto &cells = document.at("solution");
  const Puzzle &puzzle = fixture.puzzle;
  if (static_cast<int>(cells.size()) != puzzle.width)
    throw FixtureError("solution must hold one column per gridWidth in " +
                       path);
  fixture.solution.fill(kUnplayable);
  for (int x = 0; x < puzzle.width; x++) {
    for (int y = 0; y < puzzle.height; y++) {
      const auto value = cells.at(slot(x)).at(slot(y)).get<int>();
      if (value < 0 || value >= kColorLimit)
        throw FixtureError("Solution value out of range in " + path);
      fixture.solution[slot(cellIndex(x, y))] = static_cast<uint8_t>(value);
    }
  }
  fixture.hasSolution = true;
}

nlohmann::json columnMajor(const Puzzle &puzzle, const Colors &colors) {
  auto grid = nlohmann::json::array();
  for (int x = 0; x < puzzle.width; x++) {
    auto column = nlohmann::json::array();
    for (int y = 0; y < puzzle.height; y++)
      column.push_back(colors[slot(cellIndex(x, y))]);
    grid.push_back(column);
  }
  return grid;
}

nlohmann::json cluesToJson(const Puzzle &puzzle) {
  auto symbols = nlohmann::json::array();
  for (const auto &[index, kind, value] : puzzle.clues) {
    nlohmann::json entry;
    entry["x"] = columnOf(index);
    entry["y"] = rowOf(index);
    entry["type"] = kind;
    if (kind == kClueLetter)
      entry["value"] = std::string(1, static_cast<char>('A' + value));
    else
      entry["value"] = value;
    symbols.push_back(entry);
  }
  return symbols;
}

} // namespace

Fixture load(const std::string &path) {
  const nlohmann::json document = readDocument(path);
  Fixture fixture;
  Puzzle &puzzle = fixture.puzzle;
  puzzle.width = document.at("gridWidth").get<int>();
  puzzle.height = document.at("gridHeight").get<int>();
  if (puzzle.width < 1 || puzzle.width > kMaxSide || puzzle.height < 1 ||
      puzzle.height > kMaxSide)
    throw FixtureError("Grid size out of range in " + path);
  readCells(document, puzzle, path);
  readRules(document, puzzle, path);
  readClues(document, puzzle, path);
  readSolution(document, fixture, path);
  return fixture;
}

void save(const std::string &path, const Fixture &fixture) {
  const Puzzle &puzzle = fixture.puzzle;
  nlohmann::json document;
  document["gridWidth"] = puzzle.width;
  document["gridHeight"] = puzzle.height;

  auto ruleList = nlohmann::json::array();
  for (int index = 0; index < rules::kRuleCount; index++) {
    if ((puzzle.ruleMask >> index & 1U) != 0)
      ruleList.push_back(index);
  }
  document["rules"] = ruleList;
  document["cells"] = columnMajor(puzzle, puzzle.givens);
  document["symbols"] = cluesToJson(puzzle);
  if (fixture.hasSolution)
    document["solution"] = columnMajor(puzzle, fixture.solution);

  std::ofstream output(path);
  if (!output)
    throw FixtureError("Could not write " + path);
  output << document.dump(2) << "\n";
}

} // namespace lg::fixtureio
