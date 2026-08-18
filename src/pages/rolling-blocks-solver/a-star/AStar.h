#pragma once

#include "Block.h"
#include "GoalCluster.h"
#include "Node.h"
#include "NodeKey.h"
#include "StateTable.h"
#include "Types.h"

#include <atomic>
#include <boost/dynamic_bitset.hpp>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <optional>
#include <queue>
#include <vector>

class AStar {
public:
  // Hard engine caps. The byte-per-field NodeKey encoding and Block's int8_t
  // roll arithmetic are sized for these (x + dim <= 127 keeps every roll
  // transient inside int8_t); search() rejects anything larger, and the UI /
  // wasm boundary / CLI enforce the same limits with real error messages.
  static constexpr uint8_t MaxGridSide = 64;
  static constexpr size_t MaxBlocks = 255;
  static constexpr uint8_t MaxBlockDim = 64;

  struct Config {
    uint8_t weight = 2;           // f = g + weight * h
    uint32_t maxMs = 0;           // 0 = no wall-clock budget
    uint64_t maxNodes = 0;        // 0 = no expansion budget
    uint64_t maxStatesStored = 0; // deterministic budget knob for tests
    uint64_t maxHeapBytes = 0;    // production memory knob (measured bytes)
    uint32_t seed = 0;            // tie-break / restart diversification
    std::atomic<bool> *cancel = nullptr;
    // Cracker-only (never exposed at the wasm/CLI boundary): when set,
    // searchCracker succeeds once THESE cells are satisfied instead of the
    // whole board, and narrows its reachability prune and transit guidance
    // to them. Every other must-touch cell keeps its real one-shot
    // semantics, so a leg plan found this way replays legally on the full
    // board. Used by the chunked-alternation scheme in SolverArms.cpp.
    const std::vector<uint16_t> *requiredCells = nullptr;
    // Cracker-only companion to requiredCells: when set, after every
    // touching move EVERY still-open must-touch cell must remain coverable
    // by the searching block (from its new pose) or by this parked partner
    // — otherwise the move stranded a cell for good and the subtree is
    // dead even though the leg itself could still "succeed". Enforced by a
    // two-seed pose-space BFS on touch moves (transit moves add no walls).
    const Block *coveragePartner = nullptr;
    // Cracker-only: the same coverage-intact prune for a JOINT two-block
    // search — after every touching move, every open must-touch cell must
    // stay coverable by one of the two blocks from their current poses.
    bool jointCoverageIntact = false;
  };

  // Why the search stopped and how much it did. stoppedOnMemory distinguishes
  // "too big for this heap" from "genuinely searched out".
  struct SearchStats {
    uint64_t nodesExpanded = 0;
    uint64_t statesStored = 0;
    bool stoppedOnMemory = false;
    uint32_t wallMs = 0;
  };

  // Optional per-expansion progress callback (throttled by the search).
  void setOnProgress(std::function<void(uint32_t)> cb) {
    onProgress = std::move(cb);
  }

  AStar(uint8_t gridWidth, uint8_t gridHeight, std::vector<Tile> cells,
        uint8_t weight = 2);
  AStar(uint8_t gridWidth, uint8_t gridHeight, std::vector<Tile> cells,
        const Config &config);

  std::vector<Turn> search(Node root);

  // Coverage cracker: depth-first over rolls with touch-greedy Warnsdorff
  // ordering and Luby-scheduled seeded restarts. Built for the endgame class
  // (must-touch-dominant boards) where best-first search drowns; see
  // SearchCracker.cpp.
  std::vector<Turn> searchCracker(Node root);

  // Memory-bounded beam: level-synchronous best-f frontier of at most
  // beamWidth states. Trades completeness for bounded memory on boards whose
  // honest state space exceeds the heap; see SearchBeam.cpp.
  std::vector<Turn> searchBeam(Node root, uint32_t beamWidth);

  [[nodiscard]] const SearchStats &stats() const { return stats_; }

