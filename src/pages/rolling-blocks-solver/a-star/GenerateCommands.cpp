#include "GenerateCommands.h"

#include "Block.h"
#include "Replay.h"
#include "SeededRng.h"
#include "Types.h"

#include <algorithm>
#include <cstdint>
#include <fstream>
#include <iostream>
#include <nlohmann/json.hpp>
#include <ranges>
#include <string>
#include <vector>

namespace {

// The order of draws from the rng is load-bearing: `--generate --seed N`
// must keep producing the same fixture, because the fuzz harness addresses
// boards by seed.

Direction inverseOf(const Direction dir) {
  using enum Direction;
  switch (dir) {
  case UP:
    return DOWN;
  case DOWN:
    return UP;
  case LEFT:
    return RIGHT;
  case RIGHT:
    return LEFT;
  }
  return UP;
}

Direction drawDirection(SeededRng &rng) {
  return static_cast<Direction>(rng.uniform(0, 3));
}

struct BoardGen {
  uint8_t width = 0;
  uint8_t height = 0;
  std::vector<Tile> cells;
  std::vector<Block> blocks; // START positions
  std::vector<Turn> witness; // replays from the start positions to solved
  uint64_t accepted = 0;
};

bool placeBlock(BoardGen &g, SeededRng &rng, const uint8_t id,
                const uint8_t bw, const uint8_t bd, const uint8_t bh,
                const int minX, const int maxX) {
  const boost::dynamic_bitset<> empty(g.cells.size());
  const int hiX = std::min(maxX, g.width - bw);
  const int hiY = g.height - bd;
  if (hiX < minX || hiY < 0) {
    return false;
  }
  for (int attempt = 0; attempt < 200; attempt++) {
    const auto x = static_cast<int8_t>(rng.uniform(minX, hiX));
    const auto y = static_cast<int8_t>(rng.uniform(0, hiY));
    const Block candidate{id, x, y, bw, bd, bh};
    if (candidate.checkValidity(g.width, g.height, g.cells, g.blocks, empty)) {
      g.blocks.push_back(candidate);
      return true;
    }
  }
  return false;
}

// Scrambles the given block indices with random valid rolls and APPENDS the
// forward witness (the reversed inverse walk) to `forward`.
void scramble(BoardGen &g, SeededRng &rng,
              const std::vector<size_t> &movable, const uint32_t shuffle,
              const boost::dynamic_bitset<> &satisfied,
              std::vector<Turn> &forward) {
  std::vector<Turn> walk;
  uint64_t attempts = 0;
  const uint64_t maxAttempts = std::min<uint64_t>(
      static_cast<uint64_t>(shuffle) * 4, 4000000);
  while (g.accepted < shuffle && attempts < maxAttempts) {
    attempts++;
    const size_t bi = movable[static_cast<size_t>(
        rng.uniform(0, static_cast<int>(movable.size()) - 1))];
    const Direction dir = drawDirection(rng);
    Block trial = g.blocks[bi].clone();
    trial.roll(dir);
    if (!trial.checkValidity(g.width, g.height, g.cells, g.blocks,
                             satisfied)) {
      continue;
    }
    g.blocks[bi] = trial;
    walk.push_back({.blockId = g.blocks[bi].id, .direction = dir});
    g.accepted++;
  }
  for (const Turn &move : std::views::reverse(walk)) {
    forward.push_back(
        {.blockId = move.blockId, .direction = inverseOf(move.direction)});
  }
}

// Goal boards: blocks start ON their goal footprints (exact cover), then get
// scrambled away — the reversed walk solves by construction.
BoardGen generateGoal(SeededRng &rng, const uint32_t shuffle) {
  BoardGen g;
  g.width = static_cast<uint8_t>(rng.uniform(4, 64));
  g.height = static_cast<uint8_t>(rng.uniform(4, 64));
  g.cells.assign(static_cast<size_t>(g.width) * g.height, Tile::Regular);
  const int density = rng.uniform(0, 30);
  for (auto &cell : g.cells) {
    if (rng.uniform(0, 99) < density) {
      cell = Tile::Unplayable;
    }
  }

  const int targetBlocks = rng.uniform(1, 12);
  for (int t = 0; t < targetBlocks; t++) {
    placeBlock(g, rng, static_cast<uint8_t>(g.blocks.size() + 1),
               static_cast<uint8_t>(rng.uniform(1, 3)),
               static_cast<uint8_t>(rng.uniform(1, 3)),
               static_cast<uint8_t>(rng.uniform(1, 4)), 0, g.width - 1);
  }
  if (g.blocks.empty()) {
    // Degenerate density; clear a corner and drop a unit cube on it.
    g.cells[0] = Tile::Regular;
    g.blocks.emplace_back(1, 0, 0, 1, 1, 1);
  }

  // Goals are only meaningful on blocks that can actually MOVE: a frozen
  // block (a corner 3x3x4 wedged in by walls, measured on seed 42) keeps its
  // own goal patch covered through any amount of scrambling and the board
  // arrives pre-solved.
  const boost::dynamic_bitset<> noneSatisfied(g.cells.size());
  const auto isMobile = [&](const Block &b) {
    for (int d = 0; d < 4; d++) {
      Block trial = b.clone();
      trial.roll(static_cast<Direction>(d));
      if (trial.checkValidity(g.width, g.height, g.cells, g.blocks,
                              noneSatisfied)) {
        return true;
      }
    }
    return false;
  };
  std::vector<size_t> mobile;
  for (size_t i = 0; i < g.blocks.size(); i++) {
    if (isMobile(g.blocks[i])) {
      mobile.push_back(i);
    }
  }
  if (mobile.empty()) {
    // Fully jammed layout: emit as-is with no goals; the harness scores it
    // trivial rather than the generator looping forever.
    return g;
  }
  const int goalBlocks =
      rng.uniform(1, static_cast<int>(mobile.size()));
  for (int k = 0; k < goalBlocks; k++) {
    const Block &b = g.blocks[mobile[static_cast<size_t>(k)]];
    for (int8_t cx = b.x; cx < b.x + static_cast<int8_t>(b.width); cx++) {
      for (int8_t cy = b.y; cy < b.y + static_cast<int8_t>(b.depth); cy++) {
        g.cells[positionToIndex(cx, cy, g.width)] = Tile::Goal;
      }
    }
  }

  std::vector<size_t> movable(g.blocks.size());
  for (size_t i = 0; i < movable.size(); i++) {
    movable[i] = i;
  }
  scramble(g, rng, movable, shuffle, noneSatisfied, g.witness);

  // A random walk can still wander the cover home (or barely move on a tight
  // board). A short extra scramble usually displaces it; its inverse moves
  // are the FIRST forward moves, so they prepend. A board that stays covered
  // anyway is emitted and scored trivial by the harness.
  for (int extra = 0; extra < 3; extra++) {
    const replay::Puzzle check{.gridWidth = g.width,
                               .gridHeight = g.height,
                               .cells = g.cells,
                               .blocks = g.blocks};
    if (!replay::replayTurns(check, {}).solvedAtEnd) {
      break;
    }
    std::vector<Turn> extraWitness;
    const uint64_t before = g.accepted;
    g.accepted = 0;
    scramble(g, rng, movable, 64, noneSatisfied, extraWitness);
    g.accepted += before;
    g.witness.insert(g.witness.begin(), extraWitness.begin(),
                     extraWitness.end());
  }
  return g;
}

// Coverage boards: a self-avoiding walk from the start positions; every cell
// on FIRST touch becomes must-touch with probability p, and the game's
// one-shot rule (never land on a satisfied must-touch cell) is enforced
// during the walk itself — so the walk IS the forward witness.
BoardGen generateCoverage(SeededRng &rng, const uint32_t shuffle) {
  BoardGen g;
  g.width = static_cast<uint8_t>(rng.uniform(6, 64));
  g.height = static_cast<uint8_t>(rng.uniform(6, 64));
  g.cells.assign(static_cast<size_t>(g.width) * g.height, Tile::Regular);

  const int numBlocks = rng.uniform(1, 2);
  for (int t = 0; t < numBlocks; t++) {
    const int shape = rng.uniform(0, 3);
    const uint8_t bw = shape == 2 ? 2 : 1;
    const uint8_t bd = shape == 3 ? 2 : 1;
    const uint8_t bh = shape == 1 ? 2 : 1;
    placeBlock(g, rng, static_cast<uint8_t>(g.blocks.size() + 1), bw, bd, bh,
               0, g.width - 1);
  }
  if (g.blocks.empty()) {
    g.blocks.emplace_back(1, 0, 0, 1, 1, 1);
  }
  const std::vector<Block> startBlocks = g.blocks;

  const int markPct = rng.uniform(50, 100);
  boost::dynamic_bitset<> touched(g.cells.size());
  boost::dynamic_bitset<> satisfied(g.cells.size());
  const auto touch = [&](const Block &b) {
    for (int8_t cx = b.x; cx < b.x + static_cast<int8_t>(b.width); cx++) {
      for (int8_t cy = b.y; cy < b.y + static_cast<int8_t>(b.depth); cy++) {
        const auto idx = positionToIndex(cx, cy, g.width);
        if (touched.test(idx)) {
          continue;
        }
        touched.set(idx);
        if (rng.uniform(0, 99) < markPct) {
          g.cells[idx] = Tile::MustTouch;
          satisfied.set(idx);
        }
      }
    }
  };
  for (const auto &b : g.blocks) {
    touch(b);
  }

  const uint64_t playable = g.cells.size();
  const uint64_t walkTarget =
      std::min<uint64_t>(shuffle, playable * 3);
  uint64_t attempts = 0;
  while (g.accepted < walkTarget && attempts < walkTarget * 8 + 64) {
    attempts++;
    const auto bi = static_cast<size_t>(
        rng.uniform(0, static_cast<int>(g.blocks.size()) - 1));
    const Direction dir = drawDirection(rng);
    Block trial = g.blocks[bi].clone();
    trial.roll(dir);
    if (!trial.checkValidity(g.width, g.height, g.cells, g.blocks,
                             satisfied)) {
      continue;
    }
    g.blocks[bi] = trial;
    g.witness.push_back({.blockId = g.blocks[bi].id, .direction = dir});
    g.accepted++;
    touch(trial);
  }

  // Corridor shaping: cells the walk never reached become walls sometimes.
  const int wallPct = rng.uniform(0, 50);
  for (size_t i = 0; i < g.cells.size(); i++) {
    if (!touched.test(i) && rng.uniform(0, 99) < wallPct) {
      g.cells[i] = Tile::Unplayable;
    }
  }

  g.blocks = startBlocks;
  return g;
}

// Mixed boards: a coverage region and a goal region separated by a fully
// unplayable divider column, so the two witnesses cannot interact and can be
// concatenated in any order.
BoardGen generateMixed(SeededRng &rng, const uint32_t shuffle) {
  BoardGen g;
  g.width = static_cast<uint8_t>(rng.uniform(14, 64));
  g.height = static_cast<uint8_t>(rng.uniform(6, 64));
  g.cells.assign(static_cast<size_t>(g.width) * g.height, Tile::Regular);
  const int divider = rng.uniform(5, g.width - 6);
  for (int8_t y = 0; y < static_cast<int8_t>(g.height); y++) {
    g.cells[positionToIndex(static_cast<int8_t>(divider), y, g.width)] =
        Tile::Unplayable;
  }

  // Coverage side (left of the divider): one small block, marked walk.
  placeBlock(g, rng, 1, 1, 1, static_cast<uint8_t>(rng.uniform(1, 2)), 0,
             divider - 1);
  if (g.blocks.empty()) {
    g.cells[0] = Tile::Regular;
    g.blocks.emplace_back(1, 0, 0, 1, 1, 1);
  }
  const size_t coverageCount = g.blocks.size();
  const std::vector<Block> coverageStart = g.blocks;

  const int markPct = rng.uniform(50, 100);
  boost::dynamic_bitset<> touched(g.cells.size());
  boost::dynamic_bitset<> satisfied(g.cells.size());
  const auto touch = [&](const Block &b) {
    for (int8_t cx = b.x; cx < b.x + static_cast<int8_t>(b.width); cx++) {
      for (int8_t cy = b.y; cy < b.y + static_cast<int8_t>(b.depth); cy++) {
        const auto idx = positionToIndex(cx, cy, g.width);
        if (touched.test(idx)) {
          continue;
        }
        touched.set(idx);
        if (rng.uniform(0, 99) < markPct) {
          g.cells[idx] = Tile::MustTouch;
          satisfied.set(idx);
        }
      }
    }
  };
  for (const auto &b : g.blocks) {
    touch(b);
  }
  const uint64_t leftCells =
      static_cast<uint64_t>(divider) * g.height;
  const uint64_t walkTarget = std::min<uint64_t>(shuffle, leftCells * 3);
  uint64_t attempts = 0;
  while (g.accepted < walkTarget && attempts < walkTarget * 8 + 64) {
    attempts++;
    const auto bi = static_cast<size_t>(
        rng.uniform(0, static_cast<int>(coverageCount) - 1));
    const Direction dir = drawDirection(rng);
    Block trial = g.blocks[bi].clone();
    trial.roll(dir);
    if (!trial.checkValidity(g.width, g.height, g.cells, g.blocks,
                             satisfied)) {
      continue;
    }
    g.blocks[bi] = trial;
    g.witness.push_back({.blockId = g.blocks[bi].id, .direction = dir});
    g.accepted++;
    touch(trial);
  }

  // Goal side (right of the divider): place, paint, scramble.
  const int goalBlocks = rng.uniform(1, 4);
  for (int t = 0; t < goalBlocks; t++) {
    placeBlock(g, rng, static_cast<uint8_t>(g.blocks.size() + 1),
               static_cast<uint8_t>(rng.uniform(1, 2)),
               static_cast<uint8_t>(rng.uniform(1, 2)),
               static_cast<uint8_t>(rng.uniform(1, 3)), divider + 1,
               g.width - 1);
  }
  std::vector<size_t> goalMovable;
  for (size_t i = coverageCount; i < g.blocks.size(); i++) {
    goalMovable.push_back(i);
    const Block &b = g.blocks[i];
    for (int8_t cx = b.x; cx < b.x + static_cast<int8_t>(b.width); cx++) {
      for (int8_t cy = b.y; cy < b.y + static_cast<int8_t>(b.depth); cy++) {
        g.cells[positionToIndex(cx, cy, g.width)] = Tile::Goal;
      }
    }
  }
  std::vector<Turn> goalWitness;
  if (!goalMovable.empty()) {
    const uint64_t before = g.accepted;
    g.accepted = 0;
    scramble(g, rng, goalMovable, shuffle, satisfied, goalWitness);
    g.accepted += before;
  }

  // Start blocks: coverage blocks at their walk START, goal blocks where the
  // scramble left them. Witness: coverage walk first, then the goal return.
  for (size_t i = 0; i < coverageCount; i++) {
    g.blocks[i] = coverageStart[i];
  }
  g.witness.insert(g.witness.end(), goalWitness.begin(), goalWitness.end());
  return g;
}

const char *tileName(const Tile tile) {
  using enum Tile;
  switch (tile) {
  case MustTouch:
    return "mustTouch";
  case Goal:
    return "goal";
  case Unplayable:
    return "unplayable";
  case Regular:
    return "regular";
  }
  return "regular";
}

const char *directionName(const Direction dir) {
  using enum Direction;
  switch (dir) {
  case UP:
    return "UP";
  case RIGHT:
    return "RIGHT";
  case DOWN:
    return "DOWN";
  case LEFT:
    return "LEFT";
  }
  return "UP";
}

void writeFixture(const std::string &path, const BoardGen &g,
                  const bool storeWitness) {
  nlohmann::json j;
  j["gridWidth"] = g.width;
  j["gridHeight"] = g.height;
  auto cells = nlohmann::json::array();
  for (int8_t x = 0; x < static_cast<int8_t>(g.width); x++) {
    auto column = nlohmann::json::array();
    for (int8_t y = 0; y < static_cast<int8_t>(g.height); y++) {
      column.push_back(tileName(g.cells[positionToIndex(x, y, g.width)]));
    }
    cells.push_back(std::move(column));
  }
  j["cells"] = std::move(cells);
  auto blocks = nlohmann::json::array();
  for (const auto &b : g.blocks) {
    blocks.push_back({{"id", b.id},
                      {"x", b.x},
                      {"y", b.y},
                      {"width", b.width},
                      {"depth", b.depth},
                      {"height", b.height}});
  }
  j["blocks"] = std::move(blocks);
  if (storeWitness) {
    auto turns = nlohmann::json::array();
    for (const auto &t : g.witness) {
      turns.push_back(
          {{"blockId", t.blockId}, {"direction", directionName(t.direction)}});
    }
    j["turns"] = std::move(turns);
  }
  std::ofstream out(path);
  out << j.dump(2) << "\n";
}

} // namespace

