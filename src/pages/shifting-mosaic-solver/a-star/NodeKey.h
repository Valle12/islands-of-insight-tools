#pragma once

#include <array>
#include <cstdint>
#include <cstring>

// Inline-buffer NodeKey for anchor-tuple signatures.
// Each block's anchor is packed into a single uint16_t (x in the upper byte,
// y in the lower byte) — valid for grids up to 255x255. Up to InlineCapacity
// blocks live in the inline array; past that we spill onto the heap.
//
// The compact 2-bytes-per-anchor encoding (vs a naive 4) keeps the search's
// hash-map keys small, which matters because every explored state stores
// several NodeKeys — it is the dominant memory cost of the search.
struct NodeKey {
  static constexpr size_t InlineCapacity = 16;
  std::array<uint16_t, InlineCapacity> inlineData{};
  uint16_t *heapData = nullptr;
  uint8_t len = 0;

  uint16_t *data() {
    return len <= InlineCapacity ? inlineData.data() : heapData;
  }
  [[nodiscard]] const uint16_t *data() const {
    return len <= InlineCapacity ? inlineData.data() : heapData;
  }

  NodeKey() = default;

  explicit NodeKey(const uint8_t n) : len(n) {
    if (n > InlineCapacity)
      heapData = new uint16_t[n]();
  }

  ~NodeKey() { delete[] heapData; }

  NodeKey(const NodeKey &o) : len(o.len) {
    if (len > InlineCapacity) {
      heapData = new uint16_t[len];
      std::memcpy(heapData, o.heapData, len * sizeof(uint16_t));
    } else {
      std::memcpy(inlineData.data(), o.inlineData.data(),
                  len * sizeof(uint16_t));
    }
  }

  NodeKey &operator=(const NodeKey &o) {
    if (this == &o)
      return *this;
    delete[] heapData;
    heapData = nullptr;
    len = o.len;
    if (len > InlineCapacity) {
      heapData = new uint16_t[len];
      std::memcpy(heapData, o.heapData, len * sizeof(uint16_t));
    } else {
      std::memcpy(inlineData.data(), o.inlineData.data(),
                  len * sizeof(uint16_t));
    }
    return *this;
  }

  NodeKey(NodeKey &&o) noexcept : heapData(o.heapData), len(o.len) {
    std::memcpy(inlineData.data(), o.inlineData.data(), sizeof(inlineData));
    o.heapData = nullptr;
    o.len = 0;
  }

  NodeKey &operator=(NodeKey &&o) noexcept {
    if (this == &o)
      return *this;
    delete[] heapData;
    len = o.len;
    heapData = o.heapData;
    std::memcpy(inlineData.data(), o.inlineData.data(), sizeof(inlineData));
    o.heapData = nullptr;
    o.len = 0;
    return *this;
  }

  bool operator==(const NodeKey &o) const {
    if (len != o.len)
      return false;
    return std::memcmp(data(), o.data(), len * sizeof(uint16_t)) == 0;
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
    const auto *p = reinterpret_cast<const uint8_t *>(k.data());
    const size_t bytes = k.len * sizeof(uint16_t);
    for (size_t i = 0; i < bytes; i++) {
      h ^= p[i];
      h *= Fnv::prime;
    }
    return h;
  }
};
