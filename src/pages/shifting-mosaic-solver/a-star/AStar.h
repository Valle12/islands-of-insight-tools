#pragma once

#include "Node.h"
#include "NodeKey.h"
#include "StateTable.h"
#include "Types.h"

#include <array>
#include <atomic>
#include <cstdint>
#include <functional>
#include <optional>
#include <unordered_map>
#include <unordered_set>
#include <vector>

struct HeapEntry;

class AStar {
public:
  // Internal move record: a Turn plus a slide distance. slideDistance is the
  // move stride (1 unless the puzzle is grid-quantized); the path
  // reconstructor expands it to that many 1-cell Turns.
  struct InternalMove {
    uint8_t blockId = 0;
    Direction direction = Direction::UP;
    uint8_t slideDistance = 0;
  };

  struct StateInfo {
    uint32_t gScore = UINT32_MAX;
    // Parent link as a POINTER, not a copy of the parent's 48-byte NodeKey —
    // that copy was three quarters of this struct, paid by every stored state.
    // 64 -> 24 bytes. Safe because unordered_map keeps element pointers valid
    // across inserts and rehashes and `states` is never erased; the chain is
    // only ever walked for `move`, never for an ancestor's key. nullptr = root.
    const StateInfo *parent = nullptr;
    InternalMove move{};
    bool hasParent = false;
    bool closed = false;
  };

  // Optional per-expansion progress callback (throttled by the search).
  void setOnProgress(std::function<void(uint32_t)> cb) {
    onProgress = std::move(cb);
  }

