#pragma once

#include "Types.h"
#include <boost/dynamic_bitset.hpp>
#include <vector>

class Block {
public:
  uint8_t id;
  int8_t x;
  int8_t y;
  uint8_t width;
  uint8_t depth;
  uint8_t height;

  Block(uint8_t id, int8_t x, int8_t y, uint8_t width, uint8_t depth,
        uint8_t height);

  bool operator==(const Block &) const = default;

  void roll(Direction direction);

  [[nodiscard]] Block clone() const;

  [[nodiscard]] bool
  checkValidity(uint8_t gridWidth, uint8_t gridHeight,
                const std::vector<Tile> &cells,
                const std::vector<Block> &blocks,
                const boost::dynamic_bitset<> &mustTouchCellsSatisfied) const;

  [[nodiscard]] boost::dynamic_bitset<>
  updateMustTouchCells(uint8_t gridWidth, const std::vector<Tile> &cells,
                       boost::dynamic_bitset<> mustTouchCellsSatisfied) const;

private:
  [[nodiscard]] bool checkOutOfBounds(uint8_t gridWidth,
                                      uint8_t gridHeight) const;
  [[nodiscard]] bool
  checkBlockCollisions(const std::vector<Block> &blocks) const;
  [[nodiscard]] bool checkBlockingCells(
      uint8_t gridWidth, const std::vector<Tile> &cells,
      const boost::dynamic_bitset<> &mustTouchCellsSatisfied) const;
};
