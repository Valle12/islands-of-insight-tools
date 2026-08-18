// The coverage cracker: depth-first search over rolls, tuned for the endgame
// class — must-touch-dominant boards where touched cells become walls. Best-
// first search structurally drowns there (the state space is positions x
// 2^mustTouch and the counting heuristics barely discriminate), while a
// depth-first walk that greedily touches fresh cells and prefers moves
// keeping the most onward options (Warnsdorff's rule) rides the puzzle's
// self-avoiding-path structure. Restarts follow a Luby schedule with a
// seeded ordering jitter, so a round that commits to a doomed prefix gets
// abandoned instead of exhausting the budget.

#include "AStar.h"

#include "SolverClock.h"

#include <algorithm>
#include <array>
#include <bit>
#include <cstdint>
#include <iostream>
#include <utility>

namespace {

// Luby restart sequence (1-based): 1,1,2,1,1,2,4,1,1,2,1,1,2,4,8,...
uint64_t luby(uint64_t i) {
  for (;;) {
    const uint64_t p = std::bit_floor(i + 1);
    if (p == i + 1) {
      return p / 2;
    }
    i -= p - 1;
  }
}

uint32_t mixHash(uint32_t h) {
  h ^= h >> 16;
  h *= 0x7feb352dU;
  h ^= h >> 15;
  h *= 0x846ca68bU;
  h ^= h >> 16;
  return h;
}

constexpr std::array kDirs = {Direction::UP, Direction::RIGHT,
                              Direction::DOWN, Direction::LEFT};

} // namespace

// Per-run state and helpers for searchCracker. One instance lives for the
// whole call: the transit-field cache, pose graphs and epoch-stamped BFS
// scratch persist across rounds exactly like the former function-local
// captures did.
struct AStar::CrackerRun {
  CrackerRun(AStar &solver, const Node &root,
             const boost::dynamic_bitset<> &rootOrd, const uint64_t startMs,
             const uint64_t deadline)
      : a_(solver), cfg_(solver.cfg_), cells_(solver.cells_),
        mustTouchIndices_(solver.mustTouchIndices_),
        requiredCellBits_(solver.requiredCellBits_),
        requiredOrd_(solver.requiredOrd_),
        requiredSubset_(solver.requiredSubset_), stats_(solver.stats_),
        onProgress_(solver.onProgress), gridWidth_(solver.gridWidth_),
        gridHeight_(solver.gridHeight_), root_(root), rootOrd_(rootOrd),
        startMs_(startMs), deadline_(deadline),
        totalCells_(static_cast<size_t>(solver.gridWidth_) *
                    solver.gridHeight_) {
    field_.dist.assign(totalCells_, UINT16_MAX);
  }

  std::vector<Turn> run() {
    if (legDone(root_.blocks, rootOrd_)) {
      return {};
    }
    uint64_t round = 0;
    while (!a_.budgetExhausted(deadline_, 0)) {
      round++;
      std::vector<Turn> solution;
      const RoundResult result = runRound(round, solution);
      if (result == RoundResult::Solved) {
        return solution;
      }
      if (result == RoundResult::SearchedOut) {
        // The whole reachable space under this ordering is exhausted; more
        // rounds would only reshuffle it.
        break;
      }
    }
    stats_.wallMs = static_cast<uint32_t>(nowMs() - startMs_);
    std::cout << "Cracker found no solution\n";
    return {};
  }

private:
  struct ScoredMove {
    uint64_t order;
    uint8_t bi;
    Direction dir;
  };
  // Frames keep REAL-id block vectors, so the path is the answer directly —
  // no reconstruction, no canonical-identity headaches.
  struct Frame {
    std::vector<Block> blocks;
    boost::dynamic_bitset<> cells;
    boost::dynamic_bitset<> ord;
    std::vector<ScoredMove> moves;
    size_t next = 0;

    Frame() = default;
    Frame(const Frame &) = default;
    Frame &operator=(const Frame &) = default;
    Frame(Frame &&) noexcept = default;
    Frame &operator=(Frame &&) noexcept = default;
    ~Frame() = default;
  };
  // Coverage-intact prune plumbing: the orientation closure and roll deltas
  // are precomputed per seed block — a roll's effect depends only on the
  // (w,d,h) triple, so BFS states are plain ints.
  struct PoseTr {
    int8_t dx = 0;
    int8_t dy = 0;
    uint8_t next = 0;
  };
  struct PoseGraph {
    std::vector<std::array<uint8_t, 3>> orients; // (w,d,h)
    std::vector<std::array<PoseTr, 4>> trans;    // [orient][dir]
    uint8_t startOrient = 0;
  };
  // Everything one restart round owns: its own visited table, DFS stack and
  // path, plus the round's ordering knobs.
  struct RoundState {
    Table visited;
    std::vector<Frame> frames;
    std::vector<Turn> path;
    uint32_t roundSeed = 0;
    bool diversify = false;
    uint64_t nodeCap = 0;
  };
  enum class StepResult : uint8_t { Continue, Solved, Exhausted };
  enum class RoundResult : uint8_t { Solved, Exhausted, SearchedOut };

