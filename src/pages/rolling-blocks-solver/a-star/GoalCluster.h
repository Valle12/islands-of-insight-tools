#pragma once

#include <cstdint>

struct GoalCluster {
    int8_t minX, maxX, minY, maxY;
    uint8_t width, depth;
};
