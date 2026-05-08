#pragma once

#include "Block.h"
#include "Node.h"
#include "Types.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <functional>
#include <iostream>
#include <queue>
#include <unordered_map>
#include <vector>
#include <boost/dynamic_bitset.hpp>

struct GoalCluster {
    int8_t minX, maxX, minY, maxY;
    uint8_t width, depth;
};

// ---------------------------------------------------------------------------
// Compact binary key for node states — avoids expensive string formatting.
// Layout: [packed_block0][packed_block1]...[bitset_word0][bitset_word1]...
// Each packed block is 4 bytes.  Each bitset word is sizeof(block_type) bytes.
// ---------------------------------------------------------------------------
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

class AStar {
public:
    // Combined state info — replaces separate gScore, closedSet, cameFrom maps
    struct StateInfo {
        uint32_t gScore = UINT32_MAX;
        NodeKey parent;
        Turn turn;
        bool hasParent = false;
        bool closed = false;
    };

    struct HeapEntry {
        uint32_t f;
        uint32_t g;
        NodeKey signature;
        bool operator>(const HeapEntry& o) const { return f > o.f; }
    };

    std::function<void(uint32_t)> onProgress;

    AStar(uint8_t gridWidth, uint8_t gridHeight, std::vector<Tile> cells, uint8_t weight = 2)
        : gridWidth_(gridWidth)
        , gridHeight_(gridHeight)
        , cells_(std::move(cells))
        , weight_(weight) {
        goalClusters_ = precomputeGoalClusters();
        for (int8_t x = 0; x < static_cast<int8_t>(gridWidth_); x++)
            for (int8_t y = 0; y < static_cast<int8_t>(gridHeight_); y++) {
                auto idx = positionToIndex(x, y, gridWidth_);
                if (cells_[idx] == Tile::MustTouch)
                    mustTouchIndices_.push_back({x, y, idx});
                if (cells_[idx] == Tile::Goal)
                    goalIndices_.push_back(idx);
            }
    }

