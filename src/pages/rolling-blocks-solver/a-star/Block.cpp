#include "Block.h"
#include <algorithm>

Block::Block(uint8_t id, int8_t x, int8_t y, uint8_t width, uint8_t depth, uint8_t height)
    : id(id), x(x), y(y), width(width), depth(depth), height(height) {}

void Block::roll(Direction direction) {
    switch (direction) {
        case Direction::UP:
            y -= static_cast<int8_t>(height);
            std::swap(depth, height);
            break;
        case Direction::RIGHT:
            x += static_cast<int8_t>(width);
            std::swap(width, height);
            break;
        case Direction::DOWN:
            y += static_cast<int8_t>(depth);
            std::swap(depth, height);
            break;
        case Direction::LEFT:
            x -= static_cast<int8_t>(height);
            std::swap(width, height);
            break;
    }
}

Block Block::clone() const {
    return {id, x, y, width, depth, height};
}

bool Block::checkValidity(
    uint8_t gridWidth,
    uint8_t gridHeight,
    const std::vector<Tile>& cells,
    const std::vector<Block>& blocks,
    const boost::dynamic_bitset<>& mustTouchCellsSatisfied
) const {
    return checkOutOfBounds(gridWidth, gridHeight)
        && checkBlockCollisions(blocks)
        && checkBlockingCells(gridWidth, cells, mustTouchCellsSatisfied);
}

boost::dynamic_bitset<> Block::updateMustTouchCells(
    uint8_t gridWidth,
    const std::vector<Tile>& cells,
    boost::dynamic_bitset<> mustTouchCellsSatisfied
) const {
    for (int8_t cx = x; cx < x + static_cast<int8_t>(width); cx++) {
        for (int8_t cy = y; cy < y + static_cast<int8_t>(depth); cy++) {
            auto idx = positionToIndex(cx, cy, gridWidth);
            if (cells[idx] == Tile::MustTouch && idx < mustTouchCellsSatisfied.size())
                mustTouchCellsSatisfied.set(idx);
        }
    }
    return mustTouchCellsSatisfied;
}

bool Block::checkOutOfBounds(uint8_t gridWidth, uint8_t gridHeight) const {
    return !(x < 0 || x + width > gridWidth || y < 0 || y + depth > gridHeight);
}

bool Block::checkBlockCollisions(const std::vector<Block>& blocks) const {
    for (const auto& block : blocks) {
        if (id == block.id) continue;
        if (x + static_cast<int8_t>(width) <= block.x || block.x + static_cast<int8_t>(block.width) <= x ||
            y + static_cast<int8_t>(depth) <= block.y || block.y + static_cast<int8_t>(block.depth) <= y)
            continue;
        return false;
    }
    return true;
}

bool Block::checkBlockingCells(
    uint8_t gridWidth,
    const std::vector<Tile>& cells,
    const boost::dynamic_bitset<>& mustTouchCellsSatisfied
) const {
    for (int8_t cx = x; cx < x + static_cast<int8_t>(width); cx++) {
        for (int8_t cy = y; cy < y + static_cast<int8_t>(depth); cy++) {
            auto idx = positionToIndex(cx, cy, gridWidth);
            if (idx >= cells.size()) return false;
            if (cells[idx] == Tile::Unplayable) return false;
            if (cells[idx] == Tile::MustTouch &&
                idx < mustTouchCellsSatisfied.size() && mustTouchCellsSatisfied.test(idx))
                return false;
        }
    }
    return true;
}
