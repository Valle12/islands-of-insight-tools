#include "Reference.h"

#include "Bitboard.h"
#include "Puzzle.h"
#include "Types.h"
#include "Verify.h"

#include <cstdint>
#include <vector>

namespace lg::reference {
namespace {

/// Drops every cell the two colourings disagree on back to kUnknown, which is
/// the running intersection an underclued answer is made of.
void intersect(Colors &forced, const Colors &found, const std::vector<int> &cells) {
  for (const int index : cells) {
    if (forced[slot(index)] != found[slot(index)])
      forced[slot(index)] = kUnknown;
  }
}

void record(Answer &answer, const Colors &colors, const std::vector<int> &cells) {
  answer.solutionCount++;
  if (answer.solutionCount == 1) {
    answer.first = colors;
    answer.forced = colors;
    return;
  }
  intersect(answer.forced, colors, cells);
}

} // namespace

Answer enumerate(const Model &model) {
  Answer answer;

  // Cells already painted are givens, so they are not enumerated over — which
  // also means a fully painted board costs one verification.
  //
  // One bit per CELL, not per square: a merged cell takes one colour for all of
  // its squares, so enumerating them separately would spend almost the whole
  // space on colourings the puzzle cannot express, and `kMaxFreeCells` would
  // stop meaning what it says. The comparison set stays square-granular,
  // because that is what an answer is compared against.
  std::vector<int> playable;
  std::vector<Bits> free;
  Colors colors{};
  colors.fill(kUnplayable);
  for (int i = model.playable.nextSet(0); i >= 0;
       i = model.playable.nextSet(i + 1)) {
    colors[slot(i)] = model.puzzle.givens[slot(i)];
    playable.push_back(i);
  }
  for (int i = model.representatives.nextSet(0); i >= 0;
       i = model.representatives.nextSet(i + 1)) {
    // Validation has already established that a merged cell's squares agree
    // about their given, so the representative speaks for all of them.
    if (model.puzzle.givens[slot(i)] == kUnknown)
      free.push_back(model.cellMask(i));
  }

  if (free.size() > static_cast<size_t>(kMaxFreeCells))
    return answer;
  answer.ranToCompletion = true;
  answer.forced.fill(kUnplayable);

  const uint64_t total = uint64_t{1} << free.size();
  for (uint64_t code = 0; code < total; code++) {
    for (size_t bit = 0; bit < free.size(); bit++) {
      const uint8_t color = (code >> bit & 1U) != 0 ? kLight : kDark;
      const Bits &cell = free[bit];
      for (int i = cell.nextSet(0); i >= 0; i = cell.nextSet(i + 1))
        colors[slot(i)] = color;
    }
    if (verify::check(model, colors) == verify::Violation::None)
      record(answer, colors, playable);
  }
  return answer;
}

} // namespace lg::reference