    std::vector<Turn> search(Node root) {
        size_t totalCells = static_cast<size_t>(gridWidth_) * gridHeight_;
        if (root.mustTouchCellsSatisfied.size() < totalCells)
            root.mustTouchCellsSatisfied.resize(totalCells, false);

        for (const auto& block : root.blocks)
            root.mustTouchCellsSatisfied = block.updateMustTouchCells(
                gridWidth_, cells_, root.mustTouchCellsSatisfied);

        assignBlocksToGoals(root.blocks);

        auto rootSig = nodeSignature(root);

        using StateMap = std::unordered_map<NodeKey, StateInfo, NodeKeyHash>;
        using NodeMap  = std::unordered_map<NodeKey, Node, NodeKeyHash>;

        StateMap states;
        states[rootSig] = {0, {}, {}, false, false};

        NodeMap nodeStore;
        nodeStore.emplace(rootSig, root);

        std::priority_queue<HeapEntry, std::vector<HeapEntry>, std::greater<>> openHeap;
        openHeap.push({static_cast<uint32_t>(weight_ * heuristic(root)), 0, rootSig});

        uint32_t nodesExpanded = 0;
        constexpr Direction dirs[] = {Direction::UP, Direction::RIGHT, Direction::DOWN, Direction::LEFT};

        // Reusable buffer for updateMustTouchCells — avoids alloc when not touching new cells
        boost::dynamic_bitset<> mustTouchBuf;

        while (!openHeap.empty()) {
            auto current = std::move(const_cast<HeapEntry&>(openHeap.top()));
            openHeap.pop();

            // Single map lookup replaces separate closedSet + gScore checks
            auto sit = states.find(current.signature);
            if (sit == states.end()) continue;
            if (sit->second.closed) continue;
            if (sit->second.gScore < current.g) continue;

            sit->second.closed = true;
            auto nit = nodeStore.find(current.signature);
            Node node = std::move(nit->second);
            nodeStore.erase(nit);

            if (isGoalState(node)) {
                std::cout << "A* (w=" << static_cast<int>(weight_)
                          << ") found solution in " << current.g << " moves, expanded "
                          << nodesExpanded << " nodes\n";
                return reconstructPath(states, current.signature);
            }

            nodesExpanded++;
            if (onProgress && nodesExpanded % 10000 == 0)
                onProgress(nodesExpanded);

            for (size_t bi = 0; bi < node.blocks.size(); bi++) {
                for (auto direction : dirs) {
                    Block newBlock = node.blocks[bi].clone();
                    newBlock.roll(direction);

                    if (!newBlock.checkValidity(gridWidth_, gridHeight_, cells_,
                                                node.blocks, node.mustTouchCellsSatisfied))
                        continue;

                    // Check if block touches any new must-touch cell
                    bool touchesNew = false;
                    for (int8_t cx = newBlock.x;
                         cx < newBlock.x + static_cast<int8_t>(newBlock.width) && !touchesNew; cx++)
                        for (int8_t cy = newBlock.y;
                             cy < newBlock.y + static_cast<int8_t>(newBlock.depth) && !touchesNew; cy++) {
                            auto idx = positionToIndex(cx, cy, gridWidth_);
                            if (cells_[idx] == Tile::MustTouch &&
                                !node.mustTouchCellsSatisfied.test(idx))
                                touchesNew = true;
                        }

                    // Avoid bitset copy when no new must-touch cells are hit
                    if (touchesNew)
                        mustTouchBuf = newBlock.updateMustTouchCells(
                            gridWidth_, cells_, node.mustTouchCellsSatisfied);
                    const auto& mustTouchRef = touchesNew
                        ? mustTouchBuf : node.mustTouchCellsSatisfied;

                    // Compute signature without copying the blocks vector
                    auto newSig = signatureFromParts(
                        node.blocks, bi, newBlock, mustTouchRef);

                    // Single lookup for both closed-set and g-score pruning
                    auto [nsit, inserted] = states.try_emplace(newSig);
                    if (!inserted) {
                        if (nsit->second.closed) continue;
                        if (current.g + 1 >= nsit->second.gScore) continue;
                    }

                    uint32_t newG = current.g + 1;

                    // Only now create the full Node (blocks vector copy deferred past pruning)
                    std::vector<Block> newBlocks = node.blocks;
                    newBlocks[bi] = newBlock;
                    Node newNode(std::move(newBlocks),
                        touchesNew
                            ? boost::dynamic_bitset<>(mustTouchBuf)
                            : boost::dynamic_bitset<>(node.mustTouchCellsSatisfied));

                    nsit->second = {newG, current.signature,
                                    {node.blocks[bi].id, direction}, true, false};
                    nodeStore.insert_or_assign(newSig, newNode);
                    openHeap.push({
                        newG + static_cast<uint32_t>(weight_ * heuristic(newNode)),
                        newG, newSig});
                }
            }
        }

        std::cout << "No solution found\n";
        return {};
    }

private:
    uint8_t gridWidth_;
    uint8_t gridHeight_;
    std::vector<Tile> cells_;
    uint8_t weight_;
    std::vector<GoalCluster> goalClusters_;

    struct MustTouchEntry { int8_t x, y; uint16_t index; };
    std::vector<MustTouchEntry> mustTouchIndices_;
    std::vector<uint16_t> goalIndices_;

    struct GoalAssignEntry { GoalCluster cluster; bool valid = false; };
    GoalAssignEntry blockGoalAssignment_[256]{};

    // -- Heuristic --
    uint32_t heuristic(const Node& node) const {
        return std::max({mustTouchHeuristic(node),
                         groupedMustTouchHeuristic(node),
                         goalDistanceHeuristic(node)});
    }

    uint32_t mustTouchHeuristic(const Node& node) const {
        uint32_t unsatisfied = 0;
        uint32_t maxFootprint = 1;
        for (const auto& block : node.blocks)
            maxFootprint = std::max(maxFootprint,
                static_cast<uint32_t>(block.width) * block.depth);
        for (const auto& [mx, my, idx] : mustTouchIndices_)
            if (idx >= node.mustTouchCellsSatisfied.size() ||
                !node.mustTouchCellsSatisfied.test(idx))
                unsatisfied++;
        return (unsatisfied + maxFootprint - 1) / maxFootprint;
    }

