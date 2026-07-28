// The bench CLI's non-solve subcommands. See BenchCommands.h.

#include "ClangdCompat.h" // must stay first; see the header

#include "BenchCommands.h"

#include "BitGrid.h"
#include "SeededRng.h"

#include <algorithm>
#include <cstdint>
#include <fstream>
#include <iostream>
#include <nlohmann/json.hpp>
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

namespace {

// The pieces of runGenerate below were lambdas inside it. As free functions
// each is measured on its own, and — more to the point — the placement search
// is three levels of loop-and-test that only reads as three levels once it is
// not also nested inside its owner.
//
// The order of draws from `rng` is load-bearing: --generate --seed N must keep
// producing the same fixture, since fuzzShiftingMosaic.ts addresses boards by
// seed. Nothing here reorders them.

// A random polyomino of up to maxCells cells, normalised so its bounding box
// starts at (0, 0).
std::vector<Position> randomShape(SeededRng &rng, const int maxCells) {
  const int want = rng.uniform(1, maxCells);
  std::vector<std::pair<int, int>> cells{{0, 0}};
  // guard bounds the retries for a shape that cannot grow, when the cell drawn
  // keeps having its neighbour already occupied. Decremented as the first
  // statement of the body, not as `guard-- > 0` in the condition: there it is
  // a side effect in the right-hand operand of &&, evaluated only when the
  // left side holds, so the count can only be read correctly by reasoning
  // about short-circuiting.
  int guard = want * 25;
  while (static_cast<int>(cells.size()) < want && guard > 0) {
    guard--;
    const auto &[bx, by] =
        cells[rng.uniform(0, static_cast<int>(cells.size()) - 1)];
    const int d = rng.uniform(0, 3);
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
}

// The board being filled: occupancy plus the anchors placed so far.
struct Board {
  int width;
  int height;
  std::vector<uint8_t> cellUsed;
  std::vector<Position> anchors;
};

// True when `shape` fits somewhere free; on success it is marked occupied and
// its anchor appended.
bool overlapsAt(const Board &board, const std::vector<Position> &shape,
                const int ax, const int ay) {
  return std::ranges::any_of(shape, [&](const Position &cell) {
    return board.cellUsed[(ax + cell.x) * board.height + (ay + cell.y)] != 0;
  });
}

bool tryPlace(SeededRng &rng, Board &board,
              const std::vector<Position> &shape) {
  int bw = 0;
  int bh = 0;
  for (const auto &[cx, cy] : shape) {
    bw = std::max(bw, cx + 1);
    bh = std::max(bh, cy + 1);
  }
  if (bw > board.width || bh > board.height)
    return false;
  for (int tries = 0; tries < 200; tries++) {
    const int ax = rng.uniform(0, board.width - bw);
    const int ay = rng.uniform(0, board.height - bh);
    if (overlapsAt(board, shape, ax, ay))
      continue;
    for (const auto &[cx, cy] : shape)
      board.cellUsed[(ax + cx) * board.height + (ay + cy)] = 1;
    board.anchors.push_back(
        {.x = static_cast<int8_t>(ax), .y = static_cast<int8_t>(ay)});
    return true;
  }
  return false;
}

struct ShuffleStats {
  uint32_t accepted = 0;
  uint64_t attempts = 0;
};

// Scrambles with a long random walk of valid unit moves. The reverse walk
// solves the result, which is what makes the instance solvable by
// construction.
ShuffleStats shuffleBoard(SeededRng &rng, BitGrid &grid,
                          std::vector<Position> &anchors,
                          const size_t blockCount,
                          const uint32_t shuffleMoves) {
  ShuffleStats stats;
  const uint64_t maxAttempts = static_cast<uint64_t>(shuffleMoves) * 4;
  while (stats.accepted < shuffleMoves && stats.attempts < maxAttempts) {
    stats.attempts++;
    const auto b =
        static_cast<uint8_t>(rng.uniform(0, static_cast<int>(blockCount) - 1));
    const int d = rng.uniform(0, 3);
    const Position from = anchors[b];
    const Position to = {.x = static_cast<int8_t>(from.x + BitGrid::DX[d]),
                         .y = static_cast<int8_t>(from.y + BitGrid::DY[d])};
    grid.removeBlock(b, from);
    if (grid.canPlace(b, to.x, to.y)) {
      grid.addBlock(b, to);
      anchors[b] = to;
      stats.accepted++;
    } else {
      grid.addBlock(b, from);
    }
  }
  return stats;
}

json fixtureJson(const Board &board,
                 const std::vector<std::vector<Position>> &shapes,
                 const int goalAnchorX, const int goalAnchorY) {
  json shapesJson = json::array();
  for (const auto &s : shapes) {
    json cells = json::array();
    for (const auto &[cx, cy] : s)
      cells.push_back({{"x", cx}, {"y", cy}});
    shapesJson.push_back(cells);
  }
  json anchorsJson = json::array();
  for (const auto &[ax, ay] : board.anchors)
    anchorsJson.push_back({{"x", ax}, {"y", ay}});

  json fixture;
  fixture["gridWidth"] = board.width;
  fixture["gridHeight"] = board.height;
  fixture["shapes"] = shapesJson;
  fixture["initialAnchors"] = anchorsJson;
  fixture["goalIndex"] = 0;
  fixture["goalAnchor"] = {{"x", goalAnchorX}, {"y", goalAnchorY}};
  return fixture;
}

} // namespace

// Generates a random SOLVABLE fixture: random grid and polyomino blocks with
// the goal block initially ON its goal anchor, then a long random walk of
// valid unit moves scrambles the board. The reverse walk solves the shuffled
// instance, so solvability is guaranteed by construction.
int runGenerate(const std::string &outPath, const uint32_t seed,
                const uint32_t shuffleMoves, const bool emitJson) {
  SeededRng rng(seed);
  const int W = rng.uniform(4, 60);
  const int H = rng.uniform(4, 60);
  const int targetBlocks = rng.uniform(1, 20);

  std::vector<std::vector<Position>> shapes;
  Board board{.width = W,
              .height = H,
              .cellUsed = std::vector<uint8_t>(static_cast<size_t>(W) * H, 0),
              .anchors = {}};

  for (int b = 0; b < targetBlocks; b++) {
    if (const auto shape = randomShape(rng, 12); tryPlace(rng, board, shape))
      shapes.push_back(shape);
  }
  if (shapes.empty()) {
    // Degenerate tight board: guarantee at least a 1-cell goal block.
    if (!tryPlace(rng, board, {{.x = 0, .y = 0}})) {
      std::cerr << "generate: could not place any block (seed " << seed
                << ")\n";
      return 1;
    }
    shapes.push_back({{.x = 0, .y = 0}});
  }

  // The goal block starts ON its goal; the shuffle below is what moves it off.
  const auto [goalAnchorX, goalAnchorY] = board.anchors[0];
  BitGrid grid(static_cast<uint8_t>(W), static_cast<uint8_t>(H), shapes);
  grid.buildOccupancy(board.anchors);
  const auto [accepted, attempts] =
      shuffleBoard(rng, grid, board.anchors, shapes.size(), shuffleMoves);

  std::ofstream out(outPath);
  if (!out.is_open()) {
    std::cerr << "generate: cannot write " << outPath << "\n";
    return 1;
  }
  out << fixtureJson(board, shapes, goalAnchorX, goalAnchorY).dump();

  size_t totalCells = 0;
  for (const auto &s : shapes)
    totalCells += s.size();
  const bool goalDisplaced =
      board.anchors[0].x != goalAnchorX || board.anchors[0].y != goalAnchorY;
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
