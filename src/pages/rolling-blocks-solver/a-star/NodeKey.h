#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <memory>

struct NodeKey {
  static constexpr size_t InlineCapacity = 16; // uint32_t units
  std::array<uint32_t, InlineCapacity> inlineData{};
  // Owning spill buffer for keys longer than InlineCapacity. unique_ptr is the
  // same one pointer wide as the raw pointer it replaced, so the inline-buffer
  // optimisation this struct exists for is unchanged.
  std::unique_ptr<uint32_t[]> heapData;
  uint8_t len = 0;

  uint32_t *data() {
    return len <= InlineCapacity ? inlineData.data() : heapData.get();
  }
  [[nodiscard]] const uint32_t *data() const {
    return len <= InlineCapacity ? inlineData.data() : heapData.get();
  }

  NodeKey() = default;

  explicit NodeKey(const uint8_t n) : len(n) {
    if (n > InlineCapacity)
      heapData = std::make_unique<uint32_t[]>(n);
  }

  ~NodeKey() = default;

  NodeKey(const NodeKey &o) : len(o.len) {
    if (len > InlineCapacity) {
      heapData = std::make_unique_for_overwrite<uint32_t[]>(len);
      std::memcpy(heapData.get(), o.heapData.get(), len * sizeof(uint32_t));
    } else {
      std::memcpy(inlineData.data(), o.inlineData.data(),
                  len * sizeof(uint32_t));
    }
  }

  NodeKey &operator=(const NodeKey &o) {
    if (this == &o) {
      return *this;
    }
    heapData.reset();
    len = o.len;
    if (len > InlineCapacity) {
      heapData = std::make_unique_for_overwrite<uint32_t[]>(len);
      std::memcpy(heapData.get(), o.heapData.get(), len * sizeof(uint32_t));
    } else {
      std::memcpy(inlineData.data(), o.inlineData.data(),
                  len * sizeof(uint32_t));
    }
    return *this;
  }

  NodeKey(NodeKey &&o) noexcept
      : heapData(std::move(o.heapData)), len(o.len) {
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
    return std::memcmp(data(), o.data(), len * sizeof(uint32_t)) == 0;
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
    const auto *p = reinterpret_cast<const std::byte *>(k.data());
    const size_t bytes = k.len * sizeof(uint32_t);
    for (size_t i = 0; i < bytes; i++) {
      h ^= std::to_integer<size_t>(p[i]);
      h *= Fnv::prime;
    }
    return h;
  }
};