  // Required-subset legs (Config::requiredCells) succeed once the required
  // ordinals are satisfied; full searches keep the exact-cover goal test.
  [[nodiscard]] bool legDone(const std::vector<Block> &blocks,
                             const boost::dynamic_bitset<> &ord) const {
    return requiredSubset_ ? requiredOrd_.is_subset_of(ord)
                           : a_.isGoalState(blocks, ord);
  }

  RoundResult runRound(const uint64_t round, std::vector<Turn> &solution) {
    constexpr uint64_t kRoundBaseCap = 150000;
    RoundState st;
    st.nodeCap = stats_.nodesExpanded + kRoundBaseCap * luby(round);
    st.roundSeed = static_cast<uint32_t>(cfg_.seed * 2654435761U + round);
    // Every third round drops the transit-distance term: the deterministic
    // guidance otherwise replays near-identical walks across restarts (the
    // jitter sits below distance and never gets to differ), so restarts
    // explored nothing new — measured on fuzz-7007's endgame, bestOrd was
    // bit-identical across seeds.
    st.diversify = round % 3 == 2;

    Frame rootFrame;
    rootFrame.blocks = root_.blocks;
    rootFrame.cells = root_.mustTouchCellsSatisfied;
    rootFrame.ord = rootOrd_;
    st.visited.emplace(a_.encodeStateOrdinal(rootFrame.blocks, rootFrame.ord));
    st.frames.push_back(std::move(rootFrame));
    scoreFrame(st.frames.back(), st);

    RoundResult result = RoundResult::SearchedOut;
    while (!st.frames.empty()) {
      const StepResult stepResult = step(st);
      if (stepResult != StepResult::Continue) {
        result = stepResult == StepResult::Solved ? RoundResult::Solved
                                                  : RoundResult::Exhausted;
        break;
      }
    }
    stats_.statesStored = st.visited.size();
    if (result == RoundResult::Solved) {
      stats_.wallMs = static_cast<uint32_t>(nowMs() - startMs_);
      std::cout << "Cracker (round " << round << ") found solution in "
                << st.path.size() << " moves, expanded "
                << stats_.nodesExpanded << " nodes\n";
      solution = std::move(st.path);
    }
    return result;
  }

  // One DFS step: take the top frame's next-best move, build the child,
  // run the prunes, and either descend or backtrack.
  StepResult step(RoundState &st) {
    Frame &top = st.frames.back();
    if (top.next >= top.moves.size()) {
      st.frames.pop_back();
      if (!st.path.empty()) {
        st.path.pop_back();
      }
      return StepResult::Continue;
    }
    const auto [order, bi, dir] = top.moves[top.next++];

    Frame child;
    child.blocks = top.blocks;
    Block &moved = child.blocks[bi];
    moved.roll(dir);
    child.cells = top.cells;
    child.ord = top.ord;
    a_.applyTouch(moved, child.cells, child.ord);

    if (!survivesPrunes(top, moved, bi, child, st.visited)) {
      return StepResult::Continue;
    }

    stats_.nodesExpanded++;
    if ((stats_.nodesExpanded & 0x3FFU) == 0 &&
        a_.budgetExhausted(deadline_, st.visited.size())) {
      return StepResult::Exhausted;
    }
    if (onProgress_ && stats_.nodesExpanded % 10000 == 0) {
      onProgress_(static_cast<uint32_t>(stats_.nodesExpanded));
    }

    st.path.push_back({.blockId = top.blocks[bi].id, .direction = dir});
    if (legDone(child.blocks, child.ord)) {
      return StepResult::Solved;
    }
    scoreFrame(child, st);
    st.frames.push_back(std::move(child));

    return stats_.nodesExpanded >= st.nodeCap ? StepResult::Exhausted
                                              : StepResult::Continue;
  }

  bool survivesPrunes(const Frame &parent, const Block &moved,
                      const uint8_t bi, const Frame &child, Table &visited) {
    if (orphansCell(moved, child.blocks, parent.cells, child.cells)) {
      return false;
    }
    if (const bool intactWanted =
            cfg_.coveragePartner != nullptr ||
            (cfg_.jointCoverageIntact && child.blocks.size() == 2);
        intactWanted && child.ord.count() != parent.ord.count()) {
      const Block *partner = cfg_.coveragePartner;
      if (partner == nullptr) {
        partner = &child.blocks[bi == 0 ? 1 : 0];
      }
      if (!coverageIntactOk(moved, *partner, child.cells,
                            child.ord.count())) {
        return false;
      }
    }
    if (!visited.emplace(a_.encodeStateOrdinal(child.blocks, child.ord))
             .second) {
      return false;
    }
    return a_.isReachable(parent.blocks, bi, moved, child.cells, child.ord);
  }

