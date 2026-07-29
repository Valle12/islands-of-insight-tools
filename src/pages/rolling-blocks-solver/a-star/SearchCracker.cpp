// The coverage cracker: depth-first search over rolls, tuned for the endgame
// class — must-touch-dominant boards where touched cells become walls. Best-
// first search structurally drowns there (the state space is positions x
// 2^mustTouch and the counting heuristics barely discriminate), while a
// depth-first walk that greedily touches fresh cells and prefers moves
// keeping the most onward options (Warnsdorff's rule) rides the puzzle's
// self-avoiding-path structure. Restarts follow a Luby schedule with a
// seeded ordering jitter, so a round that commits to a doomed prefix gets
// abandoned instead of exhausting the budget.

#include "AStar.h"

#include "SolverClock.h"

#include <algorithm>
#include <array>
#include <bit>
#include <cstdint>
#include <iostream>

namespace {

// Luby restart sequence (1-based): 1,1,2,1,1,2,4,1,1,2,1,1,2,4,8,...
uint64_t luby(uint64_t i) {
  for (;;) {
    const uint64_t p = std::bit_floor(i + 1);
    if (p == i + 1) {
      return p / 2;
    }
    i -= p - 1;
  }
}

uint32_t mixHash(uint32_t h) {
  h ^= h >> 16;
  h *= 0x7feb352dU;
  h ^= h >> 15;
  h *= 0x846ca68bU;
  h ^= h >> 16;
  return h;
}

} // namespace

