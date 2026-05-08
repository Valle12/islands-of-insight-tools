#pragma once

#include "Block.h"
#include <vector>
#include <boost/dynamic_bitset.hpp>

struct Node {
    std::vector<Block> blocks;
    boost::dynamic_bitset<> mustTouchCellsSatisfied;

    Node(std::vector<Block> blocks, boost::dynamic_bitset<> mustTouchCellsSatisfied = {})
        : blocks(std::move(blocks)), mustTouchCellsSatisfied(std::move(mustTouchCellsSatisfied)) {}
};
