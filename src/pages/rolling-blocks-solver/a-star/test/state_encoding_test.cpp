// Tests for the canonical state encoding, real-id turn attribution, budgets
// and engine caps introduced with the StateTable-based search core.

#ifdef __clang__
#include <yvals_core.h>
#undef __cpp_lib_is_pointer_interconvertible
#endif
#include "AStar.h"
#include "Block.h"
#include "Node.h"
#include "Types.h"
#if defined(__GNUC__) && !defined(__clang__)
namespace boost {
template <typename T>
dynamic_bitset(T) -> dynamic_bitset<>;
}
#endif
#include <gtest/gtest.h>

#include <algorithm>
#include <atomic>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <nlohmann/json.hpp>
#include <string>
#include <vector>

namespace {

std::vector<Tile> uniformCells(const uint8_t w, const uint8_t h,
                               const Tile tile = Tile::Regular) {
  return std::vector(static_cast<size_t>(w) * h, tile);
}

void setCell(std::vector<Tile> &cells, const uint8_t w, const int8_t x,
             const int8_t y, const Tile tile) {
  cells[positionToIndex(x, y, w)] = tile;
}

boost::dynamic_bitset<> emptyBits(const uint8_t w, const uint8_t h) {
  return boost::dynamic_bitset<>(static_cast<size_t>(w) * h);
}

// Replays a solution on the original real-id blocks, asserting legality of
// every roll. Out-parameter shape because gtest's ASSERT_* macros only
// compile in void functions.
struct ReplayResult {
  std::vector<Block> blocks;
  boost::dynamic_bitset<> satisfied;
};

void replaySolution(const uint8_t w, const uint8_t h,
                    const std::vector<Tile> &cells, std::vector<Block> blocks,
                    const std::vector<Turn> &turns, ReplayResult &out) {
  boost::dynamic_bitset<> satisfied(static_cast<size_t>(w) * h);
  for (const auto &b : blocks) {
    satisfied = b.updateMustTouchCells(w, cells, satisfied);
  }
  for (const auto &turn : turns) {
    const auto it = std::ranges::find_if(
        blocks, [&](const Block &b) { return b.id == turn.blockId; });
    ASSERT_NE(it, blocks.end()) << "turn references unknown block id";
    it->roll(turn.direction);
    ASSERT_TRUE(it->checkValidity(w, h, cells, blocks, satisfied));
    satisfied = it->updateMustTouchCells(w, cells, satisfied);
  }
  out = {.blocks = std::move(blocks), .satisfied = std::move(satisfied)};
}

// Exact goal cover: the set of goal cells under fully-on-goal blocks must be
// every goal cell.
void assertGoalsCovered(const uint8_t w, const uint8_t h,
                        const std::vector<Tile> &cells,
                        const std::vector<Block> &blocks) {
  boost::dynamic_bitset<> covered(static_cast<size_t>(w) * h);
  for (const auto &b : blocks) {
    bool fullyOnGoal = true;
    for (int8_t cx = b.x; cx < b.x + static_cast<int8_t>(b.width); cx++) {
      for (int8_t cy = b.y; cy < b.y + static_cast<int8_t>(b.depth); cy++) {
        if (cells[positionToIndex(cx, cy, w)] != Tile::Goal) {
          fullyOnGoal = false;
        }
      }
    }
    if (!fullyOnGoal) {
      continue;
    }
    for (int8_t cx = b.x; cx < b.x + static_cast<int8_t>(b.width); cx++) {
      for (int8_t cy = b.y; cy < b.y + static_cast<int8_t>(b.depth); cy++) {
        covered.set(positionToIndex(cx, cy, w));
      }
    }
  }
  for (size_t i = 0; i < cells.size(); i++) {
    if (cells[i] == Tile::Goal) {
      EXPECT_TRUE(covered.test(i)) << "goal cell " << i << " not covered";
    }
  }
}

} // namespace

TEST(StateEncoding, EqualDimsPermutationCollapses) {
  const uint8_t w = 6;
  const uint8_t h = 6;
  AStar solver(w, h, uniformCells(w, h));

  const std::vector<Block> a = {{1, 1, 1, 1, 1, 2}, {2, 4, 4, 1, 1, 2}};
  const std::vector<Block> b = {{2, 1, 1, 1, 1, 2}, {1, 4, 4, 1, 1, 2}};
  const auto bits = emptyBits(w, h);

  EXPECT_EQ(solver.encodeState(a, bits), solver.encodeState(b, bits))
      << "swapping two same-shaped blocks must collapse into one state";
}

