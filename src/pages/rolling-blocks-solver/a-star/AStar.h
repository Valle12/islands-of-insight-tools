#pragma once

#include "Block.h"
#include "GoalCluster.h"
#include "Node.h"
#include "NodeKey.h"
#include "Types.h"

#include <cstdint>
#include <cstring>
#include <functional>
#include <unordered_map>
#include <vector>
#include <boost/dynamic_bitset.hpp>

class AStar {
public:
    struct StateInfo {
        uint32_t gScore = UINT32_MAX;
        NodeKey parent;
        Turn turn;
        bool hasParent = false;
        bool closed = false;
    };

    std::function<void(uint32_t)> onProgress;

    AStar(uint8_t gridWidth, uint8_t gridHeight, std::vector<Tile> cells, uint8_t weight = 2);

    std::vector<Turn> search(Node root);

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

    uint32_t heuristic(const Node& node) const;
    uint32_t mustTouchHeuristic(const Node& node) const;
    uint32_t groupedMustTouchHeuristic(const Node& node) const;
    uint32_t goalDistanceHeuristic(const Node& node) const;
    bool blockCoversGoal(const Block& block, const GoalCluster& goal) const;

    bool isReachable(const std::vector<Block>& blocks, size_t replaceIdx,
                     const Block& replacement,
                     const boost::dynamic_bitset<>& mustTouchSatisfied);

    std::vector<GoalCluster> precomputeGoalClusters() const;
    static bool blockCompatibleWithCluster(const Block& block, const GoalCluster& cluster);
    void assignBlocksToGoals(const std::vector<Block>& blocks);

    bool isGoalState(const Node& node) const;

    using StateMap = std::unordered_map<NodeKey, StateInfo, NodeKeyHash>;
    static std::vector<Turn> reconstructPath(const StateMap& states, const NodeKey& goalSignature);

    static NodeKey nodeSignature(const Node& node);
    static NodeKey signatureFromParts(
        const std::vector<Block>& blocks, size_t replaceIdx,
        const Block& replacement, const boost::dynamic_bitset<>& mustTouch);

    std::vector<uint8_t> reachBuf_;
    std::vector<uint16_t> reachStack_;

    template<typename BlockAccessor>
    static NodeKey buildSignature(
        uint8_t numBlocks, const uint8_t* indices,
        BlockAccessor&& getBlock, const boost::dynamic_bitset<>& mustTouch) {
        using block_type = boost::dynamic_bitset<>::block_type;
        size_t numBitBlocks = mustTouch.size() > 0 ? mustTouch.num_blocks() : 0;
        static constexpr size_t ratio = sizeof(block_type) / sizeof(uint32_t);
        auto bitSlots = static_cast<uint8_t>(numBitBlocks * ratio);

        NodeKey key(numBlocks + bitSlots);
        uint32_t* d = key.data();

        for (uint8_t i = 0; i < numBlocks; i++) {
            const auto& b = getBlock(indices[i]);
            d[i] = (static_cast<uint32_t>(static_cast<uint8_t>(b.x)) << 24) |
                   (static_cast<uint32_t>(static_cast<uint8_t>(b.y)) << 16) |
                   (static_cast<uint32_t>(b.width) << 8) |
                   b.depth;
        }

        if (numBitBlocks > 0) {
            block_type temp[16]; // enough for grids up to ~1024 cells
            boost::to_block_range(mustTouch, temp);
            std::memcpy(d + numBlocks, temp, numBitBlocks * sizeof(block_type));
        }

        return key;
    }
};