  // Order a frame's candidate moves: most fresh touches first, then
  // closest to the nearest remaining cell (beeline transit), then the
  // fewest onward options (finish corridors before they get walled off),
  // then a seeded jitter so restarts explore different tie orders.
  void scoreFrame(Frame &frame, const RoundState &st) {
    frame.moves.clear();
    rebuildField(frame.cells, frame.ord.count());
    for (size_t bi = 0; bi < frame.blocks.size(); bi++) {
      for (const auto dir : kDirs) {
        Block moved = frame.blocks[bi].clone();
        moved.roll(dir);
        if (!moved.checkValidity(gridWidth_, gridHeight_, cells_,
                                 frame.blocks, frame.cells)) {
          continue;
        }
        const uint32_t touched = touchedCount(moved, frame.cells);
        const uint32_t dist = touched > 0 ? 0 : fieldDistance(moved);
        const uint32_t onward = onwardOptions(moved, frame.cells);
        const uint32_t trample = trampleCount(moved, frame.cells);
        const uint32_t openness = opennessCount(moved, frame.cells);
        const uint32_t jitter = mixHash(
            st.roundSeed ^ static_cast<uint32_t>(moved.x) << 24 ^
            static_cast<uint32_t>(moved.y) << 16 ^
            static_cast<uint32_t>(bi) << 8 ^ std::to_underlying(dir));
        // Smaller sorts first: invert touches (footprints cap at 4096
        // cells), then subset-leg tramples (always 0 in full searches),
        // then openness (mow along the wall — touching a wide-open cell
        // carves peninsulas that strand later), then Warnsdorff's onward
        // count, then transit distance. Distance strictly BELOW onward:
        // distance-first walks straight into snake traps (measured: it
        // turned a solving cracker into one that found nothing on the
        // same board), while as a tie-break it replaces random jitter
        // with progress toward the remaining cells.
        const uint64_t order =
            static_cast<uint64_t>(4096 - std::min(touched, 4096U)) << 48 |
            static_cast<uint64_t>(std::min(trample, 15U)) << 44 |
            static_cast<uint64_t>(std::min(openness, 7U)) << 41 |
            static_cast<uint64_t>(onward) << 38 |
            (st.diversify
                 ? static_cast<uint64_t>(jitter >> 7)
                 : static_cast<uint64_t>(dist) << 26 | (jitter >> 7));
        frame.moves.push_back(
            {.order = order, .bi = static_cast<uint8_t>(bi), .dir = dir});
      }
    }
    std::ranges::sort(frame.moves, {}, &ScoredMove::order);
  }

  // Cheap onward-mobility count for Warnsdorff ordering: how many rolls the
  // moved block could take next, ignoring other blocks.
  [[nodiscard]] uint32_t
  onwardOptions(const Block &moved,
                const boost::dynamic_bitset<> &cellBits) const {
    uint32_t options = 0;
    for (const auto dir : kDirs) {
      Block next = moved.clone();
      next.roll(dir);
      if (rectPassable(next.x, next.y, next.width, next.depth, cellBits)) {
        options++;
      }
    }
    return options;
  }

  [[nodiscard]] uint32_t
  touchedCount(const Block &moved,
               const boost::dynamic_bitset<> &cellBits) const {
    uint32_t touched = 0;
    for (int8_t cx = moved.x; cx < moved.x + static_cast<int8_t>(moved.width);
         cx++) {
      for (int8_t cy = moved.y;
           cy < moved.y + static_cast<int8_t>(moved.depth); cy++) {
        if (const auto idx = positionToIndex(cx, cy, gridWidth_);
            cells_[idx] == Tile::MustTouch && !cellBits.test(idx) &&
            (!requiredSubset_ || requiredCellBits_.test(idx))) {
          touched++;
        }
      }
    }
    return touched;
  }

