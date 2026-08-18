#pragma once

#include "Types.h"

#include <algorithm>
#include <array>
#include <bit>
#include <cstdint>

// A set of cells as 1024 bits, and the four neighbor shifts everything here
// is built out of.
//
// Every interesting propagator in this solver is a flood fill — the region
// behind an area clue, the cells a color can still reach, the component a
// letter group has to live in. At the fixed 32-cell row pitch (see kStride)
// one 64-bit word holds exactly two rows, which makes all four shifts trivial:
//
//   - up / down are a 32-bit shift of the whole 1024-bit value, which is a
//     half-word move and one carry per word;
//   - left / right are a 1-bit shift AFTER masking out the column that would
//     wrap, and masking that column also zeroes the only bit that could carry
//     into the next word. So they need no carry at all.
//
// A full fill is then a handful of instructions per iteration rather than a
// queue of cell indices, which is what makes the underclued mode — hundreds of
// refutations, each flooding repeatedly — affordable.
namespace lg {

inline constexpr int kBitsPerWord = 64;
inline constexpr int kWords = kMaxCells / kBitsPerWord;
inline constexpr int kRowsPerWord = kBitsPerWord / kStride;

/// Cells in column 0, and cells in the last column. With two rows to a word
/// these are the same constant in every word.
inline constexpr uint64_t kLeftColumn = 0x0000'0001'0000'0001ULL;
inline constexpr uint64_t kRightColumn = 0x8000'0000'8000'0000ULL;

/// A set of cells, one bit per index of the strided space.
struct Bits {
  std::array<uint64_t, kWords> words{};

  bool operator==(const Bits &other) const = default;

  static constexpr int wordOf(const int index) { return index / kBitsPerWord; }
  static constexpr int bitOf(const int index) { return index % kBitsPerWord; }

  constexpr void set(const int index) {
    words[slot(wordOf(index))] |= uint64_t{1} << bitOf(index);
  }

  constexpr void reset(const int index) {
    words[slot(wordOf(index))] &= ~(uint64_t{1} << bitOf(index));
  }

  [[nodiscard]] constexpr bool test(const int index) const {
    return (words[slot(wordOf(index))] >> bitOf(index) & uint64_t{1}) != 0;
  }

  [[nodiscard]] bool any() const {
    return std::ranges::any_of(words,
                               [](const uint64_t word) { return word != 0; });
  }

  [[nodiscard]] bool none() const { return !any(); }

  [[nodiscard]] int count() const {
    int total = 0;
    for (const uint64_t word : words)
      total += std::popcount(word);
    return total;
  }

  /// The lowest set index at or after `from`, or -1 when there is none. The
  /// iteration idiom is
  /// `for (int i = bits.nextSet(0); i >= 0; i = bits.nextSet(i + 1))`.
  [[nodiscard]] int nextSet(const int from) const {
    const int start = from > 0 ? from : 0;
    if (start >= kMaxCells)
      return -1;
    int word = wordOf(start);
    uint64_t value = words[slot(word)] & ~uint64_t{0} << bitOf(start);
    while (value == 0) {
      word++;
      if (word >= kWords)
        return -1;
      value = words[slot(word)];
    }
    return word * kBitsPerWord + std::countr_zero(value);
  }

  constexpr Bits &operator|=(const Bits &other) {
    for (int w = 0; w < kWords; w++)
      words[slot(w)] |= other.words[slot(w)];
    return *this;
  }

  constexpr Bits &operator&=(const Bits &other) {
    for (int w = 0; w < kWords; w++)
      words[slot(w)] &= other.words[slot(w)];
    return *this;
  }

  /// This set with everything in `other` taken out.
  [[nodiscard]] constexpr Bits without(const Bits &other) const {
    Bits out;
    for (int w = 0; w < kWords; w++)
      out.words[slot(w)] = words[slot(w)] & ~other.words[slot(w)];
    return out;
  }

  [[nodiscard]] bool intersects(const Bits &other) const {
    for (int w = 0; w < kWords; w++) {
      if ((words[slot(w)] & other.words[slot(w)]) != 0)
        return true;
    }
    return false;
  }

  [[nodiscard]] bool isSubsetOf(const Bits &other) const {
    return without(other).none();
  }

  /// One row down (y + 1): every index gains kStride.
  [[nodiscard]] constexpr Bits shiftDown() const {
    Bits out;
    for (int w = 0; w < kWords; w++) {
      uint64_t value = words[slot(w)] << kStride;
      if (w > 0)
        value |= words[slot(w - 1)] >> (kBitsPerWord - kStride);
      out.words[slot(w)] = value;
    }
    return out;
  }

  /// One row up (y - 1).
  [[nodiscard]] constexpr Bits shiftUp() const {
    Bits out;
    for (int w = 0; w < kWords; w++) {
      uint64_t value = words[slot(w)] >> kStride;
      if (w + 1 < kWords)
        value |= words[slot(w + 1)] << (kBitsPerWord - kStride);
      out.words[slot(w)] = value;
    }
    return out;
  }