  // Cumulative counters for the most recent search() call, summed across
  // fallback passes (stride-1 retry, BFS retry). Benchmarking/telemetry
  // only — never read by the search itself.
  struct SearchStats {
    uint32_t nodesExpanded = 0;
    uint64_t statesStored = 0;
    // True when the search stopped because it hit maxHeapBytes rather than
    // exhausting the space or the clock — distinguishes "too big for this heap"
    // from "genuinely searched out", which the two need different responses to.
    bool stoppedOnMemory = false;
    uint8_t passes = 0;
  };
  [[nodiscard]] const SearchStats &lastStats() const { return stats_; }

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
    // Move-stride override. 0 = auto-detect the grid-quantization factor;
    // >=1 = force that stride (1 disables quantization).
    uint8_t strideOverride = 0;
    // If true, search() runs optimizeSolution() on the found path before
    // returning. Turn it off to measure the raw search output.
    bool postProcess = true;
    // If true, when guided (weighted) A* finds nothing, search() retries once
    // as pure breadth-first search (weight 0). BFS cannot be misled by a weak
    // heuristic, so it cracks dense puzzles whose heuristic gives no usable
    // gradient — at the cost of a second search pass.
    bool bfsFallback = true;
    // Cooperative cancellation: when set and it becomes true, the search
    // returns empty at the next budget checkpoint.
    std::atomic<bool> *cancel = nullptr;
    // Ceiling on the LIVE state map of a single search pass; 0 = unlimited
    // (bit-identical to the historical behaviour). maxNodes bounds EXPANSIONS,
    // which is not what fills the heap. Mirrors DragSolver::Config::
    // maxStatesStored — see the longer rationale there. Deterministic, so this
    // is the knob TESTS should use.
    uint64_t maxStatesStored = 0;
    // Ceiling on MEASURED live allocated bytes; 0 = unlimited. The production
    // mechanism — see DragSolver::Config::maxHeapBytes.
    uint64_t maxHeapBytes = 0;
    // Backstop cap for optimizeSolution, which is otherwise unbounded: no
    // deadline, no cancel check, up to 100k rewrite passes each replaying the
    // whole plan. NOTE: measurement cleared the optimizer as the cause of the
    // browser budget overruns — on seed 45501 (118 turns) --no-post was no
    // faster (618s vs 601s), so the overrun was the search arms, fixed in
    // AStar::search. This cap exists only so a pathological plan cannot add an
    // unbounded tail after the search stops; it is deliberately loose enough
    // never to bite in practice, because the optimizer earns its keep (that
    // same board: 163 -> 118 turns). Stopping early is safe — the loop is
    // monotone and every accepted rewrite is replay-validated, so an early
    // exit yields a valid, merely-less-polished plan. 0 = unbounded.
    uint32_t optimizeMaxMs = 30000;
  };

  AStar(uint8_t gridWidth, uint8_t gridHeight,
        std::vector<std::vector<Position>> shapes,
        std::vector<Position> initialAnchors, uint8_t goalIndex,
        Position goalAnchor, const Config &config);

  AStar(uint8_t gridWidth, uint8_t gridHeight,
        std::vector<std::vector<Position>> shapes,
        std::vector<Position> initialAnchors, uint8_t goalIndex,
        Position goalAnchor)
      : AStar(gridWidth, gridHeight, std::move(shapes),
              std::move(initialAnchors), goalIndex, goalAnchor, Config{}) {}

  // maxMs == 0 means no wall-clock budget.
  // maxNodes == 0 means no expansion-count budget.
  std::vector<Turn> search(uint32_t maxMs = 0, uint32_t maxNodes = 0);

  // Post-processes a solved turn list with validity-preserving local rewrites
  // (trailing-move truncation, redundant out-and-back cancellation,
  // pointless-excursion removal, segment reorder/merge). The result is always
  // a valid solution and never longer (in turns or in player steps) than the
  // input. Pure — does not touch search state — so it is safe to run after a
  // solution has been found.
  [[nodiscard]] std::vector<Turn>
  optimizeSolution(const std::vector<Turn> &input) const;

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

  // Groups (size >= 2) of non-goal block indices that share an identical
  // shape. Such blocks are physically interchangeable; signatureFromAnchors
  // sorts each group's anchors so permutation-equivalent states collapse to
  // one signature — a large state-space reduction for same-shape-heavy
  // puzzles.
  std::vector<std::vector<uint8_t>> symmetryGroups_;

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
  // Per-block Manhattan-distance field: blockSafeAnchorDist_[i][cell] is the
  // min Manhattan distance from anchor `cell` to a "safe" anchor of block i
  // (valid + shape clears the goal corridor). UINT16_MAX = no safe anchor
  // exists. Precomputed so lpDisplacementCost runs in O(blocks) per call
  // instead of O(blocks * gridCells * shapeCells).
  std::vector<std::vector<uint16_t>> blockSafeAnchorDist_;
  void computeBlockReachability();

  // Move stride. If the whole puzzle (grid, every anchor, every shape, the
  // goal) is uniformly scaled by a factor G, the puzzle is isomorphic to one
  // 1/G the size, so restricting moves to G-cell strides loses no solution
  // while shrinking the state space by ~G^(2N). 1 means no quantization.
  uint8_t moveStride_ = 1;
  [[nodiscard]] uint8_t detectStride() const;
  // Set by runAStar: true if the open set was fully drained (genuine "no
  // solution" within the move model), false if a budget/cap aborted it.
  bool searchExhausted_ = false;
  SearchStats stats_{};
  // Kept last: this is cold, and putting it ahead of the hot scalars above
  // would push them onto different cache lines.
  std::function<void(uint32_t)> onProgress;
  std::vector<Turn> runAStar(uint32_t maxMs, uint32_t maxNodes);

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
  axisAwareBlockerCost(const std::vector<Position> &anchors,
                       Position currentGoal) const;
  [[nodiscard]] uint32_t
  lpDisplacementCost(const std::vector<Position> &anchors) const;
  [[nodiscard]] bool isGoalState(const Node &node) const;
  [[nodiscard]] std::vector<bool>
  computeMovableSet(const std::vector<Position> &anchors) const;
  [[nodiscard]] bool
  isDeadlocked(const std::vector<Position> &anchors) const;
  // Canonical state signatures. Not static: they consult symmetryGroups_ to
  // canonicalise interchangeable same-shape blocks.
  [[nodiscard]] NodeKey nodeSignature(const Node &node) const;
  [[nodiscard]] NodeKey
  signatureFromAnchors(const std::vector<Position> &anchors) const;

  using StateMap = StateTable<StateInfo>;

  // Walks the parent chain from the goal state. Takes the state itself rather
  // than (map, key): the walk only ever reads `move`, so it needs no lookups.
  static std::vector<Turn> reconstructPath(const StateInfo *goal);

  // --- Solution post-processing -------------------------------------------
  // A run is a maximal stretch of consecutive turns of the same block in the
  // same direction — one straight leg of a drag. (A player step can span
  // several runs of one block; countSteps uses that coarser UI definition.)
  struct MoveRun {
    size_t start;
    size_t len;
    uint8_t blockId;
    Direction dir;
  };
  static std::vector<MoveRun> computeRuns(const std::vector<Turn> &turns);
  static size_t countSteps(const std::vector<Turn> &turns);
  // Replays the turns from the initial state: true iff every move is a valid
  // 1-cell move and the goal block ends exactly on goalAnchor.
  [[nodiscard]] bool replaySolves(const std::vector<Turn> &turns) const;
  // Length of the shortest prefix that already lands the goal block on
  // goalAnchor — anything past it is dead weight.
  [[nodiscard]] size_t
  firstSolvingPrefixLen(const std::vector<Turn> &turns) const;
  // Each rewrites `turns` in place and returns true when it found a strictly
  // improving, still-valid candidate; false (turns untouched) otherwise.
  [[nodiscard]] bool tryRunPairCancellation(std::vector<Turn> &turns) const;
  [[nodiscard]] bool tryRunRemoval(std::vector<Turn> &turns) const;
  [[nodiscard]] bool trySingleRemoval(std::vector<Turn> &turns) const;
  [[nodiscard]] bool tryReorderMerge(std::vector<Turn> &turns) const;
};
