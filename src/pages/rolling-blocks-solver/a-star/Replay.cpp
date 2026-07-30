#include "Replay.h"

#include <algorithm>

namespace {

// A block counts towards goal coverage only if its WHOLE footprint is on goal
// tiles — a block half on a goal contributes nothing.
bool footprintAllGoal(const replay::Puzzle &puzzle, const Block &block) {
  const uint8_t w = puzzle.gridWidth;
  for (int8_t cx = block.x; cx < block.x + static_cast<int8_t>(block.width);
       cx++) {
    for (int8_t cy = block.y; cy < block.y + static_cast<int8_t>(block.depth);
         cy++) {
      if (puzzle.cells[positionToIndex(cx, cy, w)] != Tile::Goal) {
        return false;
      }
    }
  }
  return true;
}

void markFootprint(const replay::Puzzle &puzzle, const Block &block,
                   boost::dynamic_bitset<> &covered) {
  const uint8_t w = puzzle.gridWidth;
  for (int8_t cx = block.x; cx < block.x + static_cast<int8_t>(block.width);
       cx++) {
    for (int8_t cy = block.y; cy < block.y + static_cast<int8_t>(block.depth);
         cy++) {
      covered.set(positionToIndex(cx, cy, w));
    }
  }
}

// Strict solved test: all must-touch cells satisfied AND the set of goal
// cells under fully-on-goal blocks is every goal cell.
bool isSolved(const replay::Puzzle &puzzle, const std::vector<Block> &blocks,
              const boost::dynamic_bitset<> &satisfied) {
  size_t goalCells = 0;
  for (size_t i = 0; i < puzzle.cells.size(); i++) {
    if (puzzle.cells[i] == Tile::MustTouch && !satisfied.test(i)) {
      return false;
    }
    if (puzzle.cells[i] == Tile::Goal) {
      goalCells++;
    }
  }
  if (goalCells == 0) {
    return true;
  }
  boost::dynamic_bitset covered(puzzle.cells.size());
  for (const auto &block : blocks) {
    if (footprintAllGoal(puzzle, block)) {
      markFootprint(puzzle, block, covered);
    }
  }
  return covered.count() == goalCells;
}

} // namespace

namespace replay {

Outcome replayTurns(const Puzzle &puzzle, const std::vector<Turn> &turns) {
  Outcome outcome;
  std::vector<Block> blocks = puzzle.blocks;
  boost::dynamic_bitset satisfied(puzzle.cells.size());
  for (const auto &block : blocks) {
    satisfied =
        block.updateMustTouchCells(puzzle.gridWidth, puzzle.cells, satisfied);
  }

  if (isSolved(puzzle, blocks, satisfied)) {
    outcome.firstSolvedAt = 0;
  }

  for (size_t i = 0; i < turns.size(); i++) {
    const auto it = std::ranges::find_if(blocks, [&](const Block &b) {
      return b.id == turns[i].blockId;
    });
    if (it == blocks.end()) {
      return outcome; // legal stays false
    }
    it->roll(turns[i].direction);
    if (!it->checkValidity(puzzle.gridWidth, puzzle.gridHeight, puzzle.cells,
                           blocks, satisfied)) {
      return outcome;
    }
    satisfied =
        it->updateMustTouchCells(puzzle.gridWidth, puzzle.cells, satisfied);
    if (outcome.firstSolvedAt == SIZE_MAX &&
        isSolved(puzzle, blocks, satisfied)) {
      outcome.firstSolvedAt = i + 1;
    }
  }

  outcome.legal = true;
  outcome.solvedAtEnd = isSolved(puzzle, blocks, satisfied);
  return outcome;
}

bool applyTurns(const Puzzle &puzzle, const std::vector<Turn> &turns,
                std::vector<Block> &blocksOut,
                boost::dynamic_bitset<> &satisfiedOut) {
  blocksOut = puzzle.blocks;
  satisfiedOut.resize(puzzle.cells.size());
  satisfiedOut.reset();
  for (const auto &block : blocksOut) {
    satisfiedOut = block.updateMustTouchCells(puzzle.gridWidth, puzzle.cells,
                                              satisfiedOut);
  }
  for (const auto &[blockId, direction] : turns) {
    const auto it = std::ranges::find_if(blocksOut, [&](const Block &b) {
      return b.id == blockId;
    });
    if (it == blocksOut.end()) {
      return false;
    }
    it->roll(direction);
    if (!it->checkValidity(puzzle.gridWidth, puzzle.gridHeight, puzzle.cells,
                           blocksOut, satisfiedOut)) {
      return false;
    }
    satisfiedOut =
        it->updateMustTouchCells(puzzle.gridWidth, puzzle.cells, satisfiedOut);
  }
  return true;
}

std::vector<Turn> truncateToEarliestSolve(const Puzzle &puzzle,
                                          const std::vector<Turn> &turns) {
  const auto [legal, solvedAtEnd, firstSolvedAt] = replayTurns(puzzle, turns);
  if (!legal || firstSolvedAt == SIZE_MAX || firstSolvedAt >= turns.size()) {
    return turns;
  }
  return {turns.begin(), turns.begin() + static_cast<ptrdiff_t>(firstSolvedAt)};
}

} // namespace replay
