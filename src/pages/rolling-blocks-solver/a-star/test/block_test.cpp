#ifdef __clang__
#include <yvals_core.h>
#undef __cpp_lib_is_pointer_interconvertible
#endif
#include "Block.h"
#include "Types.h"
#include <boost/dynamic_bitset.hpp>
#include <gtest/gtest.h>
#include <vector>

// =========================================================================
// Roll tests
// =========================================================================

struct RollTestParam {
  Block initial;       // NOLINT: used via structured binding
  Block expected;      // NOLINT: used via structured binding
  Direction direction; // NOLINT: used via structured binding
  std::string name;
};

class BlockRollTest : public testing::TestWithParam<RollTestParam> {};

// -- UP cases --
static std::vector<RollTestParam> makeUpCases() {
  using enum Direction;
  return {
      {Block(1, 3, 3, 1, 2, 3), Block(1, 3, 0, 1, 3, 2), UP, "1x2x3"},
      {Block(1, 3, 3, 1, 3, 2), Block(1, 3, 1, 1, 2, 3), UP, "1x3x2"},
      {Block(1, 3, 3, 2, 1, 3), Block(1, 3, 0, 2, 3, 1), UP, "2x1x3"},
      {Block(1, 3, 3, 2, 3, 1), Block(1, 3, 2, 2, 1, 3), UP, "2x3x1"},
      {Block(1, 3, 3, 3, 1, 2), Block(1, 3, 1, 3, 2, 1), UP, "3x1x2"},
      {Block(1, 3, 3, 3, 2, 1), Block(1, 3, 2, 3, 1, 2), UP, "3x2x1"},
  };
}

INSTANTIATE_TEST_SUITE_P(RollUp, BlockRollTest,
                         testing::ValuesIn(makeUpCases()),
                         [](const auto &info) {
                           return "up_" + info.param.name;
                         });

// -- RIGHT cases --
static std::vector<RollTestParam> makeRightCases() {
  using enum Direction;
  return {
      {Block(1, 3, 3, 1, 2, 3), Block(1, 4, 3, 3, 2, 1), RIGHT, "1x2x3"},
      {Block(1, 3, 3, 1, 3, 2), Block(1, 4, 3, 2, 3, 1), RIGHT, "1x3x2"},
      {Block(1, 3, 3, 2, 1, 3), Block(1, 5, 3, 3, 1, 2), RIGHT, "2x1x3"},
      {Block(1, 3, 3, 2, 3, 1), Block(1, 5, 3, 1, 3, 2), RIGHT, "2x3x1"},
      {Block(1, 3, 3, 3, 1, 2), Block(1, 6, 3, 2, 1, 3), RIGHT, "3x1x2"},
      {Block(1, 3, 3, 3, 2, 1), Block(1, 6, 3, 1, 2, 3), RIGHT, "3x2x1"},
  };
}

INSTANTIATE_TEST_SUITE_P(RollRight, BlockRollTest,
                         testing::ValuesIn(makeRightCases()),
                         [](const auto &info) {
                           return "right_" + info.param.name;
                         });

// -- DOWN cases --
static std::vector<RollTestParam> makeDownCases() {
  using enum Direction;
  return {
      {Block(1, 3, 3, 1, 2, 3), Block(1, 3, 5, 1, 3, 2), DOWN, "1x2x3"},
      {Block(1, 3, 3, 1, 3, 2), Block(1, 3, 6, 1, 2, 3), DOWN, "1x3x2"},
      {Block(1, 3, 3, 2, 1, 3), Block(1, 3, 4, 2, 3, 1), DOWN, "2x1x3"},
      {Block(1, 3, 3, 2, 3, 1), Block(1, 3, 6, 2, 1, 3), DOWN, "2x3x1"},
      {Block(1, 3, 3, 3, 1, 2), Block(1, 3, 4, 3, 2, 1), DOWN, "3x1x2"},
      {Block(1, 3, 3, 3, 2, 1), Block(1, 3, 5, 3, 1, 2), DOWN, "3x2x1"},
  };
}

INSTANTIATE_TEST_SUITE_P(RollDown, BlockRollTest,
                         testing::ValuesIn(makeDownCases()),
                         [](const auto &info) {
                           return "down_" + info.param.name;
                         });

