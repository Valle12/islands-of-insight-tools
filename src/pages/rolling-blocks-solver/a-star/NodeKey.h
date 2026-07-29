#pragma once

#include <array>
#include <cstdint>
#include <cstring>
#include <memory>

// Byte-oriented state key: the canonical, COMPLETE encoding of a search state.
// AStar::encodeState writes, per state:
//
//   numBlocks * 5 bytes   one (x, y, width, depth, height) record per block,
//                         records sorted ascending as 5-byte tuples so states
//                         differing only in which same-shaped block sits where
//                         collapse into one entry
//   ceil(K/8) bytes       must-touch satisfaction bits, indexed by must-touch
//                         ORDINAL (K = number of must-touch cells), not by
//                         board cell
//
// Height is part of the record: without it a standing 1x1x3 and a standing
// 1x1x5 on the same footprint alias into one state (the fixture-32 bug). The
// ordinal bit block replaces the old fixed to_block_range scratch, whose 16
// unsigned longs silently overflowed past 512 board cells on wasm32 and whose
// block width differed between wasm32 (4 bytes) and native (8), making keys
// non-portable. len is in BYTES and uint16_t: the worst case at the engine
// caps (255 blocks * 5 + 4096/8) is 1787.
struct NodeKey {
  static constexpr size_t InlineCapacity = 48; // bytes
  std::array<uint8_t, InlineCapacity> inlineData{};
  // Owning spill buffer for keys longer than InlineCapacity. unique_ptr is the
  // same one pointer wide as the raw pointer it replaced, so the inline-buffer
  // optimisation this struct exists for is unchanged.
  std::unique_ptr<uint8_t[]> heapData;
  uint16_t len = 0;

  uint8_t *data() {
    return len <= InlineCapacity ? inlineData.data() : heapData.get();
  }
  [[nodiscard]] const uint8_t *data() const {
    return len <= InlineCapacity ? inlineData.data() : heapData.get();
  }

  NodeKey() = default;

  explicit NodeKey(const uint16_t n) : len(n) {
    if (n > InlineCapacity)
      heapData = std::make_unique<uint8_t[]>(n); // value-init: starts zeroed
  }

  ~NodeKey() = default;

  NodeKey(const NodeKey &o) : len(o.len) {
    if (len > InlineCapacity) {
      heapData = std::make_unique_for_overwrite<uint8_t[]>(len);
      std::memcpy(heapData.get(), o.heapData.get(), len);
    } else {
      std::memcpy(inlineData.data(), o.inlineData.data(), len);
    }
  }

  NodeKey &operator=(const NodeKey &o) {
    if (this == &o) {
      return *this;
    }
    heapData.reset();
    len = o.len;
    if (len > InlineCapacity) {
      heapData = std::make_unique_for_overwrite<uint8_t[]>(len);
      std::memcpy(heapData.get(), o.heapData.get(), len);
    } else {
      std::memcpy(inlineData.data(), o.inlineData.data(), len);
    }
    return *this;
  }

  NodeKey(NodeKey &&o) noexcept : heapData(std::move(o.heapData)), len(o.len) {
    std::memcpy(inlineData.data(), o.inlineData.data(), sizeof(inlineData));
    o.len = 0;
  }

  NodeKey &operator=(NodeKey &&o) noexcept {
    if (this == &o) {
      return *this;
    }
    len = o.len;
    heapData = std::move(o.heapData);
    std::memcpy(inlineData.data(), o.inlineData.data(), sizeof(inlineData));
    o.len = 0;
    return *this;
  }

  bool operator==(const NodeKey &o) const {
    if (len != o.len)
      return false;
    return std::memcmp(data(), o.data(), len) == 0;
  }
};

namespace detail {
template <size_t N> struct FnvParams;
template <> struct FnvParams<8> {
  static constexpr uint64_t offset = 14695981039346656037ULL;
  static constexpr uint64_t prime = 1099511628211ULL;
};
template <> struct FnvParams<4> {
  static constexpr uint32_t offset = 2166136261U;
  static constexpr uint32_t prime = 16777619U;
};
} // namespace detail

struct NodeKeyHash {
  size_t operator()(const NodeKey &k) const noexcept {
    using Fnv = detail::FnvParams<sizeof(size_t)>;
    size_t h = Fnv::offset;
    const uint8_t *p = k.data();
    for (size_t i = 0; i < k.len; i++) {
      h ^= p[i];
      h *= Fnv::prime;
    }
    return h;
  }
};