    uint32_t groupedMustTouchHeuristic(const Node& node) const {
        uint32_t counts[256]{};
        for (const auto& [mx, my, idx] : mustTouchIndices_) {
            if (idx < node.mustTouchCellsSatisfied.size() &&
                node.mustTouchCellsSatisfied.test(idx))
                continue;
            uint8_t bestId = node.blocks[0].id;
            int bestDist = INT32_MAX;
            for (const auto& block : node.blocks) {
                int d = std::abs(static_cast<int>(block.x) - mx) +
                        std::abs(static_cast<int>(block.y) - my);
                if (d < bestDist) { bestDist = d; bestId = block.id; }
            }
            counts[bestId]++;
        }
        uint32_t maxLowerBound = 0;
        for (const auto& block : node.blocks) {
            uint32_t count = counts[block.id];
            if (count == 0) continue;
            uint32_t footprint = static_cast<uint32_t>(block.width) * block.depth;
            maxLowerBound = std::max(maxLowerBound, (count + footprint - 1) / footprint);
        }
        return maxLowerBound;
    }

    uint32_t goalDistanceHeuristic(const Node& node) const {
        if (goalIndices_.empty()) return 0;
        uint32_t total = 0;
        for (const auto& block : node.blocks) {
            const auto& entry = blockGoalAssignment_[block.id];
            if (!entry.valid) continue;
            if (blockCoversGoal(block, entry.cluster)) continue;
            total += std::abs(static_cast<int>(block.x) - entry.cluster.minX) +
                     std::abs(static_cast<int>(block.y) - entry.cluster.minY);
        }
        return total;
    }

    bool blockCoversGoal(const Block& block, const GoalCluster& goal) const {
        for (int8_t cx = block.x; cx < block.x + static_cast<int8_t>(block.width); cx++)
            for (int8_t cy = block.y; cy < block.y + static_cast<int8_t>(block.depth); cy++) {
                auto idx = positionToIndex(cx, cy, gridWidth_);
                if (idx >= cells_.size() || cells_[idx] != Tile::Goal) return false;
            }
        return true;
    }

    // -- Goal cluster pre-computation --
    std::vector<GoalCluster> precomputeGoalClusters() const {
        size_t totalCells = static_cast<size_t>(gridWidth_) * gridHeight_;
        std::vector<bool> visited(totalCells, false);
        std::vector<GoalCluster> clusters;
        for (int8_t x = 0; x < static_cast<int8_t>(gridWidth_); x++)
            for (int8_t y = 0; y < static_cast<int8_t>(gridHeight_); y++) {
                auto idx = positionToIndex(x, y, gridWidth_);
                if (cells_[idx] != Tile::Goal || visited[idx]) continue;
                std::vector<std::pair<int8_t, int8_t>> component;
                std::queue<std::pair<int8_t, int8_t>> q;
                q.push({x, y});
                visited[idx] = true;
                while (!q.empty()) {
                    auto [cx, cy] = q.front();
                    q.pop();
                    component.emplace_back(cx, cy);
                    constexpr int8_t dxs[] = {0, 0, 1, -1};
                    constexpr int8_t dys[] = {1, -1, 0, 0};
                    for (int i = 0; i < 4; i++) {
                        int8_t nx = cx + dxs[i];
                        int8_t ny = cy + dys[i];
                        if (nx < 0 || nx >= gridWidth_ || ny < 0 || ny >= gridHeight_) continue;
                        auto nidx = positionToIndex(nx, ny, gridWidth_);
                        if (cells_[nidx] != Tile::Goal || visited[nidx]) continue;
                        visited[nidx] = true;
                        q.push({nx, ny});
                    }
                }
                int8_t minX = component[0].first, maxX = component[0].first;
                int8_t minY = component[0].second, maxY = component[0].second;
                for (const auto& [cx, cy] : component) {
                    minX = std::min(minX, cx); maxX = std::max(maxX, cx);
                    minY = std::min(minY, cy); maxY = std::max(maxY, cy);
                }
                clusters.push_back({minX, maxX, minY, maxY,
                    static_cast<uint8_t>(maxX - minX + 1),
                    static_cast<uint8_t>(maxY - minY + 1)});
            }
        return clusters;
    }

