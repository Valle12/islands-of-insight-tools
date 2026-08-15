#include "Block.h"

#include <algorithm>

Block::Block(const uint8_t id, const int8_t x, const int8_t y,
             const uint8_t width, const uint8_t depth, const uint8_t height)
    : id(id), x(x), y(y), width(width), depth(depth), height(height) {}

void Block::roll(const Direction direction) {
  using enum Direction;
  switch (direction) {
  case UP:
    y = static_cast<int8_t>(y - height);
    std::swap(depth, height);
    break;
  case RIGHT:
    x = static_cast<int8_t>(x + width);
    std::swap(width, height);
    break;
  case DOWN:
    y = static_cast<int8_t>(y + depth);
    std::swap(depth, height);
    break;
  case LEFT:
    x = static_cast<int8_t>(x - height);
    std::swap(width, height);
    break;
  }
}

Block Block::clone() const { return {id, x, y, width, depth, height}; }

bool Block::checkValidity(
    const uint8_t gridWidth, const uint8_t gridHeight,
    const std::vector<Tile> &cells, const std::vector<Block> &blocks,
    const boost::dynamic_bitset<> &mustTouchCellsSatisfied) const {
  return checkOutOfBounds(gridWidth, gridHeight) &&
         checkBlockCollisions(blocks) &&
         checkBlockingCells(gridWidth, cells, mustTouchCellsSatisfied);
}

boost::dynamic_bitset<> Block::updateMustTouchCells(
    const uint8_t gridWidth, const std::vector<Tile> &cells,
    boost::dynamic_bitset<> mustTouchCellsSatisfied) const {
  for (int8_t cx = x; cx < x + static_cast<int8_t>(width); cx++) {
    for (int8_t cy = y; cy < y + static_cast<int8_t>(depth); cy++) {
      // Bounds FIRST, and against `cells` as well as the bitset. `&&` sequences
      // the range test AFTER the subscript, so the old spelling read
      // `cells[idx]` before deciding whether idx was on the board — and
      // `positionToIndex` casts to uint16_t, so an off-board block arrives as
      // ~65535. `checkBlockingCells` below already guards first, and it has to
      // be done here too: both seeding callers (Replay.cpp's satisfied mask and
      // AStar::prepareSearch) run before any validity check, and the exported
      // `verify` binding never runs one at all.
      const auto idx = positionToIndex(cx, cy, gridWidth);
      if (idx >= cells.size() || idx >= mustTouchCellsSatisfied.size())
        continue;
      if (cells[idx] == Tile::MustTouch)
        mustTouchCellsSatisfied.set(idx);
    }
  }
  return mustTouchCellsSatisfied;
}

bool Block::checkOutOfBounds(const uint8_t gridWidth,
                             const uint8_t gridHeight) const {
  return !(x < 0 || x + width > gridWidth || y < 0 || y + depth > gridHeight);
}

bool Block::checkBlockCollisions(const std::vector<Block> &blocks) const {
  return std::ranges::all_of(blocks, [this](const Block &block) {
    if (id == block.id)
      return true;
    return x + static_cast<int8_t>(width) <= block.x ||
           block.x + static_cast<int8_t>(block.width) <= x ||
           y + static_cast<int8_t>(depth) <= block.y ||
           block.y + static_cast<int8_t>(block.depth) <= y;
  });
}

bool Block::checkBlockingCells(
    const uint8_t gridWidth, const std::vector<Tile> &cells,
    const boost::dynamic_bitset<> &mustTouchCellsSatisfied) const {
  for (int8_t cx = x; cx < x + static_cast<int8_t>(width); cx++) {
    for (int8_t cy = y; cy < y + static_cast<int8_t>(depth); cy++) {
      const auto idx = positionToIndex(cx, cy, gridWidth);
      if (idx >= cells.size())
        return false;
      if (cells[idx] == Tile::Unplayable)
        return false;
      if (cells[idx] == Tile::MustTouch &&
          idx < mustTouchCellsSatisfied.size() &&
          mustTouchCellsSatisfied.test(idx))
        return false;
    }
  }
  return true;
}