// -- LEFT cases --
static std::vector<RollTestParam> makeLeftCases() {
  using enum Direction;
  return {
      {Block(1, 3, 3, 1, 2, 3), Block(1, 0, 3, 3, 2, 1), LEFT, "1x2x3"},
      {Block(1, 3, 3, 1, 3, 2), Block(1, 1, 3, 2, 3, 1), LEFT, "1x3x2"},
      {Block(1, 3, 3, 2, 1, 3), Block(1, 0, 3, 3, 1, 2), LEFT, "2x1x3"},
      {Block(1, 3, 3, 2, 3, 1), Block(1, 2, 3, 1, 3, 2), LEFT, "2x3x1"},
      {Block(1, 3, 3, 3, 1, 2), Block(1, 1, 3, 2, 1, 3), LEFT, "3x1x2"},
      {Block(1, 3, 3, 3, 2, 1), Block(1, 2, 3, 1, 2, 3), LEFT, "3x2x1"},
  };
}

INSTANTIATE_TEST_SUITE_P(RollLeft, BlockRollTest,
                         testing::ValuesIn(makeLeftCases()),
                         [](const auto &info) {
                           return "left_" + info.param.name;
                         });

TEST_P(BlockRollTest, Roll) {
  auto [initial, expected, direction, name] = GetParam();
  initial.roll(direction);
  EXPECT_EQ(initial, expected);
}

// =========================================================================
// Clone test
// =========================================================================

TEST(BlockClone, ChangesToCloneShouldNotAffectOriginal) {
  Block original(1, 3, 3, 1, 2, 3);
  Block clone = original.clone();
  original.x = 0;
  EXPECT_NE(original, clone);
  clone.x = 0;
  EXPECT_EQ(original, clone);
}

// =========================================================================
// CheckValidity tests
// =========================================================================

// Helper: build the 5x5 flat cell grid used in the TS tests.
// TS has cells[x][y] with all "mustTouch" except cells[4][0], cells[0][4],
// cells[4][4] = "unplayable"
static std::vector<Tile> makeTestCells() {
  using enum Tile;
  // Flat layout: index = x + y * 5
  std::vector cells(25, MustTouch);
  cells[4 + 0 * 5] = Unplayable; // (4,0)
  cells[0 + 4 * 5] = Unplayable; // (0,4)
  cells[4 + 4 * 5] = Unplayable; // (4,4)
  return cells;
}

static boost::dynamic_bitset<> makeTestMustTouch() {
  boost::dynamic_bitset bits(25);
  bits.set(0 + 0 * 5); // (0,0)
  bits.set(1 + 0 * 5); // (1,0)
  bits.set(0 + 1 * 5); // (0,1)
  bits.set(1 + 1 * 5); // (1,1)
  bits.set(2 + 2 * 5); // (2,2)
  bits.set(3 + 2 * 5); // (3,2)
  bits.set(2 + 3 * 5); // (2,3)
  bits.set(3 + 3 * 5); // (3,3)
  return bits;
}

// -- Out of bounds (completely) --
struct BoundsTestParam {
  int8_t x; // NOLINT: used via structured binding
  int8_t y; // NOLINT: used via structured binding
  std::string position;
};

class CompletelyOutOfBoundsTest
    : public testing::TestWithParam<BoundsTestParam> {};

static std::vector<BoundsTestParam> completelyOutOfBoundsCases() {
  return {
      {-3, -3, "top_left"},   {1, -3, "top"},         {6, -3, "top_right"},
      {6, 1, "right"},        {6, 6, "bottom_right"}, {2, 6, "bottom"},
      {-3, 6, "bottom_left"}, {-3, 2, "left"},
  };
}

INSTANTIATE_TEST_SUITE_P(Bounds, CompletelyOutOfBoundsTest,
                         testing::ValuesIn(completelyOutOfBoundsCases()),
                         [](const auto &info) {
                           return "completely_oob_" + info.param.position;
                         });

TEST_P(CompletelyOutOfBoundsTest, ShouldBeOutOfBounds) {
  const auto &[x, y, pos] = GetParam();
  const auto cells = makeTestCells();
  const auto mustTouch = makeTestMustTouch();
  const Block block(1, x, y, 2, 2, 2);
  EXPECT_FALSE(block.checkValidity(5, 5, cells, {}, mustTouch));
}

// -- Out of bounds (partially) --
class PartiallyOutOfBoundsTest
    : public testing::TestWithParam<BoundsTestParam> {};

