#pragma once

#include <algorithm>
#include <array>
#include <cstdint>
#include <vector>

// The match-three solver's shared vocabulary. The cell encoding mirrors
// src/pages/match-three-solver/cell.ts exactly — 0 empty, 1 blocked, symbols
// from 2 — because boards cross the wasm boundary as those same integers and
// every solution must replay under the TypeScript rules the page renders
// with.
namespace mt {

/// Cells that must line up before anything clears.
inline constexpr int kMinRun = 3;

/// Hard ceiling on either grid side, matching MAX_GRID_SIDE in config.ts.
inline constexpr int kMaxSide = 32;
inline constexpr int kMaxCells = kMaxSide * kMaxSide;

/// The game's fixed symbol palette, matching symbols.ts (append-only there).
inline constexpr int kSymbolCount = 8;

inline constexpr uint8_t kEmpty = 0;
inline constexpr uint8_t kBlocked = 1;
inline constexpr uint8_t kFirstSymbol = 2;

constexpr bool isSymbol(const uint8_t cell) {
  return cell >= kFirstSymbol;
}

/// The flat index of (x, y), widened before the arithmetic rather than after.
/// Nothing here can overflow — an index tops out near a thousand — but the
/// other order is the shape that overflows in general, and static analysis is
/// right not to distinguish.
constexpr size_t flat(const int width, const int x, const int y) {
  return static_cast<size_t>(y) * static_cast<size_t>(width) +
         static_cast<size_t>(x);
}

/// An already-flat index as an array subscript. Exists so the widening cast
/// applies to a value rather than to an arithmetic expression.
constexpr size_t slot(const int index) { return static_cast<size_t>(index); }

/// A board, cells row-major (y * width + x). The inline array keeps a state
/// one flat copy with no allocation; only the first width*height entries are
/// meaningful.
struct Board {
  int width = 0;
  int height = 0;
  std::array<uint8_t, kMaxCells> cells{};

  [[nodiscard]] int cellCount() const { return width * height; }
  [[nodiscard]] uint8_t at(const int x, const int y) const {
    return cells[flat(width, x, y)];
  }
};

/// Copies only the cells a board actually uses.
///
/// Plain assignment copies the whole inline array — 1024 bytes whatever the
/// board's size — and a search that clones a state per child pays that on
/// every one of them. Measured on matchThreeTest44 (12x12, 144 cells): the
/// difference is a factor of three in wall time.
inline void copyBoard(const Board &from, Board &into) {
  into.width = from.width;
  into.height = from.height;
  const size_t used = slot(from.cellCount());
  std::copy_n(from.cells.begin(), used, into.cells.begin());
}

/// One player move: swapping the cell at (ax, ay) with the orthogonally
/// adjacent one at (bx, by). This is the shape solutions leave the solver in;
/// the search itself packs moves as integers.
struct Move {
  uint8_t ax = 0;
  uint8_t ay = 0;
  uint8_t bx = 0;
  uint8_t by = 0;
};

using Moves = std::vector<Move>;

} // namespace mt