  // Cell-level Warnsdorff: how many unsatisfied must-touch neighbors the
  // cells satisfied by this move would leave behind. Low openness means the
  // move finishes an almost-enclosed cell (mowing along the wall); high
  // openness means carving through open area, which leaves peninsulas that
  // strand later. Found on fuzz-7007's dense blobs.
  [[nodiscard]] uint32_t
  opennessCount(const Block &moved,
                const boost::dynamic_bitset<> &prevCells) const {
    uint32_t open = 0;
    for (int8_t cx = moved.x; cx < moved.x + static_cast<int8_t>(moved.width);
         cx++) {
      for (int8_t cy = moved.y;
           cy < moved.y + static_cast<int8_t>(moved.depth); cy++) {
        if (const auto idx = positionToIndex(cx, cy, gridWidth_);
            cells_[idx] != Tile::MustTouch || prevCells.test(idx)) {
          continue;
        }
        open += openNeighbors(cx, cy, moved, prevCells);
      }
    }
    return open;
  }

  [[nodiscard]] uint32_t
  openNeighbors(const int cx, const int cy, const Block &moved,
                const boost::dynamic_bitset<> &prevCells) const {
    uint32_t open = 0;
    for (int d = 0; d < 4; d++) {
      constexpr std::array<int8_t, 4> dxs = {0, 0, 1, -1};
      constexpr std::array<int8_t, 4> dys = {1, -1, 0, 0};
      const int nx = cx + dxs[d];
      const int ny = cy + dys[d];
      if (nx < 0 || nx >= gridWidth_ || ny < 0 || ny >= gridHeight_ ||
          insideBlock(moved, nx, ny)) {
        continue;
      }
      if (const auto nidx = positionToIndex(static_cast<int8_t>(nx),
                                            static_cast<int8_t>(ny),
                                            gridWidth_);
          cells_[nidx] == Tile::MustTouch && !prevCells.test(nidx)) {
        open++;
      }
    }
    return open;
  }

  static bool insideBlock(const Block &b, const int px, const int py) {
    return px >= b.x && px < b.x + static_cast<int>(b.width) && py >= b.y &&
           py < b.y + static_cast<int>(b.depth);
  }

  // Subset legs only: fresh NON-required cells this move would trample.
  // Every trample turns a cell the partner (or a later leg) still needs
  // into a wall, so it ranks as a cost right below fresh required touches.
  [[nodiscard]] uint32_t
  trampleCount(const Block &moved,
               const boost::dynamic_bitset<> &cellBits) const {
    if (!requiredSubset_) {
      return 0U;
    }
    uint32_t trampled = 0;
    for (int8_t cx = moved.x; cx < moved.x + static_cast<int8_t>(moved.width);
         cx++) {
      for (int8_t cy = moved.y;
           cy < moved.y + static_cast<int8_t>(moved.depth); cy++) {
        if (const auto idx = positionToIndex(cx, cy, gridWidth_);
            cells_[idx] == Tile::MustTouch && !cellBits.test(idx) &&
            !requiredCellBits_.test(idx)) {
          trampled++;
        }
      }
    }
    return trampled;
  }

  // Rebuild the transit field: cell distance to the NEAREST unsatisfied
  // must-touch cell (multi-source BFS, satisfied cells are walls). Without
  // it every zero-touch move ordered purely by Warnsdorff + jitter and the
  // walk meandered enormously between touches — measured 3025-turn
  // solutions against 213-turn witnesses on a 56x43 fuzz board.
  void rebuildField(const boost::dynamic_bitset<> &cellBits,
                    const size_t satisfiedCount) {
    if (satisfiedCount == field_.builtCount) {
      return;
    }
    field_.builtCount = satisfiedCount;
    std::ranges::fill(field_.dist, UINT16_MAX);
    field_.frontier.clear();
    for (const auto &[mx, my, idx] : mustTouchIndices_) {
      if (!cellBits.test(idx) &&
          (!requiredSubset_ || requiredCellBits_.test(idx))) {
        field_.dist[idx] = 0;
        field_.frontier.push_back(idx);
      }
    }
    field_.live = !field_.frontier.empty();
    uint16_t depth = 0;
    while (!field_.frontier.empty()) {
      field_.next.clear();
      depth++;
      for (const uint16_t idx : field_.frontier) {
        spreadFieldFrom(idx, depth, cellBits);
      }
      field_.frontier.swap(field_.next);
    }
  }

  void spreadFieldFrom(const uint16_t idx, const uint16_t depth,
                       const boost::dynamic_bitset<> &cellBits) {
    forEachNeighbor(gridWidth_, gridHeight_, idx,
                    [this, depth, &cellBits](const uint16_t nidx) {
                      if (field_.dist[nidx] != UINT16_MAX ||
                          cells_[nidx] == Tile::Unplayable ||
                          (cells_[nidx] == Tile::MustTouch &&
                           cellBits.test(nidx))) {
                        return;
                      }
                      field_.dist[nidx] = depth;
                      field_.next.push_back(nidx);
                    });
  }

