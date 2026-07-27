// The bench CLI's non-solve subcommands. See BenchCommands.h.

#include "ClangdCompat.h" // must stay first; see the header

#include "BenchCommands.h"

#include "BitGrid.h"

#include <algorithm>
#include <cstdint>
#include <fstream>
#include <iostream>
#include <nlohmann/json.hpp>
#include <random>
#include <vector>

using json = nlohmann::json;

// Replays a turn stream read from a file. The safety net for a plan STITCHED
// from two independently-solved halves, where nothing else has validated the
// seam. Shares firstIllegalMove() with the inline `valid` check above.
int runVerify(const Fixture &data, const std::string &turnsPath) {
  std::ifstream f(turnsPath);
  if (!f.is_open()) {
    std::cerr << "verify: cannot open " << turnsPath << "\n";
    return 2;
  }
  const json tj = json::parse(f);
  std::vector<Turn> turns;
  turns.reserve(tj.size());
  for (const auto &t : tj)
    turns.push_back(
        {.blockId = t["blockId"].get<uint8_t>(),
         .direction = static_cast<Direction>(t["direction"].get<int>())});

  std::vector<Position> anchors;
  const size_t illegalAt = firstIllegalMove(data, turns, anchors);
  const bool legal = illegalAt == SIZE_MAX;
  const auto &[gx, gy] = anchors[data.goalIndex];
  const bool solved =
      legal && gx == data.goalAnchor.x && gy == data.goalAnchor.y;
  const json out = {
      {"verify", turnsPath},
      {"turns", turns.size()},
      {"steps", countPlayerSteps(turns)},
      {"legal", legal},
      {"illegalAt", legal ? int64_t{-1} : static_cast<int64_t>(illegalAt)},
      {"solved", solved},
  };
  std::cout << out.dump() << "\n";
  return solved ? 0 : 1;
}