    // -- Block-goal assignment --
    static bool blockCompatibleWithCluster(const Block& block, const GoalCluster& cluster) {
        uint8_t dims[][2] = {
            {block.width, block.depth}, {block.height, block.depth},
            {block.width, block.height}, {block.depth, block.width},
            {block.depth, block.height}, {block.height, block.width}
        };
        uint32_t seen = 0;
        for (auto& [w, d] : dims) {
            uint16_t k = (static_cast<uint16_t>(w) << 8) | d;
            if (seen & (1u << (k & 31))) continue;
            seen |= (1u << (k & 31));
            if (w == cluster.width && d == cluster.depth) return true;
        }
        return false;
    }

    void assignBlocksToGoals(const std::vector<Block>& blocks) {
        for (auto& e : blockGoalAssignment_) e.valid = false;
        if (goalClusters_.empty()) return;
        bool taken[64]{};
        bool changed = true;
        while (changed) {
            changed = false;
            for (const auto& block : blocks) {
                if (blockGoalAssignment_[block.id].valid) continue;
                size_t compatIdx = SIZE_MAX;
                int compatCount = 0;
                for (size_t i = 0; i < goalClusters_.size(); i++) {
                    if (taken[i]) continue;
                    if (blockCompatibleWithCluster(block, goalClusters_[i])) {
                        compatIdx = i;
                        if (++compatCount > 1) break;
                    }
                }
                if (compatCount == 1) {
                    blockGoalAssignment_[block.id] = {goalClusters_[compatIdx], true};
                    taken[compatIdx] = true;
                    changed = true;
                }
            }
        }
        for (const auto& block : blocks) {
            if (blockGoalAssignment_[block.id].valid) continue;
            int bestDist = INT32_MAX;
            size_t bestIdx = SIZE_MAX;
            for (size_t i = 0; i < goalClusters_.size(); i++) {
                if (taken[i]) continue;
                if (!blockCompatibleWithCluster(block, goalClusters_[i])) continue;
                int d = std::abs(static_cast<int>(block.x) - goalClusters_[i].minX) +
                        std::abs(static_cast<int>(block.y) - goalClusters_[i].minY);
                if (d < bestDist) { bestDist = d; bestIdx = i; }
            }
            if (bestIdx != SIZE_MAX) {
                blockGoalAssignment_[block.id] = {goalClusters_[bestIdx], true};
                taken[bestIdx] = true;
            }
        }
    }

    // -- Goal state check --
    bool isGoalState(const Node& node) const {
        for (const auto& [mx, my, idx] : mustTouchIndices_)
            if (idx >= node.mustTouchCellsSatisfied.size() ||
                !node.mustTouchCellsSatisfied.test(idx))
                return false;
        if (goalIndices_.empty()) return true;
        // Count goal cells covered by blocks entirely on goal
        size_t satisfied = 0;
        for (const auto& block : node.blocks) {
            bool fullyOnGoal = true;
            for (int8_t cx = block.x;
                 cx < block.x + static_cast<int8_t>(block.width) && fullyOnGoal; cx++)
                for (int8_t cy = block.y;
                     cy < block.y + static_cast<int8_t>(block.depth) && fullyOnGoal; cy++)
                    if (cells_[positionToIndex(cx, cy, gridWidth_)] != Tile::Goal)
                        fullyOnGoal = false;
            if (fullyOnGoal)
                satisfied += static_cast<size_t>(block.width) * block.depth;
        }
        return satisfied >= goalIndices_.size();
    }