  [[nodiscard]] uint32_t fieldDistance(const Block &moved) const {
    if (!field_.live) {
      return 0;
    }
    uint32_t best = 0xFFF;
    for (int8_t cx = moved.x; cx < moved.x + static_cast<int8_t>(moved.width);
         cx++) {
      for (int8_t cy = moved.y;
           cy < moved.y + static_cast<int8_t>(moved.depth); cy++) {
        best = std::min(
            best, static_cast<uint32_t>(
                      field_.dist[positionToIndex(cx, cy, gridWidth_)]));
      }
    }
    return std::min(best, 0xFFFU);
  }

  [[nodiscard]] bool
  rectPassable(const int rx, const int ry, const int rw, const int rd,
               const boost::dynamic_bitset<> &satCells) const {
    if (rx < 0 || ry < 0 || rx + rw > gridWidth_ || ry + rd > gridHeight_) {
      return false;
    }
    for (int px = rx; px < rx + rw; px++) {
      for (int py = ry; py < ry + rd; py++) {
        const auto idx = positionToIndex(static_cast<int8_t>(px),
                                         static_cast<int8_t>(py), gridWidth_);
        if (cells_[idx] == Tile::Unplayable ||
            (cells_[idx] == Tile::MustTouch && satCells.test(idx))) {
          return false;
        }
      }
    }
    return true;
  }

  // Orphan prune. A move that satisfies cells may strand a neighboring
  // unsatisfied must-touch cell: to ever cover a cell, SOME all-passable
  // pose containing it must be enterable by a roll from another
  // all-passable pose. When no block has such a pose left the whole subtree
  // is dead. Found on fuzz-7007 (2x1x1 dominoes): a plain "has a passable
  // neighbor" test was not enough — standing a domino on an isolated cell
  // needs TWO consecutive free cells to roll up from.
  [[nodiscard]] bool orphansCell(const Block &moved,
                                 const std::vector<Block> &blocks,
                                 const boost::dynamic_bitset<> &prevCells,
                                 const boost::dynamic_bitset<> &newCells) const {
    for (int8_t cx = moved.x; cx < moved.x + static_cast<int8_t>(moved.width);
         cx++) {
      for (int8_t cy = moved.y;
           cy < moved.y + static_cast<int8_t>(moved.depth); cy++) {
        if (const auto idx = positionToIndex(cx, cy, gridWidth_);
            cells_[idx] != Tile::MustTouch || prevCells.test(idx)) {
          continue; // only cells THIS move newly satisfied can orphan
        }
        if (orphanedNeighbor(cx, cy, blocks, newCells)) {
          return true;
        }
      }
    }
    return false;
  }

  [[nodiscard]] bool
  orphanedNeighbor(const int cx, const int cy,
                   const std::vector<Block> &blocks,
                   const boost::dynamic_bitset<> &newCells) const {
    for (int d = 0; d < 4; d++) {
      constexpr std::array<int8_t, 4> dxs = {0, 0, 1, -1};
      constexpr std::array<int8_t, 4> dys = {1, -1, 0, 0};
      const int nx = cx + dxs[d];
      const int ny = cy + dys[d];
      if (nx < 0 || nx >= gridWidth_ || ny < 0 || ny >= gridHeight_) {
        continue;
      }
      if (const auto nidx = positionToIndex(static_cast<int8_t>(nx),
                                            static_cast<int8_t>(ny),
                                            gridWidth_);
          cells_[nidx] != Tile::MustTouch || newCells.test(nidx)) {
        continue;
      }
      if (!cellCoverable(nx, ny, blocks, newCells)) {
        return true;
      }
    }
    return false;
  }

  [[nodiscard]] bool
  cellCoverable(const int nx, const int ny, const std::vector<Block> &blocks,
                const boost::dynamic_bitset<> &satCells) const {
    // A block may stand ON satisfied cells (it satisfies on arrival and
    // stays until it rolls off) — a launch pose the generic enumeration
    // below rejects as impassable. One roll from a real current pose is
    // always enterable: without this, walking INTO a dead-end corridor's
    // last cell reads as orphaning it (broke fixtures 37/38/39).
    if (coverableByRoll(nx, ny, blocks, satCells)) {
      return true;
    }
    for (const auto &block : blocks) {
      const std::array<std::array<uint8_t, 3>, 6> orients = {{
          {block.width, block.depth, block.height},
          {block.depth, block.width, block.height},
          {block.width, block.height, block.depth},
          {block.height, block.width, block.depth},
          {block.depth, block.height, block.width},
          {block.height, block.depth, block.width},
      }};
      if (std::ranges::any_of(orients, [this, nx, ny, &satCells](
                                           const std::array<uint8_t, 3> &o) {
            return footprintCanEnter(nx, ny, o, satCells);
          })) {
        return true;
      }
    }
    return false;
  }

