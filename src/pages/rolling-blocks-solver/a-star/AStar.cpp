// AStar: the search loop, state encode/decode, move expansion, budgets and
// reachability pruning.
//
// The state lives ONLY in its canonical NodeKey (sorted block records plus
// must-touch ordinal bits, see NodeKey.h); expansion decodes the popped key
// into reusable scratch. The heuristics and the goal-cluster machinery they
// score against live in AStarGoals.cpp.

#include "AStar.h"

#include "MemoryProbe.h"
#include "SolverClock.h"

#include <algorithm>
#include <array>
#include <cassert>
#include <iostream>

AStar::AStar(const uint8_t gridWidth, const uint8_t gridHeight,
             std::vector<Tile> cells, const uint8_t weight)
    : AStar(gridWidth, gridHeight, std::move(cells), Config{.weight = weight}) {
}

AStar::AStar(const uint8_t gridWidth, const uint8_t gridHeight,
             std::vector<Tile> cells, const Config &config)
    : gridWidth_(gridWidth), gridHeight_(gridHeight), cells_(std::move(cells)),
      cfg_(config) {
  goalClusters_ = precomputeGoalClusters();
  const size_t totalCells = static_cast<size_t>(gridWidth_) * gridHeight_;
  ordinalOfCell_.assign(totalCells, UINT16_MAX);
  for (int8_t x = 0; x < static_cast<int8_t>(gridWidth_); x++) {
    for (int8_t y = 0; y < static_cast<int8_t>(gridHeight_); y++) {
      const auto idx = positionToIndex(x, y, gridWidth_);
      if (cells_[idx] == Tile::MustTouch) {
        ordinalOfCell_[idx] = static_cast<uint16_t>(mustTouchIndices_.size());
        cellOfOrdinal_.push_back(idx);
        mustTouchIndices_.push_back({.x = x, .y = y, .index = idx});
      }
      if (cells_[idx] == Tile::Goal) {
        goalIndices_.push_back(idx);
      }
    }
  }
  mtBytes_ = static_cast<uint16_t>((mustTouchIndices_.size() + 7) / 8);
  curOrd_.resize(mustTouchIndices_.size());
  childOrdBuf_.resize(mustTouchIndices_.size());
  ordWords_.resize(curOrd_.num_blocks());
}

// ---------------------------------------------------------------------------
// Canonical state encoding
// ---------------------------------------------------------------------------
NodeKey AStar::encodeState(const std::vector<Block> &blocks,
                           const boost::dynamic_bitset<> &mustTouchCells) {
  // Pack each record into a uint64 with x in the most significant of the five
  // bytes, so a plain numeric sort IS the lexicographic (x,y,w,d,h) sort.
  encodeScratch_.clear();
  for (const auto &b : blocks) {
    encodeScratch_.push_back(static_cast<uint64_t>(static_cast<uint8_t>(b.x))
                                 << 32 |
                             static_cast<uint64_t>(static_cast<uint8_t>(b.y))
                                 << 24 |
                             static_cast<uint64_t>(b.width) << 16 |
                             static_cast<uint64_t>(b.depth) << 8 | b.height);
  }
  std::ranges::sort(encodeScratch_);

  NodeKey key(static_cast<uint16_t>(blocks.size() * 5 + mtBytes_));
  uint8_t *d = key.data();
  for (const uint64_t rec : encodeScratch_) {
    d[0] = static_cast<uint8_t>(rec >> 32);
    d[1] = static_cast<uint8_t>(rec >> 24);
    d[2] = static_cast<uint8_t>(rec >> 16);
    d[3] = static_cast<uint8_t>(rec >> 8);
    d[4] = static_cast<uint8_t>(rec);
    d += 5;
  }
  // d now points at the (zero-initialised) ordinal bit block.
  const size_t numOrdinals = cellOfOrdinal_.size();
  for (size_t k = 0; k < numOrdinals; k++) {
    if (mustTouchCells.test(cellOfOrdinal_[k])) {
      d[k >> 3] |= static_cast<uint8_t>(1u << (k & 7u));
    }
  }
  return key;
}

