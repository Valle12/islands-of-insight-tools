#pragma once

#include "Types.h"

#include <algorithm>
#include <cstdint>
#include <vector>

// Row-bitboard board model for grids up to 64 columns wide: one uint64_t per
// row, bit c = column c occupied. Shape cells are precomputed as row masks
// relative to the block's anchor, so a collision test for block i anchored at
// (x, y) is boxHeight(i) shift-AND operations.
//
// Also provides the per-block anchor flood fill that defines a "drag": the
// set of anchors block i can reach by 4-directional unit slides while every
// other block stays fixed. Scratch arrays are epoch-stamped so repeated fills
// don't pay a clear.
//
// Coordinates follow the solver convention: x = column, y = row (down = +y),
// anchor index = x * gridHeight + y.
class BitGrid {
public:
  BitGrid(const uint8_t gridWidth, const uint8_t gridHeight,
          const std::vector<std::vector<Position>> &shapes)
      : w_(gridWidth), h_(gridHeight), occ_(gridHeight, 0),
        epoch_(static_cast<size_t>(gridWidth) * gridHeight, 0),
        dist_(epoch_.size(), 0), parentDir_(epoch_.size(), -1) {
    shapeRows_.reserve(shapes.size());
    boxW_.reserve(shapes.size());
    boxH_.reserve(shapes.size());
    for (const auto &shape : shapes) {
      uint8_t maxX = 0;
      uint8_t maxY = 0;
      for (const auto &[cx, cy] : shape) {
        if (cx > static_cast<int8_t>(maxX))
          maxX = static_cast<uint8_t>(cx);
        if (cy > static_cast<int8_t>(maxY))
          maxY = static_cast<uint8_t>(cy);
      }
      boxW_.push_back(maxX + 1);
      boxH_.push_back(maxY + 1);
      std::vector<uint64_t> rows(maxY + 1, 0);
      for (const auto &[cx, cy] : shape)
        rows[cy] |= uint64_t{1} << static_cast<unsigned>(cx);
      shapeRows_.push_back(std::move(rows));
    }
  }

  [[nodiscard]] uint8_t width() const { return w_; }
  [[nodiscard]] uint8_t height() const { return h_; }
  [[nodiscard]] uint8_t boxWidth(const uint8_t i) const { return boxW_[i]; }
  [[nodiscard]] uint8_t boxHeight(const uint8_t i) const { return boxH_[i]; }
  [[nodiscard]] const std::vector<uint64_t> &shapeRows(const uint8_t i) const {
    return shapeRows_[i];
  }
  [[nodiscard]] uint16_t anchorIndex(const Position a) const {
    return static_cast<uint16_t>(a.x * h_ + a.y);
  }
  [[nodiscard]] Position anchorFromIndex(const uint16_t idx) const {
    return {.x = static_cast<int8_t>(idx / h_),
            .y = static_cast<int8_t>(idx % h_)};
  }

  void clearOccupancy() { std::ranges::fill(occ_, 0); }

  void buildOccupancy(const std::vector<Position> &anchors) {
    clearOccupancy();
    for (size_t i = 0; i < anchors.size(); i++)
      addBlock(static_cast<uint8_t>(i), anchors[i]);
  }

  void addBlock(const uint8_t i, const Position a) {
    const auto &rows = shapeRows_[i];
    for (size_t r = 0; r < rows.size(); r++)
      occ_[a.y + r] |= rows[r] << static_cast<unsigned>(a.x);
  }

  // Valid because blocks never overlap: every cell is set exactly once.
  void removeBlock(const uint8_t i, const Position a) {
    const auto &rows = shapeRows_[i];
    for (size_t r = 0; r < rows.size(); r++)
      occ_[a.y + r] ^= rows[r] << static_cast<unsigned>(a.x);
  }