  // Canonical state encode/decode, public for the state-encoding tests.
  //
  // encodeState sorts the block records, so two states that differ only by
  // which same-dimensioned block occupies which pose produce the SAME key —
  // physically interchangeable blocks are searched once. Ids are deliberately
  // absent from the key; decodeState assigns slot indices as ids (all the
  // game rules are geometric, ids only matter for reporting turns, and
  // reconstructPath recovers the real ids by forward replay).
  [[nodiscard]] NodeKey
  encodeState(const std::vector<Block> &blocks,
              const boost::dynamic_bitset<> &mustTouchCells);
  void decodeState(const NodeKey &key, std::vector<Block> &blocks,
                   boost::dynamic_bitset<> &mustTouchCells) const;

private:
  // 12 bytes on wasm32. parent points at another entry's value inside the
  // StateTable arena (entries never move), replacing the full NodeKey copy
  // the previous StateInfo carried — that copy was 72 of its 80 bytes.
  struct StateInfo {
    // std::byte, not uint8_t: these are a bit set, and the only operations on
    // them are bitwise. Still one byte, so the 12 above is unchanged.
    static constexpr std::byte ClosedFlag{1};
    static constexpr std::byte HasParentFlag{2};

    uint32_t g = UINT32_MAX;
    const StateInfo *parent = nullptr;
    // The moved block's PRE-ROLL anchor plus the direction. Anchors are unique
    // per state (footprints are disjoint), so forward replay resolves each
    // step to exactly one real block — that is how turns get real ids back.
    uint8_t fromX = 0;
    uint8_t fromY = 0;
    uint8_t dir = 0;
    std::byte flags{};
  };

  using Table = StateTable<StateInfo>;

  struct HeapEntry {
    uint32_t f;
    uint32_t g;
    Table::Entry *entry;
  };

  // Min-heap on f; deeper-first (larger g) on ties. Measured against f-only
  // ordering on fixtures 18/34/36: deeper-first halves fixture 34's
  // expansions (1.34M vs 2.65M) and wins on 18, at a mild cost on 36 —
  // clearly the better default for weighted A* here.
  struct HeapCmp {
    bool operator()(const HeapEntry &a, const HeapEntry &b) const {
      if (a.f != b.f)
        return a.f > b.f;
      return a.g < b.g;
    }
  };

  struct SearchContext {
    Table states;
    std::priority_queue<HeapEntry, std::vector<HeapEntry>, HeapCmp> openHeap;
  };

  // One scored beam candidate: f in the high bits, the arm's seed jitter in
  // the low 12 so portfolio arms walk distinct beams of equal quality.
  struct BeamCand {
    uint64_t score;
    Table::Entry *entry;
  };

  uint8_t gridWidth_;
  uint8_t gridHeight_;
  std::vector<Tile> cells_;
  Config cfg_;
  SearchStats stats_;
  std::vector<GoalCluster> goalClusters_;

  struct MustTouchEntry {
    int8_t x;
    int8_t y;
    uint16_t index;
  };
  std::vector<MustTouchEntry> mustTouchIndices_;
  std::vector<uint16_t> goalIndices_;

  // Must-touch ordinal tables: the key stores one bit per must-touch CELL
  // ORDINAL, the working bitset stays board-cell-indexed so Block's rule code
  // and the TS replay oracle are untouched. mtBytes_ is the key's bit-block
  // size; it is a per-search constant, which is what lets decodeState derive
  // the block count from key.len alone.
  std::vector<uint16_t> ordinalOfCell_;
  std::vector<uint16_t> cellOfOrdinal_;
  uint16_t mtBytes_ = 0;

  // Required-subset mode (Config::requiredCells): cell- and ordinal-indexed
  // views of the required set, empty/false in normal full-board searches.
  boost::dynamic_bitset<> requiredCellBits_;
  boost::dynamic_bitset<> requiredOrd_;
  bool requiredSubset_ = false;

