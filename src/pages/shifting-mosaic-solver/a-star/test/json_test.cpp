#include "AStar.h"
#include "DragSolver.h"
#include "Node.h"
#include "ParallelCascade.h"
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

// Player "steps" as the UI counts them (solutionView.ts): maximal runs of
// same-block turns — direction changes fold into one polyline drag. The
// post-processor must never increase this.
size_t countSteps(const std::vector<Turn> &turns) {
  size_t steps = 0;
  for (size_t i = 0; i < turns.size(); i++) {
    if (i == 0 || turns[i].blockId != turns[i - 1].blockId) {
      steps++;
    }
  }
  return steps;
}

class ShiftingMosaicJsonTest : public testing::TestWithParam<std::string> {};

std::vector<std::string> allTestFiles() {
  std::vector<std::string> files;
  files.emplace_back("shiftingMosaicTest.json");
  for (int i = 1; i <= 43; i++)
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

  // Default engine "cascade" = solveArmsParallel, the SAME six-arm race the
  // threaded wasm build runs in the browser — this suite hard-requires every
  // fixture through the production flow (test37 falls to the deep-drag arm
  // in ~4-5 min, test41 to the assembly arm in ~25s; everything else in
  // ms-to-seconds, since the first winning arm cancels the rest). Env vars
  // override any field so a single binary can be re-run under different
  // settings; SHIFTING_MOSAIC_ENGINE selects cascade (default), unit, drag,
  // or hier.
  AStar::Config cfg;
  cfg.weight = 3;
  cfg.lpDisplacementWeight = 1;
  cfg.axisAwareWeight = 1;
  cfg.pathBlockerWeight = 1;
  cfg.boundaryDistanceWeight = 1;
  // Get the raw search output here; the post-processor is exercised explicitly
  // below so the baseline and optimized turn counts can be compared.
  cfg.postProcess = false;
  // Per arm (cascade) / per search pass (unit, which retries as BFS on a
  // failed guided pass — so a hard puzzle can take up to 2x this). 300s
  // mirrors the production per-arm budget.
  uint32_t budgetMs = 300000;
  uint32_t maxNodes = 20000000;
  if (const char *w = std::getenv("SHIFTING_MOSAIC_WEIGHT"))
    cfg.weight = static_cast<uint8_t>(std::atoi(w));
  if (const char *p = std::getenv("SHIFTING_MOSAIC_PATH_BLOCKER_WEIGHT"))
    cfg.pathBlockerWeight = static_cast<uint8_t>(std::atoi(p));
  if (const char *bd = std::getenv("SHIFTING_MOSAIC_BOUNDARY_WEIGHT"))
    cfg.boundaryDistanceWeight = static_cast<uint8_t>(std::atoi(bd));
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
  std::string engine = "cascade";
  if (const char *e = std::getenv("SHIFTING_MOSAIC_ENGINE"))
    engine = e;

  std::vector<Turn> turns;
  AStar solver(data.gridWidth, data.gridHeight, data.shapes, data.initialAnchors,
               data.goalIndex, data.goalAnchor, cfg);
  if (engine == "cascade") {
    turns = solveArmsParallel(data.gridWidth, data.gridHeight, data.shapes,
                              data.initialAnchors, data.goalIndex,
                              data.goalAnchor, budgetMs, maxNodes,
                              /*postProcess=*/false, nullptr);
  } else if (engine == "drag" || engine == "hier") {
    DragSolver::Config dcfg;
    dcfg.weight = cfg.weight;
    dcfg.postProcess = cfg.postProcess;
    if (const char *s = std::getenv("SHIFTING_MOSAIC_SETTLED"))
      dcfg.settledOnly = std::atoi(s) != 0;
    if (const char *pw = std::getenv("SHIFTING_MOSAIC_PEA"))
      dcfg.partialExpansionWidth = static_cast<uint16_t>(std::atoi(pw));
    DragSolver drag(data.gridWidth, data.gridHeight, data.shapes,
                    data.initialAnchors, data.goalIndex, data.goalAnchor,
                    dcfg);
    turns = engine == "hier" ? drag.searchHierarchical(budgetMs, maxNodes)
                             : drag.search(budgetMs, maxNodes);
  } else {
    turns = solver.search(budgetMs, maxNodes);
  }

  ASSERT_FALSE(turns.empty()) << "No solution found for " << filename;
  EXPECT_TRUE(validateSolution(data, turns))
      << "Invalid raw solution for " << filename;

  // Post-process and compare against the raw solution as a baseline.
  const size_t baseMoves = turns.size();
  const size_t baseSteps = countSteps(turns);
  const auto optimized = solver.optimizeSolution(turns);
  const size_t optMoves = optimized.size();
  const size_t optSteps = countSteps(optimized);

  std::cout << filename << ": " << baseMoves << " -> " << optMoves
            << " moves, " << baseSteps << " -> " << optSteps << " steps\n";

  EXPECT_TRUE(validateSolution(data, optimized))
      << "Invalid optimized solution for " << filename;
  EXPECT_LE(optMoves, baseMoves)
      << "Post-processing increased the move count for " << filename;
  EXPECT_LE(optSteps, baseSteps)
      << "Post-processing increased the step count for " << filename;
}

} // namespace