// Hot-path variant of encodeState: the search maintains the satisfied set in
// ordinal form alongside the cell form, so the key's bit block is a straight
// word copy here instead of a loop over every must-touch cell. Byte layout is
// identical to encodeState's on every target this builds for (little-endian
// wasm32 / x64), which the state-encoding tests pin down.
NodeKey AStar::encodeStateOrdinal(const std::vector<Block> &blocks,
                                  const boost::dynamic_bitset<> &ordinal) {
  encodeScratch_.clear();
  for (const auto &b : blocks) {
    encodeScratch_.push_back(static_cast<uint64_t>(static_cast<uint8_t>(b.x))
                                 << 32 |
                             static_cast<uint64_t>(static_cast<uint8_t>(b.y))
                                 << 24 |
                             static_cast<uint64_t>(b.width) << 16 |
                             static_cast<uint64_t>(b.depth) << 8 | b.height);
  }
  std::ranges::sort(encodeScratch_);

  NodeKey key(static_cast<uint16_t>(blocks.size() * 5 + mtBytes_));
  uint8_t *d = key.data();
  for (const uint64_t rec : encodeScratch_) {
    d[0] = static_cast<uint8_t>(rec >> 32);
    d[1] = static_cast<uint8_t>(rec >> 24);
    d[2] = static_cast<uint8_t>(rec >> 16);
    d[3] = static_cast<uint8_t>(rec >> 8);
    d[4] = static_cast<uint8_t>(rec);
    d += 5;
  }
  if (mtBytes_ > 0) {
    boost::to_block_range(ordinal, ordWords_.begin());
    std::memcpy(d, ordWords_.data(), mtBytes_);
  }
  return key;
}

// Decodes the popped key into ALL the working forms at once: blocks with slot
// ids, the cell-indexed satisfied set, and its ordinal mirror.
void AStar::decodeWorking(const NodeKey &key) {
  const size_t n = (static_cast<size_t>(key.len) - mtBytes_) / 5;
  curBlocks_.clear();
  const uint8_t *d = key.data();
  for (size_t i = 0; i < n; i++) {
    curBlocks_.emplace_back(static_cast<uint8_t>(i), static_cast<int8_t>(d[0]),
                            static_cast<int8_t>(d[1]), d[2], d[3], d[4]);
    d += 5;
  }
  const size_t totalCells = static_cast<size_t>(gridWidth_) * gridHeight_;
  curBits_.resize(totalCells);
  curBits_.reset();
  curOrd_.reset();
  const size_t numOrdinals = cellOfOrdinal_.size();
  for (size_t k = 0; k < numOrdinals; k++) {
    if (d[k >> 3] >> (k & 7u) & 1u) {
      curBits_.set(cellOfOrdinal_[k]);
      curOrd_.set(k);
    }
  }
}

// Marks every unsatisfied must-touch cell under the block's footprint in both
// working forms. The successor path uses this instead of Block::
// updateMustTouchCells, whose by-value-and-return shape costs an allocation
// per call and only maintains the cell form.
void AStar::applyTouch(const Block &block, boost::dynamic_bitset<> &cellBits,
                       boost::dynamic_bitset<> &ordinalBits) const {
  for (int8_t cx = block.x; cx < block.x + static_cast<int8_t>(block.width);
       cx++) {
    for (int8_t cy = block.y; cy < block.y + static_cast<int8_t>(block.depth);
         cy++) {
      if (const auto idx = positionToIndex(cx, cy, gridWidth_);
          cells_[idx] == Tile::MustTouch && !cellBits.test(idx)) {
        cellBits.set(idx);
        ordinalBits.set(ordinalOfCell_[idx]);
      }
    }
  }
}

