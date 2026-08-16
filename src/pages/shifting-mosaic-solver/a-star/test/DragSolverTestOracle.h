#pragma once

#include "DragSolver.h"
#include "SeededRng.h"
#include "Types.h"

#include <array>
#include <cstdint>
#include <cstdlib>
#include <functional>
#include <map>
#include <queue>
#include <random>
#include <string>
#include <utility>
#include <vector>

// Brute-force oracles shared by the DragSolver test TUs.
//
// Every check in those files compares against a deliberately independent
// implementation: scalar cell-set collision tests, a reference anchor BFS,
// and an exhaustive drag-space BFS that yields provably minimal drag counts
// on tiny puzzles. The last one doubles as the heuristic-admissibility test —
// weight-1 A* with an admissible consistent h must return exactly its
// optimum, so the oracle must never share code with the solver.

// Per-test RNG seed, overridable with SHIFTING_MOSAIC_TEST_SEED.
//
// The default is the caller's fixed constant, so a failing board stays
// reproducible from the test name alone — that is the whole reason these
// suites seed deterministically. Setting the env var re-runs the same suites
// over a different slice of the puzzle space, which is how you widen fuzz
// coverage without editing the tests. (It also stops the seed being a literal
// constant, which is what cert-msc51-cpp objects to.)
inline uint32_t testSeed(const uint32_t fallback) {
  const char *const raw = std::getenv("SHIFTING_MOSAIC_TEST_SEED");
  if (raw == nullptr || *raw == 0)
    return fallback;
  char *end = nullptr;
  const unsigned long v = std::strtoul(raw, &end, 10);
  return end == raw || *end != 0 ? fallback : static_cast<uint32_t>(v);
}

// kDX/kDY, not DX/DY: this header is included BEFORE AStar.h by two test TUs,
// and at namespace scope it made that class's own private DX/DY read as
// shadowing declarations (cpp:S1117) in files the solver never sees.
constexpr std::array<int, 4> kDX = {0, 1, 0, -1};
constexpr std::array<int, 4> kDY = {-1, 0, 1, 0};

struct Puzzle {
  uint8_t w = 0;
  uint8_t h = 0;
  std::vector<std::vector<Position>> shapes;
  std::vector<Position> anchors;
  uint8_t goalIndex = 0;
  Position goalAnchor{};
};

// Brute-force placement check: block i at anchor a, all cells in-bounds by
// BOUNDING BOX (mirrors AStar::inBounds) and no overlap with other blocks.
inline bool oracleCanPlace(const Puzzle &p, const size_t i, const Position a,
                           const std::vector<Position> &anchors) {
  int boxW = 0;
  int boxH = 0;
  for (const auto &[cx, cy] : p.shapes[i]) {
    boxW = std::max(boxW, cx + 1);
    boxH = std::max(boxH, cy + 1);
  }
  if (a.x < 0 || a.y < 0 || a.x + boxW > p.w || a.y + boxH > p.h)
    return false;
  std::vector occ(static_cast<size_t>(p.w) * p.h, -1);
  for (size_t j = 0; j < anchors.size(); j++) {
    if (j == i)
      continue;
    for (const auto &[cx, cy] : p.shapes[j])
      occ[(anchors[j].x + cx) * p.h + (anchors[j].y + cy)] =
          static_cast<int>(j);
  }
  for (const auto &[cx, cy] : p.shapes[i])
    if (occ[(a.x + cx) * p.h + (a.y + cy)] != -1)
      return false;
  return true;
}

// Reference per-block reachability BFS (a "drag"), independent of BitGrid.
inline std::map<uint16_t, uint16_t>
oracleFloodFill(const Puzzle &p, const size_t i,
                const std::vector<Position> &anchors) {
  std::map<uint16_t, uint16_t> dist; // anchorIdx -> BFS distance
  std::queue<Position> q;
  dist[static_cast<uint16_t>(anchors[i].x * p.h + anchors[i].y)] = 0;
  q.push(anchors[i]);
  while (!q.empty()) {
    const auto [curX, curY] = q.front();
    q.pop();
    const auto curIdx = static_cast<uint16_t>(curX * p.h + curY);
    for (int d = 0; d < 4; d++) {
      const Position next = {.x = static_cast<int8_t>(curX + kDX[d]),
                             .y = static_cast<int8_t>(curY + kDY[d])};
      if (!oracleCanPlace(p, i, next, anchors))
        continue;
      const auto nIdx = static_cast<uint16_t>(next.x * p.h + next.y);
      if (dist.contains(nIdx))
        continue;
      dist[nIdx] = static_cast<uint16_t>(dist[curIdx] + 1);
      q.push(next);
    }
  }
  return dist;
}

// Exhaustive drag-space BFS: minimal number of drags to bring the goal block
// onto goalAnchor, or -1 if unreachable. State = all anchors.
/** A whole-board state as a map key: two bytes per anchor. */
inline std::string oracleKey(const std::vector<Position> &anchors) {
  std::string k;
  for (const auto &[ax, ay] : anchors) {
    k.push_back(static_cast<char>(ax));
    k.push_back(static_cast<char>(ay));
  }
  return k;
}

/**
 * Every one-drag successor of `anchors`, enqueued if not already seen.
 *
 * Lifted out of the BFS below only to get under the nesting limit (cpp:S134).
 * It is deliberately the same exhaustive, uninteresting expansion it was
 * inline — this oracle earns its keep by sharing NOTHING with the solver it
 * checks, so it must stay obviously correct rather than become clever.
 */