TEST(StateEncoding, DifferentHeightsDoNotAlias) {
  const uint8_t w = 6;
  const uint8_t h = 6;
  AStar solver(w, h, uniformCells(w, h));

  // A standing 1x1x3 and a standing 1x1x5 share the 1x1 footprint. Swapping
  // which tower stands where must produce a DIFFERENT state: this is the
  // aliasing the old (x, y, width, depth)-only signature had.
  const std::vector<Block> a = {{1, 1, 1, 1, 1, 3}, {2, 4, 4, 1, 1, 5}};
  const std::vector<Block> b = {{1, 1, 1, 1, 1, 5}, {2, 4, 4, 1, 1, 3}};
  const auto bits = emptyBits(w, h);

  EXPECT_NE(solver.encodeState(a, bits), solver.encodeState(b, bits))
      << "towers of different heights on equal footprints must not alias";
}

TEST(StateEncoding, MustTouchOrdinalBitsRoundTrip) {
  const uint8_t w = 7;
  const uint8_t h = 5;
  auto cells = uniformCells(w, h);
  setCell(cells, w, 0, 0, Tile::MustTouch);
  setCell(cells, w, 3, 2, Tile::MustTouch);
  setCell(cells, w, 6, 4, Tile::MustTouch);
  AStar solver(w, h, cells);

  const std::vector<Block> blocks = {{1, 2, 2, 1, 1, 2}};
  auto bits = emptyBits(w, h);
  bits.set(positionToIndex(3, 2, w));
  bits.set(positionToIndex(6, 4, w));

  const NodeKey key = solver.encodeState(blocks, bits);

  std::vector<Block> decodedBlocks;
  boost::dynamic_bitset<> decodedBits;
  solver.decodeState(key, decodedBlocks, decodedBits);

  EXPECT_EQ(decodedBits, bits);
  ASSERT_EQ(decodedBlocks.size(), 1u);
  EXPECT_EQ(decodedBlocks[0].x, 2);
  EXPECT_EQ(decodedBlocks[0].y, 2);
  EXPECT_EQ(decodedBlocks[0].height, 2);

  auto otherBits = emptyBits(w, h);
  otherBits.set(positionToIndex(0, 0, w));
  EXPECT_NE(solver.encodeState(blocks, otherBits), key)
      << "a different satisfied set must produce a different key";
}

TEST(StateEncoding, LargeBoardKeysRoundTripThroughSpill) {
  // 64x64 = 4096 cells: far past the 512-cell ceiling the old fixed
  // to_block_range scratch silently overflowed on wasm32.
  const uint8_t w = 64;
  const uint8_t h = 64;
  auto cells = uniformCells(w, h);
  std::vector<uint16_t> mustTouchCells;
  for (int i = 0; i < 300; i++) {
    const auto x = static_cast<int8_t>(i * 7 % 64);
    const auto y = static_cast<int8_t>(i * 13 % 64);
    if (const auto idx = positionToIndex(x, y, w);
        cells[idx] == Tile::Regular) {
      cells[idx] = Tile::MustTouch;
      mustTouchCells.push_back(idx);
    }
  }
  AStar solver(w, h, cells);

  std::vector<Block> blocks;
  blocks.reserve(20);
  for (uint8_t i = 0; i < 20; i++) {
    blocks.emplace_back(static_cast<uint8_t>(i + 1),
                        static_cast<int8_t>(i * 3), static_cast<int8_t>(60),
                        1, 1, static_cast<uint8_t>(1 + i % 3));
  }

  auto bits = emptyBits(w, h);
  for (size_t i = 0; i < mustTouchCells.size(); i += 2) {
    bits.set(mustTouchCells[i]);
  }

  const NodeKey key = solver.encodeState(blocks, bits);
  EXPECT_GT(key.len, NodeKey::InlineCapacity)
      << "this case is meant to exercise the heap-spill path";

  std::vector<Block> decodedBlocks;
  boost::dynamic_bitset<> decodedBits;
  solver.decodeState(key, decodedBlocks, decodedBits);

  EXPECT_EQ(decodedBits, bits);
  ASSERT_EQ(decodedBlocks.size(), blocks.size());
  // decode returns slot ids in canonical order; geometry must round-trip.
  EXPECT_EQ(solver.encodeState(decodedBlocks, decodedBits), key);
}

TEST(StateEncoding, LargeBoardSearchSolves) {
  const uint8_t w = 64;
  const uint8_t h = 64;
  auto cells = uniformCells(w, h);
  setCell(cells, w, 1, 0, Tile::Goal);
  setCell(cells, w, 2, 0, Tile::Goal);
  AStar solver(w, h, cells);

  const std::vector<Block> blocks = {{1, 0, 0, 1, 1, 2}};
  auto turns = solver.search(Node(blocks));
  ASSERT_FALSE(turns.empty());

  ReplayResult replayed;
  ASSERT_NO_FATAL_FAILURE(
      replaySolution(w, h, cells, blocks, turns, replayed));
  assertGoalsCovered(w, h, cells, replayed.blocks);
}

