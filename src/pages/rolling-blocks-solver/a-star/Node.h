#pragma once

#include "Block.h"
#include <boost/dynamic_bitset.hpp>
#include <vector>

struct Node {
  std::vector<Block> blocks;
  boost::dynamic_bitset<> mustTouchCellsSatisfied;

  explicit Node(std::vector<Block> blocks,
                boost::dynamic_bitset<> mustTouchCellsSatisfied = {})
      : blocks(std::move(blocks)),
        mustTouchCellsSatisfied(std::move(mustTouchCellsSatisfied)) {}
};
