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

} // namespace

std::vector<Turn> AStar::searchCracker(Node root) {
  const uint64_t startMs = nowMs();
  const uint64_t deadline = deadlineFrom(cfg_.maxMs);

  boost::dynamic_bitset<> rootOrd;
  if (!prepareSearch(root, rootOrd)) {
    return {};
  }

  // Required-subset legs (Config::requiredCells) succeed once the required
  // ordinals are satisfied; full searches keep the exact-cover goal test.
  const auto legDone = [this](const std::vector<Block> &blocks,
                              const boost::dynamic_bitset<> &ord) {
    return requiredSubset_ ? requiredOrd_.is_subset_of(ord)
                           : isGoalState(blocks, ord);
  };

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
  };

  constexpr std::array kDirs = {Direction::UP, Direction::RIGHT,
                                Direction::DOWN, Direction::LEFT};
  constexpr uint64_t kRoundBaseCap = 150000;

  // Cheap onward-mobility count for Warnsdorff ordering: how many rolls the
  // moved block could take next, ignoring other blocks.
  const auto onwardOptions = [&](const Block &moved,
                                 const boost::dynamic_bitset<> &cellBits) {
    uint32_t options = 0;
    for (const auto dir : kDirs) {
      Block next = moved.clone();
      next.roll(dir);
      if (next.x < 0 || next.y < 0 || next.x + next.width > gridWidth_ ||
          next.y + next.depth > gridHeight_) {
        continue;
      }
      bool blocked = false;
      for (int8_t cx = next.x;
           !blocked && cx < next.x + static_cast<int8_t>(next.width); cx++) {
        for (int8_t cy = next.y;
             cy < next.y + static_cast<int8_t>(next.depth); cy++) {
          const auto idx = positionToIndex(cx, cy, gridWidth_);
          if (cells_[idx] == Tile::Unplayable ||
              (cells_[idx] == Tile::MustTouch && cellBits.test(idx))) {
            blocked = true;
            break;
          }
        }
      }
      if (!blocked) {
        options++;
      }
    }
    return options;
  };

  const auto touchedCount = [&](const Block &moved,
                                const boost::dynamic_bitset<> &cellBits) {
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
  };

  // Cell-level Warnsdorff: how many unsatisfied must-touch neighbours the
  // cells satisfied by this move would leave behind. Low openness means the
  // move finishes an almost-enclosed cell (mowing along the wall); high
  // openness means carving through open area, which leaves peninsulas that
  // strand later. Found on fuzz-7007's dense blobs.
  const auto opennessCount = [&](const Block &moved,
                                 const boost::dynamic_bitset<> &prevCells) {
    constexpr std::array<int8_t, 4> dxs = {0, 0, 1, -1};
    constexpr std::array<int8_t, 4> dys = {1, -1, 0, 0};
    const auto insideMoved = [&](const int px, const int py) {
      return px >= moved.x && px < moved.x + static_cast<int>(moved.width) &&
             py >= moved.y && py < moved.y + static_cast<int>(moved.depth);
    };
    uint32_t open = 0;
    for (int8_t cx = moved.x; cx < moved.x + static_cast<int8_t>(moved.width);
         cx++) {
      for (int8_t cy = moved.y;
           cy < moved.y + static_cast<int8_t>(moved.depth); cy++) {
        const auto idx = positionToIndex(cx, cy, gridWidth_);
        if (cells_[idx] != Tile::MustTouch || prevCells.test(idx)) {
          continue;
        }
        for (int d = 0; d < 4; d++) {
          const int nx = cx + dxs[d];
          const int ny = cy + dys[d];
          if (nx < 0 || nx >= gridWidth_ || ny < 0 || ny >= gridHeight_ ||
              insideMoved(nx, ny)) {
            continue;
          }
          const auto nidx = positionToIndex(
              static_cast<int8_t>(nx), static_cast<int8_t>(ny), gridWidth_);
          if (cells_[nidx] == Tile::MustTouch && !prevCells.test(nidx)) {
            open++;
          }
        }
      }
    }
    return open;
  };

  // Subset legs only: fresh NON-required cells this move would trample.
  // Every trample turns a cell the partner (or a later leg) still needs
  // into a wall, so it ranks as a cost right below fresh required touches.
  const auto trampleCount = [&](const Block &moved,
                                const boost::dynamic_bitset<> &cellBits) {
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
  };

  // Transit guidance: cell distance to the NEAREST unsatisfied must-touch
  // cell (multi-source BFS, satisfied cells are walls). Without it every
  // zero-touch move ordered purely by Warnsdorff + jitter and the walk
  // meandered enormously between touches — measured 3025-turn solutions
  // against 213-turn witnesses on a 56x43 fuzz board.
  const size_t totalCells = static_cast<size_t>(gridWidth_) * gridHeight_;
  std::vector<uint16_t> field(totalCells, UINT16_MAX);
  std::vector<uint16_t> fieldFrontier;
  std::vector<uint16_t> fieldNext;
  bool fieldLive = false;
  // Cache key: the satisfied count. Two branches with equal counts but
  // different sets share a slightly stale field — acceptable, the field only
  // orders moves (legality never consults it) and rebuilding per frame was
  // measured 12x slower per node.
  size_t fieldBuiltCount = SIZE_MAX;
  const auto rebuildField = [&](const boost::dynamic_bitset<> &cellBits,
                                const size_t satisfiedCount) {
    if (satisfiedCount == fieldBuiltCount) {
      return;
    }
    fieldBuiltCount = satisfiedCount;
    std::ranges::fill(field, UINT16_MAX);
    fieldFrontier.clear();
    for (const auto &[mx, my, idx] : mustTouchIndices_) {
      if (!cellBits.test(idx) &&
          (!requiredSubset_ || requiredCellBits_.test(idx))) {
        field[idx] = 0;
        fieldFrontier.push_back(idx);
      }
    }
    fieldLive = !fieldFrontier.empty();
    uint16_t depth = 0;
    while (!fieldFrontier.empty()) {
      fieldNext.clear();
      depth++;
      for (const uint16_t idx : fieldFrontier) {
        const auto cx = static_cast<int8_t>(idx % gridWidth_);
        const auto cy = static_cast<int8_t>(idx / gridWidth_);
        for (int d = 0; d < 4; d++) {
          constexpr std::array<int8_t, 4> dy = {1, -1, 0, 0};
          constexpr std::array<int8_t, 4> dx = {0, 0, 1, -1};
          const auto nx = static_cast<int8_t>(cx + dx[d]);
          const auto ny = static_cast<int8_t>(cy + dy[d]);
          if (nx < 0 || nx >= gridWidth_ || ny < 0 || ny >= gridHeight_) {
            continue;
          }
          const auto nidx = positionToIndex(nx, ny, gridWidth_);
          if (field[nidx] != UINT16_MAX ||
              cells_[nidx] == Tile::Unplayable ||
              (cells_[nidx] == Tile::MustTouch && cellBits.test(nidx))) {
            continue;
          }
          field[nidx] = depth;
          fieldNext.push_back(nidx);
        }
      }
      fieldFrontier.swap(fieldNext);
    }
  };
  // Orphan prune. A move that satisfies cells may strand a neighbouring
  // unsatisfied must-touch cell: to ever cover a cell, SOME all-passable
  // pose containing it must be enterable by a roll from another
  // all-passable pose. When no block has such a pose left the whole subtree
  // is dead. Found on fuzz-7007 (2x1x1 dominoes): a plain "has a passable
  // neighbour" test was not enough — standing a domino on an isolated cell
  // needs TWO consecutive free cells to roll up from.
  const auto rectPassable = [&](const int rx, const int ry, const int rw,
                                const int rd,
                                const boost::dynamic_bitset<> &satCells) {
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
  };
  const auto cellCoverable = [&](const int nx, const int ny,
                                 const std::vector<Block> &blocks,
                                 const boost::dynamic_bitset<> &satCells) {
    // A block may stand ON satisfied cells (it satisfies on arrival and
    // stays until it rolls off) — a launch pose the generic enumeration
    // below rejects as impassable. One roll from a real current pose is
    // always enterable: without this, walking INTO a dead-end corridor's
    // last cell reads as orphaning it (broke fixtures 37/38/39).
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
    for (const auto &block : blocks) {
      const std::array<std::array<uint8_t, 3>, 6> orients = {{
          {block.width, block.depth, block.height},
          {block.depth, block.width, block.height},
          {block.width, block.height, block.depth},
          {block.height, block.width, block.depth},
          {block.depth, block.height, block.width},
          {block.height, block.depth, block.width},
      }};
      for (const auto &o : orients) {
        const int fw = o[0];
        const int fd = o[1];
        for (int rx = nx - fw + 1; rx <= nx; rx++) {
          for (int ry = ny - fd + 1; ry <= ny; ry++) {
            if (!rectPassable(rx, ry, fw, fd, satCells)) {
              continue;
            }
            Block pose(0, static_cast<int8_t>(rx), static_cast<int8_t>(ry),
                       static_cast<uint8_t>(fw), static_cast<uint8_t>(fd),
                       o[2]);
            for (const auto dir : kDirs) {
              Block from = pose.clone();
              from.roll(dir);
              if (rectPassable(from.x, from.y, from.width, from.depth,
                               satCells)) {
                return true;
              }
            }
          }
        }
      }
    }
    return false;
  };
  const auto orphansCell = [&](const Block &moved,
                               const std::vector<Block> &blocks,
                               const boost::dynamic_bitset<> &prevCells,
                               const boost::dynamic_bitset<> &newCells) {
    constexpr std::array<int8_t, 4> dxs = {0, 0, 1, -1};
    constexpr std::array<int8_t, 4> dys = {1, -1, 0, 0};
    for (int8_t cx = moved.x; cx < moved.x + static_cast<int8_t>(moved.width);
         cx++) {
      for (int8_t cy = moved.y;
           cy < moved.y + static_cast<int8_t>(moved.depth); cy++) {
        const auto idx = positionToIndex(cx, cy, gridWidth_);
        if (cells_[idx] != Tile::MustTouch || prevCells.test(idx)) {
          continue; // only cells THIS move newly satisfied can orphan
        }
        for (int d = 0; d < 4; d++) {
          const int nx = cx + dxs[d];
          const int ny = cy + dys[d];
          if (nx < 0 || nx >= gridWidth_ || ny < 0 || ny >= gridHeight_) {
            continue;
          }
          const auto nidx = positionToIndex(static_cast<int8_t>(nx),
                                            static_cast<int8_t>(ny),
                                            gridWidth_);
          if (cells_[nidx] != Tile::MustTouch || newCells.test(nidx)) {
            continue;
          }
          if (!cellCoverable(nx, ny, blocks, newCells)) {
            return true;
          }
        }
      }
    }
    return false;
  };

  // Coverage-intact prune (Config::coveragePartner): after a touching
  // move, EVERY still-open must-touch cell must remain coverable by the
  // searching block from its new pose or by the parked partner — a
  // two-seed pose-space BFS over the same wall graph (the seeds share it,
  // so one visited-set serves both). Only touch moves are checked; transit
  // moves add no walls. This is what makes dense-blob sweeps back out of
  // lines that wall off whole regions (fuzz-7007). The orientation closure
  // and roll deltas are precomputed per seed block: a roll's effect depends
  // only on the (w,d,h) triple, so BFS states are plain ints.
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
  const auto buildPoseGraph = [](const Block &seed) {
    PoseGraph graph;
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
      // Mirrors Block::roll: UP y-=h swap(d,h); RIGHT x+=w swap(w,h);
      // DOWN y+=d swap(d,h); LEFT x-=h swap(w,h).
      graph.trans[o][0] = {0, static_cast<int8_t>(-h), findOrAdd({w, h, d})};
      graph.trans[o][1] = {static_cast<int8_t>(w), 0, findOrAdd({h, d, w})};
      graph.trans[o][2] = {0, static_cast<int8_t>(d), findOrAdd({w, h, d})};
      graph.trans[o][3] = {static_cast<int8_t>(-h), 0, findOrAdd({h, d, w})};
    }
    return graph;
  };
  PoseGraph activeGraph; // rebuilt lazily when the moved block's dims change
  PoseGraph partnerGraph;
  bool partnerGraphBuilt = false;

  std::vector<uint32_t> poseStamp;
  std::vector<uint32_t> coverStamp;
  uint32_t poseEpoch = 0;
  std::vector<uint32_t> poseFrontier;
  std::vector<uint32_t> poseNext;
  const auto findOrient = [](const PoseGraph &graph, const Block &b) -> int {
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
  };
  const auto coverageIntactOk = [&](const Block &from, const Block &partner,
                                    const boost::dynamic_bitset<> &satCells,
                                    const size_t satisfiedCount) {
    const auto need =
        static_cast<uint32_t>(mustTouchIndices_.size() - satisfiedCount);
    if (need == 0) {
      return true;
    }
    // The leg's own targets must stay coverable by THIS block — the
    // partner cannot finish this leg. Checked against the active seed's
    // BFS below; failing it prunes the subtree immediately instead of
    // letting the leg search for the impossible until its budget dies.
    uint32_t requiredNeed = 0;
    if (cfg_.requiredCells != nullptr) {
      for (const uint16_t cell : *cfg_.requiredCells) {
        if (!satCells.test(cell)) {
          requiredNeed++;
        }
      }
    }
    // 12 orientation slots: two seed blocks x up to 6 orientations each.
    if (poseStamp.size() != totalCells * 12) {
      poseStamp.assign(totalCells * 12, 0);
      coverStamp.assign(totalCells, 0);
      poseEpoch = 0;
    }
    ++poseEpoch;
    if (poseEpoch == 0) {
      std::ranges::fill(poseStamp, 0);
      std::ranges::fill(coverStamp, 0);
      poseEpoch = 1;
    }
    uint32_t got = 0;
    uint32_t requiredGot = 0;
    // state encoding: (orientBase + orient) * totalCells + cellIdx
    const auto runBfs = [&](const PoseGraph &graph, const uint8_t orient0,
                            const int8_t x0, const int8_t y0,
                            const size_t orientBase) {
      const auto rectPassableAt = [&](const int rx, const int ry,
                                      const std::array<uint8_t, 3> &o) {
        if (rx < 0 || ry < 0 || rx + o[0] > gridWidth_ ||
            ry + o[1] > gridHeight_) {
          return false;
        }
        for (int px = rx; px < rx + o[0]; px++) {
          for (int py = ry; py < ry + o[1]; py++) {
            const auto idx = positionToIndex(static_cast<int8_t>(px),
                                             static_cast<int8_t>(py),
                                             gridWidth_);
            if (cells_[idx] == Tile::Unplayable || satCells.test(idx)) {
              return false;
            }
          }
        }
        return true;
      };
      const auto markCover = [&](const int rx, const int ry,
                                 const std::array<uint8_t, 3> &o) {
        for (int px = rx; px < rx + o[0]; px++) {
          for (int py = ry; py < ry + o[1]; py++) {
            const auto idx = positionToIndex(static_cast<int8_t>(px),
                                             static_cast<int8_t>(py),
                                             gridWidth_);
            if (coverStamp[idx] != poseEpoch) {
              coverStamp[idx] = poseEpoch;
              if (cells_[idx] == Tile::MustTouch && !satCells.test(idx)) {
                got++;
                if (requiredSubset_ && requiredCellBits_.test(idx)) {
                  requiredGot++;
                }
              }
            }
          }
        }
        return got == need;
      };
      poseFrontier.clear();
      const auto seedState = static_cast<uint32_t>(
          (orientBase + orient0) * totalCells +
          static_cast<size_t>(x0) + static_cast<size_t>(y0) * gridWidth_);
      auto &seedStamp = poseStamp[seedState];
      if (seedStamp == poseEpoch) {
        return false; // partner pose already swept by the first seed
      }
      seedStamp = poseEpoch;
      if (markCover(x0, y0, graph.orients[orient0])) {
        return true;
      }
      poseFrontier.push_back(seedState);
      while (!poseFrontier.empty()) {
        poseNext.clear();
        for (const uint32_t state : poseFrontier) {
          const size_t orient = state / totalCells - orientBase;
          const size_t cell = state % totalCells;
          const int cx = static_cast<int>(cell % gridWidth_);
          const int cy = static_cast<int>(cell / gridWidth_);
          for (const auto &tr : graph.trans[orient]) {
            const int nx = cx + tr.dx;
            const int ny = cy + tr.dy;
            const auto &no = graph.orients[tr.next];
            if (!rectPassableAt(nx, ny, no)) {
              continue;
            }
            const auto nextState = static_cast<uint32_t>(
                (orientBase + tr.next) * totalCells +
                static_cast<size_t>(nx) +
                static_cast<size_t>(ny) * gridWidth_);
            auto &stamp = poseStamp[nextState];
            if (stamp == poseEpoch) {
              continue;
            }
            stamp = poseEpoch;
            if (markCover(nx, ny, no)) {
              return true;
            }
            poseNext.push_back(nextState);
          }
        }
        poseFrontier.swap(poseNext);
      }
      return false;
    };

    int activeOrient = findOrient(activeGraph, from);
    if (activeOrient < 0) {
      activeGraph = buildPoseGraph(from);
      activeOrient = activeGraph.startOrient;
    }
    if (runBfs(activeGraph, static_cast<uint8_t>(activeOrient), from.x,
               from.y, 0)) {
      return true;
    }
    if (requiredGot < requiredNeed) {
      return false; // a leg target escaped the active block for good
    }
    int partnerOrient = partnerGraphBuilt ? findOrient(partnerGraph, partner)
                                          : -1;
    if (partnerOrient < 0) {
      partnerGraph = buildPoseGraph(partner);
      partnerGraphBuilt = true;
      partnerOrient = partnerGraph.startOrient;
    }
    return runBfs(partnerGraph, static_cast<uint8_t>(partnerOrient),
                  partner.x, partner.y, 6);
  };

  const auto fieldDistance = [&](const Block &moved) -> uint32_t {
    if (!fieldLive) {
      return 0;
    }
    uint32_t best = 0xFFF;
    for (int8_t cx = moved.x; cx < moved.x + static_cast<int8_t>(moved.width);
         cx++) {
      for (int8_t cy = moved.y;
           cy < moved.y + static_cast<int8_t>(moved.depth); cy++) {
        best = std::min(
            best, static_cast<uint32_t>(
                      field[positionToIndex(cx, cy, gridWidth_)]));
      }
    }
    return std::min(best, 0xFFFU);
  };

  for (uint64_t round = 1;; round++) {
    if (budgetExhausted(deadline, 0)) {
      break;
    }
    const uint64_t roundCap =
        stats_.nodesExpanded + kRoundBaseCap * luby(round);
    const uint32_t roundSeed = cfg_.seed * 2654435761U + round;
    // Every third round drops the transit-distance term: the deterministic
    // guidance otherwise replays near-identical walks across restarts (the
    // jitter sits below distance and never gets to differ), so restarts
    // explored nothing new — measured on fuzz-7007's endgame, bestOrd was
    // bit-identical across seeds.
    const bool diversifyRound = round % 3 == 2;

    Table visited;
    std::vector<Frame> frames;
    std::vector<Turn> path;

    Frame rootFrame{root.blocks, root.mustTouchCellsSatisfied, rootOrd, {}, 0};
    visited.emplace(encodeStateOrdinal(rootFrame.blocks, rootFrame.ord));
    if (legDone(rootFrame.blocks, rootFrame.ord)) {
      return {};
    }
    frames.push_back(std::move(rootFrame));

    // Order a frame's candidate moves: most fresh touches first, then
    // closest to the nearest remaining cell (beeline transit), then the
    // fewest onward options (finish corridors before they get walled off),
    // then a seeded jitter so restarts explore different tie orders.
    const auto scoreFrame = [&](Frame &frame) {
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
              roundSeed ^ static_cast<uint32_t>(moved.x) << 24 ^
              static_cast<uint32_t>(moved.y) << 16 ^
              static_cast<uint32_t>(bi) << 8 ^ static_cast<uint32_t>(dir));
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
              (diversifyRound
                   ? static_cast<uint64_t>(jitter >> 7)
                   : static_cast<uint64_t>(dist) << 26 | (jitter >> 7));
          frame.moves.push_back({order, static_cast<uint8_t>(bi), dir});
        }
      }
      std::ranges::sort(frame.moves, {}, &ScoredMove::order);
    };
    scoreFrame(frames.back());

    bool roundExhausted = false;
    while (!frames.empty() && !roundExhausted) {
      Frame &frame = frames.back();
      if (frame.next >= frame.moves.size()) {
        frames.pop_back();
        if (!path.empty()) {
          path.pop_back();
        }
        continue;
      }
      const ScoredMove move = frame.moves[frame.next++];

      Frame child;
      child.blocks = frame.blocks;
      Block &moved = child.blocks[move.bi];
      moved.roll(move.dir);
      child.cells = frame.cells;
      child.ord = frame.ord;
      applyTouch(moved, child.cells, child.ord);

      if (orphansCell(moved, child.blocks, frame.cells, child.cells)) {
        continue;
      }
      if (const bool intactWanted =
              cfg_.coveragePartner != nullptr ||
              (cfg_.jointCoverageIntact && child.blocks.size() == 2);
          intactWanted && child.ord.count() != frame.ord.count()) {
        const Block &partner = cfg_.coveragePartner != nullptr
                                   ? *cfg_.coveragePartner
                                   : child.blocks[move.bi == 0 ? 1 : 0];
        if (!coverageIntactOk(moved, partner, child.cells,
                              child.ord.count())) {
          continue;
        }
      }
      if (!visited.emplace(encodeStateOrdinal(child.blocks, child.ord))
               .second) {
        continue;
      }
      if (!isReachable(frame.blocks, move.bi, moved, child.cells, child.ord)) {
        continue;
      }

      stats_.nodesExpanded++;
      if ((stats_.nodesExpanded & 0x3FFU) == 0 &&
          budgetExhausted(deadline, visited.size())) {
        roundExhausted = true;
        break;
      }
      if (onProgress && stats_.nodesExpanded % 10000 == 0) {
        onProgress(static_cast<uint32_t>(stats_.nodesExpanded));
      }

      path.push_back({frame.blocks[move.bi].id, move.dir});
      if (legDone(child.blocks, child.ord)) {
        stats_.statesStored = visited.size();
        stats_.wallMs = static_cast<uint32_t>(nowMs() - startMs);
        std::cout << "Cracker (round " << round << ") found solution in "
                  << path.size() << " moves, expanded " << stats_.nodesExpanded
                  << " nodes\n";
        return path;
      }
      scoreFrame(child);
      frames.push_back(std::move(child));

      if (stats_.nodesExpanded >= roundCap) {
        roundExhausted = true;
      }
    }

    stats_.statesStored = visited.size();
    if (!roundExhausted) {
      // The whole reachable space under this ordering is exhausted; more
      // rounds would only reshuffle it.
      break;
    }
  }

  stats_.wallMs = static_cast<uint32_t>(nowMs() - startMs);
  std::cout << "Cracker found no solution\n";
  return {};
}