TEST(StateEncoding, RealIdAttributionWithInterchangeableBlocks) {
  // Two identical standing dominoes with deliberately non-contiguous real ids
  // must both reach a goal cell. Under the canonical encoding the two blocks
  // trade identities freely between states; the reported turns must still
  // carry REAL ids and replay to a valid solution.
  const uint8_t w = 4;
  const uint8_t h = 4;
  auto cells = uniformCells(w, h);
  setCell(cells, w, 1, 2, Tile::Goal);
  setCell(cells, w, 2, 1, Tile::Goal);
  AStar solver(w, h, cells);

  const std::vector<Block> blocks = {{7, 3, 0, 1, 1, 2}, {9, 0, 3, 1, 1, 2}};
  auto turns = solver.search(Node(blocks));
  ASSERT_FALSE(turns.empty());

  for (const auto &turn : turns) {
    EXPECT_TRUE(turn.blockId == 7 || turn.blockId == 9)
        << "turn attributed to unknown id " << int{turn.blockId};
  }

  ReplayResult replayed;
  ASSERT_NO_FATAL_FAILURE(
      replaySolution(w, h, cells, blocks, turns, replayed));
  assertGoalsCovered(w, h, cells, replayed.blocks);
}

TEST(StateEncoding, CancelStopsBeforeAnyExpansion) {
  const uint8_t w = 5;
  const uint8_t h = 5;
  auto cells = uniformCells(w, h);
  setCell(cells, w, 4, 4, Tile::Goal);

  std::atomic cancel{true};
  AStar::Config cfg;
  cfg.cancel = &cancel;
  AStar solver(w, h, cells, cfg);

  const std::vector<Block> blocks = {{1, 0, 0, 1, 1, 1}};
  const auto turns = solver.search(Node(blocks));
  EXPECT_TRUE(turns.empty());
  EXPECT_EQ(solver.stats().nodesExpanded, 0u);
}

TEST(StateEncoding, MaxNodesBudgetStopsTheSearch) {
  // Budget checks run on a 1024-expansion cadence, so maxNodes=1 stops at
  // exactly 1024 on any board that needs more than that. Fixture 36 does by
  // orders of magnitude.
  const std::filesystem::path p =
      std::filesystem::path(TEST_RESOURCES_DIR) / "rollingBlocksTest36.json";
  std::ifstream f(p);
  if (!f.is_open()) {
    GTEST_SKIP() << "fixture not present: " << p.string();
  }
  const nlohmann::json j = nlohmann::json::parse(f);
  const auto gridWidth = j["gridWidth"].get<uint8_t>();
  const auto gridHeight = j["gridHeight"].get<uint8_t>();
  std::vector<Tile> cells(static_cast<size_t>(gridWidth) * gridHeight,
                          Tile::Regular);
  for (uint8_t x = 0; x < gridWidth; x++) {
    for (uint8_t y = 0; y < gridHeight; y++) {
      const auto s = j["cells"][x][y].get<std::string>();
      Tile tile = Tile::Regular;
      if (s == "mustTouch") {
        tile = Tile::MustTouch;
      } else if (s == "goal") {
        tile = Tile::Goal;
      } else if (s == "unplayable") {
        tile = Tile::Unplayable;
      }
      cells[x + y * gridWidth] = tile;
    }
  }
  std::vector<Block> blocks;
  for (const auto &jb : j["blocks"]) {
    blocks.emplace_back(
        jb["id"].get<uint8_t>(), static_cast<int8_t>(jb["x"].get<int>()),
        static_cast<int8_t>(jb["y"].get<int>()), jb["width"].get<uint8_t>(),
        jb["depth"].get<uint8_t>(), jb["height"].get<uint8_t>());
  }

  AStar::Config cfg;
  cfg.maxNodes = 1;
  AStar solver(gridWidth, gridHeight, cells, cfg);
  const auto turns = solver.search(Node(blocks));

  EXPECT_TRUE(turns.empty());
  EXPECT_EQ(solver.stats().nodesExpanded, 1024u);
  EXPECT_GT(solver.stats().statesStored, 0u);
  EXPECT_FALSE(solver.stats().stoppedOnMemory);
}

TEST(StateEncoding, InputBeyondCapsIsRejected) {
  {
    AStar solver(65, 5, uniformCells(65, 5));
    EXPECT_TRUE(solver.search(Node({{1, 0, 0, 1, 1, 1}})).empty());
  }
  {
    AStar solver(5, 5, uniformCells(5, 5));
    EXPECT_TRUE(solver.search(Node({{1, 0, 0, 1, 1, 65}})).empty())
        << "block dimension above 64 must be rejected";
  }
  {
    AStar solver(5, 5, uniformCells(5, 5));
    EXPECT_TRUE(solver.search(Node(std::vector<Block>{})).empty());
  }
}
