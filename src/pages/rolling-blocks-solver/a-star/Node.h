#pragma once

#include "Block.h"
#include <boost/dynamic_bitset.hpp>
#include <vector>

struct Node {
  std::vector<Block> blocks;
  boost::dynamic_bitset<> mustTouchCellsSatisfied;

  explicit Node(std::vector<Block> blocksIn,
                boost::dynamic_bitset<> mustTouchCellsSatisfiedIn = {})
      : blocks(std::move(blocksIn)),
        mustTouchCellsSatisfied(std::move(mustTouchCellsSatisfiedIn)) {}

  // boost::dynamic_bitset is generic over allocators, so it does not mark its
  // move operations noexcept. That made Node's implicit move potentially
  // throwing, which means every relocation COPIES the bitset rather than
  // stealing it. With the default allocator the move is a std::vector move and
  // cannot throw, so spelling these noexcept is safe and restores the move.
  Node(const Node &) = default;
  Node &operator=(const Node &) = default;
  Node(Node &&) noexcept = default;
  Node &operator=(Node &&) noexcept = default;
  ~Node() = default;
};