  std::function<void(uint32_t)> onProgress;

  // The real-id blocks the caller passed in, kept for path reconstruction.
  std::vector<Block> rootBlocks_;

  // Reusable per-search scratch. curBlocks_/curBits_ hold the decoded state
  // being expanded; childBlocks_/childBitsBuf_ the successor being generated.
  // The satisfied set is carried in TWO synchronised forms: cell-indexed
  // (what Block's rule code and the flood fill test against) and
  // must-touch-ordinal-indexed (what the key stores) — keeping the ordinal
  // mirror live makes encoding a state a straight word copy instead of a
  // per-successor loop over every must-touch cell.
  std::vector<Block> curBlocks_;
  boost::dynamic_bitset<> curBits_;
  boost::dynamic_bitset<> curOrd_;
  std::vector<Block> childBlocks_;
  boost::dynamic_bitset<> childBitsBuf_;
  boost::dynamic_bitset<> childOrdBuf_;
  std::vector<uint64_t> encodeScratch_;
  std::vector<boost::dynamic_bitset<>::block_type> ordWords_;
  std::vector<uint32_t> groupScratch_;
  std::vector<int> matchDp_;

  [[nodiscard]] NodeKey encodeRecords(const std::vector<Block> &blocks);
  [[nodiscard]] NodeKey
  encodeStateOrdinal(const std::vector<Block> &blocks,
                     const boost::dynamic_bitset<> &ordinal);
  void decodeWorking(const NodeKey &key);
  void applyTouch(const Block &block, boost::dynamic_bitset<> &cellBits,
                  boost::dynamic_bitset<> &ordinalBits) const;

  [[nodiscard]] bool inputWithinCaps(const std::vector<Block> &blocks) const;

  // Shared entry-point preparation: caps check, root bookkeeping (real-id
  // blocks, goal tables), and the root's satisfied set in both forms.
  // Returns false when the input is outside the engine caps.
  bool prepareSearch(Node &root, boost::dynamic_bitset<> &rootOrd);

  // Per-run state and helpers for searchCracker (transit-field cache, pose
  // graphs, orphan/coverage prunes, round machinery); defined in
  // SearchCracker.cpp. Nested so it can reach the private search internals.
  struct CrackerRun;

  // searchBeam, one level at a time: every entry's expansion, one candidate
  // roll, and the cull that refills the beam. Defined in SearchBeam.cpp.
  [[nodiscard]] std::optional<std::vector<Turn>>
  expandBeamEntry(const Table::Entry *entry, uint32_t depth, Table &states,
                  std::vector<BeamCand> &candidates);
  [[nodiscard]] std::optional<std::vector<Turn>>
  tryBeamMove(const Table::Entry *entry, size_t bi, Direction dir,
              uint32_t depth, Table &states,
              std::vector<BeamCand> &candidates);
  static void refillBeam(std::vector<BeamCand> &candidates, uint32_t beamWidth,
                         std::vector<Table::Entry *> &beam);

  void expandNeighbor(size_t bi, Direction direction,
                      const Table::Entry *curEntry,
                      SearchContext &ctx);
  bool searchLimitReached(uint64_t deadline, const SearchContext &ctx);
  bool budgetExhausted(uint64_t deadline, size_t statesStored);

  // The heuristics are non-const: they reuse member scratch instead of
  // zero-initializing fresh tables per call. mustTouch is the cell-indexed
  // satisfied set, ordinal its must-touch-ordinal mirror (see below).
  [[nodiscard]] uint32_t heuristic(const std::vector<Block> &blocks,
                                   const boost::dynamic_bitset<> &mustTouch,
                                   const boost::dynamic_bitset<> &ordinal);
  [[nodiscard]] uint32_t
  mustTouchHeuristic(const std::vector<Block> &blocks,
                     const boost::dynamic_bitset<> &ordinal) const;
  [[nodiscard]] uint32_t
  groupedMustTouchHeuristic(const std::vector<Block> &blocks,
                            const boost::dynamic_bitset<> &mustTouch);
  [[nodiscard]] uint32_t
  goalDistanceHeuristic(const std::vector<Block> &blocks);
  // The two inner steps of goalDistanceHeuristic's cluster/block matching DP,
  // split out to keep each piece flat; `inf` is that DP's own infinity.
  void relaxMatchingWithBlock(const Block &block, size_t numClusters, int inf);
  void extendMatchingSubset(const Block &block, size_t subset,
                            size_t numClusters, int inf);
  [[nodiscard]] bool isBlockFullyOnGoal(const Block &block) const;

