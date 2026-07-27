#pragma once

#include <cstdint>

struct GoalCluster {
  int8_t minX;
  int8_t maxX;
  int8_t minY;
  int8_t maxY;
  uint8_t width;
  uint8_t depth;
};