  /// One column right (x + 1). Masking the last column first is what stops a
  /// cell wrapping onto the next row, and it also clears the only bit that
  /// could carry into the next word — so there is no carry here.
  [[nodiscard]] constexpr Bits shiftRight() const {
    Bits out;
    for (int w = 0; w < kWords; w++)
      out.words[slot(w)] = (words[slot(w)] & ~kRightColumn) << 1;
    return out;
  }

  /// One column left (x - 1); the mirror of shiftRight.
  [[nodiscard]] constexpr Bits shiftLeft() const {
    Bits out;
    for (int w = 0; w < kWords; w++)
      out.words[slot(w)] = (words[slot(w)] & ~kLeftColumn) >> 1;
    return out;
  }

  /// This set together with every cell orthogonally touching it.
  [[nodiscard]] constexpr Bits grown() const {
    Bits out = *this;
    out |= shiftUp();
    out |= shiftDown();
    out |= shiftLeft();
    out |= shiftRight();
    return out;
  }

  /// Cells orthogonally touching this set but not in it.
  [[nodiscard]] constexpr Bits border() const { return grown().without(*this); }

  // Hidden friends: defined inside the class, found only by argument-dependent
  // lookup. A free operator at namespace scope joins the overload set of every
  // unqualified `|` and `&` in the namespace and has to be rejected one
  // candidate at a time, which is what cpp:S2807 is about.
  [[nodiscard]] friend constexpr Bits operator|(Bits left, const Bits &right) {
    left |= right;
    return left;
  }

  [[nodiscard]] friend constexpr Bits operator&(Bits left, const Bits &right) {
    left &= right;
    return left;
  }
};

/// A set holding exactly one cell.
[[nodiscard]] constexpr Bits oneCell(const int index) {
  Bits out;
  out.set(index);
  return out;
}

/// Every index a width x height board occupies in the strided space.
[[nodiscard]] constexpr Bits boardMask(const int width, const int height) {
  Bits out;
  for (int y = 0; y < height; y++) {
    for (int x = 0; x < width; x++)
      out.set(cellIndex(x, y));
  }
  return out;
}

/// Every cell of `allowed` orthogonally reachable from `seed`.
[[nodiscard]] inline Bits flood(const Bits &seed, const Bits &allowed) {
  Bits current = seed & allowed;
  Bits next = current.grown() & allowed;
  while (next != current) {
    current = next;
    next = current.grown() & allowed;
  }
  return current;
}

/// The component of `allowed` containing `index`, empty when it is not in it.
[[nodiscard]] inline Bits component(const int index, const Bits &allowed) {
  return flood(oneCell(index), allowed);
}

/**
 * A region's shape, as the one key two regions compare equal on exactly when
 * they are CONGRUENT: the smallest of its eight dihedral images — the four
 * rotations and the four reflections — each slid against the top-left corner.
 *
 * Every image is a bijection of the region, so all eight hold the same number
 * of squares: the SIZE is in the key, which is why "the same shape and size"
 * needs no second test anywhere. Which of the eight is picked is arbitrary and
 * only has to be deterministic — keys are compared for equality, never for
 * order — so the words' own ordering is used and nothing reads into it.
 *
 * Lives here, beside `flood`, for the reason `mirrorSquare` lives in `Types.h`
 * while each lotus's mirror MAP stays with its owner: what a dihedral image of
 * a polyomino IS belongs to the geometry, while what a rule does with one stays
 * duplicated between `Verify.cpp` and `Propagate.cpp`, so the two can still
 * only agree by both being right.
 *
 * A normalized image always fits: both sides of the bounding box are at most
 * `kMaxSide`, whichever way a transpose swaps them, so `cellIndex` cannot wrap.
 */
[[nodiscard]] inline Bits canonicalShape(const Bits &region) {
  // (x, y) -> (a*x + b*y, c*x + d*y): identity, three rotations, then the
  // four reflections.
  static constexpr std::array<std::array<int, 4>, 8> kDihedral{
      {{1, 0, 0, 1},
       {0, -1, 1, 0},
       {-1, 0, 0, -1},
       {0, 1, -1, 0},
       {-1, 0, 0, 1},
       {1, 0, 0, -1},
       {0, 1, 1, 0},
       {0, -1, -1, 0}}};

  Bits best;
  bool have = false;
  for (const auto &[a, b, c, d] : kDihedral) {
    int minX = kMaxSide;
    int minY = kMaxSide;
    for (int i = region.nextSet(0); i >= 0; i = region.nextSet(i + 1)) {
      const int x = a * columnOf(i) + b * rowOf(i);
      const int y = c * columnOf(i) + d * rowOf(i);
      minX = std::min(minX, x);
      minY = std::min(minY, y);
    }
    Bits image;
    for (int i = region.nextSet(0); i >= 0; i = region.nextSet(i + 1)) {
      const int x = a * columnOf(i) + b * rowOf(i) - minX;
      const int y = c * columnOf(i) + d * rowOf(i) - minY;
      image.set(cellIndex(x, y));
    }
    if (!have || std::ranges::lexicographical_compare(image.words, best.words)) {
      best = image;
      have = true;
    }
  }
  return best;
}

} // namespace lg