void AStar::decodeState(const NodeKey &key, std::vector<Block> &blocks,
                        boost::dynamic_bitset<> &mustTouchCells) const {
  const size_t n = (static_cast<size_t>(key.len) - mtBytes_) / 5;
  blocks.clear();
  const uint8_t *d = key.data();
  for (size_t i = 0; i < n; i++) {
    blocks.emplace_back(static_cast<uint8_t>(i), static_cast<int8_t>(d[0]),
                        static_cast<int8_t>(d[1]), d[2], d[3], d[4]);
    d += 5;
  }
  const size_t totalCells = static_cast<size_t>(gridWidth_) * gridHeight_;
  mustTouchCells.resize(totalCells);
  mustTouchCells.reset();
  const size_t numOrdinals = cellOfOrdinal_.size();
  for (size_t k = 0; k < numOrdinals; k++) {
    if (d[k >> 3] >> (k & 7u) & 1u) {
      mustTouchCells.set(cellOfOrdinal_[k]);
    }
  }
}

// ---------------------------------------------------------------------------
// Helper: check if a moved block touches any new must-touch cell
// ---------------------------------------------------------------------------
bool AStar::blockTouchesNewMustTouch(
    const Block &block, const boost::dynamic_bitset<> &satisfied) const {
  for (int8_t cx = block.x; cx < block.x + static_cast<int8_t>(block.width);
       cx++) {
    for (int8_t cy = block.y; cy < block.y + static_cast<int8_t>(block.depth);
         cy++) {
      if (const auto idx = positionToIndex(cx, cy, gridWidth_);
          cells_[idx] == Tile::MustTouch && !satisfied.test(idx)) {
        return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Helper: try to expand a single neighbor in search
// ---------------------------------------------------------------------------
void AStar::expandNeighbor(const size_t bi, const Direction direction,
                           Table::Entry *curEntry, SearchContext &ctx) {
  Block newBlock = curBlocks_[bi].clone();
  newBlock.roll(direction);

  if (!newBlock.checkValidity(gridWidth_, gridHeight_, cells_, curBlocks_,
                              curBits_)) {
    return;
  }

  const bool touchesNew = blockTouchesNewMustTouch(newBlock, curBits_);
  if (touchesNew) {
    childBitsBuf_ = curBits_;
    childOrdBuf_ = curOrd_;
    applyTouch(newBlock, childBitsBuf_, childOrdBuf_);
  }
  const auto &mustTouchRef = touchesNew ? childBitsBuf_ : curBits_;
  const auto &ordinalRef = touchesNew ? childOrdBuf_ : curOrd_;

  if (!isReachable(curBlocks_, bi, newBlock, mustTouchRef, ordinalRef)) {
    return;
  }

  childBlocks_ = curBlocks_;
  childBlocks_[bi] = newBlock;
  const NodeKey newKey = encodeStateOrdinal(childBlocks_, ordinalRef);

  const uint32_t newG = curEntry->value.g + 1;
  auto [child, inserted] = ctx.states.emplace(newKey);
  if (!inserted && ((child->value.flags & StateInfo::ClosedFlag) != 0 ||
                    newG >= child->value.g)) {
    return;
  }

  child->value.g = newG;
  child->value.parent = &curEntry->value;
  child->value.fromX = static_cast<uint8_t>(curBlocks_[bi].x);
  child->value.fromY = static_cast<uint8_t>(curBlocks_[bi].y);
  child->value.dir = static_cast<uint8_t>(direction);
  child->value.flags = StateInfo::HasParentFlag;

  const uint32_t h = heuristic(childBlocks_, mustTouchRef, ordinalRef);
  ctx.openHeap.push({.f = newG + cfg_.weight * h, .g = newG, .entry = child});
}

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------
bool AStar::budgetExhausted(const uint64_t deadline,
                            const size_t statesStored) {
  if (cfg_.cancel != nullptr &&
      cfg_.cancel->load(std::memory_order_relaxed)) {
    return true;
  }
  if (deadline != 0 && nowMs() >= deadline) {
    return true;
  }
  if (cfg_.maxNodes != 0 && stats_.nodesExpanded >= cfg_.maxNodes) {
    return true;
  }
  if (cfg_.maxStatesStored != 0 && statesStored >= cfg_.maxStatesStored) {
    return true;
  }
#if defined(__EMSCRIPTEN__)
  // Off wasm nearHeapLimit() is a constant false; the guard keeps analysers
  // from (correctly) flagging the branch as dead code in native builds.
  if (memprobe::nearHeapLimit()) {
    stats_.stoppedOnMemory = true;
    return true;
  }
#endif
  if (cfg_.maxHeapBytes != 0) {
    // 0 from the probe means "cannot measure", not "no memory used".
    if (const uint64_t live = memprobe::liveAllocatedBytes();
        live != 0 && live >= cfg_.maxHeapBytes) {
      stats_.stoppedOnMemory = true;
      return true;
    }
  }
  return false;
}

bool AStar::searchLimitReached(const uint64_t deadline,
                               const SearchContext &ctx) {
  return budgetExhausted(deadline, ctx.states.size());
}

bool AStar::inputWithinCaps(const std::vector<Block> &blocks) const {
  if (gridWidth_ == 0 || gridWidth_ > MaxGridSide || gridHeight_ == 0 ||
      gridHeight_ > MaxGridSide) {
    return false;
  }
  if (blocks.empty() || blocks.size() > MaxBlocks) {
    return false;
  }
  return std::ranges::all_of(blocks, [](const Block &b) {
    return b.width >= 1 && b.width <= MaxBlockDim && b.depth >= 1 &&
           b.depth <= MaxBlockDim && b.height >= 1 && b.height <= MaxBlockDim;
  });
}

// ---------------------------------------------------------------------------
// Shared entry-point preparation
// ---------------------------------------------------------------------------
bool AStar::prepareSearch(Node &root, boost::dynamic_bitset<> &rootOrd) {
  stats_ = {};
  if (!inputWithinCaps(root.blocks)) {
    std::cout << "Input exceeds engine caps (grid <= 64x64, 1..255 blocks, "
                 "dims 1..64)\n";
    return false;
  }

  rootBlocks_ = root.blocks;
  prepareGoalTables(root.blocks);

  const size_t totalCells = static_cast<size_t>(gridWidth_) * gridHeight_;
  if (root.mustTouchCellsSatisfied.size() < totalCells) {
    root.mustTouchCellsSatisfied.resize(totalCells, false);
  }
  for (const auto &block : root.blocks) {
    root.mustTouchCellsSatisfied = block.updateMustTouchCells(
        gridWidth_, cells_, root.mustTouchCellsSatisfied);
  }

  rootOrd.resize(mustTouchIndices_.size());
  rootOrd.reset();
  for (size_t k = 0; k < cellOfOrdinal_.size(); k++) {
    if (root.mustTouchCellsSatisfied.test(cellOfOrdinal_[k])) {
      rootOrd.set(k);
    }
  }

  requiredCellBits_.resize(totalCells);
  requiredCellBits_.reset();
  requiredOrd_.resize(mustTouchIndices_.size());
  requiredOrd_.reset();
  requiredSubset_ = false;
  if (cfg_.requiredCells != nullptr) {
    for (const uint16_t cell : *cfg_.requiredCells) {
      if (cell < totalCells && cells_[cell] == Tile::MustTouch) {
        requiredCellBits_.set(cell);
        requiredOrd_.set(ordinalOfCell_[cell]);
      }
    }
    requiredSubset_ = requiredOrd_.any();
  }
  return true;
}

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------
std::vector<Turn> AStar::search(Node root) {
  const uint64_t startMs = nowMs();
  const uint64_t deadline = deadlineFrom(cfg_.maxMs);

  boost::dynamic_bitset<> rootOrd;
  if (!prepareSearch(root, rootOrd)) {
    return {};
  }

  SearchContext ctx;
  const NodeKey rootKey = encodeStateOrdinal(root.blocks, rootOrd);
  Table::Entry *rootEntry = ctx.states.emplace(rootKey).first;
  rootEntry->value.g = 0;

  ctx.openHeap.push(
      {.f = cfg_.weight *
           heuristic(root.blocks, root.mustTouchCellsSatisfied, rootOrd),
       .g = 0, .entry = rootEntry});

  constexpr std::array dirs = {Direction::UP, Direction::RIGHT, Direction::DOWN,
                               Direction::LEFT};

  while (!ctx.openHeap.empty()) {
    const HeapEntry current = ctx.openHeap.top();
    ctx.openHeap.pop();

    Table::Entry *entry = current.entry;
    if ((entry->value.flags & StateInfo::ClosedFlag) != 0 ||
        entry->value.g < current.g) {
      continue;
    }
    entry->value.flags |= StateInfo::ClosedFlag;

    decodeWorking(entry->key);

    if (isGoalState(curBlocks_, curOrd_)) {
      stats_.statesStored = ctx.states.size();
      stats_.wallMs = static_cast<uint32_t>(nowMs() - startMs);
      std::cout << "A* (w=" << static_cast<int>(cfg_.weight)
                << ") found solution in " << current.g << " moves, expanded "
                << stats_.nodesExpanded << " nodes, stored "
                << stats_.statesStored << " states\n";
      return reconstructPath(entry->value);
    }

    if ((stats_.nodesExpanded & 0x3FFu) == 0 &&
        searchLimitReached(deadline, ctx)) {
      break;
    }

    stats_.nodesExpanded++;
    if (onProgress && stats_.nodesExpanded % 10000 == 0) {
      onProgress(static_cast<uint32_t>(stats_.nodesExpanded));
    }

    for (size_t bi = 0; bi < curBlocks_.size(); bi++) {
      for (const auto direction : dirs) {
        expandNeighbor(bi, direction, entry, ctx);
      }
    }
  }

  stats_.statesStored = ctx.states.size();
  stats_.wallMs = static_cast<uint32_t>(nowMs() - startMs);
  std::cout << "No solution found\n";
  return {};
}

// ---------------------------------------------------------------------------
// Path reconstruction: parents give (fromX, fromY, dir); forward replay on the
// caller's real-id blocks turns those into {blockId, direction} moves.
// ---------------------------------------------------------------------------
std::vector<Turn> AStar::reconstructPath(const StateInfo &goalInfo) const {
  struct Step {
    uint8_t fromX;
    uint8_t fromY;
    Direction dir;
  };
  std::vector<Step> steps;
  for (const StateInfo *info = &goalInfo;
       (info->flags & StateInfo::HasParentFlag) != 0; info = info->parent) {
    steps.push_back(
        {.fromX = info->fromX,
         .fromY = info->fromY,
         .dir = static_cast<Direction>(info->dir)});
  }
  std::ranges::reverse(steps);

  std::vector<Turn> turns;
  turns.reserve(steps.size());
  std::vector<Block> blocks = rootBlocks_;
  for (const auto &[fromX, fromY, dir] : steps) {
    const auto it = std::ranges::find_if(blocks, [&](const Block &b) {
      return b.x == static_cast<int8_t>(fromX) &&
             b.y == static_cast<int8_t>(fromY);
    });
    // Anchors are unique per state (disjoint footprints), so exactly one
    // block can match a recorded pre-roll anchor.
    assert(it != blocks.end());
    turns.push_back({.blockId = it->id, .direction = dir});
    it->roll(dir);
  }
  return turns;
}

// ---------------------------------------------------------------------------
// Helper: mark a single block's footprint in reachability scratch
// ---------------------------------------------------------------------------
void AStar::seedBlockReachability(const Block &block) {
  for (int8_t cx = block.x; cx < block.x + static_cast<int8_t>(block.width);
       cx++) {
    for (int8_t cy = block.y; cy < block.y + static_cast<int8_t>(block.depth);
         cy++) {
      if (const auto idx = positionToIndex(cx, cy, gridWidth_);
          reachStamp_[idx] != reachEpoch_) {
        reachStamp_[idx] = reachEpoch_;
        reachStack_.push_back(idx);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helper: seed reachability scratch with block cells
// ---------------------------------------------------------------------------
void AStar::seedReachability(const std::vector<Block> &blocks,
                             const size_t replaceIdx,
                             const Block &replacement) {
  for (size_t i = 0; i < blocks.size(); i++) {
    const auto &block = i == replaceIdx ? replacement : blocks[i];
    seedBlockReachability(block);
  }
}

// ---------------------------------------------------------------------------
// Helper: flood-fill and count reachable unsatisfied must-touch cells.
// Depth-first on purpose: it typically collects every unsatisfied cell (the
// early-out) after visiting far fewer cells than a level-order sweep — a
// breadth-first variant that also recorded a nearest-unsatisfied distance
// was measured 15-43% slower on the fill-bound fixtures for no expansion
// savings.
// ---------------------------------------------------------------------------
bool AStar::floodFillReachable(
    const boost::dynamic_bitset<> &mustTouchSatisfied,
    const uint32_t totalUnsatisfied) {

  uint32_t reachableUnsatisfied = 0;
  while (!reachStack_.empty()) {
    const uint16_t idx = reachStack_.back();
    reachStack_.pop_back();

    if (cells_[idx] == Tile::MustTouch && !mustTouchSatisfied.test(idx) &&
        (!requiredSubset_ || requiredCellBits_.test(idx))) {
      ++reachableUnsatisfied;
      if (reachableUnsatisfied == totalUnsatisfied) {
        return true;
      }
    }

    const auto cx = static_cast<int8_t>(idx % gridWidth_);
    const auto cy = static_cast<int8_t>(idx / gridWidth_);
    for (int d = 0; d < 4; d++) {
      constexpr std::array<int8_t, 4> dy = {1, -1, 0, 0};
      constexpr std::array<int8_t, 4> dx = {0, 0, 1, -1};
      const auto nx = static_cast<int8_t>(cx + dx[d]);
      const auto ny = static_cast<int8_t>(cy + dy[d]);
      if (nx < 0 || nx >= gridWidth_ || ny < 0 || ny >= gridHeight_) {
        continue;
      }
      const auto nidx = positionToIndex(nx, ny, gridWidth_);
      if (reachStamp_[nidx] == reachEpoch_ ||
          cells_[nidx] == Tile::Unplayable) {
        continue;
      }
      if (cells_[nidx] == Tile::MustTouch && mustTouchSatisfied.test(nidx)) {
        continue;
      }
      reachStamp_[nidx] = reachEpoch_;
      reachStack_.push_back(nidx);
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// isReachable
// ---------------------------------------------------------------------------
bool AStar::isReachable(const std::vector<Block> &blocks,
                        const size_t replaceIdx, const Block &replacement,
                        const boost::dynamic_bitset<> &mustTouchSatisfied,
                        const boost::dynamic_bitset<> &ordinal) {
  if (mustTouchIndices_.empty()) {
    return true;
  }

  uint32_t totalUnsatisfied = 0;
  if (requiredSubset_) {
    // Required-subset legs only care whether the REQUIRED cells stay
    // reachable — other must-touch cells getting walled off is the partner
    // block's problem, not this leg's.
    totalUnsatisfied =
        static_cast<uint32_t>(requiredOrd_.count() -
                              (requiredOrd_ & ordinal).count());
  } else {
    totalUnsatisfied =
        static_cast<uint32_t>(mustTouchIndices_.size() - ordinal.count());
  }
  if (totalUnsatisfied == 0) {
    return true;
  }

  const size_t totalCells = static_cast<size_t>(gridWidth_) * gridHeight_;
  if (reachStamp_.size() != totalCells) {
    reachStamp_.assign(totalCells, 0);
    reachEpoch_ = 0;
  }
  ++reachEpoch_;
  if (reachEpoch_ == 0) {
    // Epoch wrap after 2^32 fills: stale stamps would compare equal again, so
    // pay one full clear and restart the epoch counter.
    std::ranges::fill(reachStamp_, 0);
    reachEpoch_ = 1;
  }
  reachStack_.clear();

  seedReachability(blocks, replaceIdx, replacement);
  return floodFillReachable(mustTouchSatisfied, totalUnsatisfied);
}
