#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <utility>
#include <vector>

// The logic-grid solver's shared vocabulary. The colour encoding mirrors
// src/pages/logic-grid-solver/cell.ts exactly — 0 unknown, 1 dark, 2 light,
// 3 an unplayable gap — because boards cross the wasm boundary as those same
// integers and every answer must verify under the TypeScript rules the page
// renders with.
//
// A cell carries TWO independent layers, and only the first lives in the grid:
// the colour here, and at most one clue in the puzzle's sparse clue list. That
// is what makes the game's colourless clue representable — a clue on an unknown
// cell is one whose colour has still to be deduced.
namespace lg {

/// Hard ceiling on either grid side, matching MAX_GRID_SIDE in config.ts.
inline constexpr int kMaxSide = 32;

/**
 * The row pitch, FIXED at the maximum side rather than following the board's
 * width — so a cell index is `y * kStride + x` whatever the board measures.
 *
 * This is a deliberate departure from the other solvers' `flat(width, x, y)`,
 * and it is what makes `Bits` work: with a constant stride, "the cell above"
 * is a compile-time 32-bit shift of a 1024-bit word and "the cell to the left"
 * is a 1-bit shift with one constant column mask. Every propagator here is a
 * flood fill, so those two shifts are the hot path.
 *
 * The cost is that the index space is always 1024 entries with the board in
 * its top-left corner, and that the two boundaries which speak the packed
 * `y * width + x` layout — the wasm bridge and FixtureIo — convert. They are
 * already converting (the config's `cells` is column-major), so it is the same
 * loop either way.
 */
inline constexpr int kStride = kMaxSide;
inline constexpr int kMaxCells = kStride * kMaxSide;

inline constexpr uint8_t kUnknown = 0;
inline constexpr uint8_t kDark = 1;
inline constexpr uint8_t kLight = 2;
inline constexpr uint8_t kUnplayable = 3;

/// The first value past the end of the colour space, matching CELL_LIMIT.
inline constexpr uint8_t kColorLimit = 4;

/// Whether a cell takes part in the puzzle at all. Gaps take no colour, carry
/// no clue, and act as walls for runs, patterns and connectivity alike.
constexpr bool isPlayable(const uint8_t color) {
  return color != kUnplayable;
}

/// The other colour. Only meaningful for kDark and kLight — the two a
/// completion may use.
constexpr uint8_t opposite(const uint8_t color) {
  return color == kDark ? kLight : kDark;
}

/// The clue kinds, mirroring SYMBOL_KINDS in symbols.ts. That list is
/// append-only, so these indices are permanent.
///
/// Every place that branches on one of these does so THREE ways. A two-way
/// `if area else letter` reads a dart as a letter, and `buildClueTables` would
/// then index a 26-entry array with a dart's number.
inline constexpr uint8_t kClueArea = 0;
inline constexpr uint8_t kClueLetter = 1;
inline constexpr uint8_t kClueDart = 2;
inline constexpr int kClueKindCount = 3;

/// Letters arrive as 0..25 rather than as characters: the search never needs
/// the glyph, and the two boundaries that do convert once.
inline constexpr int kLetterCount = 26;

/// The four directions a clue can point, mirroring DIRECTIONS in symbols.ts —
/// clockwise from up, which is the order the whole repo reads directions in.
/// Stored by index in the config, so these are permanent too.
inline constexpr uint8_t kDirUp = 0;
inline constexpr uint8_t kDirRight = 1;
inline constexpr uint8_t kDirDown = 2;
inline constexpr uint8_t kDirLeft = 3;
inline constexpr int kDirectionCount = 4;

/// The (dx, dy) a direction names, in the same order.
inline constexpr auto kDirectionSteps =
    std::to_array({std::pair{0, -1}, std::pair{1, 0}, std::pair{0, 1},
                   std::pair{-1, 0}});

/// Whether `direction` names one of the four. `structureProblem` is what
/// REPORTS a clue that fails this; the two places that walk a line ask so they
/// cannot subscript the table with a number a puzzle skipping validation held.
constexpr bool isDirection(const int direction) {
  return direction >= 0 && direction < kDirectionCount;
}

/// The cell index of (x, y) in the strided space.
constexpr int cellIndex(const int x, const int y) { return y * kStride + x; }

constexpr int columnOf(const int index) { return index % kStride; }
constexpr int rowOf(const int index) { return index / kStride; }

/// An already-flat index as an array subscript. Exists so the widening cast
/// applies to a value rather than to an arithmetic expression, which is what
/// `bugprone-misplaced-widening-cast` is asking for.
constexpr std::size_t slot(const int index) {
  return static_cast<std::size_t>(index);
}

/// A clue as the solver holds it: where it sits, what kind it is, and its
/// value — an area size, a letter as 0..25, or a dart's count.
///
/// `direction` is APPENDED rather than slotted in beside `kind`, so the three
/// places that destructure a `Clue` positionally keep the names they had.
/// Meaningful only for a directed kind; a clue that points nowhere leaves it at
/// its default and nothing reads it.
struct Clue {
  int index = 0;
  uint8_t kind = kClueArea;
  int value = 0;
  int direction = kDirUp;
};

using Clues = std::vector<Clue>;

/// The four orthogonal steps. Diagonals are never adjacency in this puzzle:
/// regions, area counts and every connectivity rule are orthogonal only.
inline constexpr auto kSteps = std::to_array(
    {std::pair{1, 0}, std::pair{-1, 0}, std::pair{0, 1}, std::pair{0, -1}});

} // namespace lg