  [[nodiscard]] bool
  blockTouchesNewMustTouch(const Block &block,
                           const boost::dynamic_bitset<> &satisfied) const;

  bool isReachable(const std::vector<Block> &blocks, size_t replaceIdx,
                   const Block &replacement,
                   const boost::dynamic_bitset<> &mustTouchSatisfied,
                   const boost::dynamic_bitset<> &ordinal);
  void seedReachability(const std::vector<Block> &blocks, size_t replaceIdx,
                        const Block &replacement);
  void seedBlockReachability(const Block &block);
  bool floodFillReachable(const boost::dynamic_bitset<> &mustTouchSatisfied,
                          uint32_t totalUnsatisfied);

  [[nodiscard]] std::vector<GoalCluster> precomputeGoalClusters() const;
  void discoverGoalComponent(
      int8_t startX, int8_t startY, std::vector<bool> &visited,
      std::vector<std::pair<int8_t, int8_t>> &component) const;
  static bool blockCompatibleWithCluster(const Block &block,
                                         const GoalCluster &cluster);

  // Pose-space distance tables: for every block dimension class (sorted dims
  // multiset — physically interchangeable blocks share one class) and every
  // goal cluster, the exact minimum ROLL count from each reachable pose to an
  // accepting pose, ignoring other blocks and must-touch walls (a relaxation,
  // so the distances are admissible). A pose is (x, y, footprint); the height
  // is always the dimension the footprint leaves over. Rolls are their own
  // inverses as a move set, so one forward BFS from the accepting poses is
  // the backward distance map.
  struct GoalClassTables {
    std::array<uint8_t, 3> dims{}; // sorted multiset, identifies the class
    std::vector<std::pair<uint8_t, uint8_t>> footprints;
    // perCluster[c][footIdx * cells + cellIdx]; 0xFFFF = unreachable
    std::vector<std::vector<uint16_t>> perCluster;
  };
  std::vector<GoalClassTables> goalTables_;
  void prepareGoalTables(const std::vector<Block> &blocks);
  void fillClassClusterTable(const GoalClassTables &tables, size_t clusterIdx,
                             std::vector<uint16_t> &dist) const;
  void seedAcceptingPoses(const GoalClassTables &tables,
                          const GoalCluster &cluster,
                          std::vector<uint16_t> &dist,
                          std::queue<size_t> &frontier) const;
  void expandPoseNeighbors(const GoalClassTables &tables, size_t cur,
                           std::vector<uint16_t> &dist,
                           std::queue<size_t> &frontier) const;
  [[nodiscard]] bool poseFitsPlayable(const Block &block) const;
  [[nodiscard]] uint32_t goalPairCost(const Block &block,
                                      size_t clusterIdx) const;

  [[nodiscard]] bool
  isGoalState(const std::vector<Block> &blocks,
              const boost::dynamic_bitset<> &ordinal) const;

  [[nodiscard]] std::vector<Turn>
  reconstructPath(const StateInfo &goalInfo) const;

  // Epoch-stamped reachability scratch: a cell is "visited" when its stamp
  // equals the current epoch, so starting a flood fill is one counter bump
  // instead of a full-board memset per generated successor.
  std::vector<uint32_t> reachStamp_;
  std::vector<uint16_t> reachStack_;
  uint32_t reachEpoch_ = 0;
};
