// Fixture I/O and plan validation for the bench CLI. See BenchFixture.h.

#include "ClangdCompat.h" // must stay first; see the header

#include "BenchFixture.h"

#include "BitGrid.h"

#include <fstream>

#include <nlohmann/json.hpp>
#include <stdexcept>
#include <utility>

using json = nlohmann::json;

Fixture loadFixture(const std::string &path) {
  std::ifstream f(path);
  if (!f.is_open())
    throw std::runtime_error("Cannot open " + path);
  json j = json::parse(f);

  Fixture data;
  data.gridWidth = j["gridWidth"].get<uint8_t>();
  data.gridHeight = j["gridHeight"].get<uint8_t>();
  for (const auto &shape : j["shapes"]) {
    std::vector<Position> cells;
    cells.reserve(shape.size());
    for (const auto &c : shape)
      cells.push_back({.x = static_cast<int8_t>(c["x"].get<int>()),
                       .y = static_cast<int8_t>(c["y"].get<int>())});
    data.shapes.push_back(std::move(cells));
  }
  for (const auto &a : j["initialAnchors"])
    data.initialAnchors.push_back(
        {.x = static_cast<int8_t>(a["x"].get<int>()),
         .y = static_cast<int8_t>(a["y"].get<int>())});
  data.goalIndex = j["goalIndex"].get<uint8_t>();
  data.goalAnchor = {.x = static_cast<int8_t>(j["goalAnchor"]["x"].get<int>()),
                     .y = static_cast<int8_t>(j["goalAnchor"]["y"].get<int>())};
  return data;
}

// Replays a turn stream with FULL legality checking — bounds and collisions
// via BitGrid, not just the final goal position. Returns the index of the first
// illegal move, or SIZE_MAX when the whole stream is legal; `anchors` is left
// holding the position reached.
//
// Every validity check goes through here. A goal-position-only replay cannot
// see a plan that drives a block through another block or off the grid, which
// is exactly the class of defect the fuzz campaign exists to catch.
size_t firstIllegalMove(const Fixture &data, const std::vector<Turn> &turns,
                        std::vector<Position> &anchors) {
  anchors = data.initialAnchors;
  BitGrid grid(data.gridWidth, data.gridHeight, data.shapes);
  grid.buildOccupancy(anchors);
  for (size_t i = 0; i < turns.size(); i++) {
    const uint8_t b = turns[i].blockId;
    if (b >= anchors.size())
      return i;
    const auto d = static_cast<int>(std::to_underlying(turns[i].direction));
    if (d < 0 || d > 3)
      return i;
    const Position from = anchors[b];
    const Position to{.x = static_cast<int8_t>(from.x + BitGrid::DX[d]),
                      .y = static_cast<int8_t>(from.y + BitGrid::DY[d])};
    grid.removeBlock(b, from);
    if (!grid.canPlace(b, to.x, to.y)) {
      grid.addBlock(b, from);
      return i;
    }
    grid.addBlock(b, to);
    anchors[b] = to;
  }
  return SIZE_MAX;
}

// Replays the turns and checks the plan is legal AND lands the goal block on
// the goal anchor.
bool replaySolves(const Fixture &data, const std::vector<Turn> &turns) {
  std::vector<Position> anchors;
  if (firstIllegalMove(data, turns, anchors) != SIZE_MAX)
    return false;
  const auto &[gx, gy] = anchors[data.goalIndex];
  return gx == data.goalAnchor.x && gy == data.goalAnchor.y;
}

// Player steps as the UI counts them (solutionView.ts): one step = a maximal
// run of consecutive turns of the same block, across direction changes.
size_t countPlayerSteps(const std::vector<Turn> &turns) {
  size_t steps = 0;
  for (size_t i = 0; i < turns.size(); i++)
    if (i == 0 || turns[i].blockId != turns[i - 1].blockId)
      steps++;
  return steps;
}

// Straight-drag runs (same block AND same direction) — the legacy metric.
size_t countDirRuns(const std::vector<Turn> &turns) {
  size_t runs = 0;
  for (size_t i = 0; i < turns.size(); i++)
    if (i == 0 || turns[i].blockId != turns[i - 1].blockId ||
        turns[i].direction != turns[i - 1].direction)
      runs++;
  return runs;
}

// Writes `anchors` as a fixture over the same board. Used to hand a stalled
// jam run's deepest elite back to the solver as a RESIDUAL problem: the
// ratchet often clears the goal's dig route without committing the goal, and
// finishing from that state is far shallower than solving from the root.
bool writeFixtureAt(const Fixture &data, const std::vector<Position> &anchors,
                    const std::string &path) {
  json fx;
  fx["gridWidth"] = data.gridWidth;
  fx["gridHeight"] = data.gridHeight;
  json shapesJson = json::array();
  for (const auto &s : data.shapes) {
    json cells = json::array();
    for (const auto &[cx, cy] : s)
      cells.push_back({{"x", cx}, {"y", cy}});
    shapesJson.push_back(cells);
  }
  fx["shapes"] = shapesJson;
  json anchorsJson = json::array();
  for (const auto &[ax, ay] : anchors)
    anchorsJson.push_back({{"x", ax}, {"y", ay}});
  fx["initialAnchors"] = anchorsJson;
  fx["goalIndex"] = data.goalIndex;
  fx["goalAnchor"] = {{"x", data.goalAnchor.x}, {"y", data.goalAnchor.y}};
  std::ofstream out(path);
  if (!out.is_open())
    return false;
  out << fx.dump();
  return true;
}

void writeTurnsFile(const std::vector<Turn> &turns, const std::string &path) {
  json tj = json::array();
  for (const auto &[blockId, direction] : turns)
    tj.push_back(
        {{"blockId", blockId},
         {"direction", static_cast<int>(std::to_underlying(direction))}});
  std::ofstream f(path);
  f << tj.dump();
}