  [[nodiscard]] bool
  coverableByRoll(const int nx, const int ny,
                  const std::vector<Block> &blocks,
                  const boost::dynamic_bitset<> &satCells) const {
    for (const auto &block : blocks) {
      for (const auto dir : kDirs) {
        Block rolled = block.clone();
        rolled.roll(dir);
        if (rolled.x <= nx && nx < rolled.x + rolled.width &&
            rolled.y <= ny && ny < rolled.y + rolled.depth &&
            rectPassable(rolled.x, rolled.y, rolled.width, rolled.depth,
                         satCells)) {
          return true;
        }
      }
    }
    return false;
  }

  // Every top-left anchor whose footprint covers (nx, ny): the pose must be
  // all-passable and enterable by a roll from an all-passable pose.
  [[nodiscard]] bool
  footprintCanEnter(const int nx, const int ny,
                    const std::array<uint8_t, 3> &o,
                    const boost::dynamic_bitset<> &satCells) const {
    for (int rx = nx - o[0] + 1; rx <= nx; rx++) {
      for (int ry = ny - o[1] + 1; ry <= ny; ry++) {
        if (poseEnterable(rx, ry, o, satCells)) {
          return true;
        }
      }
    }
    return false;
  }

  [[nodiscard]] bool
  poseEnterable(const int rx, const int ry, const std::array<uint8_t, 3> &o,
                const boost::dynamic_bitset<> &satCells) const {
    if (!rectPassable(rx, ry, o[0], o[1], satCells)) {
      return false;
    }
    const Block pose(0, static_cast<int8_t>(rx), static_cast<int8_t>(ry),
                     o[0], o[1], o[2]);
    for (const auto dir : kDirs) {
      Block from = pose.clone();
      from.roll(dir);
      if (rectPassable(from.x, from.y, from.width, from.depth, satCells)) {
        return true;
      }
    }
    return false;
  }

  static PoseGraph buildPoseGraph(const Block &seed) {
    PoseGraph graph;
    // A dims multiset has at most 6 orientations; reserving up front means
    // findOrAdd never reallocates while the closure loop below holds
    // indices into the vectors.
    graph.orients.reserve(6);
    graph.trans.reserve(6);
    const auto findOrAdd = [&graph](const std::array<uint8_t, 3> &o) {
      for (size_t i = 0; i < graph.orients.size(); i++) {
        if (graph.orients[i] == o) {
          return static_cast<uint8_t>(i);
        }
      }
      graph.orients.push_back(o);
      graph.trans.emplace_back();
      return static_cast<uint8_t>(graph.orients.size() - 1);
    };
    graph.startOrient = findOrAdd({seed.width, seed.depth, seed.height});
    for (size_t o = 0; o < graph.orients.size(); o++) {
      const auto [w, d, h] = graph.orients[o];
      // Mirrors Block::roll — UP moves y by -h and swaps depth/height;
      // RIGHT moves x by +w and swaps width/height; DOWN moves y by +d and
      // swaps depth/height; LEFT moves x by -h and swaps width/height.
      // findOrAdd runs BEFORE any trans[o] access: `trans[o][k] = {...
      // findOrAdd(...)}` computes the element address first (the braced
      // RHS is an operator= argument, sequenced after the postfix
      // expression), so a push_back inside findOrAdd would leave the
      // assignment writing through a dangling pointer — glibc aborted on
      // exactly that (heap-use-after-free, found by ASan on fixture 34).
      const uint8_t vertical = findOrAdd({w, h, d});
      const uint8_t horizontal = findOrAdd({h, d, w});
      graph.trans[o][0] = {.dx = 0, .dy = static_cast<int8_t>(-h),
                           .next = vertical};
      graph.trans[o][1] = {.dx = static_cast<int8_t>(w), .dy = 0,
                           .next = horizontal};
      graph.trans[o][2] = {.dx = 0, .dy = static_cast<int8_t>(d),
                           .next = vertical};
      graph.trans[o][3] = {.dx = static_cast<int8_t>(-h), .dy = 0,
                           .next = horizontal};
    }
    return graph;
  }

  static int findOrient(const PoseGraph &graph, const Block &b) {
    for (size_t i = 0; i < graph.orients.size(); i++) {
      // All three dims must match: two different blocks can share a
      // footprint while standing at different heights (graph rebuilds are
      // trivial, silent cross-block matches are not).
      if (graph.orients[i][0] == b.width && graph.orients[i][1] == b.depth &&
          graph.orients[i][2] == b.height) {
        return static_cast<int>(i);
      }
    }
    return -1;
  }

