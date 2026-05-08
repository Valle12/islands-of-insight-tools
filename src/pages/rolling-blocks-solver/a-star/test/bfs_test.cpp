#include <gtest/gtest.h>
#include "AStar.h"
#include "Block.h"
#include <boost/dynamic_bitset.hpp>
#include "Node.h"
#include "Types.h"

#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <nlohmann/json.hpp>
#include <string>
#include <vector>

using json = nlohmann::json;

static Tile parseTile(const std::string& s) {
    if (s == "mustTouch") return Tile::MustTouch;
    if (s == "goal") return Tile::Goal;
    if (s == "unplayable") return Tile::Unplayable;
    return Tile::Regular;
}

static Direction parseDirection(const std::string& s) {
    if (s == "UP") return Direction::UP;
    if (s == "RIGHT") return Direction::RIGHT;
    if (s == "DOWN") return Direction::DOWN;
    return Direction::LEFT;
}

struct BFSTestData {
    uint8_t gridWidth;
    uint8_t gridHeight;
    std::vector<Tile> cells; // flat: cells[x + y * gridWidth]
    std::vector<Block> blocks;
    std::string filename;
};

static BFSTestData loadTestData(const std::string& filename) {
    std::filesystem::path p = std::filesystem::path(TEST_RESOURCES_DIR) / filename;
    std::ifstream f(p);
    if (!f.is_open()) {
        throw std::runtime_error("Cannot open " + p.string());
    }
    json j = json::parse(f);

    BFSTestData data;
    data.gridWidth = j["gridWidth"].get<uint8_t>();
    data.gridHeight = j["gridHeight"].get<uint8_t>();
    data.filename = filename;

    // JSON cells is [x][y] — outer array index = x, inner = y
    const auto& jcells = j["cells"];
    data.cells.resize(static_cast<size_t>(data.gridWidth) * data.gridHeight, Tile::Regular);
    for (uint8_t x = 0; x < data.gridWidth; x++) {
        for (uint8_t y = 0; y < data.gridHeight; y++) {
            data.cells[x + y * data.gridWidth] = parseTile(jcells[x][y].get<std::string>());
        }
    }

    for (const auto& jb : j["blocks"]) {
        data.blocks.emplace_back(
            jb["id"].get<uint8_t>(),
            static_cast<int8_t>(jb["x"].get<int>()),
            static_cast<int8_t>(jb["y"].get<int>()),
            jb["width"].get<uint8_t>(),
            jb["depth"].get<uint8_t>(),
            jb["height"].get<uint8_t>()
        );
    }

    return data;
}

// Validate that a sequence of turns solves the puzzle.
static bool validateSolution(const BFSTestData& data, const std::vector<Turn>& turns) {
    std::vector<Block> blocks = data.blocks;
    size_t totalCells = static_cast<size_t>(data.gridWidth) * data.gridHeight;
    boost::dynamic_bitset<> mustTouchSatisfied(static_cast<uint16_t>(totalCells));

    // Initial mustTouch update
    for (const auto& block : blocks) {
        mustTouchSatisfied = block.updateMustTouchCells(data.gridWidth, data.cells, mustTouchSatisfied);
    }

    // Apply each turn
    for (const auto& turn : turns) {
        // Find block
        Block* target = nullptr;
        for (auto& b : blocks) {
            if (b.id == turn.blockId) {
                target = &b;
                break;
            }
        }
        if (!target) return false;

        target->roll(turn.direction);

        if (!target->checkValidity(data.gridWidth, data.gridHeight, data.cells, blocks, mustTouchSatisfied))
            return false;

        mustTouchSatisfied = target->updateMustTouchCells(data.gridWidth, data.cells, mustTouchSatisfied);
    }

    // Check all mustTouch cells are satisfied
    for (int8_t x = 0; x < static_cast<int8_t>(data.gridWidth); x++) {
        for (int8_t y = 0; y < static_cast<int8_t>(data.gridHeight); y++) {
            auto idx = positionToIndex(x, y, data.gridWidth);
            if (data.cells[idx] == Tile::MustTouch) {
                if (idx >= mustTouchSatisfied.size() || !mustTouchSatisfied.test(idx))
                    return false;
            }
        }
    }

    // Check all goal cells are covered
    std::set<uint16_t> goalIndices;
    for (int8_t x = 0; x < static_cast<int8_t>(data.gridWidth); x++) {
        for (int8_t y = 0; y < static_cast<int8_t>(data.gridHeight); y++) {
            auto idx = positionToIndex(x, y, data.gridWidth);
            if (data.cells[idx] == Tile::Goal) goalIndices.insert(idx);
        }
    }

    if (goalIndices.empty()) return true;

    std::set<uint16_t> satisfiedGoals;
    for (const auto& block : blocks) {
        bool fullyOnGoal = true;
        for (int8_t cx = block.x; cx < block.x + static_cast<int8_t>(block.width) && fullyOnGoal; cx++) {
            for (int8_t cy = block.y; cy < block.y + static_cast<int8_t>(block.depth) && fullyOnGoal; cy++) {
                auto idx = positionToIndex(cx, cy, data.gridWidth);
                if (data.cells[idx] != Tile::Goal) fullyOnGoal = false;
            }
        }
        if (!fullyOnGoal) continue;
        for (int8_t cx = block.x; cx < block.x + static_cast<int8_t>(block.width); cx++) {
            for (int8_t cy = block.y; cy < block.y + static_cast<int8_t>(block.depth); cy++) {
                auto idx = positionToIndex(cx, cy, data.gridWidth);
                if (goalIndices.count(idx)) satisfiedGoals.insert(idx);
            }
        }
    }

    return satisfiedGoals.size() == goalIndices.size();
}

class BFSSearchTest : public ::testing::TestWithParam<std::string> {};

static std::vector<std::string> allTestFiles() {
    std::vector<std::string> files;
    files.push_back("bfsTest.json");
    for (int i = 1; i <= 39; i++) {
        files.push_back("bfsTest" + std::to_string(i) + ".json");
    }
    return files;
}

INSTANTIATE_TEST_SUITE_P(BFS, BFSSearchTest, ::testing::ValuesIn(allTestFiles()),
    [](const auto& info) {
        std::string name = info.param;
        // Remove .json extension for test name
        if (name.size() > 5) name = name.substr(0, name.size() - 5);
        return name;
    });

TEST_P(BFSSearchTest, ShouldFindValidSolution) {
    auto filename = GetParam();
    BFSTestData data;
    try {
        data = loadTestData(filename);
    } catch (const std::exception& e) {
        GTEST_SKIP() << "Cannot load " << filename << ": " << e.what();
    }

    AStar solver(data.gridWidth, data.gridHeight, data.cells);
    Node root(data.blocks);
    auto turns = solver.search(root);

    ASSERT_FALSE(turns.empty()) << "No solution found for " << filename;
    EXPECT_TRUE(validateSolution(data, turns)) << "Invalid solution for " << filename;
}