std::vector<Turn> AStar::searchCracker(Node root) {
  const uint64_t startMs = nowMs();
  const uint64_t deadline = deadlineFrom(cfg_.maxMs);

  boost::dynamic_bitset<> rootOrd;
  if (!prepareSearch(root, rootOrd)) {
    return {};
  }

  struct ScoredMove {
    uint64_t order;
    uint8_t bi;
    Direction dir;
  };
  // Frames keep REAL-id block vectors, so the path is the answer directly —
  // no reconstruction, no canonical-identity headaches.
  struct Frame {
    std::vector<Block> blocks;
    boost::dynamic_bitset<> cells;
    boost::dynamic_bitset<> ord;
    std::vector<ScoredMove> moves;
    size_t next = 0;
  };

  constexpr std::array kDirs = {Direction::UP, Direction::RIGHT,
                                Direction::DOWN, Direction::LEFT};
  constexpr uint64_t kRoundBaseCap = 150000;

  // Cheap onward-mobility count for Warnsdorff ordering: how many rolls the
  // moved block could take next, ignoring other blocks.
  const auto onwardOptions = [&](const Block &moved,
                                 const boost::dynamic_bitset<> &cellBits) {
    uint32_t options = 0;
    for (const auto dir : kDirs) {
      Block next = moved.clone();
      next.roll(dir);
      if (next.x < 0 || next.y < 0 || next.x + next.width > gridWidth_ ||
          next.y + next.depth > gridHeight_) {
        continue;
      }
      bool blocked = false;
      for (int8_t cx = next.x;
           !blocked && cx < next.x + static_cast<int8_t>(next.width); cx++) {
        for (int8_t cy = next.y;
             cy < next.y + static_cast<int8_t>(next.depth); cy++) {
          const auto idx = positionToIndex(cx, cy, gridWidth_);
          if (cells_[idx] == Tile::Unplayable ||
              (cells_[idx] == Tile::MustTouch && cellBits.test(idx))) {
            blocked = true;
            break;
          }
        }
      }
      if (!blocked) {
        options++;
      }
    }
    return options;
  };

  const auto touchedCount = [&](const Block &moved,
                                const boost::dynamic_bitset<> &cellBits) {
    uint32_t touched = 0;
    for (int8_t cx = moved.x; cx < moved.x + static_cast<int8_t>(moved.width);
         cx++) {
      for (int8_t cy = moved.y;
           cy < moved.y + static_cast<int8_t>(moved.depth); cy++) {
        if (const auto idx = positionToIndex(cx, cy, gridWidth_);
            cells_[idx] == Tile::MustTouch && !cellBits.test(idx)) {
          touched++;
        }
      }
    }
    return touched;
  };

  for (uint64_t round = 1;; round++) {
    if (budgetExhausted(deadline, 0)) {
      break;
    }
    const uint64_t roundCap =
        stats_.nodesExpanded + kRoundBaseCap * luby(round);
    const uint32_t roundSeed = cfg_.seed * 2654435761U + round;

    Table visited;
    std::vector<Frame> frames;
    std::vector<Turn> path;

    Frame rootFrame{root.blocks, root.mustTouchCellsSatisfied, rootOrd, {}, 0};
    visited.emplace(encodeStateOrdinal(rootFrame.blocks, rootFrame.ord));
    if (isGoalState(rootFrame.blocks, rootFrame.ord)) {
      return {};
    }
    frames.push_back(std::move(rootFrame));

    // Order a frame's candidate moves: most fresh touches first, then the
    // fewest onward options (finish corridors before they get walled off),
    // then a seeded jitter so restarts explore different tie orders.
    const auto scoreFrame = [&](Frame &frame) {
      frame.moves.clear();
      for (size_t bi = 0; bi < frame.blocks.size(); bi++) {
        for (const auto dir : kDirs) {
          Block moved = frame.blocks[bi].clone();
          moved.roll(dir);
          if (!moved.checkValidity(gridWidth_, gridHeight_, cells_,
                                   frame.blocks, frame.cells)) {
            continue;
          }
          const uint32_t touched = touchedCount(moved, frame.cells);
          const uint32_t onward = onwardOptions(moved, frame.cells);
          const uint32_t jitter = mixHash(
              roundSeed ^ static_cast<uint32_t>(moved.x) << 24 ^
              static_cast<uint32_t>(moved.y) << 16 ^
              static_cast<uint32_t>(bi) << 8 ^ static_cast<uint32_t>(dir));
          // Smaller sorts first: invert touches (footprints cap at 4096
          // cells), keep onward ascending.
          const uint64_t order =
              static_cast<uint64_t>(4096 - std::min(touched, 4096U)) << 40 |
              static_cast<uint64_t>(onward) << 32 | jitter;
          frame.moves.push_back({order, static_cast<uint8_t>(bi), dir});
        }
      }
      std::ranges::sort(frame.moves, {}, &ScoredMove::order);
    };
    scoreFrame(frames.back());

    bool roundExhausted = false;
    while (!frames.empty() && !roundExhausted) {
      Frame &frame = frames.back();
      if (frame.next >= frame.moves.size()) {
        frames.pop_back();
        if (!path.empty()) {
          path.pop_back();
        }
        continue;
      }
      const ScoredMove move = frame.moves[frame.next++];

      Frame child;
      child.blocks = frame.blocks;
      Block &moved = child.blocks[move.bi];
      moved.roll(move.dir);
      child.cells = frame.cells;
      child.ord = frame.ord;
      applyTouch(moved, child.cells, child.ord);

      if (!visited.emplace(encodeStateOrdinal(child.blocks, child.ord))
               .second) {
        continue;
      }
      if (!isReachable(frame.blocks, move.bi, moved, child.cells, child.ord)) {
        continue;
      }

      stats_.nodesExpanded++;
      if ((stats_.nodesExpanded & 0x3FFU) == 0 &&
          budgetExhausted(deadline, visited.size())) {
        roundExhausted = true;
        break;
      }
      if (onProgress && stats_.nodesExpanded % 10000 == 0) {
        onProgress(static_cast<uint32_t>(stats_.nodesExpanded));
      }

      path.push_back({frame.blocks[move.bi].id, move.dir});
      if (isGoalState(child.blocks, child.ord)) {
        stats_.statesStored = visited.size();
        stats_.wallMs = static_cast<uint32_t>(nowMs() - startMs);
        std::cout << "Cracker (round " << round << ") found solution in "
                  << path.size() << " moves, expanded " << stats_.nodesExpanded
                  << " nodes\n";
        return path;
      }
      scoreFrame(child);
      frames.push_back(std::move(child));

      if (stats_.nodesExpanded >= roundCap) {
        roundExhausted = true;
      }
    }

    stats_.statesStored = visited.size();
    if (!roundExhausted) {
      // The whole reachable space under this ordering is exhausted; more
      // rounds would only reshuffle it.
      break;
    }
  }

  stats_.wallMs = static_cast<uint32_t>(nowMs() - startMs);
  std::cout << "Cracker found no solution\n";
  return {};
}
