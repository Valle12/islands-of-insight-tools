// Memory-bounded beam search: level-synchronous best-f frontier capped at
// beamWidth states per depth. Incomplete by design — the trade for a hard
// bound on frontier growth on boards whose honest state space dwarfs the
// heap. States, parent links and path reconstruction reuse the exact A*
// machinery (StateTable entries never move), and a seeded jitter in the
// score's low bits lets portfolio arms run distinct beams.

#include "AStar.h"

#include "SolverClock.h"

#include <algorithm>
#include <array>
#include <iostream>
#include <vector>

namespace {

uint32_t mixHash(uint32_t h) {
  h ^= h >> 16;
  h *= 0x7feb352dU;
  h ^= h >> 15;
  h *= 0x846ca68bU;
  h ^= h >> 16;
  return h;
}

} // namespace

std::vector<Turn> AStar::searchBeam(Node root, uint32_t beamWidth) {
  const uint64_t startMs = nowMs();
  const uint64_t deadline = deadlineFrom(cfg_.maxMs);
  if (beamWidth == 0) {
    beamWidth = 50000;
  }

  boost::dynamic_bitset<> rootOrd;
  if (!prepareSearch(root, rootOrd)) {
    return {};
  }

  Table states;
  const NodeKey rootKey = encodeStateOrdinal(root.blocks, rootOrd);
  Table::Entry *rootEntry = states.emplace(rootKey).first;
  rootEntry->value.g = 0;
  if (isGoalState(root.blocks, rootOrd)) {
    return {};
  }

  constexpr std::array kDirs = {Direction::UP, Direction::RIGHT,
                                Direction::DOWN, Direction::LEFT};

  struct Cand {
    uint64_t score;
    Table::Entry *entry;
  };

  std::vector<Table::Entry *> beam = {rootEntry};
  std::vector<Cand> candidates;

  for (uint32_t depth = 1; !beam.empty(); depth++) {
    candidates.clear();
    for (Table::Entry  const*entry : beam) {
      decodeWorking(entry->key);

      stats_.nodesExpanded++;
      if ((stats_.nodesExpanded & 0x3FFU) == 0 &&
          budgetExhausted(deadline, states.size())) {
        stats_.statesStored = states.size();
        stats_.wallMs = static_cast<uint32_t>(nowMs() - startMs);
        std::cout << "Beam stopped on budget\n";
        return {};
      }
      if (onProgress && stats_.nodesExpanded % 10000 == 0) {
        onProgress(static_cast<uint32_t>(stats_.nodesExpanded));
      }

      for (size_t bi = 0; bi < curBlocks_.size(); bi++) {
        for (const auto dir : kDirs) {
          Block moved = curBlocks_[bi].clone();
          moved.roll(dir);
          if (!moved.checkValidity(gridWidth_, gridHeight_, cells_,
                                   curBlocks_, curBits_)) {
            continue;
          }
          const bool touchesNew = blockTouchesNewMustTouch(moved, curBits_);
          if (touchesNew) {
            childBitsBuf_ = curBits_;
            childOrdBuf_ = curOrd_;
            applyTouch(moved, childBitsBuf_, childOrdBuf_);
          }
          const auto &cellRef = touchesNew ? childBitsBuf_ : curBits_;
          const auto &ordRef = touchesNew ? childOrdBuf_ : curOrd_;
          if (!isReachable(curBlocks_, bi, moved, cellRef, ordRef)) {
            continue;
          }
          childBlocks_ = curBlocks_;
          childBlocks_[bi] = moved;
          const NodeKey childKey = encodeStateOrdinal(childBlocks_, ordRef);
          auto [child, inserted] = states.emplace(childKey);
          if (!inserted) {
            continue; // first arrival wins at equal depth; no reopening
          }
          child->value.g = depth;
          child->value.parent = &entry->value;
          child->value.fromX = static_cast<uint8_t>(curBlocks_[bi].x);
          child->value.fromY = static_cast<uint8_t>(curBlocks_[bi].y);
          child->value.dir = static_cast<uint8_t>(dir);
          child->value.flags = StateInfo::HasParentFlag;

          if (isGoalState(childBlocks_, ordRef)) {
            stats_.statesStored = states.size();
            stats_.wallMs = static_cast<uint32_t>(nowMs() - startMs);
            std::cout << "Beam found solution in " << depth
                      << " moves, expanded " << stats_.nodesExpanded
                      << " nodes\n";
            return reconstructPath(child->value);
          }

          const uint32_t h = heuristic(childBlocks_, cellRef, ordRef);
          const uint32_t f = depth + cfg_.weight * h;
          const uint32_t jitter =
              mixHash(static_cast<uint32_t>(NodeKeyHash{}(childKey)) ^
                      cfg_.seed) &
              0xFFFU;
          candidates.push_back(
              {.score = static_cast<uint64_t>(f) << 12 | jitter, .entry = child});
        }
      }
    }

    if (candidates.size() > beamWidth) {
      std::ranges::nth_element(candidates,
                               candidates.begin() +
                                   static_cast<ptrdiff_t>(beamWidth),
                               {}, &Cand::score);
      candidates.resize(beamWidth);
    }
    beam.clear();
    beam.reserve(candidates.size());
    for (const auto &cand : candidates) {
      beam.push_back(cand.entry);
    }
  }

  stats_.statesStored = states.size();
  stats_.wallMs = static_cast<uint32_t>(nowMs() - startMs);
  std::cout << "Beam exhausted without a solution\n";
  return {};
}
