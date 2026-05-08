#pragma once

#include <cstdint>
#include <vector>
#include <boost/dynamic_bitset.hpp>

enum class Tile : uint8_t {
    Regular,
    MustTouch,
    Goal,
    Unplayable
};

enum class Direction : uint8_t {
    UP,
    RIGHT,
    DOWN,
    LEFT
};

struct Turn {
    uint8_t blockId;
    Direction direction;

    bool operator==(const Turn&) const = default;
};

inline uint16_t positionToIndex(int8_t x, int8_t y, uint8_t gridWidth) {
    return static_cast<uint16_t>(x + y * gridWidth);
}
