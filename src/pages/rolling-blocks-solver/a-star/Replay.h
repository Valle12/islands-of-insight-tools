#pragma once

#include "Block.h"

#include <vector>

// Solution replay: the single validity oracle shared by the gtest suite, the
// CLI's --verify, the wasm bindings' post-processing and (later) the full
// optimizer. A solution is judged by replaying it move by move against the
// real game rules — never by trusting whatever search produced it.
namespace replay {

struct Puzzle {
  uint8_t gridWidth = 0;
  uint8_t gridHeight = 0;
  std::vector<Tile> cells; // flat, x + y * gridWidth
  std::vector<Block> blocks;
};

struct Outcome {
  // Every referenced block exists and every roll was legal.
  bool legal = false;
  // The state AFTER the final turn satisfies every must-touch cell and covers
  // every goal cell exactly (distinct-cell check, not the engine's footprint
  // sum — an independent oracle).
  bool solvedAtEnd = false;
  // Earliest prefix length whose state already solves, or SIZE_MAX if none
  // does. 0 means the start state is already solved.
  size_t firstSolvedAt = SIZE_MAX;
};

Outcome replayTurns(const Puzzle &puzzle, const std::vector<Turn> &turns);

// Replays turns from the start and hands back the resulting position:
// blocks after every roll plus the satisfied set. Returns false (leaving the
// outputs unspecified) if any move is illegal.
bool applyTurns(const Puzzle &puzzle, const std::vector<Turn> &turns,
                std::vector<Block> &blocksOut,
                boost::dynamic_bitset<> &satisfiedOut);

// Post-processing stub until the full optimizer lands: cut the solution at
// its earliest solving prefix. Returns the input unchanged when it never
// solves or is already minimal-length in that sense.
std::vector<Turn> truncateToEarliestSolve(const Puzzle &puzzle,
                                          const std::vector<Turn> &turns);

} // namespace replay
