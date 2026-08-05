#include "FixtureIo.h"

#include "Puzzle.h"
#include "Rules.h"
#include "Types.h"

#include <cstdint>
#include <format>
#include <fstream>
#include <nlohmann/json.hpp>
#include <string>
#include <utility>
#include <vector>

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
    // A lotus carries no number at all, and a file that gives it one is
    // refused rather than the key being dropped — dropping it would load a
    // different-looking puzzle under the same name. The trailing branch is
    // every NUMBER-carrying kind — area, dart and viewpoint — which all store
    // a plain integer.
    int value = 0;
    if (kind == kClueLetter)
      value = letterFrom(entry.at("value"), path);
    else if (kind == kClueLotus) {
      if (entry.contains("value"))
        throw FixtureError("A symmetry symbol carries no value in " + path);
    } else {
      value = entry.at("value").get<int>();
    }
    // Optional, like `shapes` and for the same reason — every fixture written
    // before darts existed carries no such key. Absent it reads as -1, which
    // `structureProblem` refuses for a kind that needs one. The `seat` key is
    // optional the same way, defaulting to the square's own centre, and a seat
    // on a kind that has none is refused by name downstream.
    const int direction =
        entry.contains("direction") ? entry.at("direction").get<int>() : -1;
    const int seat = entry.contains("seat") ? entry.at("seat").get<int>() : 0;
    puzzle.clues.push_back({.index = cellIndex(x, y),
                            .kind = static_cast<uint8_t>(kind),
                            .value = value,
                            .direction = direction,
                            .seat = seat});
  }
}

/**
 * The merged cells, which the app stores as FLAT `y * gridWidth + x` indices —
 * row-major, unlike the `cells` and `solution` grids in this same file, which
 * are column-major. That is the download format, and matching it is the point;
 * "fixing" the inconsistency here would silently transpose every merged board.
 */
void readShapes(const nlohmann::json &document, Puzzle &puzzle,
                const std::string &path) {
  if (!document.contains("shapes"))
    return;
  for (const auto &entry : document.at("shapes")) {
    std::vector<int> shape;
    for (const auto &member : entry) {
      const auto flat = member.get<int>();
      if (flat < 0 || flat >= puzzle.width * puzzle.height)
        throw FixtureError("A merged cell claims a square outside the board in " +
                           path);
      shape.push_back(cellIndex(flat % puzzle.width, flat / puzzle.width));
    }
    puzzle.shapes.push_back(std::move(shape));
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
  for (const auto &[index, kind, value, direction, seat] : puzzle.clues) {
    nlohmann::json entry;
    entry["x"] = columnOf(index);
    entry["y"] = rowOf(index);
    entry["type"] = kind;
    // A lotus writes no value key at all; every other kind requires one.
    if (kind == kClueLetter)
      entry["value"] = std::string(1, static_cast<char>('A' + value));
    else if (kind != kClueLotus)
      entry["value"] = value;
    // Written only where there is one, so a board with no directed clues
    // round-trips byte-identically to what the page downloads — the rule
    // `shapes` follows. A lotus's direction is its AXIS; its seat is written
    // only off its default, the same discipline again.
    if (kind == kClueDart || kind == kClueLotus)
      entry["direction"] = direction;
    if (kind == kClueLotus && seat != 0)
      entry["seat"] = seat;
    symbols.push_back(entry);
  }
  return symbols;
}

nlohmann::json shapesToJson(const Puzzle &puzzle) {
  auto shapes = nlohmann::json::array();
  for (const std::vector<int> &shape : puzzle.shapes) {
    auto members = nlohmann::json::array();
    for (const int index : shape)
      members.push_back(rowOf(index) * puzzle.width + columnOf(index));
    shapes.push_back(members);
  }
  return shapes;
}

/**
 * The format version the file claims, defaulting to 1 where the key is absent
 * — which every fixture captured before the tag existed relies on.
 *
 * Anything this build does not read is refused by name. A LATER version is a
 * file from a newer build, whose additions this one has never heard of; an
 * earlier one means the repo's own fixtures were not rewritten alongside the
 * bump, since migrating is the page's job and not this side's.
 */
void checkVersion(const nlohmann::json &document, const std::string &path) {
  if (!document.contains("version"))
    return;
  const auto &tag = document.at("version");
  if (!tag.is_number_integer())
    throw FixtureError("version must be an integer in " + path);
  if (const auto version = tag.get<int>(); version != kConfigVersion)
    throw FixtureError(
        std::format("Unsupported config version {} (this build reads {}) in {}",
                    version, kConfigVersion, path));
}

} // namespace

Fixture load(const std::string &path) {
  const nlohmann::json document = readDocument(path);
  checkVersion(document, path);
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
  readShapes(document, puzzle, path);
  readSolution(document, fixture, path);
  return fixture;
}

void save(const std::string &path, const Fixture &fixture) {
  const Puzzle &puzzle = fixture.puzzle;
  nlohmann::json document;
  // nlohmann sorts an object's keys, so this does not come out first the way
  // the page's own writer puts it — only that it is THERE matters, since every
  // reader on both sides looks the key up rather than reading in order.
  document["version"] = kConfigVersion;
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
  // Written only when there is something to write: a plain board's file must
  // stay byte-identical to what the page downloads, and the page omits the key.
  if (!puzzle.shapes.empty())
    document["shapes"] = shapesToJson(puzzle);
  if (fixture.hasSolution)
    document["solution"] = columnMajor(puzzle, fixture.solution);

  std::ofstream output(path);
  if (!output)
    throw FixtureError("Could not write " + path);
  output << document.dump(2) << "\n";
}

} // namespace lg::fixtureio
