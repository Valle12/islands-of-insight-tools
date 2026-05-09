#ifdef __clang__
#include <yvals_core.h>
#undef __cpp_lib_is_pointer_interconvertible
#endif
#include "AStar.h"
#include "Block.h"
#include "Node.h"
#include "Types.h"
#include <boost/dynamic_bitset.hpp>
#if defined(__GNUC__) && !defined(__clang__)
namespace boost {
template <typename T>
dynamic_bitset(T) -> dynamic_bitset<>;
}
#endif
#include <gtest/gtest.h>

#include <filesystem>
#include <format>
#include <fstream>
#include <nlohmann/json.hpp>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

using json = nlohmann::json;

class TestDataError final : public std::runtime_error {
  using std::runtime_error::runtime_error;
};

static Tile parseTile(const std::string_view s) {
  using enum Tile;
  if (s == "mustTouch")
    return MustTouch;
  if (s == "goal")
    return Goal;
  if (s == "unplayable")
    return Unplayable;
  return Regular;
}

struct BFSTestData {
  uint8_t gridWidth{};
  uint8_t gridHeight{};
  std::vector<Tile> cells; // flat: cells[x + y * gridWidth]
  std::vector<Block> blocks;
  std::string filename;
};

static BFSTestData loadTestData(const std::string &filename) {
  const std::filesystem::path p =
      std::filesystem::path(TEST_RESOURCES_DIR) / filename;
  std::ifstream f(p);
  if (!f.is_open()) {
    throw TestDataError("Cannot open " + p.string());
  }
  json j = json::parse(f);

  BFSTestData data;
  data.gridWidth = j["gridWidth"].get<uint8_t>();
  data.gridHeight = j["gridHeight"].get<uint8_t>();
  data.filename = filename;

  // JSON cells is [x][y] — outer array index = x, inner = y
  const auto &jsonCells = j["cells"];
  data.cells.resize(static_cast<size_t>(data.gridWidth) * data.gridHeight,
                    Tile::Regular);
  for (uint8_t x = 0; x < data.gridWidth; x++) {
    for (uint8_t y = 0; y < data.gridHeight; y++) {
      data.cells[x + y * data.gridWidth] =
          parseTile(jsonCells[x][y].get<std::string>());
    }
  }

  for (const auto &jb : j["blocks"]) {
    data.blocks.emplace_back(
        jb["id"].get<uint8_t>(), static_cast<int8_t>(jb["x"].get<int>()),
        static_cast<int8_t>(jb["y"].get<int>()), jb["width"].get<uint8_t>(),
        jb["depth"].get<uint8_t>(), jb["height"].get<uint8_t>());
  }

  return data;
}

// Check all mustTouch cells are satisfied
static bool
allMustTouchSatisfied(const BFSTestData &data,
                      const boost::dynamic_bitset<> &mustTouchSatisfied) {
  for (int8_t x = 0; x < static_cast<int8_t>(data.gridWidth); x++) {
    for (int8_t y = 0; y < static_cast<int8_t>(data.gridHeight); y++) {
      if (const auto idx = positionToIndex(x, y, data.gridWidth);
          data.cells[idx] == Tile::MustTouch &&
          (idx >= mustTouchSatisfied.size() || !mustTouchSatisfied.test(idx)))
        return false;
    }
  }
  return true;
}

// Check whether a block is fully on goal cells
static bool isBlockFullyOnGoal(const Block &block, const uint8_t gridWidth,
                               const std::vector<Tile> &cells) {
  for (int8_t cx = block.x; cx < block.x + static_cast<int8_t>(block.width);
       cx++) {
    for (int8_t cy = block.y; cy < block.y + static_cast<int8_t>(block.depth);
         cy++) {
      if (cells[positionToIndex(cx, cy, gridWidth)] != Tile::Goal)
        return false;
    }
  }
  return true;
}

