#pragma once

#include <array>
#include <cstdint>
#include <utility>

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

// Visit a cell's 4-neighbourhood, clipped to the grid — the one copy of the
// dx/dy boilerplate every board scan otherwise re-spells.
template <typename Visit>
void forEachNeighbor(const int width, const int height, const uint16_t idx,
                     const Visit &visit) {
  const int cx = idx % width;
  const int cy = idx / width;
  constexpr std::array kSteps = {std::pair{1, 0}, std::pair{-1, 0},
                                 std::pair{0, 1}, std::pair{0, -1}};
  for (const auto &[dx, dy] : kSteps) {
    const int nx = cx + dx;
    const int ny = cy + dy;
    if (nx < 0 || nx >= width || ny < 0 || ny >= height) {
      continue;
    }
    visit(static_cast<uint16_t>(nx + ny * width));
  }
}
