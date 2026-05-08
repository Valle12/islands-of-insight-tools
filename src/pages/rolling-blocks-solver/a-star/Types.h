#pragma once

#include <cstdint>

enum class Tile : uint8_t { Regular, MustTouch, Goal, Unplayable };

enum class Direction : uint8_t { UP, RIGHT, DOWN, LEFT };

struct Turn {
  uint8_t blockId;
  Direction direction;

  bool operator==(const Turn &) const = default;
};

inline uint16_t positionToIndex(const int8_t x, const int8_t y,
                                const uint8_t gridWidth) {
  return static_cast<uint16_t>(x + y * gridWidth);
}
