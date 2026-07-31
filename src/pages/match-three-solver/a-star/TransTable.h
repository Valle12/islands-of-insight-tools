#pragma once

#include "PackedState.h"

#include <cstdint>
#include <vector>

// The search's failed-state table: which boards were searched out, in vain, at
// which remaining depth. Same design as its TypeScript twin
// (src/pages/match-three-solver/transTable.ts) — 4-way set-associative over a
// flat word arena, exact key comparison on every hit, and a byte ceiling past
// which buckets evict rather than the table growing.
//
// Eviction is SOUND for the proofs the search makes: an entry only ever
// prevents re-searching a subtree already proven barren at that remaining
// depth, so losing one merely re-searches to the same conclusion, slower. What
// would be unsound is a FALSE hit — hence full-key comparison, never the hash
// alone — or recording an aborted subtree, which the search's own store
// discipline excludes.
namespace mt {

class TransTable {
public:
  /// Entries per bucket.
  static constexpr int kWays = 4;

  TransTable(const int cellCount, const uint64_t maxBytes)
      : keyWords_(keyWordsFor(cellCount)), entryWords_(keyWords_ + 2) {
    const uint64_t bucketBytes =
        static_cast<uint64_t>(kWays) * static_cast<uint64_t>(entryWords_) * 4;
    uint64_t buckets = maxBytes / (bucketBytes == 0 ? 1 : bucketBytes);
    if (buckets == 0)
      buckets = 1;
    uint64_t ceiling = 1;
    while (ceiling * 2 <= buckets)
      ceiling *= 2;
    maxBuckets_ = static_cast<uint32_t>(ceiling);
    // Start small and double only when a bucket would otherwise evict: a 3x3
    // board's solve must not pin the budget's worth of memory.
    bucketCount_ = maxBuckets_ < 64 ? maxBuckets_ : 64;
    words_.assign(static_cast<size_t>(bucketCount_) *
                      static_cast<size_t>(kWays) *
                      static_cast<size_t>(entryWords_),
                  0);
  }

  [[nodiscard]] uint64_t size() const { return entryCount_; }

  /// True when this exact board is known barren at `remaining` or deeper.
  bool probe(const Board &board, const int remaining) {
    scratchHash_ = packState(board, scratch_);
    const int at = findEntry();
    return at >= 0 &&
           words_[slot(at + 1)] >=
               static_cast<uint32_t>(remaining);
  }

  /// Records the board as searched out at `remaining`, which is never 0 — the
  /// search returns before keying a node with no moves left to make.
  void store(const Board &board, const int remaining) {
    scratchHash_ = packState(board, scratch_);
    // Growing on overflow is safe exactly because the hash avalanches:
    // colliding keys differ somewhere, so each doubling gets a fresh bit to
    // separate them with.
    while (!insert(remaining))
      grow();
  }

private:
  int keyWords_;
  int entryWords_;
  uint32_t maxBuckets_ = 1;
  uint32_t bucketCount_ = 1;
  uint64_t entryCount_ = 0;
  std::vector<uint32_t> words_;
  StateKey scratch_{};
  uint32_t scratchHash_ = 0;

  [[nodiscard]] int bucketBase() const {
    return static_cast<int>(scratchHash_ & (bucketCount_ - 1)) * kWays *
           entryWords_;
  }

  [[nodiscard]] int findEntry() const {
    const int base = bucketBase();
    for (int way = 0; way < kWays; way++) {
      const int at = base + way * entryWords_;
      if (words_[slot(at + 1)] == 0)
        continue;
      if (words_[static_cast<size_t>(at)] != scratchHash_)
        continue;
      if (keyMatches(at + 2))
        return at;
    }
    return -1;
  }

  [[nodiscard]] bool keyMatches(const int at) const {
    for (int word = 0; word < keyWords_; word++) {
      if (words_[slot(at + word)] !=
          scratch_[static_cast<size_t>(word)])
        return false;
    }
    return true;
  }

  void writeEntry(const int at, const int remaining) {
    words_[static_cast<size_t>(at)] = scratchHash_;
    words_[slot(at + 1)] = static_cast<uint32_t>(remaining);
    for (int word = 0; word < keyWords_; word++)
      words_[slot(at + 2 + word)] =
          scratch_[static_cast<size_t>(word)];
  }

  /// One insertion attempt at the current size; false asks for a doubling.
  bool insert(const int remaining) {
    const int base = bucketBase();
    int empty = -1;
    int victim = -1;
    uint32_t victimRemaining = UINT32_MAX;
    for (int way = 0; way < kWays; way++) {
      const int at = base + way * entryWords_;
      const uint32_t failedAt = words_[slot(at + 1)];
      if (failedAt == 0) {
        if (empty < 0)
          empty = at;
        continue;
      }
      if (words_[static_cast<size_t>(at)] == scratchHash_ &&
          keyMatches(at + 2)) {
        words_[slot(at + 1)] = static_cast<uint32_t>(remaining);
        return true;
      }
      if (failedAt < victimRemaining) {
        victimRemaining = failedAt;
        victim = at;
      }
    }

    if (empty >= 0) {
      writeEntry(empty, remaining);
      entryCount_++;
      return true;
    }
    if (bucketCount_ < maxBuckets_)
      return false;
    // Depth-preferred replacement: an entry that rules out a DEEPER search
    // prunes exponentially more re-work, so the shallowest one in the bucket
    // gives way — and only to an equal or deeper newcomer.
    if (static_cast<uint32_t>(remaining) >= victimRemaining)
      writeEntry(victim, remaining);
    return true;
  }

  void grow() {
    std::vector<uint32_t> old;
    old.swap(words_);
    bucketCount_ *= 2;
    words_.assign(static_cast<size_t>(bucketCount_) *
                      static_cast<size_t>(kWays) *
                      static_cast<size_t>(entryWords_),
                  0);
    entryCount_ = 0;
    const int total = static_cast<int>(old.size());
    for (int at = 0; at < total; at += entryWords_) {
      if (old[slot(at + 1)] != 0)
        reinsert(old, at);
    }
  }

  void reinsert(const std::vector<uint32_t> &old, const int from) {
    const uint32_t hash = old[static_cast<size_t>(from)];
    const int base =
        static_cast<int>(hash & (bucketCount_ - 1)) * kWays * entryWords_;
    for (int way = 0; way < kWays; way++) {
      const int at = base + way * entryWords_;
      if (words_[slot(at + 1)] != 0)
        continue;
      for (int word = 0; word < entryWords_; word++)
        words_[slot(at + word)] =
            old[slot(from + word)];
      entryCount_++;
      return;
    }
    // Unreachable: doubling splits each old bucket across exactly two new
    // ones, so at most kWays entries can land in either half.
  }
};

} // namespace mt