  // Coverage-intact prune (Config::coveragePartner): after a touching
  // move, EVERY still-open must-touch cell must remain coverable by the
  // searching block from its new pose or by the parked partner — a
  // two-seed pose-space BFS over the same wall graph (the seeds share it,
  // so one visited-set serves both). Only touch moves are checked; transit
  // moves add no walls. This is what makes dense-blob sweeps back out of
  // lines that wall off whole regions (fuzz-7007).
  bool coverageIntactOk(const Block &from, const Block &partner,
                        const boost::dynamic_bitset<> &satCells,
                        const size_t satisfiedCount) {
    cover_.need =
        static_cast<uint32_t>(mustTouchIndices_.size() - satisfiedCount);
    if (cover_.need == 0) {
      return true;
    }
    // The leg's own targets must stay coverable by THIS block — the
    // partner cannot finish this leg. Checked against the active seed's
    // BFS below; failing it prunes the subtree immediately instead of
    // letting the leg search for the impossible until its budget dies.
    cover_.requiredNeed = 0;
    if (cfg_.requiredCells != nullptr) {
      for (const uint16_t cell : *cfg_.requiredCells) {
        // Gate on the same predicate requiredCellBits_ was built with:
        // requiredGot below only counts cells in that bitset, so a
        // requiredCells entry that is not a must-touch cell must not
        // inflate the need and prune every branch.
        if (requiredCellBits_.test(cell) && !satCells.test(cell)) {
          cover_.requiredNeed++;
        }
      }
    }
    // 12 orientation slots: two seed blocks x up to 6 orientations each.
    if (cover_.poseStamp.size() != totalCells_ * 12) {
      cover_.poseStamp.assign(totalCells_ * 12, 0);
      cover_.coverStamp.assign(totalCells_, 0);
      cover_.epoch = 0;
    }
    ++cover_.epoch;
    if (cover_.epoch == 0) {
      std::ranges::fill(cover_.poseStamp, 0);
      std::ranges::fill(cover_.coverStamp, 0);
      cover_.epoch = 1;
    }
    cover_.got = 0;
    cover_.requiredGot = 0;
    int activeOrient = findOrient(cover_.activeGraph, from);
    if (activeOrient < 0) {
      cover_.activeGraph = buildPoseGraph(from);
      activeOrient = cover_.activeGraph.startOrient;
    }
    if (runCoverBfs(cover_.activeGraph, static_cast<uint8_t>(activeOrient),
                    from.x, from.y, 0, satCells)) {
      return true;
    }
    if (cover_.requiredGot < cover_.requiredNeed) {
      return false; // a leg target escaped the active block for good
    }
    int partnerOrient =
        cover_.partnerBuilt ? findOrient(cover_.partnerGraph, partner) : -1;
    if (partnerOrient < 0) {
      cover_.partnerGraph = buildPoseGraph(partner);
      cover_.partnerBuilt = true;
      partnerOrient = cover_.partnerGraph.startOrient;
    }
    return runCoverBfs(cover_.partnerGraph,
                       static_cast<uint8_t>(partnerOrient), partner.x,
                       partner.y, 6, satCells);
  }

  // state encoding: (orientBase + orient) * totalCells + cellIdx
  bool runCoverBfs(const PoseGraph &graph, const uint8_t orient0,
                   const int8_t x0, const int8_t y0, const size_t orientBase,
                   const boost::dynamic_bitset<> &satCells) {
    cover_.frontier.clear();
    const auto seedState = static_cast<uint32_t>(
        (orientBase + orient0) * totalCells_ + static_cast<size_t>(x0) +
        static_cast<size_t>(y0) * gridWidth_);
    auto &seedStamp = cover_.poseStamp[seedState];
    if (seedStamp == cover_.epoch) {
      return false; // partner pose already swept by the first seed
    }
    seedStamp = cover_.epoch;
    if (markPoseCover(x0, y0, graph.orients[orient0], satCells)) {
      return true;
    }
    cover_.frontier.push_back(seedState);
    while (!cover_.frontier.empty()) {
      cover_.next.clear();
      if (std::ranges::any_of(cover_.frontier,
                              [this, &graph, orientBase,
                               &satCells](const uint32_t state) {
                                return expandPoseState(graph, state,
                                                       orientBase, satCells);
                              })) {
        return true;
      }
      cover_.frontier.swap(cover_.next);
    }
    return false;
  }