// Generates a random SOLVABLE fixture: random grid and polyomino blocks with
// the goal block initially ON its goal anchor, then a long random walk of
// valid unit moves scrambles the board. The reverse walk solves the shuffled
// instance, so solvability is guaranteed by construction.
int runGenerate(const std::string &outPath, const uint32_t seed,
                const uint32_t shuffleMoves, const bool emitJson) {
  std::mt19937 rng(seed);
  const auto randInt = [&](const int lo, const int hi) {
    return std::uniform_int_distribution(lo, hi)(rng);
  };

  const int W = randInt(4, 60);
  const int H = randInt(4, 60);
  const int targetBlocks = randInt(1, 20);

  std::vector<std::vector<Position>> shapes;
  std::vector<Position> anchors;
  std::vector<uint8_t> cellUsed(static_cast<size_t>(W) * H, 0);

  const auto randomShape = [&](const int maxCells) {
    const int want = randInt(1, maxCells);
    std::vector<std::pair<int, int>> cells{{0, 0}};
    int guard = want * 25;
    while (static_cast<int>(cells.size()) < want && guard-- > 0) {
      const auto &[bx, by] =
          cells[randInt(0, static_cast<int>(cells.size()) - 1)];
      const int d = randInt(0, 3);
      const int nx = bx + BitGrid::DX[d];
      if (const int ny = by + BitGrid::DY[d];
          std::ranges::find(cells, std::make_pair(nx, ny)) == cells.end())
        cells.emplace_back(nx, ny);
    }
    int mx = INT32_MAX;
    int my = INT32_MAX;
    for (const auto &[x, y] : cells) {
      mx = std::min(mx, x);
      my = std::min(my, y);
    }
    std::vector<Position> shape;
    shape.reserve(cells.size());
    for (const auto &[x, y] : cells)
      shape.push_back(
          {.x = static_cast<int8_t>(x - mx), .y = static_cast<int8_t>(y - my)});
    return shape;
  };

  const auto tryPlace = [&](const std::vector<Position> &shape) {
    int bw = 0;
    int bh = 0;
    for (const auto &[cx, cy] : shape) {
      bw = std::max(bw, cx + 1);
      bh = std::max(bh, cy + 1);
    }
    if (bw > W || bh > H)
      return false;
    for (int tries = 0; tries < 200; tries++) {
      const int ax = randInt(0, W - bw);
      const int ay = randInt(0, H - bh);
      bool free = true;
      for (const auto &[cx, cy] : shape)
        if (cellUsed[(ax + cx) * H + (ay + cy)]) {
          free = false;
          break;
        }
      if (!free)
        continue;
      for (const auto &[cx, cy] : shape)
        cellUsed[(ax + cx) * H + (ay + cy)] = 1;
      anchors.push_back(
          {.x = static_cast<int8_t>(ax), .y = static_cast<int8_t>(ay)});
      return true;
    }
    return false;
  };

  for (int b = 0; b < targetBlocks; b++) {
    if (const auto shape = randomShape(12); tryPlace(shape))
      shapes.push_back(shape);
  }
  if (shapes.empty()) {
    // Degenerate tight board: guarantee at least a 1-cell goal block.
    if (!tryPlace({{.x = 0, .y = 0}})) {
      std::cerr << "generate: could not place any block (seed " << seed
                << ")\n";
      return 1;
    }
    shapes.push_back({{.x = 0, .y = 0}});
  }

  const auto [goalAnchorX, goalAnchorY] = anchors[0]; // goal starts ON its goal
  // Scramble with a long random walk of valid unit moves.
  BitGrid grid(static_cast<uint8_t>(W), static_cast<uint8_t>(H), shapes);
  grid.buildOccupancy(anchors);
  uint32_t accepted = 0;
  uint64_t attempts = 0;
  const uint64_t maxAttempts = static_cast<uint64_t>(shuffleMoves) * 4;
  while (accepted < shuffleMoves && attempts < maxAttempts) {
    attempts++;
    const auto b =
        static_cast<uint8_t>(randInt(0, static_cast<int>(shapes.size()) - 1));
    const int d = randInt(0, 3);
    const Position from = anchors[b];
    const Position to = {.x = static_cast<int8_t>(from.x + BitGrid::DX[d]),
                         .y = static_cast<int8_t>(from.y + BitGrid::DY[d])};
    grid.removeBlock(b, from);
    if (grid.canPlace(b, to.x, to.y)) {
      grid.addBlock(b, to);
      anchors[b] = to;
      accepted++;
    } else {
      grid.addBlock(b, from);
    }
  }

  size_t totalCells = 0;
  for (const auto &s : shapes)
    totalCells += s.size();

  json fixture;
  fixture["gridWidth"] = W;
  fixture["gridHeight"] = H;
  json shapesJson = json::array();
  for (const auto &s : shapes) {
    json cells = json::array();
    for (const auto &[cx, cy] : s)
      cells.push_back({{"x", cx}, {"y", cy}});
    shapesJson.push_back(cells);
  }
  fixture["shapes"] = shapesJson;
  json anchorsJson = json::array();
  for (const auto &[ax, ay] : anchors)
    anchorsJson.push_back({{"x", ax}, {"y", ay}});
  fixture["initialAnchors"] = anchorsJson;
  fixture["goalIndex"] = 0;
  fixture["goalAnchor"] = {{"x", goalAnchorX}, {"y", goalAnchorY}};

  std::ofstream out(outPath);
  if (!out.is_open()) {
    std::cerr << "generate: cannot write " << outPath << "\n";
    return 1;
  }
  out << fixture.dump();

  const bool goalDisplaced =
      anchors[0].x != goalAnchorX || anchors[0].y != goalAnchorY;
  const json summary = {
      {"generated", outPath},
      {"seed", seed},
      {"width", W},
      {"height", H},
      {"blocks", shapes.size()},
      {"cells", totalCells},
      {"density", static_cast<double>(totalCells) / (W * H)},
      {"shuffleAccepted", accepted},
      {"shuffleAttempts", attempts},
      {"goalDisplaced", goalDisplaced},
  };
  if (emitJson)
    std::cout << summary.dump() << "\n";
  else
    std::cout << "generated " << outPath << ": " << W << "x" << H << ", "
              << shapes.size() << " blocks (" << totalCells << " cells), "
              << accepted << " shuffle moves"
              << (goalDisplaced ? "" : " (goal back on target)") << "\n";
  return 0;
}

int usage(const char *argv0) {
  std::cerr << "Usage: " << argv0
            << " --fixture <path> [--engine unit|drag|hier|assembly|corridor|"
               "jam|beam|cascade] [--weight N] [--budget-ms N] [--max-nodes N]"
               " [--stride N] [--no-post] [--json]\n";
  return 2;
}