static std::vector<BoundsTestParam> partiallyOutOfBoundsCases() {
  return {
      {2, -1, "top"},         {4, -1, "top_right"}, {4, 2, "right"},
      {4, 4, "bottom_right"}, {1, 4, "bottom"},     {-1, 4, "bottom_left"},
      {-1, 1, "left"},        {-1, -1, "top_left"},
  };
}

INSTANTIATE_TEST_SUITE_P(Bounds, PartiallyOutOfBoundsTest,
                         testing::ValuesIn(partiallyOutOfBoundsCases()),
                         [](const auto &info) {
                           return "partially_oob_" + info.param.position;
                         });

TEST_P(PartiallyOutOfBoundsTest, ShouldBeOutOfBounds) {
  const auto &[x, y, pos] = GetParam();
  const auto cells = makeTestCells();
  const auto mustTouch = makeTestMustTouch();
  const Block block(1, x, y, 2, 2, 2);
  EXPECT_FALSE(block.checkValidity(5, 5, cells, {}, mustTouch));
}

// -- In bounds --
class InBoundsTest : public testing::TestWithParam<BoundsTestParam> {};

static std::vector<BoundsTestParam> inBoundsCases() {
  return {
      {0, 0, "top_left"},    {1, 0, "top"},          {3, 0, "top_right"},
      {3, 1, "right"},       {3, 3, "bottom_right"}, {2, 3, "bottom"},
      {0, 3, "bottom_left"}, {0, 2, "left"},         {1, 1, "center"},
  };
}

INSTANTIATE_TEST_SUITE_P(Bounds, InBoundsTest,
                         testing::ValuesIn(inBoundsCases()),
                         [](const auto &info) {
                           return "in_bounds_" + info.param.position;
                         });

TEST_P(InBoundsTest, ShouldBeInBounds) {
  const auto &[x, y, pos] = GetParam();
  // Use regular cells so blocking-cells check passes, and empty satisfied
  // bitmask
  const Block block(1, x, y, 2, 2, 2);
  EXPECT_TRUE(block.checkValidity(5, 5, std::vector(25, Tile::Regular), {},
                                  boost::dynamic_bitset(25)));
}

// -- Block overlap --
struct OverlapTestParam {
  Block block1; // NOLINT: used via structured binding
  Block block2; // NOLINT: used via structured binding
  std::string blockType;
};

class BlockOverlapTest : public testing::TestWithParam<OverlapTestParam> {};