// Collect goal cell indices covered by a single block's footprint
static void collectBlockGoalCells(const Block &block, const uint8_t gridWidth,
                                  const std::set<uint16_t> &goalIndices,
                                  std::set<uint16_t> &satisfiedGoals) {
  for (int8_t cx = block.x; cx < block.x + static_cast<int8_t>(block.width);
       cx++) {
    for (int8_t cy = block.y; cy < block.y + static_cast<int8_t>(block.depth);
         cy++) {
      if (const auto idx = positionToIndex(cx, cy, gridWidth);
          goalIndices.contains(idx)) {
        satisfiedGoals.insert(idx);
      }
    }
  }
}

// Check all goal cells are covered
static bool allGoalsCovered(const BFSTestData &data,
                            const std::vector<Block> &blocks) {
  std::set<uint16_t> goalIndices;
  for (int8_t x = 0; x < static_cast<int8_t>(data.gridWidth); x++) {
    for (int8_t y = 0; y < static_cast<int8_t>(data.gridHeight); y++) {
      if (const auto idx = positionToIndex(x, y, data.gridWidth);
          data.cells[idx] == Tile::Goal)
        goalIndices.insert(idx);
    }
  }

  if (goalIndices.empty())
    return true;

  std::set<uint16_t> satisfiedGoals;
  for (const auto &block : blocks) {
    if (!isBlockFullyOnGoal(block, data.gridWidth, data.cells))
      continue;
    collectBlockGoalCells(block, data.gridWidth, goalIndices, satisfiedGoals);
  }

  return satisfiedGoals.size() == goalIndices.size();
}

// Validate that a sequence of turns solves the puzzle.
static bool validateSolution(const BFSTestData &data,
                             const std::vector<Turn> &turns) {
  std::vector<Block> blocks = data.blocks;
  const size_t totalCells =
      static_cast<size_t>(data.gridWidth) * data.gridHeight;
  boost::dynamic_bitset mustTouchSatisfied(static_cast<uint16_t>(totalCells));

  // Initial mustTouch update
  for (const auto &block : blocks) {
    mustTouchSatisfied = block.updateMustTouchCells(data.gridWidth, data.cells,
                                                    mustTouchSatisfied);
  }

  // Apply each turn
  for (const auto &[blockId, direction] : turns) {
    // Find block
    Block *target = nullptr;
    for (auto &b : blocks) {
      if (b.id == blockId) {
        target = &b;
        break;
      }
    }
    if (!target)
      return false;

    target->roll(direction);

    if (!target->checkValidity(data.gridWidth, data.gridHeight, data.cells,
                               blocks, mustTouchSatisfied))
      return false;

    mustTouchSatisfied = target->updateMustTouchCells(
        data.gridWidth, data.cells, mustTouchSatisfied);
  }

  return allMustTouchSatisfied(data, mustTouchSatisfied) &&
         allGoalsCovered(data, blocks);
}

class BFSSearchTest : public testing::TestWithParam<std::string> {};

static std::vector<std::string> allTestFiles() {
  std::vector<std::string> files;
  files.emplace_back("bfsTest.json");
  for (int i = 1; i <= 39; i++) {
    files.push_back(std::format("bfsTest{}.json", i));
  }
  return files;
}

INSTANTIATE_TEST_SUITE_P(BFS, BFSSearchTest,
                         ::testing::ValuesIn(allTestFiles()),
                         [](const auto &info) {
                           std::string name = info.param;
                           // Remove .json extension for test name
                           if (name.size() > 5)
                             name = name.substr(0, name.size() - 5);
                           return name;
                         });

TEST_P(BFSSearchTest, ShouldFindValidSolution) {
  const auto &filename = GetParam();
  BFSTestData data;
  try {
    data = loadTestData(filename);
  } catch (const TestDataError &e) {
    GTEST_SKIP() << "Cannot load " << filename << ": " << e.what();
  }

  AStar solver(data.gridWidth, data.gridHeight, data.cells);
  Node root(data.blocks);
  auto turns = solver.search(root);

  ASSERT_FALSE(turns.empty()) << "No solution found for " << filename;
  EXPECT_TRUE(validateSolution(data, turns))
      << "Invalid solution for " << filename;
}
