#pragma once

#include "Types.h"
#include <algorithm>
#include <cstdint>
#include <vector>

class Block {
public:
    uint8_t id;
    int8_t x;
    int8_t y;
    uint8_t width;
    uint8_t depth;
    uint8_t height;

    Block(uint8_t id, int8_t x, int8_t y, uint8_t width, uint8_t depth, uint8_t height)
        : id(id), x(x), y(y), width(width), depth(depth), height(height) {}

    bool operator==(const Block&) const = default;

    void roll(Direction direction) {
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

    [[nodiscard]] Block clone() const {
        return {id, x, y, width, depth, height};
    }

    [[nodiscard]] bool checkValidity(
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

    [[nodiscard]] boost::dynamic_bitset<> updateMustTouchCells(
        uint8_t gridWidth,
        const std::vector<Tile>& cells,
        boost::dynamic_bitset<> mustTouchCellsSatisfied
    ) const {
        for (int8_t cx = x; cx < x + static_cast<int8_t>(width); cx++) {
            for (int8_t cy = y; cy < y + static_cast<int8_t>(depth); cy++) {
                auto idx = positionToIndex(cx, cy, gridWidth);
                if (cells[idx] != Tile::MustTouch) continue;
                if (idx < mustTouchCellsSatisfied.size()) {
                    mustTouchCellsSatisfied.set(idx);
                }
            }
        }
        return mustTouchCellsSatisfied;
    }

private:
    [[nodiscard]] bool checkOutOfBounds(uint8_t gridWidth, uint8_t gridHeight) const {
        return !(x < 0 || x + width > gridWidth || y < 0 || y + depth > gridHeight);
    }

    [[nodiscard]] bool checkBlockCollisions(const std::vector<Block>& blocks) const {
        for (const auto& block : blocks) {
            if (id == block.id) continue;
            for (int8_t cx = x; cx < x + static_cast<int8_t>(width); cx++) {
                for (int8_t cy = y; cy < y + static_cast<int8_t>(depth); cy++) {
                    if (cx >= block.x && cx < block.x + static_cast<int8_t>(block.width) &&
                        cy >= block.y && cy < block.y + static_cast<int8_t>(block.depth)) {
                        return false;
                    }
                }
            }
        }
        return true;
    }

    [[nodiscard]] bool checkBlockingCells(
        uint8_t gridWidth,
        const std::vector<Tile>& cells,
        const boost::dynamic_bitset<>& mustTouchCellsSatisfied
    ) const {
        for (int8_t cx = x; cx < x + static_cast<int8_t>(width); cx++) {
            for (int8_t cy = y; cy < y + static_cast<int8_t>(depth); cy++) {
                auto idx = positionToIndex(cx, cy, gridWidth);
                if (idx >= cells.size()) return false;
                if (cells[idx] == Tile::Unplayable) return false;
                if (cells[idx] == Tile::MustTouch) {
                    if (idx < mustTouchCellsSatisfied.size() && mustTouchCellsSatisfied.test(idx)) {
                        return false;
                    }
                }
            }
        }
        return true;
    }
};
