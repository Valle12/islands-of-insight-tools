#pragma once

#include <cstdint>
#include <cstring>

struct NodeKey {
    static constexpr size_t InlineCapacity = 16; // uint32_t units
    uint32_t inlineData[InlineCapacity]{};
    uint32_t* heapData = nullptr;
    uint8_t len = 0;

    uint32_t* data() { return len <= InlineCapacity ? inlineData : heapData; }
    const uint32_t* data() const { return len <= InlineCapacity ? inlineData : heapData; }

    NodeKey() = default;

    explicit NodeKey(uint8_t n) : len(n) {
        if (n > InlineCapacity) heapData = new uint32_t[n]();
    }

    ~NodeKey() { delete[] heapData; }

    NodeKey(const NodeKey& o) : len(o.len) {
        if (len > InlineCapacity) {
            heapData = new uint32_t[len];
            std::memcpy(heapData, o.heapData, len * sizeof(uint32_t));
        } else {
            std::memcpy(inlineData, o.inlineData, len * sizeof(uint32_t));
        }
    }

    NodeKey& operator=(const NodeKey& o) {
        if (this == &o) return *this;
        delete[] heapData;
        heapData = nullptr;
        len = o.len;
        if (len > InlineCapacity) {
            heapData = new uint32_t[len];
            std::memcpy(heapData, o.heapData, len * sizeof(uint32_t));
        } else {
            std::memcpy(inlineData, o.inlineData, len * sizeof(uint32_t));
        }
        return *this;
    }

    NodeKey(NodeKey&& o) noexcept : len(o.len), heapData(o.heapData) {
        std::memcpy(inlineData, o.inlineData, sizeof(inlineData));
        o.heapData = nullptr;
        o.len = 0;
    }

    NodeKey& operator=(NodeKey&& o) noexcept {
        if (this == &o) return *this;
        delete[] heapData;
        len = o.len;
        heapData = o.heapData;
        std::memcpy(inlineData, o.inlineData, sizeof(inlineData));
        o.heapData = nullptr;
        o.len = 0;
        return *this;
    }

    bool operator==(const NodeKey& o) const {
        if (len != o.len) return false;
        return std::memcmp(data(), o.data(), len * sizeof(uint32_t)) == 0;
    }
};

struct NodeKeyHash {
    size_t operator()(const NodeKey& k) const noexcept {
        size_t h = 14695981039346656037ULL;
        const auto* p = reinterpret_cast<const uint8_t*>(k.data());
        size_t bytes = k.len * sizeof(uint32_t);
        for (size_t i = 0; i < bytes; i++) {
            h ^= p[i];
            h *= 1099511628211ULL;
        }
        return h;
    }
};
