#pragma once

#include "Node.h"
#include "NodeKey.h"
#include "Types.h"

#include <cstdint>
#include <functional>
#include <optional>
#include <unordered_map>
#include <unordered_set>
#include <vector>

struct HeapEntry;

class AStar {
public:
  // Internal move record: a Turn plus a slide distance. With macroMoves
  // disabled, slideDistance is always 1 (so it round-trips to the public Turn
  // representation unchanged). With macroMoves enabled, slideDistance can be
  // >1 and the path reconstructor expands it to that many 1-cell Turns.
  struct InternalMove {
    uint8_t blockId = 0;
    Direction direction = Direction::UP;
    uint8_t slideDistance = 0;
  };

  struct StateInfo {
    uint32_t gScore = UINT32_MAX;
    NodeKey parent;
    InternalMove move{};
    bool hasParent = false;
    bool closed = false;
  };

  std::function<void(uint32_t)> onProgress;

  // Heuristic add-ons. All flags are tunable; the BFS-through-locked-walls
  // base + final-position blocker count are always on.
  struct Config {
    uint8_t weight = 1;
    bool deadlockPruning = true;
    // Sum of (boundaryDistanceWeight * cells-from-edge) over all non-goal
    // movable blocks. Non-admissible; biases blocks to be evicted toward the
    // grid boundary.
    uint8_t boundaryDistanceWeight = 0;
    // Multiplier on the count of movable blocks intersecting the goal block's
    // BFS shortest path through *current* non-goal blocks (path-blocker
    // count). Non-admissible.
    uint8_t pathBlockerWeight = 0;
    // If true, replace the BFS-through-locked-walls heuristic base with the
    // tighter "BFS through *all* current non-goal blocks". Admissible (lower
    // bound on goal-block moves) but per-state cost.
    bool allWallsBfsBase = false;
    // If true, move generation emits multi-cell macro slides: each
    // (block, direction, k) for k=1..max-slide is a separate successor with
    // cost = k. Same state space as 1-cell A* (intermediate stops still
    // reachable), but A* can directly enqueue deeper states. Often helps
    // rush-hour-style puzzles where solutions involve long slides.
    bool macroMoves = false;
    // Multiplier on per-block perpendicular-displacement penalty. For each
    // movable block currently in the goal block's BFS path that can only move
    // perpendicular to the goal block's direction of travel, this adds at
    // least one extra unit (it must side-step). Non-admissible. 0 = disabled.
    uint8_t axisAwareWeight = 0;
    // Multiplier on the LP-relaxed blocker-displacement sum: for each
    // movable block whose footprint currently overlaps the goal block's
    // shortest path, add its minimum Manhattan distance to a "safe" anchor
    // (one whose shape lies outside the path). Admissible relaxation of the
    // bipartite assignment "which blocker side-steps to which slot". 0 =
    // disabled.
    uint8_t lpDisplacementWeight = 0;
  };

  AStar(uint8_t gridWidth, uint8_t gridHeight,
        std::vector<std::vector<Position>> shapes,
        std::vector<Position> initialAnchors, uint8_t goalIndex,
        Position goalAnchor, Config config);

  AStar(uint8_t gridWidth, uint8_t gridHeight,
        std::vector<std::vector<Position>> shapes,
        std::vector<Position> initialAnchors, uint8_t goalIndex,
        Position goalAnchor)
      : AStar(gridWidth, gridHeight, std::move(shapes),
              std::move(initialAnchors), goalIndex, goalAnchor, Config{}) {}

  // maxMs == 0 means no wall-clock budget.
  // maxNodes == 0 means no expansion-count budget.
  std::vector<Turn> search(uint32_t maxMs = 0, uint32_t maxNodes = 0);

  // IDA* alternative. O(depth) memory; same heuristic / config knobs.
  std::vector<Turn> searchIDAStar(uint32_t maxMs = 0,
                                  uint32_t maxNodes = 0);

private:
  uint8_t gridWidth_;
  uint8_t gridHeight_;
  std::vector<std::vector<Position>> shapes_;
  std::vector<Position> initialAnchors_;
  uint8_t goalIndex_;
  Position goalAnchor_;
  Config cfg_;

  std::vector<uint8_t> shapeBoxWidth_;
  std::vector<uint8_t> shapeBoxHeight_;
  std::vector<std::unordered_set<uint16_t>> shapeCellSets_;
  std::unordered_set<uint16_t> goalBlockFinalCells_;

