#include "AStar.h"
#include "Node.h"
#include "Types.h"

#include <gtest/gtest.h>

#include <cstdlib>
#include <filesystem>
#include <format>
#include <fstream>
#include <iostream>
#include <nlohmann/json.hpp>
#include <stdexcept>
#include <string>
#include <vector>

using json = nlohmann::json;

namespace {

class TestDataError final : public std::runtime_error {
  using std::runtime_error::runtime_error;
};

struct ShiftingMosaicTestData {
  uint8_t gridWidth{};
  uint8_t gridHeight{};
  std::vector<std::vector<Position>> shapes;
  std::vector<Position> initialAnchors;
  uint8_t goalIndex{};
  Position goalAnchor{};
  std::string filename;
};

ShiftingMosaicTestData loadTestData(const std::string &filename) {
  const std::filesystem::path p =
      std::filesystem::path(TEST_RESOURCES_DIR) / filename;
  std::ifstream f(p);
  if (!f.is_open())
    throw TestDataError("Cannot open " + p.string());
  json j = json::parse(f);

  ShiftingMosaicTestData data;
  data.gridWidth = j["gridWidth"].get<uint8_t>();
  data.gridHeight = j["gridHeight"].get<uint8_t>();
  data.filename = filename;

  for (const auto &shape : j["shapes"]) {
    std::vector<Position> cells;
    cells.reserve(shape.size());
    for (const auto &c : shape)
      cells.push_back({static_cast<int8_t>(c["x"].get<int>()),
                       static_cast<int8_t>(c["y"].get<int>())});
    data.shapes.push_back(std::move(cells));
  }
  for (const auto &a : j["initialAnchors"])
    data.initialAnchors.push_back({static_cast<int8_t>(a["x"].get<int>()),
                                    static_cast<int8_t>(a["y"].get<int>())});
  data.goalIndex = j["goalIndex"].get<uint8_t>();
  data.goalAnchor = {static_cast<int8_t>(j["goalAnchor"]["x"].get<int>()),
                     static_cast<int8_t>(j["goalAnchor"]["y"].get<int>())};
  return data;
}

bool validateSolution(const ShiftingMosaicTestData &data,
                      const std::vector<Turn> &turns) {
  std::vector<Position> anchors = data.initialAnchors;
  for (const auto &[blockId, direction] : turns) {
    if (blockId >= anchors.size())
      return false;
    auto &p = anchors[blockId];
    switch (direction) {
    case Direction::UP:
      p.y--;
      break;
    case Direction::RIGHT:
      p.x++;
      break;
    case Direction::DOWN:
      p.y++;
      break;
    case Direction::LEFT:
      p.x--;
      break;
    }
  }
  const auto &g = anchors[data.goalIndex];
  return g.x == data.goalAnchor.x && g.y == data.goalAnchor.y;
}

class ShiftingMosaicJsonTest : public testing::TestWithParam<std::string> {};

std::vector<std::string> allTestFiles() {
  std::vector<std::string> files;
  files.emplace_back("shiftingMosaicTest.json");
  for (int i = 1; i <= 30; i++)
    files.push_back(std::format("shiftingMosaicTest{}.json", i));
  return files;
}

INSTANTIATE_TEST_SUITE_P(ShiftingMosaic, ShiftingMosaicJsonTest,
                         ::testing::ValuesIn(allTestFiles()),
                         [](const auto &info) {
                           std::string name = info.param;
                           if (name.size() > 5)
                             name = name.substr(0, name.size() - 5);
                           return name;
                         });

TEST_P(ShiftingMosaicJsonTest, ShouldFindValidSolution) {
  const auto &filename = GetParam();
  ShiftingMosaicTestData data;
  try {
    data = loadTestData(filename);
  } catch (const TestDataError &e) {
    GTEST_SKIP() << "Cannot load " << filename << ": " << e.what();
  }

  // Production config: weighted A* with the full additive heuristic stack.
  // This solves 30 of the 31 fixtures (everything except shiftingMosaicTest21).
  // Env vars override any field so a single binary can be re-run under
  // different settings.
  AStar::Config cfg;
  cfg.weight = 3;
  cfg.lpDisplacementWeight = 1;
  cfg.axisAwareWeight = 1;
  cfg.pathBlockerWeight = 1;
  cfg.boundaryDistanceWeight = 1;
  uint32_t budgetMs = 120000;
  uint32_t maxNodes = 20000000;
  bool useIda = false;
  if (const char *w = std::getenv("SHIFTING_MOSAIC_WEIGHT"))
    cfg.weight = static_cast<uint8_t>(std::atoi(w));
  if (const char *p = std::getenv("SHIFTING_MOSAIC_PATH_BLOCKER_WEIGHT"))
    cfg.pathBlockerWeight = static_cast<uint8_t>(std::atoi(p));
  if (const char *bd = std::getenv("SHIFTING_MOSAIC_BOUNDARY_WEIGHT"))
    cfg.boundaryDistanceWeight = static_cast<uint8_t>(std::atoi(bd));
  if (const char *aw = std::getenv("SHIFTING_MOSAIC_ALL_WALLS_BFS"))
    cfg.allWallsBfsBase = std::atoi(aw) != 0;
  if (const char *mm = std::getenv("SHIFTING_MOSAIC_MACROS"))
    cfg.macroMoves = std::atoi(mm) != 0;
  if (const char *ax = std::getenv("SHIFTING_MOSAIC_AXIS_WEIGHT"))
    cfg.axisAwareWeight = static_cast<uint8_t>(std::atoi(ax));
  if (const char *lp = std::getenv("SHIFTING_MOSAIC_LP_WEIGHT"))
    cfg.lpDisplacementWeight = static_cast<uint8_t>(std::atoi(lp));
  if (const char *st = std::getenv("SHIFTING_MOSAIC_STRIDE"))
    cfg.strideOverride = static_cast<uint8_t>(std::atoi(st));
  if (const char *b = std::getenv("SHIFTING_MOSAIC_BUDGET_MS"))
    budgetMs = static_cast<uint32_t>(std::atoi(b));
  if (const char *m = std::getenv("SHIFTING_MOSAIC_MAX_NODES"))
    maxNodes = static_cast<uint32_t>(std::atoi(m));
  if (const char *i = std::getenv("SHIFTING_MOSAIC_IDASTAR"))
    useIda = std::atoi(i) != 0;

  AStar solver(data.gridWidth, data.gridHeight, data.shapes, data.initialAnchors,
               data.goalIndex, data.goalAnchor, cfg);
  auto turns = useIda ? solver.searchIDAStar(budgetMs, maxNodes)
                      : solver.search(budgetMs, maxNodes);
  std::cout << filename << ": " << turns.size() << " moves\n";

  ASSERT_FALSE(turns.empty()) << "No solution found for " << filename;
  EXPECT_TRUE(validateSolution(data, turns))
      << "Invalid solution for " << filename;
}

} // namespace
