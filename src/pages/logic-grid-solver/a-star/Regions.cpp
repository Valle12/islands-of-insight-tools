#include "Regions.h"

#include "Bitboard.h"
#include "Puzzle.h"
#include "Types.h"

#include <cstdint>
#include <vector>

namespace lg {
namespace {

/// Folds one cell's clue into the region it belongs to.
void absorbClue(Regions &regions, const Model &model, const int id,
                const int cell) {
  const int clueId = model.clueAt[slot(cell)];
  if (clueId < 0)
    return;
  regions.clues[slot(id)]++;
  const Clue &clue = model.puzzle.clues[slot(clueId)];
  if (clue.kind == kClueLetter) {
    regions.letters[slot(id)] |= uint32_t{1} << clue.value;
    return;
  }
  if (int &value = regions.areaValue[slot(id)]; value == 0)
    value = clue.value;
  else if (value != clue.value)
    value = kAreaConflict;
}

/// Queues every unlabelled orthogonal neighbour inside `set`. The bounds test
/// is on x and y rather than on membership: at a fixed row pitch, stepping off
/// the left edge lands on the previous row's right edge, which is in `set`
/// often enough to matter.
void pushNeighbours(const Bits &set, Regions &regions, std::vector<int> &stack,
                    const int cell, const int id) {
  const int x = columnOf(cell);
  const int y = rowOf(cell);
  for (const auto &[dx, dy] : kSteps) {
    const int nx = x + dx;
    const int ny = y + dy;
    if (nx < 0 || nx >= kStride || ny < 0 || ny >= kMaxSide)
      continue;
    const int next = cellIndex(nx, ny);
    if (!set.test(next) || regions.id[slot(next)] >= 0)
      continue;
    regions.id[slot(next)] = id;
    stack.push_back(next);
  }
}

} // namespace

Regions labelRegions(const Bits &set, const Model &model) {
  Regions regions;
  regions.id.fill(-1);
  std::vector<int> stack;

  for (int start = set.nextSet(0); start >= 0; start = set.nextSet(start + 1)) {
    if (regions.id[slot(start)] >= 0)
      continue;
    const int id = regions.count();
    regions.size.push_back(0);
    regions.areaValue.push_back(0);
    regions.letters.push_back(0);
    regions.clues.push_back(0);
    regions.id[slot(start)] = id;
    stack.push_back(start);
    while (!stack.empty()) {
      const int cell = stack.back();
      stack.pop_back();
      regions.size[slot(id)]++;
      absorbClue(regions, model, id, cell);
      pushNeighbours(set, regions, stack, cell, id);
    }
  }
  return regions;
}

} // namespace lg