  // Blocks proven permanently immovable from the initial state's fixpoint.
  // They stay in `anchors` (so collision checks still respect them as walls),
  // but we skip them when generating successor moves and use them to detect
  // unsolvable puzzles upfront.
  std::vector<uint8_t> movableBlockIndices_;
  bool unsolvableAtStart_ = false;

  // BFS distance from each valid goal-block-anchor to goalAnchor, with locked
  // blocks treated as walls. UINT16_MAX means unreachable.
  std::vector<uint16_t> goalAnchorBfsDist_;
  uint16_t goalAnchorAt(int8_t x, int8_t y) const {
    return goalAnchorBfsDist_[x * gridHeight_ + y];
  }
  void computeGoalAnchorBfs();

  // Per-block reachability cache: for each block i, the set of anchor cells
  // where shape_i doesn't overlap any locked cell. Computed at construction.
  // Used by the LP-relaxed blocker-displacement heuristic to estimate how
  // far each blocker must move to vacate the goal block's path.
  std::vector<std::vector<uint8_t>> blockValidAnchorMask_;
  // Cells of the goal block's BFS shortest path from init to target (through
  // locked walls). Used as a fixed "path" reference for displacement
  // estimates — independent of per-state goal-block position.
  std::vector<uint8_t> initialGoalPathCells_;
  void computeBlockReachability();

  static constexpr int8_t DX[4] = {0, 1, 0, -1};
  static constexpr int8_t DY[4] = {-1, 0, 1, 0};
  static constexpr Direction DIRS[4] = {Direction::UP, Direction::RIGHT,
                                         Direction::DOWN, Direction::LEFT};
  static constexpr uint32_t SHAPE_STRIDE = 1024;

  [[nodiscard]] bool inBounds(uint8_t blockIndex, Position anchor) const;
  [[nodiscard]] bool boundingBoxesOverlap(uint8_t i, Position ai, uint8_t j,
                                          Position aj) const;
  [[nodiscard]] bool blocksCollide(uint8_t i, Position ai, uint8_t j,
                                   Position aj) const;
  [[nodiscard]] bool
  collidesWithOthers(uint8_t blockIndex, Position newAnchor,
                     const std::vector<Position> &anchors) const;
  [[nodiscard]] uint32_t heuristic(const Node &node) const;
  [[nodiscard]] uint32_t
  countFinalPositionBlockers(const std::vector<Position> &anchors) const;
  [[nodiscard]] uint32_t
  countSweepRectangleBlockers(const std::vector<Position> &anchors,
                              Position goal) const;
  [[nodiscard]] uint32_t
  countPathBlockers(const std::vector<Position> &anchors,
                    Position currentGoal) const;
  [[nodiscard]] uint32_t
  boundaryDistanceSum(const std::vector<Position> &anchors) const;
  [[nodiscard]] uint32_t
  allWallsBfsDistance(const std::vector<Position> &anchors,
                      Position currentGoal) const;
  [[nodiscard]] uint32_t
  axisAwareBlockerCost(const std::vector<Position> &anchors,
                       Position currentGoal) const;
  [[nodiscard]] uint32_t
  lpDisplacementCost(const std::vector<Position> &anchors) const;
  [[nodiscard]] bool isGoalState(const Node &node) const;
  [[nodiscard]] std::vector<bool>
  computeMovableSet(const std::vector<Position> &anchors) const;
  [[nodiscard]] bool
  isDeadlocked(const std::vector<Position> &anchors) const;
  static NodeKey nodeSignature(const Node &node);
  static NodeKey signatureFromAnchors(const std::vector<Position> &anchors);

  using StateMap = std::unordered_map<NodeKey, StateInfo, NodeKeyHash>;

  static std::vector<Turn> reconstructPath(const StateMap &states,
                                           const NodeKey &goalSignature);

  // IDA* DFS helper. Returns +1 when the search ran but no goal was found.
  // Mutates `path` and `pathSet` as it descends.
  struct IDAResult {
    bool found;
    uint32_t nextThreshold;
    bool exhausted; // true when budget hit (caller should abort)
  };
  IDAResult idaStarDFS(std::vector<Position> &anchors, uint32_t g,
                       uint32_t threshold,
                       std::vector<InternalMove> &path,
                       std::unordered_set<NodeKey, NodeKeyHash> &pathSet,
                       uint64_t deadline, uint32_t maxNodes,
                       uint32_t &nodesExpanded);
};
