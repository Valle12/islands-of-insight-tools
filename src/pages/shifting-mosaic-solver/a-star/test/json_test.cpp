#include "ClangdCompat.h" // must stay first; see the header

#include "AStar.h"
#include "DragSolver.h"
#include "ParallelCascade.h"
#include "Types.h"

#include <gtest/gtest.h>

#include <cerrno>
#include <climits>
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

// Independent occupancy check — deliberately shares no code with the solver
// (mirrors optimizer_test.cpp's collisionFree): every block in bounds, no two
// blocks overlapping.
bool collisionFree(const ShiftingMosaicTestData &data,
                   const std::vector<Position> &anchors) {
  std::vector occupied(static_cast<size_t>(data.gridWidth) * data.gridHeight,
                       false);
  for (size_t i = 0; i < anchors.size(); i++) {
    for (const auto &[dx, dy] : data.shapes[i]) {
      const int cx = anchors[i].x + dx;
      const int cy = anchors[i].y + dy;
      if (cx < 0 || cy < 0 || cx >= data.gridWidth || cy >= data.gridHeight)
        return false;
      const auto idx = static_cast<size_t>(cx) * data.gridHeight + cy;
      if (occupied[idx])
        return false;
      occupied[idx] = true;
    }
  }
  return true;
}

// Full legality replay: the goal anchor alone is not enough. Checking only the
// final position accepts a plan that drags a block THROUGH another block or
// off the grid — the exact defect class this suite exists to catch, and the
// one BenchFixture::firstIllegalMove already guards on the CLI side.
bool validateSolution(const ShiftingMosaicTestData &data,
                      const std::vector<Turn> &turns) {
  std::vector<Position> anchors = data.initialAnchors;
  if (data.goalIndex >= anchors.size() ||
      data.shapes.size() != anchors.size() || !collisionFree(data, anchors))
    return false;
  for (const auto &[blockId, direction] : turns) {
    if (blockId >= anchors.size())
      return false;
    auto &[px, py] = anchors[blockId];
    switch (direction) {
      using enum Direction;
    case UP:
      py--;
      break;
    case RIGHT:
      px++;
      break;
    case DOWN:
      py++;
      break;
    case LEFT:
      px--;
      break;
    }
    if (!collisionFree(data, anchors))
      return false;
  }
  const auto &[gx, gy] = anchors[data.goalIndex];
  return gx == data.goalAnchor.x && gy == data.goalAnchor.y;
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

// Reads a numeric env override, or returns `fallback` when it is unset.
//
// std::atoi reports nothing — a typo'd or out-of-range value silently
// becomes 0, and the run then measures something other than what the sweep
// asked for while still looking like it honored the variable. Every knob
// below goes through this instead, and a malformed value fails the test
// rather than quietly changing the configuration.
uint32_t envU32(const char *name, const uint32_t fallback) {
  const char *const raw = std::getenv(name);
  if (raw == nullptr || *raw == '\0')
    return fallback;
  char *end = nullptr;
  errno = 0;
  const unsigned long long v = std::strtoull(raw, &end, 10);
  const bool valid = end != raw && *end == '\0' && errno != ERANGE &&
                     raw[0] != '-' && v <= UINT32_MAX;
  EXPECT_TRUE(valid) << name << "=" << raw << " is not a valid unsigned number";
  return valid ? static_cast<uint32_t>(v) : fallback;
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
  cfg.weight =
      static_cast<uint8_t>(envU32("SHIFTING_MOSAIC_WEIGHT", cfg.weight));
  cfg.pathBlockerWeight = static_cast<uint8_t>(
      envU32("SHIFTING_MOSAIC_PATH_BLOCKER_WEIGHT", cfg.pathBlockerWeight));
  cfg.boundaryDistanceWeight = static_cast<uint8_t>(
      envU32("SHIFTING_MOSAIC_BOUNDARY_WEIGHT", cfg.boundaryDistanceWeight));
  cfg.axisAwareWeight = static_cast<uint8_t>(
      envU32("SHIFTING_MOSAIC_AXIS_WEIGHT", cfg.axisAwareWeight));
  cfg.lpDisplacementWeight = static_cast<uint8_t>(
      envU32("SHIFTING_MOSAIC_LP_WEIGHT", cfg.lpDisplacementWeight));
  cfg.strideOverride = static_cast<uint8_t>(
      envU32("SHIFTING_MOSAIC_STRIDE", cfg.strideOverride));
  budgetMs = envU32("SHIFTING_MOSAIC_BUDGET_MS", budgetMs);
  maxNodes = envU32("SHIFTING_MOSAIC_MAX_NODES", maxNodes);
  std::string engine = "cascade";
  if (const char *e = std::getenv("SHIFTING_MOSAIC_ENGINE"))
    engine = e;

  std::vector<Turn> turns;
  AStar solver(data.gridWidth, data.gridHeight, data.shapes,
               data.initialAnchors, data.goalIndex, data.goalAnchor, cfg);
  if (engine == "cascade") {
    const cascade::Board board{.gridWidth = data.gridWidth,
                              .gridHeight = data.gridHeight,
                              .shapes = data.shapes,
                              .initialAnchors = data.initialAnchors,
                              .goalIndex = data.goalIndex,
                              .goalAnchor = data.goalAnchor};
    turns = solveArmsParallel(board,
                              {.maxMs = budgetMs,
                               .maxNodes = maxNodes,
                               .postProcess = false},
                              nullptr);
  } else if (engine == "drag" || engine == "hier") {
    DragSolver::Config dcfg;
    dcfg.weight = cfg.weight;
    dcfg.postProcess = cfg.postProcess;
    dcfg.settledOnly = envU32("SHIFTING_MOSAIC_SETTLED", 0) != 0;
    dcfg.partialExpansionWidth = static_cast<uint16_t>(
        envU32("SHIFTING_MOSAIC_PEA", dcfg.partialExpansionWidth));
    DragSolver drag(data.gridWidth, data.gridHeight, data.shapes,
                    data.initialAnchors, data.goalIndex, data.goalAnchor, dcfg);
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

  std::cout << filename << ": " << baseMoves << " -> " << optMoves << " moves, "
            << baseSteps << " -> " << optSteps << " steps\n";

  EXPECT_TRUE(validateSolution(data, optimized))
      << "Invalid optimized solution for " << filename;
  EXPECT_LE(optMoves, baseMoves)
      << "Post-processing increased the move count for " << filename;
  EXPECT_LE(optSteps, baseSteps)
      << "Post-processing increased the step count for " << filename;
}

} // namespace
