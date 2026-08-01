#pragma once

#include "Types.h"

#include <array>
#include <cstdint>
#include <vector>

// The game's rules, ported cell for cell from
// src/pages/match-three-solver/rules.ts. That file stays the definition of
// record: the page replays every solution through it, so a witness this
// engine produces must be legal there too — which is what
// src/util/fuzzMatchThree.ts checks on every generated board.
namespace mt::rules {

/// A per-cell flag grid, sized once for the largest board rather than per call.
using Mask = std::array<uint8_t, kMaxCells>;

/// Live blocks per symbol, indexed by symbol.
using SymbolCounts = std::array<int32_t, kSymbolCount>;

/// A move as one integer: `(cellIndex << 1) | downBit`, where the bit says
/// whether the partner cell is below (1) or to the right (0). Only those two
/// directions exist, because taking all four would offer every swap twice.
using PackedMove = uint16_t;

constexpr PackedMove packMove(const int index, const int down) {
  return static_cast<PackedMove>((index << 1) | down);
}
constexpr int moveIndex(const PackedMove packed) {
  return static_cast<int>(packed) >> 1;
}
constexpr bool moveIsDown(const PackedMove packed) {
  return (packed & 1U) != 0;
}
constexpr int partnerIndex(const PackedMove packed, const int width) {
  return moveIndex(packed) + (moveIsDown(packed) ? width : 1);
}

/// The packed move as the pair of cells a witness names. Every arm ends by
/// doing this, and it lives here rather than four times over: a copy that drifts
/// emits an illegal witness that only replay validation would catch.
constexpr Move decodeMove(const PackedMove packed, const int width) {
  const int aIndex = moveIndex(packed);
  const int x = aIndex % width;
  const int y = aIndex / width;
  const bool down = moveIsDown(packed);
  return {.ax = static_cast<uint8_t>(x),
          .ay = static_cast<uint8_t>(y),
          .bx = static_cast<uint8_t>(down ? x : x + 1),
          .by = static_cast<uint8_t>(down ? y + 1 : y)};
}

/// What a swap took out: the cells cleared over every wave, and how many
/// waves there were.
struct ApplyResult {
  int cleared = 0;
  int cascades = 0;
};

/// Why a board is not a state the game could be in.
enum class BoardProblem : uint8_t { None, Floating, Matching };

/// Every cell in some run of three, into a caller-owned mask. True when the
/// board is unstable.
bool findMatchesInto(const Board &board, Mask &mask);

/// Marks the runs through (x, y) only. On a board that had settled before a
/// swap, every new match passes through one of the two swapped cells, so two
/// of these find the whole first wave without rescanning the board.
bool markRunsThrough(const Board &board, int x, int y, Mask &mask);

/// Whether (x, y) sits in a run of three — the swap-legality check.
bool hasRunThrough(const Board &board, int x, int y);

/// Blocks fall to the bottom of their column segment; kBlocked never moves.
void applyGravity(Board &board);

int blockCount(const Board &board);
void symbolCountsInto(const Board &board, SymbolCounts &counts);

/// True once some symbol is down to one or two blocks: nothing can ever clear
/// those, so the board is dead. The search's load-bearing prune.
bool hasStrandedSymbol(const Board &board);

/// Clears and drops until nothing matches, counting what went.
ApplyResult resolve(Board &board, Mask &mask);

BoardProblem boardProblem(const Board &board);
const char *describe(BoardProblem problem);

/// Every legal swap, appended to `out` in the order rules.ts enumerates them
/// (right then down, scanning rows). `probe` is scratch the caller owns.
void legalMovesInto(const Board &board, Board &probe,
                    std::vector<PackedMove> &out);

/// Plays `packed` out on a copy of `from` living in `into`: swap, clear the
/// first wave, then cascade until stable. `deltas`, when given, receives the
/// per-symbol breakdown of what was cleared (added to, never zeroed here).
ApplyResult applyPacked(const Board &from, Board &into, PackedMove packed,
                        Mask &mask, SymbolCounts *deltas);

/// The same, from a `Move` — for replaying a witness rather than searching.
/// False when the swap is not a legal move on this board.
bool applyMove(const Board &from, const Move &move, Board &into, Mask &mask,
               ApplyResult &result);

} // namespace mt::rules