inline void oracleExpand(const Puzzle &p, const std::vector<Position> &anchors,
                         const int d,
                         std::map<std::string, int, std::less<>> &dist,
                         std::queue<std::vector<Position>> &q) {
  for (size_t i = 0; i < anchors.size(); i++) {
    for (const auto &[toIdx, dd] : oracleFloodFill(p, i, anchors)) {
      if (dd == 0)
        continue;
      auto next = anchors;
      next[i] = {.x = static_cast<int8_t>(toIdx / p.h),
                 .y = static_cast<int8_t>(toIdx % p.h)};
      if (dist.try_emplace(oracleKey(next), d + 1).second)
        q.push(next);
    }
  }
}

inline int oracleMinDrags(const Puzzle &p) {
  std::map<std::string, int, std::less<>> dist;
  std::queue<std::vector<Position>> q;
  dist[oracleKey(p.anchors)] = 0;
  q.push(p.anchors);
  while (!q.empty()) {
    const auto anchors = q.front();
    q.pop();
    const int d = dist[oracleKey(anchors)];
    if (anchors[p.goalIndex] == p.goalAnchor)
      return d;
    oracleExpand(p, anchors, d, dist, q);
  }
  return -1;
}

inline bool replayValid(const Puzzle &p, const std::vector<Turn> &turns) {
  std::vector<Position> anchors = p.anchors;
  for (const auto &[blockId, direction] : turns) {
    if (blockId >= anchors.size())
      return false;
    const auto d = static_cast<int>(std::to_underlying(direction));
    const Position next = {.x = static_cast<int8_t>(anchors[blockId].x + kDX[d]),
                           .y =
                               static_cast<int8_t>(anchors[blockId].y + kDY[d])};
    if (!oracleCanPlace(p, blockId, next, anchors))
      return false;
    anchors[blockId] = next;
  }
  return anchors[p.goalIndex] == p.goalAnchor;
}

inline size_t countPlayerSteps(const std::vector<Turn> &turns) {
  size_t steps = 0;
  for (size_t i = 0; i < turns.size(); i++)
    if (i == 0 || turns[i].blockId != turns[i - 1].blockId)
      steps++;
  return steps;
}

// Random small puzzle. Blocks are placed greedily; the result may be solvable
// or not — the oracle decides, and DragSolver must agree either way.
inline Puzzle randomPuzzle(SeededRng &rng) {
  const std::vector<std::vector<Position>> catalog = {
      {{.x = 0, .y = 0}},
      {{.x = 0, .y = 0}, {.x = 1, .y = 0}},
      {{.x = 0, .y = 0}, {.x = 0, .y = 1}},
      {{.x = 0, .y = 0}, {.x = 1, .y = 0}, {.x = 0, .y = 1}},
      {{.x = 0, .y = 0}, {.x = 1, .y = 0}, {.x = 1, .y = 1}},
  };
  std::uniform_int_distribution wDist(4, 6);
  std::uniform_int_distribution hDist(3, 5);
  Puzzle p;
  p.w = static_cast<uint8_t>(rng.draw(wDist));
  p.h = static_cast<uint8_t>(rng.draw(hDist));
  std::uniform_int_distribution nDist(2, 3);
  const int n = rng.draw(nDist);
  std::uniform_int_distribution shapeDist(0,
                                          static_cast<int>(catalog.size()) - 1);
  std::uniform_int_distribution xDist(0, p.w - 1);
  std::uniform_int_distribution yDist(0, p.h - 1);
  for (int i = 0; i < n; i++) {
    const auto &shape = catalog[rng.draw(shapeDist)];
    for (int tries = 0; tries < 50; tries++) {
      const Position a = {.x = static_cast<int8_t>(rng.draw(xDist)),
                          .y = static_cast<int8_t>(rng.draw(yDist))};
      p.shapes.push_back(shape);
      p.anchors.push_back(a);
      if (oracleCanPlace(p, p.shapes.size() - 1, a, p.anchors))
        break;
      p.shapes.pop_back();
      p.anchors.pop_back();
    }
  }
  if (p.shapes.empty()) {
    p.shapes.push_back(catalog[0]);
    p.anchors.push_back({.x = 0, .y = 0});
  }
  p.goalIndex = 0;
  for (int tries = 0; tries < 50; tries++) {
    const Position t = {.x = static_cast<int8_t>(rng.draw(xDist)),
                        .y = static_cast<int8_t>(rng.draw(yDist))};
    std::vector<Position> alone(p.anchors.size(), {.x = 127, .y = 127});
    alone[0] = t;
    // Target just needs the goal's bbox in-grid.
    int boxW = 0;
    int boxH = 0;
    for (const auto &[cx, cy] : p.shapes[0]) {
      boxW = std::max(boxW, cx + 1);
      boxH = std::max(boxH, cy + 1);
    }
    if (t.x + boxW <= p.w && t.y + boxH <= p.h) {
      p.goalAnchor = t;
      return p;
    }
  }
  p.goalAnchor = p.anchors[0];
  return p;
}

inline DragSolver makeDragSolver(const Puzzle &p,
                                 const DragSolver::Config &cfg) {
  return {p.w, p.h, p.shapes, p.anchors, p.goalIndex, p.goalAnchor, cfg};
}
