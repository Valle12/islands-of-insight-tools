#pragma once

#include "Bitboard.h"
#include "Puzzle.h"
#include "Types.h"

#include <array>
#include <cstdint>
#include <vector>

// The connected pieces of a set of cells, labelled in one pass, together with
// what each piece already commits to.
//
// The propagators keep asking the same three questions about the cells one
// colour definitely occupies — how big is this piece, does it carry an area
// number, does it carry a letter — and asking them with a flood fill per clue
// costs a fill per question. Labelling every piece once is O(cells) and
// answers all of them by lookup.
namespace lg {

/// An area value meaning "two clues in this piece disagree", which is a
/// contradiction rather than a size.
inline constexpr int kAreaConflict = -1;

struct Regions {
  /// Region id per cell, -1 for a cell outside the set.
  std::array<int, kMaxCells> id{};
  std::vector<int> size;
  /**
   * What the region's area clues agree the region's TRUE size could be, as
   * the exact candidate set's two ends: both 0 for no clue, `kAreaConflict`
   * in `areaHi` when the clues' sets intersect to nothing. With the rules as
   * they stand each clue offers one value and the ends coincide; under
   * `off-by-one` a clue offers its displayed value ± 1, and intersecting the
   * SETS is what makes two clues differing by exactly two share a region —
   * the game's off-by-2 trick — while equal clues keep both candidates open.
   */
  std::vector<int> areaLo;
  std::vector<int> areaHi;
  /// One bit per letter the region carries; more than one is a contradiction.
  std::vector<uint32_t> letters;
  /// How many clues of any kind sit in the region — what "one symbol per area"
  /// counts. Letters are counted per CELL here, not per letter, because two
  /// cells of the same letter are still two symbols.
  std::vector<int> clues;

  [[nodiscard]] int count() const { return static_cast<int>(size.size()); }
};

/// Labels every connected piece of `set`. Cells outside it get id -1.
Regions labelRegions(const Bits &set, const Model &model);

} // namespace lg
