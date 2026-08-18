#pragma once

#include "Rules.h"
#include "Types.h"

#include <algorithm>
#include <array>
#include <cstdlib>
#include <limits>
#include <span>

// The forced-single-clear bound: this puzzle's one admissible lower bound that
// is actually worth computing.
//
// The stranded prune catches a symbol down to one or two blocks — it can never
// line up again. Four and five say something stronger. Every clear takes at
// least three blocks of the symbol it clears, so a symbol's clears partition its
// blocks into parts of three or more; for four the only partition is {4} and for
// five it is {5}. A symbol at exactly four or five blocks must therefore lose ALL
// of them in a SINGLE clear — taking three would leave one or two behind, and the
// stranded prune then calls that dead.
//
// So every one of those blocks has to reach one clearing shape together. And
// reaching it costs MOVES, because:
//
//   * a block changes column only via a horizontal swap, exactly one column at a
//     time — gravity and cascades are vertical;
//   * a horizontal swap moves two blocks of two DIFFERENT symbols (swapping equal
//     symbols is not a legal move), so per move at most ONE block of any given
//     symbol changes column, by one.
//
// Hence the least total horizontal displacement from where those blocks are to
// any single clearing shape is a lower bound on the moves still needed. Unlike
// the rejected "remaining x 3 cells" bound it is immune to cascades, because a
// cascade moves nothing horizontally.
//
// Two deliberate under-estimates keep it admissible. Vertical positions are
// treated as free, though gravity is in fact not controllable; and blockades are
// ignored, though they restrict which swaps exist. Both only ever make the bound
// smaller, which is the safe direction for a prover.
//
// Measured before it was built (bench/HARD-BOARDS.md). It fires on 20-90% of the
// deep states a proof actually visits and cuts 20-52% of them on
// matchThreeTest51, 6-12% on matchThreeTest47 — and a cut at depth d removes the
// whole subtree under it. Its weaker predecessor, the plain "get three of them
// aligned" bound, pruned zero of ~15 000 states and was rejected.
namespace mt::forced {

/// No symbol is at a forced-single-clear count, so this bound says nothing.
inline constexpr int kNoBound = -1;

/// The block counts this bound has anything to say about. Below kMinForced the
/// stranded prune already applies; above kMaxForced a symbol can split its
/// blocks across two clears and nothing is forced.
inline constexpr int kMinForced = 4;
inline constexpr int kMaxForced = 5;

/// Columns of every live block, per symbol. Only counts of 4 and 5 are used, so
/// this stops recording a symbol once it passes 5 — a symbol with 30 blocks
/// costs nothing beyond the count.
struct SymbolColumns {
  std::array<std::array<int, kMaxForced>, kSymbolCount> columns{};
  std::array<int, kSymbolCount> counts{};
};

inline SymbolColumns collectColumns(const Board &board) {
  SymbolColumns out;
  const int width = board.width;
  for (int y = 0; y < board.height; y++) {
    for (int x = 0; x < width; x++) {
      const uint8_t cell = board.cells[flat(width, x, y)];
      if (!isSymbol(cell))
        continue;
      const size_t s = slot(cell - kFirstSymbol);
      const int seen = out.counts[s];
      if (seen < kMaxForced)
        out.columns[s][slot(seen)] = x;
      out.counts[s] = seen + 1;
    }
  }
  return out;
}

/// Least displacement to bring every block into one column — the vertical run.
inline int intoOneColumn(const std::span<const int> cols, const int width) {
  int best = std::numeric_limits<int>::max();
  for (int c = 0; c < width; c++) {
    int total = 0;
    for (const int col : cols)
      total += std::abs(col - c);
    best = std::min(best, total);
  }
  return best;
}

/// Least displacement to one block per column across a `sorted.size()`-wide
/// window — the horizontal run. Sorted-to-sorted is the optimal assignment on a
/// line.
inline int intoOneRow(const std::span<const int> sorted, const int width) {
  const auto count = static_cast<int>(sorted.size());
  int best = std::numeric_limits<int>::max();
  for (int c = 0; c + count - 1 < width; c++) {
    int total = 0;
    for (int i = 0; i < count; i++)
      total += std::abs(sorted[slot(i)] - (c + i));
    best = std::min(best, total);
  }
  return best;
}

/// The target columns of one T, L or plus: the three-wide window starting at
/// `from`, with the vertical run's column `triple` taking three of the five
/// cells and each neighbor taking one. Ascending, to pair with sorted input.
inline std::array<int, kMaxForced> teeTargets(const int from, const int triple) {
  std::array<int, kMaxForced> targets{};
  int n = 0;
  for (int c = from; c < from + kMinRun; c++) {
    const int repeats = c == triple ? kMinRun : 1;
    for (int k = 0; k < repeats; k++)
      targets[slot(n++)] = c;
  }
  return targets;
}

/// Least displacement to a T, L or plus: a vertical three and a horizontal three
/// sharing one cell. Its columns are three consecutive ones, three blocks in one
/// of them and one in each of the others.
///
/// This shape is why a count of five cannot reuse the straight-run cost. Five
/// cells clear together either as a run of five or as a perpendicular 3+3
/// overlapping in one cell, and pricing only the run would OVER-estimate — which
/// in a prover is not conservative, it is wrong.
inline int intoTee(const std::span<const int> sorted, const int width) {
  int best = std::numeric_limits<int>::max();
  for (int from = 0; from + kMinRun - 1 < width; from++) {
    for (int triple = from; triple < from + kMinRun; triple++) {
      const std::array<int, kMaxForced> targets = teeTargets(from, triple);
      // Both sides ascending, so index i pairs with index i.
      int total = 0;
      for (int i = 0; i < kMaxForced; i++)
        total += std::abs(sorted[slot(i)] - targets[slot(i)]);
      best = std::min(best, total);
    }
  }
  return best;
}

/// Moves that symbol alone still needs, for a symbol at 4 or 5 blocks.
inline int costForSymbol(const std::span<const int> columns, const int width) {
  const auto count = static_cast<int>(columns.size());
  std::array<int, kMaxForced> buffer{};
  std::ranges::copy(columns, buffer.begin());
  std::sort(buffer.begin(), buffer.begin() + count);
  const std::span<const int> sorted{buffer.data(), columns.size()};

  int cost = std::min(intoOneColumn(sorted, width), intoOneRow(sorted, width));
  if (count == kMaxForced)
    cost = std::min(cost, intoTee(sorted, width));
  return cost;
}

/// The bound, or kNoBound when no symbol is at a forced-single-clear count.
///
/// Two admissible combinations, take the larger: every symbol's own cost is a
/// bound on its own (one unit per move per symbol), and half the total rounded up
/// is a bound too, because a horizontal swap moves blocks of exactly two
/// different symbols and so can serve two of them at once but never more.
inline int bound(const Board &board) {
  const auto [columns, counts] = collectColumns(board);
  int max = kNoBound;
  int sum = 0;
  for (size_t s = 0; s < kSymbolCount; s++) {
    const int count = counts[s];
    if (count != kMinForced && count != kMaxForced)
      continue;
    const int cost =
        costForSymbol(std::span{columns[s]}.first(slot(count)), board.width);
    max = std::max(max, cost);
    sum += cost;
  }
  if (max == kNoBound)
    return kNoBound;
  return std::max(max, (sum + 1) / 2);
}

/// Whether any symbol sits at a forced-single-clear count. O(kSymbolCount) off
/// the counts the search already maintains, so the O(cells) scan above only runs
/// where it can possibly say something.
inline bool anyForcedCount(const rules::SymbolCounts &counts) {
  return std::ranges::any_of(counts, [](const int32_t n) {
    return n == kMinForced || n == kMaxForced;
  });
}

} // namespace mt::forced