static std::vector<OverlapTestParam> blockOverlapCases() {
  return {
      {Block(1, 1, 1, 3, 2, 1), Block(2, 1, 1, 1, 2, 3), "second_1x2_0"},
      {Block(1, 1, 1, 3, 2, 1), Block(2, 2, 1, 1, 2, 3), "second_1x2_1"},
      {Block(1, 1, 1, 3, 2, 1), Block(2, 3, 1, 1, 2, 3), "second_1x2_2"},
      {Block(1, 1, 1, 3, 2, 1), Block(2, 1, 2, 1, 2, 3), "second_1x2_3"},
      {Block(1, 1, 1, 3, 2, 1), Block(2, 2, 2, 1, 2, 3), "second_1x2_4"},
      {Block(1, 1, 1, 3, 2, 1), Block(2, 3, 2, 1, 2, 3), "second_1x2_5"},
      {Block(1, 1, 1, 3, 2, 1), Block(2, 1, 1, 1, 1, 1), "second_1x1_0"},
      {Block(1, 1, 1, 3, 2, 1), Block(2, 2, 1, 1, 1, 1), "second_1x1_1"},
      {Block(1, 1, 1, 3, 2, 1), Block(2, 3, 1, 1, 1, 1), "second_1x1_2"},
      {Block(1, 1, 1, 3, 2, 1), Block(2, 1, 2, 1, 1, 1), "second_1x1_3"},
      {Block(1, 1, 1, 3, 2, 1), Block(2, 2, 2, 1, 1, 1), "second_1x1_4"},
      {Block(1, 1, 1, 3, 2, 1), Block(2, 3, 2, 1, 1, 1), "second_1x1_5"},
      {Block(1, 0, 0, 1, 1, 1), Block(2, 0, 0, 1, 1, 1), "both_1x1_0"},
      {Block(1, 4, 0, 1, 1, 1), Block(2, 4, 0, 1, 1, 1), "both_1x1_1"},
      {Block(1, 4, 4, 1, 1, 1), Block(2, 4, 4, 1, 1, 1), "both_1x1_2"},
      {Block(1, 0, 4, 1, 1, 1), Block(2, 0, 4, 1, 1, 1), "both_1x1_3"},
      {Block(1, 0, 0, 3, 3, 3), Block(2, 0, 0, 3, 3, 3), "both_3x3_0"},
      {Block(1, 2, 0, 3, 3, 3), Block(2, 2, 0, 3, 3, 3), "both_3x3_1"},
      {Block(1, 2, 2, 3, 3, 3), Block(2, 2, 2, 3, 3, 3), "both_3x3_2"},
      {Block(1, 0, 2, 3, 3, 3), Block(2, 0, 2, 3, 3, 3), "both_3x3_3"},
      {Block(1, 1, 1, 1, 1, 1), Block(2, 0, 0, 3, 3, 3),
       "second_includes_first_0"},
      {Block(1, 3, 1, 1, 1, 1), Block(2, 2, 0, 3, 3, 3),
       "second_includes_first_1"},
      {Block(1, 3, 3, 1, 1, 1), Block(2, 2, 2, 3, 3, 3),
       "second_includes_first_2"},
      {Block(1, 1, 3, 1, 1, 1), Block(2, 0, 2, 3, 3, 3),
       "second_includes_first_3"},
      {Block(1, 0, 0, 3, 3, 3), Block(2, 1, 1, 1, 1, 1),
       "first_includes_second_0"},
      {Block(1, 2, 0, 3, 3, 3), Block(2, 3, 1, 1, 1, 1),
       "first_includes_second_1"},
      {Block(1, 2, 2, 3, 3, 3), Block(2, 3, 3, 1, 1, 1),
       "first_includes_second_2"},
      {Block(1, 0, 2, 3, 3, 3), Block(2, 1, 3, 1, 1, 1),
       "first_includes_second_3"},
  };
}

INSTANTIATE_TEST_SUITE_P(Collisions, BlockOverlapTest,
                         testing::ValuesIn(blockOverlapCases()),
                         [](const auto &info) { return info.param.blockType; });

TEST_P(BlockOverlapTest, ShouldOverlap) {
  const auto &[block1, block2, name] = GetParam();
  // Use regular cells so only collision check matters
  const std::vector blocks = {block1, block2};
  EXPECT_FALSE(block1.checkValidity(5, 5, std::vector(25, Tile::Regular),
                                    blocks, boost::dynamic_bitset(25)));
}

// -- Non-overlapping blocks --
TEST(BlockCollisions, NonOverlappingBorderBlocks) {
  const std::vector blocks = {
      Block(1, 0, 0, 4, 1, 1),
      Block(2, 4, 0, 1, 4, 1),
      Block(3, 1, 4, 4, 1, 1),
      Block(4, 0, 1, 1, 4, 1),
  };
  EXPECT_TRUE(blocks[0].checkValidity(5, 5, std::vector(25, Tile::Regular),
                                      blocks, boost::dynamic_bitset(25)));
}

TEST(BlockCollisions, NonOverlapping25Blocks) {
  std::vector<Block> blocks;
  uint8_t id = 1;
  for (int8_t y = 0; y < 5; y++) {
    for (int8_t x = 0; x < 5; x++) {
      blocks.emplace_back(id, x, y, 1, 1, 1);
      id++;
    }
  }
  // Check block at index 13 (id=14, position (3,2))
  EXPECT_TRUE(blocks[13].checkValidity(5, 5, std::vector(25, Tile::Regular),
                                       blocks, boost::dynamic_bitset(25)));
}

TEST(BlockCollisions, SingleBlockOnGrid) {
  const Block block(1, 1, 1, 2, 2, 2);
  const std::vector blocks = {block};
  EXPECT_TRUE(block.checkValidity(5, 5, std::vector(25, Tile::Regular), blocks,
                                  boost::dynamic_bitset(25)));
}

// -- Overlapping satisfied mustTouch cells --
struct MustTouchBlockParam {
  Block block; // NOLINT: used via structured binding
  std::string name;
};

class OverlappingSatisfiedMustTouchTest
    : public testing::TestWithParam<MustTouchBlockParam> {};