  // Block i's bounding box must lie fully in-grid (same rule as
  // AStar::inBounds) and its cells must not hit the current occupancy.
  // Call with block i itself removed from the occupancy.
  [[nodiscard]] bool canPlace(const uint8_t i, const int x, const int y) const {
    if (x < 0 || y < 0 || x + boxW_[i] > w_ || y + boxH_[i] > h_)
      return false;
    const auto &rows = shapeRows_[i];
    for (size_t r = 0; r < rows.size(); r++)
      if (rows[r] << static_cast<unsigned>(x) & occ_[y + r])
        return false;
    return true;
  }

  // BFS over block i's anchor positions from `from`, against the current
  // occupancy (block i must have been removed first). Fills the scratch
  // dist/parentDir fields and returns the reached anchor indices, excluding
  // `from` itself. parentDir(idx) is the direction taken INTO idx.
  const std::vector<uint16_t> &floodFill(const uint8_t i, const Position from) {
    // Epoch stamping lets the scratch arrays skip a clear on every fill, but
    // the counter is finite: once it wraps, stale stamps from ~4 billion fills
    // ago compare equal to the current epoch and wasReached()/parentDirOf()
    // report visits this fill never made (DragSolver::reconstructTurns then
    // walks a stale parent chain, or reads DIRS[-1]). One long run reaches this
    // — the fuzz harness retries at --budget-ms 10800000 and there is roughly
    // one fill per expansion per movable block. Reset the stamps on wrap; it
    // costs one O(cells) clear per 2^32 fills.
    if (++curEpoch_ == 0) {
      std::ranges::fill(epoch_, 0);
      curEpoch_ = 1;
    }
    reached_.clear();
    queue_.clear();
    const uint16_t start = anchorIndex(from);
    epoch_[start] = curEpoch_;
    dist_[start] = 0;
    parentDir_[start] = -1;
    queue_.push_back(start);
    for (size_t head = 0; head < queue_.size(); head++) {
      const uint16_t cur = queue_[head];
      const int cx = cur / h_;
      const int cy = cur % h_;
      for (int d = 0; d < 4; d++) {
        const int nx = cx + DX[d];
        const int ny = cy + DY[d];
        if (!canPlace(i, nx, ny))
          continue;
        const auto nIdx = static_cast<uint16_t>(nx * h_ + ny);
        if (epoch_[nIdx] == curEpoch_)
          continue;
        epoch_[nIdx] = curEpoch_;
        dist_[nIdx] = static_cast<uint16_t>(dist_[cur] + 1);
        parentDir_[nIdx] = static_cast<int8_t>(d);
        queue_.push_back(nIdx);
        reached_.push_back(nIdx);
      }
    }
    return reached_;
  }

  [[nodiscard]] bool wasReached(const uint16_t idx) const {
    return epoch_[idx] == curEpoch_;
  }
  [[nodiscard]] uint16_t distTo(const uint16_t idx) const { return dist_[idx]; }
  [[nodiscard]] int8_t parentDirOf(const uint16_t idx) const {
    return parentDir_[idx];
  }

  static constexpr int8_t DX[4] = {0, 1, 0, -1};
  static constexpr int8_t DY[4] = {-1, 0, 1, 0};
  static constexpr Direction DIRS[4] = {Direction::UP, Direction::RIGHT,
                                        Direction::DOWN, Direction::LEFT};

private:
  uint8_t w_;
  uint8_t h_;
  std::vector<std::vector<uint64_t>> shapeRows_;
  std::vector<uint8_t> boxW_;
  std::vector<uint8_t> boxH_;
  std::vector<uint64_t> occ_;

  // Flood-fill scratch, epoch-stamped to skip clears between fills.
  std::vector<uint32_t> epoch_;
  std::vector<uint16_t> dist_;
  std::vector<int8_t> parentDir_;
  std::vector<uint16_t> queue_;
  std::vector<uint16_t> reached_;
  uint32_t curEpoch_ = 0;
};