    // -- Path reconstruction --
    using StateMap = std::unordered_map<NodeKey, StateInfo, NodeKeyHash>;

    static std::vector<Turn> reconstructPath(
        const StateMap& states, const NodeKey& goalSignature
    ) {
        std::vector<Turn> turns;
        NodeKey current = goalSignature;
        while (true) {
            auto it = states.find(current);
            if (it == states.end() || !it->second.hasParent) break;
            turns.push_back(it->second.turn);
            current = it->second.parent;
        }
        std::reverse(turns.begin(), turns.end());
        return turns;
    }

    // -- Compact binary signature --
    // Builds a NodeKey from sorted block data + bitset, using a block accessor
    // to avoid copying the blocks vector.
    template<typename BlockAccessor>
    static NodeKey buildSignature(
        uint8_t numBlocks, const uint8_t* indices,
        BlockAccessor&& getBlock,
        const boost::dynamic_bitset<>& mustTouch
    ) {
        using block_type = boost::dynamic_bitset<>::block_type;
        size_t numBitBlocks = mustTouch.size() > 0 ? mustTouch.num_blocks() : 0;
        static constexpr size_t ratio = sizeof(block_type) / sizeof(uint32_t);
        auto bitWords = static_cast<uint8_t>(numBitBlocks * ratio);

        NodeKey key(numBlocks + bitWords);
        uint32_t* d = key.data();

        for (uint8_t i = 0; i < numBlocks; i++) {
            const auto& b = getBlock(indices[i]);
            d[i] = (static_cast<uint32_t>(static_cast<uint8_t>(b.x)) << 24) |
                   (static_cast<uint32_t>(static_cast<uint8_t>(b.y)) << 16) |
                   (static_cast<uint32_t>(b.width) << 8) |
                   b.depth;
        }

        if (numBitBlocks > 0) {
            // Write directly to stack buffer — avoids heap-allocated std::vector
            block_type temp[16]; // 512+ bits, enough for 20×20
            boost::to_block_range(mustTouch, temp);
            std::memcpy(d + numBlocks, temp, numBitBlocks * sizeof(block_type));
        }

        return key;
    }

    // Signature for a full Node (used for root)
    static NodeKey nodeSignature(const Node& node) {
        uint8_t n = static_cast<uint8_t>(node.blocks.size());
        uint8_t indices[256];
        for (uint8_t i = 0; i < n; i++) indices[i] = i;
        std::sort(indices, indices + n, [&](uint8_t a, uint8_t b) {
            const auto& ba = node.blocks[a];
            const auto& bb = node.blocks[b];
            if (ba.x != bb.x) return ba.x < bb.x;
            if (ba.y != bb.y) return ba.y < bb.y;
            if (ba.width != bb.width) return ba.width < bb.width;
            return ba.depth < bb.depth;
        });
        return buildSignature(n, indices,
            [&](uint8_t i) -> const Block& { return node.blocks[i]; },
            node.mustTouchCellsSatisfied);
    }

    // Signature with one block replaced — avoids copying the blocks vector
    static NodeKey signatureFromParts(
        const std::vector<Block>& blocks, size_t replaceIdx,
        const Block& replacement,
        const boost::dynamic_bitset<>& mustTouch
    ) {
        uint8_t n = static_cast<uint8_t>(blocks.size());
        uint8_t indices[256];
        for (uint8_t i = 0; i < n; i++) indices[i] = i;
        std::sort(indices, indices + n, [&](uint8_t a, uint8_t b) {
            const auto& ba = (a == replaceIdx) ? replacement : blocks[a];
            const auto& bb = (b == replaceIdx) ? replacement : blocks[b];
            if (ba.x != bb.x) return ba.x < bb.x;
            if (ba.y != bb.y) return ba.y < bb.y;
            if (ba.width != bb.width) return ba.width < bb.width;
            return ba.depth < bb.depth;
        });
        return buildSignature(n, indices,
            [&](uint8_t i) -> const Block& {
                return (i == replaceIdx) ? replacement : blocks[i];
            }, mustTouch);
    }
};
