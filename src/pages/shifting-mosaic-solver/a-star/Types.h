#pragma once

#include <cstdint>

enum class Direction : uint8_t { UP, RIGHT, DOWN, LEFT };

struct Position {
  int8_t x;
  int8_t y;
  bool operator==(const Position &) const = default;
};

struct Turn {
  uint8_t blockId;
  Direction direction;
  bool operator==(const Turn &) const = default;
};
