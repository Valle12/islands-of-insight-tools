#include "AStar.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <iostream>
#include <queue>

AStar::AStar(uint8_t gridWidth, uint8_t gridHeight, std::vector<Tile> cells, uint8_t weight)
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

struct HeapEntry {
    uint32_t f;
    uint32_t g;
    NodeKey signature;
    bool operator>(const HeapEntry& o) const { return f > o.f; }
};

std::vector<Turn> AStar::search(Node root) {
    size_t totalCells = static_cast<size_t>(gridWidth_) * gridHeight_;
    if (root.mustTouchCellsSatisfied.size() < totalCells)
        root.mustTouchCellsSatisfied.resize(totalCells, false);

    for (const auto& block : root.blocks)
        root.mustTouchCellsSatisfied = block.updateMustTouchCells(
            gridWidth_, cells_, root.mustTouchCellsSatisfied);

    assignBlocksToGoals(root.blocks);

    auto rootSig = nodeSignature(root);

    using NodeMap = std::unordered_map<NodeKey, Node, NodeKeyHash>;

    StateMap states;
    states[rootSig] = {0, {}, {}, false, false};

    NodeMap nodeStore;
    nodeStore.emplace(rootSig, root);

    std::priority_queue<HeapEntry, std::vector<HeapEntry>, std::greater<>> openHeap;
    openHeap.push({static_cast<uint32_t>(weight_ * heuristic(root)), 0, rootSig});

    uint32_t nodesExpanded = 0;
    constexpr Direction dirs[] = {Direction::UP, Direction::RIGHT, Direction::DOWN, Direction::LEFT};

    boost::dynamic_bitset<> mustTouchBuf;

    while (!openHeap.empty()) {
        auto current = std::move(const_cast<HeapEntry&>(openHeap.top()));
        openHeap.pop();

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

                if (touchesNew)
                    mustTouchBuf = newBlock.updateMustTouchCells(
                        gridWidth_, cells_, node.mustTouchCellsSatisfied);
                const auto& mustTouchRef = touchesNew
                    ? mustTouchBuf : node.mustTouchCellsSatisfied;

                if (!isReachable(node.blocks, bi, newBlock, mustTouchRef))
                    continue;

                auto newSig = signatureFromParts(
                    node.blocks, bi, newBlock, mustTouchRef);

                auto [nsit, inserted] = states.try_emplace(newSig);
                if (!inserted) {
                    if (nsit->second.closed) continue;
                    if (current.g + 1 >= nsit->second.gScore) continue;
                }

                uint32_t newG = current.g + 1;

                std::vector<Block> newBlocks = node.blocks;
                newBlocks[bi] = newBlock;
                Node newNode(std::move(newBlocks), mustTouchRef);

                nsit->second = {newG, current.signature,
                                {node.blocks[bi].id, direction}, true, false};
                nodeStore.insert_or_assign(newSig, std::move(newNode));
                openHeap.push({
                    newG + static_cast<uint32_t>(weight_ * heuristic(nodeStore.find(newSig)->second)),
                    newG, newSig});
            }
        }
    }

    std::cout << "No solution found\n";
    return {};
}

uint32_t AStar::heuristic(const Node& node) const {
    return std::max({mustTouchHeuristic(node),
                     groupedMustTouchHeuristic(node),
                     goalDistanceHeuristic(node)});
}

bool AStar::isReachable(
    const std::vector<Block>& blocks, size_t replaceIdx,
    const Block& replacement,
    const boost::dynamic_bitset<>& mustTouchSatisfied
) {
    if (mustTouchIndices_.empty()) return true;

    uint32_t totalUnsatisfied = 0;
    for (const auto& [mx, my, idx] : mustTouchIndices_)
        if (!mustTouchSatisfied.test(idx))
            totalUnsatisfied++;
    if (totalUnsatisfied == 0) return true;

    size_t totalCells = static_cast<size_t>(gridWidth_) * gridHeight_;
    reachBuf_.assign(totalCells, 0);
    reachStack_.clear();

    for (size_t i = 0; i < blocks.size(); i++) {
        const auto& block = (i == replaceIdx) ? replacement : blocks[i];
        for (int8_t cx = block.x; cx < block.x + static_cast<int8_t>(block.width); cx++)
            for (int8_t cy = block.y; cy < block.y + static_cast<int8_t>(block.depth); cy++) {
                auto idx = positionToIndex(cx, cy, gridWidth_);
                if (!reachBuf_[idx]) {
                    reachBuf_[idx] = 1;
                    reachStack_.push_back(idx);
                }
            }
    }

    uint32_t reachableUnsatisfied = 0;
    while (!reachStack_.empty()) {
        uint16_t idx = reachStack_.back();
        reachStack_.pop_back();

        if (cells_[idx] == Tile::MustTouch && !mustTouchSatisfied.test(idx))
            if (++reachableUnsatisfied == totalUnsatisfied)
                return true;

        int8_t cx = static_cast<int8_t>(idx % gridWidth_);
        int8_t cy = static_cast<int8_t>(idx / gridWidth_);
        constexpr int8_t dx[] = {0, 0, 1, -1};
        constexpr int8_t dy[] = {1, -1, 0, 0};
        for (int d = 0; d < 4; d++) {
            int8_t nx = cx + dx[d], ny = cy + dy[d];
            if (nx < 0 || nx >= gridWidth_ || ny < 0 || ny >= gridHeight_) continue;
            auto nidx = positionToIndex(nx, ny, gridWidth_);
            if (reachBuf_[nidx]) continue;
            if (cells_[nidx] == Tile::Unplayable) continue;
            if (cells_[nidx] == Tile::MustTouch && mustTouchSatisfied.test(nidx)) continue;
            reachBuf_[nidx] = 1;
            reachStack_.push_back(nidx);
        }
    }
    return false;
}

uint32_t AStar::mustTouchHeuristic(const Node& node) const {
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

uint32_t AStar::groupedMustTouchHeuristic(const Node& node) const {
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

uint32_t AStar::goalDistanceHeuristic(const Node& node) const {
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

bool AStar::blockCoversGoal(const Block& block, const GoalCluster& goal) const {
    for (int8_t cx = block.x; cx < block.x + static_cast<int8_t>(block.width); cx++)
        for (int8_t cy = block.y; cy < block.y + static_cast<int8_t>(block.depth); cy++) {
            auto idx = positionToIndex(cx, cy, gridWidth_);
            if (idx >= cells_.size() || cells_[idx] != Tile::Goal) return false;
        }
    return true;
}

std::vector<GoalCluster> AStar::precomputeGoalClusters() const {
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

bool AStar::blockCompatibleWithCluster(const Block& block, const GoalCluster& cluster) {
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

void AStar::assignBlocksToGoals(const std::vector<Block>& blocks) {
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

bool AStar::isGoalState(const Node& node) const {
    for (const auto& [mx, my, idx] : mustTouchIndices_)
        if (idx >= node.mustTouchCellsSatisfied.size() ||
            !node.mustTouchCellsSatisfied.test(idx))
            return false;
    if (goalIndices_.empty()) return true;
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

std::vector<Turn> AStar::reconstructPath(
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

NodeKey AStar::nodeSignature(const Node& node) {
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

NodeKey AStar::signatureFromParts(
    const std::vector<Block>& blocks, size_t replaceIdx,
    const Block& replacement, const boost::dynamic_bitset<>& mustTouch
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

// buildSignature is a template defined in AStar.h