static std::vector<MustTouchBlockParam> overlappingSatisfiedMustTouchCases() {
  return {
      {Block(1, 0, 0, 2, 2, 2), "0_0"},    {Block(1, 2, 1, 2, 2, 2), "2_1"},
      {Block(1, 3, 2, 2, 2, 2), "3_2"},    {Block(1, 2, 3, 2, 2, 2), "2_3"},
      {Block(1, 1, 2, 2, 2, 2), "1_2"},    {Block(1, 2, 0, 3, 2, 2), "2_0_3w"},
      {Block(1, 0, 2, 2, 3, 2), "0_2_3d"}, {Block(1, 4, 4, 1, 1, 1), "4_4"},
  };
}

INSTANTIATE_TEST_SUITE_P(
    MustTouch, OverlappingSatisfiedMustTouchTest,
    testing::ValuesIn(overlappingSatisfiedMustTouchCases()),
    [](const auto &info) { return info.param.name; });

TEST_P(OverlappingSatisfiedMustTouchTest, ShouldFail) {
  const auto &[block, name] = GetParam();
  const auto cells = makeTestCells();
  const auto mustTouch = makeTestMustTouch();
  EXPECT_FALSE(block.checkValidity(5, 5, cells, {}, mustTouch));
}

// -- Non-overlapping satisfied mustTouch cells --
class NonOverlappingSatisfiedMustTouchTest
    : public testing::TestWithParam<MustTouchBlockParam> {};

static std::vector<MustTouchBlockParam>
nonOverlappingSatisfiedMustTouchCases() {
  return {
      {Block(1, 0, 2, 2, 2, 2), "0_2"},
      {Block(1, 2, 0, 2, 2, 2), "2_0"},
      {Block(1, 1, 4, 3, 1, 1), "1_4_3w"},
      {Block(1, 4, 1, 1, 3, 1), "4_1_3d"},
  };
}

INSTANTIATE_TEST_SUITE_P(
    MustTouch, NonOverlappingSatisfiedMustTouchTest,
    testing::ValuesIn(nonOverlappingSatisfiedMustTouchCases()),
    [](const auto &info) { return info.param.name; });

TEST_P(NonOverlappingSatisfiedMustTouchTest, ShouldPass) {
  const auto &[block, name] = GetParam();
  const auto cells = makeTestCells();
  const auto mustTouch = makeTestMustTouch();
  EXPECT_TRUE(block.checkValidity(5, 5, cells, {}, mustTouch));
}

// =========================================================================
// UpdateMustTouchCells tests
// =========================================================================

TEST(UpdateMustTouchCells, NoMustTouchCellsOnGrid) {
  const Block block(1, 1, 1, 1, 1, 1);
  const auto result = block.updateMustTouchCells(
      5, std::vector(25, Tile::Regular), boost::dynamic_bitset(25));
  EXPECT_EQ(result.count(), 0u);
}

TEST(UpdateMustTouchCells, BlockDoesNotOverlapMustTouch) {
  using enum Tile;
  const Block block(1, 1, 1, 1, 1, 1);
  std::vector cells(25, Regular);
  cells[0 + 0 * 5] = MustTouch; // (0,0)
  cells[4 + 4 * 5] = MustTouch; // (4,4)
  const auto result =
      block.updateMustTouchCells(5, cells, boost::dynamic_bitset(25));
  EXPECT_EQ(result.count(), 0u);
}

TEST(UpdateMustTouchCells, BlockOverlapsSomeMustTouch) {
  using enum Tile;
  const Block block(1, 1, 1, 2, 2, 2);
  std::vector cells(25, Regular);
  cells[1 + 1 * 5] = MustTouch; // (1,1) -> index 6
  cells[2 + 2 * 5] = MustTouch; // (2,2) -> index 12
  cells[3 + 3 * 5] = MustTouch; // (3,3) -> index 18
  const auto result =
      block.updateMustTouchCells(5, cells, boost::dynamic_bitset(25));
  // Block covers (1,1), (2,1), (1,2), (2,2)
  // MustTouch at (1,1)=index 6 and (2,2)=index 12 are within footprint
  // (3,3)=index 18 is NOT within footprint
  EXPECT_TRUE(result.test(6));
  EXPECT_TRUE(result.test(12));
  EXPECT_FALSE(result.test(18));
  EXPECT_EQ(result.count(), 2u);
}
