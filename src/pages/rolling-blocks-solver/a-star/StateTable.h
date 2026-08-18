#pragma once

#include "NodeKey.h"

#include <array>
#include <cstdint>
#include <memory>
#include <vector>

// Open-addressed NodeKey -> V map for the search's state store. Adapted from
// the shifting-mosaic solver's StateTable, which replaced std::unordered_map
// there for the same two reasons that apply here:
//
// Why not std::unordered_map: MSVC implements it as a linked list of
// separately-allocated nodes plus a bucket array of iterator PAIRS. Per stored
// state that is ~16 bytes of prev/next, a per-node malloc header, and ~16
// bytes of bucket — roughly 48 bytes of pure overhead on a small payload,
// paid tens of millions of times. Growth also relinks every node one pointer
// chase at a time, which is the source of multi-second rehash stalls that let
// searches overrun their deadline (nothing can preempt a rehash).
//
// Layout here is two pieces, deliberately:
//
//   slots_   a flat vector<uint32_t> of (arena index + 1), 0 = empty. This is
//            the only thing that moves when the table grows, and growing is a
//            re-probe of integers — no allocation, no pointer chasing.
//   blocks_  a block arena holding the entries themselves. Entries NEVER move,
//            because the search stores raw pointers into them: StateInfo::
//            parent and the priority-queue entries both address these directly
//            (that is what makes them 4 bytes instead of a NodeKey copy). A
//            conventional open-addressing table, which relocates elements on
//            growth, would silently corrupt every one of those.
//
// Not a std::unordered_map replacement in general: no erase (the state store
// never erases), no iteration (nothing iterates it), no rehash-invalidates-
// references contract. Those omissions are what make it cheap.
template <typename V> class StateTable {
public:
  struct Entry {
    NodeKey key;
    V value{};
  };

  StateTable() { rehash(1024); }

  [[nodiscard]] size_t size() const { return count_; }

  // Pre-size the index table when the caller knows the ceiling; avoids the
  // growth re-probes entirely. Entries are allocated per block regardless.
  void reserve(const size_t n) {
    size_t cap = 1024;
    while (cap * 7 < n * 10)
      cap <<= 1u;
    if (cap > slots_.size())
      rehash(cap);
  }

  Entry *find(const NodeKey &k) {
    const size_t mask = slots_.size() - 1;
    size_t i = NodeKeyHash{}(k) & mask;
    while (const uint32_t s = slots_[i]) {
      if (Entry &e = at(s - 1); e.key == k)
        return &e;
      i = (i + 1) & mask;
    }
    return nullptr;
  }

  // Returns the entry and whether it was newly created. On insert the key is
  // copied in and the value is default-constructed, matching the
  // try_emplace(key) shape the callers previously used.
  std::pair<Entry *, bool> emplace(const NodeKey &k) {
    if (count_ * 10 >= slots_.size() * 7)
      rehash(slots_.size() << 1u);
    const size_t mask = slots_.size() - 1;
    size_t i = NodeKeyHash{}(k) & mask;
    while (const uint32_t s = slots_[i]) {
      if (Entry &e = at(s - 1); e.key == k)
        return {&e, false};
      i = (i + 1) & mask;
    }
    const auto idx = static_cast<uint32_t>(count_);
    ensureBlock(idx);
    Entry &e = at(idx);
    e.key = k;
    slots_[i] = idx + 1;
    count_++;
    return {&e, true};
  }

private:
  // 4096 entries per block: big enough that the block vector stays tiny, small
  // enough that a partly-filled tail block wastes little.
  static constexpr uint32_t kBlockShift = 12;
  static constexpr uint32_t kBlockSize = 1u << kBlockShift;
  static constexpr uint32_t kBlockMask = kBlockSize - 1;

  std::vector<uint32_t> slots_;
  // std::array rather than a `unique_ptr<Entry[]>`: the block size is a
  // compile-time constant, so the array form buys nothing and reads as a
  // C array to analyzers (cpp:S5945). Layout, size and the never-relocate
  // guarantee the arena depends on are identical either way.
  std::vector<std::unique_ptr<std::array<Entry, kBlockSize>>> blocks_;
  size_t count_ = 0;

  Entry &at(const uint32_t i) {
    return (*blocks_[i >> kBlockShift])[i & kBlockMask];
  }

  void ensureBlock(const uint32_t idx) {
    if (idx >> kBlockShift >= blocks_.size())
      blocks_.push_back(std::make_unique<std::array<Entry, kBlockSize>>());
  }

  // Re-probe existing indices into a larger slot table. Entries stay put, so
  // this touches only integers — no allocation and no element moves, which is
  // what makes it orders of magnitude cheaper than an unordered_map rehash.
  void rehash(const size_t cap) {
    std::vector<uint32_t> next(cap, 0);
    const size_t mask = cap - 1;
    for (size_t n = 0; n < count_; n++) {
      size_t i = NodeKeyHash{}(at(static_cast<uint32_t>(n)).key) & mask;
      while (next[i])
        i = (i + 1) & mask;
      next[i] = static_cast<uint32_t>(n) + 1;
    }
    slots_.swap(next);
  }
};
