#pragma once

#include "Types.h"

#include <array>
#include <cstdint>

// A board as a transposition-table key. Every cell value fits in four bits
// (kEmpty, kBlocked and eight symbols), so a 9x23 board is 26 words rather
// than the ~200-byte string the TypeScript engine started out with — and the
// packing is the same one src/pages/match-three-solver/transTable.ts uses, so
// the two engines' tables cost the same per state.
namespace mt {

inline constexpr int kMaxKeyWords = (kMaxCells + 7) / 8;
using StateKey = std::array<uint32_t, kMaxKeyWords>;

/// FNV-1a folded over 32-bit words; dispersion is all this needs.
inline constexpr uint32_t kFnvBasis = 0x811c9dc5;
inline constexpr uint32_t kFnvPrime = 16777619;

/// How many words a board of this many cells occupies.
constexpr int keyWordsFor(const int cellCount) {
  return cellCount <= 0 ? 1 : (cellCount + 7) / 8;
}

/// Packs `board` into `key` and returns its hash.
///
/// The murmur3 finalizer at the end is load-bearing, not decoration: the
/// bucket index is the hash's LOW bits, and a bare multiply's low bits never
/// see the operands' high bits — so without it, sibling boards differing only
/// in high-nibble cells all landed in one bucket. Measured on the TypeScript
/// twin, where it ballooned a 229-entry table to its ceiling and then evicted
/// entries a live search still needed.
inline uint32_t packState(const Board &board, StateKey &key) {
  uint32_t hash = kFnvBasis;
  uint32_t word = 0;
  int shift = 0;
  int out = 0;
  const int cells = board.cellCount();
  for (int i = 0; i < cells; i++) {
    word |= static_cast<uint32_t>(board.cells[static_cast<size_t>(i)]) << shift;
    shift += 4;
    if (shift == 32) {
      key[slot(out++)] = word;
      hash = (hash ^ word) * kFnvPrime;
      word = 0;
      shift = 0;
    }
  }
  if (shift != 0) {
    key[static_cast<size_t>(out)] = word;
    hash = (hash ^ word) * kFnvPrime;
  }

  hash ^= hash >> 16;
  hash *= 0x85ebca6b;
  hash ^= hash >> 13;
  hash *= 0xc2b2ae35;
  hash ^= hash >> 16;
  return hash;
}

} // namespace mt
