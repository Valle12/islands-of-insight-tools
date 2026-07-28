#pragma once

#include "Types.h"
#include <utility>
#include <vector>

struct Node {
  std::vector<Position> anchors;

  explicit Node(std::vector<Position> anchorsIn)
      : anchors(std::move(anchorsIn)) {}
};