namespace generate {

int run(const std::string &outPath, const uint32_t seed,
        const uint32_t shuffle, const std::string &kind) {
  SeededRng rng(seed);
  BoardGen g;
  if (kind == "goal") {
    g = generateGoal(rng, shuffle);
  } else if (kind == "coverage") {
    g = generateCoverage(rng, shuffle);
  } else if (kind == "mixed") {
    g = generateMixed(rng, shuffle);
  } else {
    std::cerr << "Unknown kind '" << kind
              << "' (available: goal, coverage, mixed)\n";
    return 2;
  }

  // The construction argument in code form: the witness MUST replay to a
  // solution. A failure here is a generator bug, never a puzzle property.
  const replay::Puzzle puzzle{.gridWidth = g.width,
                              .gridHeight = g.height,
                              .cells = g.cells,
                              .blocks = g.blocks};
  const replay::Outcome outcome = replay::replayTurns(puzzle, g.witness);
  if (!outcome.legal || !outcome.solvedAtEnd) {
    nlohmann::json err;
    err["generated"] = false;
    err["seed"] = seed;
    err["error"] = "witness does not replay to a solution (generator bug)";
    std::cout << err.dump() << "\n";
    return 3;
  }

  // Witnesses are kept in the fixture only when short enough to be a useful
  // debugging aid — a million-turn walk would bloat the file to tens of MB.
  writeFixture(outPath, g, g.witness.size() <= 200);

  size_t mustTouch = 0;
  size_t goals = 0;
  size_t playable = 0;
  for (const Tile cell : g.cells) {
    if (cell != Tile::Unplayable) {
      playable++;
    }
    if (cell == Tile::MustTouch) {
      mustTouch++;
    } else if (cell == Tile::Goal) {
      goals++;
    }
  }
  nlohmann::json summary;
  summary["generated"] = true;
  summary["seed"] = seed;
  summary["kind"] = kind;
  summary["width"] = g.width;
  summary["height"] = g.height;
  summary["blocks"] = g.blocks.size();
  summary["mustTouch"] = mustTouch;
  summary["goals"] = goals;
  summary["playable"] = playable;
  summary["shuffleAccepted"] = g.accepted;
  summary["witnessLen"] = g.witness.size();
  std::cout << summary.dump() << "\n";
  return 0;
}

} // namespace generate