  bool expandPoseState(const PoseGraph &graph, const uint32_t state,
                       const size_t orientBase,
                       const boost::dynamic_bitset<> &satCells) {
    const size_t orient = state / totalCells_ - orientBase;
    const size_t cell = state % totalCells_;
    const auto cx = static_cast<int>(cell % gridWidth_);
    const auto cy = static_cast<int>(cell / gridWidth_);
    for (const auto &[dx, dy, nextOrient] : graph.trans[orient]) {
      const int nx = cx + dx;
      const int ny = cy + dy;
      const auto &no = graph.orients[nextOrient];
      if (!poseRectPassable(nx, ny, no, satCells)) {
        continue;
      }
      const auto nextState = static_cast<uint32_t>(
          (orientBase + nextOrient) * totalCells_ + static_cast<size_t>(nx) +
          static_cast<size_t>(ny) * gridWidth_);
      auto &stamp = cover_.poseStamp[nextState];
      if (stamp == cover_.epoch) {
        continue;
      }
      stamp = cover_.epoch;
      if (markPoseCover(nx, ny, no, satCells)) {
        return true;
      }
      cover_.next.push_back(nextState);
    }
    return false;
  }

  // Unlike rectPassable, the coverage BFS treats EVERY satisfied cell as a
  // wall directly (the set only ever holds must-touch cells).
  [[nodiscard]] bool
  poseRectPassable(const int rx, const int ry, const std::array<uint8_t, 3> &o,
                   const boost::dynamic_bitset<> &satCells) const {
    if (rx < 0 || ry < 0 || rx + o[0] > gridWidth_ ||
        ry + o[1] > gridHeight_) {
      return false;
    }
    for (int px = rx; px < rx + o[0]; px++) {
      for (int py = ry; py < ry + o[1]; py++) {
        const auto idx = positionToIndex(static_cast<int8_t>(px),
                                         static_cast<int8_t>(py), gridWidth_);
        if (cells_[idx] == Tile::Unplayable || satCells.test(idx)) {
          return false;
        }
      }
    }
    return true;
  }

  bool markPoseCover(const int rx, const int ry,
                     const std::array<uint8_t, 3> &o,
                     const boost::dynamic_bitset<> &satCells) {
    for (int px = rx; px < rx + o[0]; px++) {
      for (int py = ry; py < ry + o[1]; py++) {
        const auto idx = positionToIndex(static_cast<int8_t>(px),
                                         static_cast<int8_t>(py), gridWidth_);
        if (cover_.coverStamp[idx] == cover_.epoch) {
          continue;
        }
        cover_.coverStamp[idx] = cover_.epoch;
        if (cells_[idx] != Tile::MustTouch || satCells.test(idx)) {
          continue;
        }
        cover_.got++;
        if (requiredSubset_ && requiredCellBits_.test(idx)) {
          cover_.requiredGot++;
        }
      }
    }
    return cover_.got == cover_.need;
  }

  AStar &a_;
  const Config &cfg_;
  const std::vector<Tile> &cells_;
  const std::vector<MustTouchEntry> &mustTouchIndices_;
  const boost::dynamic_bitset<> &requiredCellBits_;
  const boost::dynamic_bitset<> &requiredOrd_;
  const bool requiredSubset_;
  SearchStats &stats_;
  const std::function<void(uint32_t)> &onProgress_;
  const uint8_t gridWidth_;
  const uint8_t gridHeight_;
  const Node &root_;
  const boost::dynamic_bitset<> &rootOrd_;
  const uint64_t startMs_;
  const uint64_t deadline_;
  const size_t totalCells_;

  // Transit guidance field (see rebuildField). Cache key: the satisfied
  // count. Two branches with equal counts but different sets share a
  // slightly stale field — acceptable, the field only orders moves
  // (legality never consults it) and rebuilding per frame was measured 12x
  // slower per node.
  struct TransitField {
    std::vector<uint16_t> dist;
    std::vector<uint16_t> frontier;
    std::vector<uint16_t> next;
    bool live = false;
    size_t builtCount = SIZE_MAX;
  };
  TransitField field_;

  // Pose-space BFS scratch for the coverage-intact prune, plus the
  // per-check tallies.
  struct CoverScratch {
    PoseGraph activeGraph; // rebuilt lazily when the moved block's dims change
    PoseGraph partnerGraph;
    bool partnerBuilt = false;
    std::vector<uint32_t> poseStamp;
    std::vector<uint32_t> coverStamp;
    uint32_t epoch = 0;
    std::vector<uint32_t> frontier;
    std::vector<uint32_t> next;
    uint32_t need = 0;
    uint32_t got = 0;
    uint32_t requiredNeed = 0;
    uint32_t requiredGot = 0;
  };
  CoverScratch cover_;
};

std::vector<Turn> AStar::searchCracker(Node root) {
  const uint64_t startMs = nowMs();
  const uint64_t deadline = deadlineFrom(cfg_.maxMs);

  boost::dynamic_bitset<> rootOrd;
  if (!prepareSearch(root, rootOrd)) {
    return {};
  }
  CrackerRun cracker(*this, root, rootOrd, startMs, deadline);
  return cracker.run();
}
