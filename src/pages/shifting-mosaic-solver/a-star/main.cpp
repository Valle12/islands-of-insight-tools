// Bench CLI for the shifting-mosaic solver. Runs one fixture under a chosen
// engine/config and reports machine-readable stats, so configs can be swept
// and compared across engines (see src/util/benchShiftingMosaic.ts and
// src/util/fuzzShiftingMosaic.ts).
//
//   shifting_mosaic_a_star --fixture <path>
//       [--engine unit|drag|hier|assembly|corridor|jam|beam|cascade|
//                parallel|sequential|twophase|arm]
//       [--arm N] [--arm-gated] [--jam-aspect N] [--jam-density N]
//       [--weight N] [--budget-ms N] [--max-nodes N] [--stride N]
//       [--no-post] [--settled] [--pea N] [--ratchet] [--max-states N]
//       [--max-heap-bytes N]
//       [--json]
//
//   shifting_mosaic_a_star --generate <outPath> --seed N [--shuffle N]
//       [--json]
//     Builds a random solvable fixture: random grid (4..60 square-ish),
//     random polyomino blocks (1..20), the goal block STARTING on its goal
//     anchor, then shuffled by a long random walk — the reverse walk is a
//     solution, so the instance is solvable by construction.
//
// With --json the LAST stdout line is a single JSON object (search progress
// chatter precedes it); consumers should parse the final line only.

#include "AStar.h"
#include "BitGrid.h"
#include "DragSolver.h"
#include "ParallelCascade.h"
#include "Types.h"

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <nlohmann/json.hpp>
#include <random>
#include <string>
#include <string_view>
#include <vector>

using json = nlohmann::json;

namespace {

struct Fixture {
  uint8_t gridWidth{};
  uint8_t gridHeight{};
  std::vector<std::vector<Position>> shapes;
  std::vector<Position> initialAnchors;
  uint8_t goalIndex{};
  Position goalAnchor{};
};

Fixture loadFixture(const std::string &path) {
  std::ifstream f(path);
  if (!f.is_open())
    throw std::runtime_error("Cannot open " + path);
  json j = json::parse(f);

  Fixture data;
  data.gridWidth = j["gridWidth"].get<uint8_t>();
  data.gridHeight = j["gridHeight"].get<uint8_t>();
  for (const auto &shape : j["shapes"]) {
    std::vector<Position> cells;
    cells.reserve(shape.size());
    for (const auto &c : shape)
      cells.push_back({static_cast<int8_t>(c["x"].get<int>()),
                       static_cast<int8_t>(c["y"].get<int>())});
    data.shapes.push_back(std::move(cells));
  }
  for (const auto &a : j["initialAnchors"])
    data.initialAnchors.push_back({static_cast<int8_t>(a["x"].get<int>()),
                                   static_cast<int8_t>(a["y"].get<int>())});
  data.goalIndex = j["goalIndex"].get<uint8_t>();
  data.goalAnchor = {static_cast<int8_t>(j["goalAnchor"]["x"].get<int>()),
                     static_cast<int8_t>(j["goalAnchor"]["y"].get<int>())};
  return data;
}

// Replays the turns and checks the goal block ends on the goal anchor.
bool replaySolves(const Fixture &data, const std::vector<Turn> &turns) {
  std::vector<Position> anchors = data.initialAnchors;
  for (const auto &[blockId, direction] : turns) {
    if (blockId >= anchors.size())
      return false;
    auto &p = anchors[blockId];
    switch (direction) {
    case Direction::UP:    p.y--; break;
    case Direction::RIGHT: p.x++; break;
    case Direction::DOWN:  p.y++; break;
    case Direction::LEFT:  p.x--; break;
    }
  }
  const auto &g = anchors[data.goalIndex];
  return g.x == data.goalAnchor.x && g.y == data.goalAnchor.y;
}

// Player steps as the UI counts them (solutionView.ts): one step = a maximal
// run of consecutive turns of the same block, across direction changes.
size_t countPlayerSteps(const std::vector<Turn> &turns) {
  size_t steps = 0;
  for (size_t i = 0; i < turns.size(); i++)
    if (i == 0 || turns[i].blockId != turns[i - 1].blockId)
      steps++;
  return steps;
}

// Straight-drag runs (same block AND same direction) — the legacy metric.
size_t countDirRuns(const std::vector<Turn> &turns) {
  size_t runs = 0;
  for (size_t i = 0; i < turns.size(); i++)
    if (i == 0 || turns[i].blockId != turns[i - 1].blockId ||
        turns[i].direction != turns[i - 1].direction)
      runs++;
  return runs;
}

uint64_t nowMs() {
  using namespace std::chrono;
  return static_cast<uint64_t>(
      duration_cast<milliseconds>(steady_clock::now().time_since_epoch())
          .count());
}

// Writes `anchors` as a fixture over the same board. Used to hand a stalled
// jam run's deepest elite back to the solver as a RESIDUAL problem: the
// ratchet often clears the goal's dig route without committing the goal, and
// finishing from that state is far shallower than solving from the root.
bool writeFixtureAt(const Fixture &data, const std::vector<Position> &anchors,
                    const std::string &path) {
  json fx;
  fx["gridWidth"] = data.gridWidth;
  fx["gridHeight"] = data.gridHeight;
  json shapesJson = json::array();
  for (const auto &s : data.shapes) {
    json cells = json::array();
    for (const auto &c : s)
      cells.push_back({{"x", c.x}, {"y", c.y}});
    shapesJson.push_back(cells);
  }
  fx["shapes"] = shapesJson;
  json anchorsJson = json::array();
  for (const auto &a : anchors)
    anchorsJson.push_back({{"x", a.x}, {"y", a.y}});
  fx["initialAnchors"] = anchorsJson;
  fx["goalIndex"] = data.goalIndex;
  fx["goalAnchor"] = {{"x", data.goalAnchor.x}, {"y", data.goalAnchor.y}};
  std::ofstream out(path);
  if (!out.is_open())
    return false;
  out << fx.dump();
  return true;
}

void writeTurnsFile(const std::vector<Turn> &turns, const std::string &path) {
  json tj = json::array();
  for (const auto &t : turns)
    tj.push_back(
        {{"blockId", t.blockId}, {"direction", static_cast<int>(t.direction)}});
  std::ofstream f(path);
  f << tj.dump();
}

// Replays a turn stream against the fixture with FULL legality checking —
// bounds and collisions via BitGrid, not just the final goal position that
// replaySolves checks. This is the safety net for a plan STITCHED from two
// independently-solved halves, where nothing else has validated the seam.
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
    turns.push_back({t["blockId"].get<uint8_t>(),
                     static_cast<Direction>(t["direction"].get<int>())});

  std::vector<Position> anchors = data.initialAnchors;
  BitGrid grid(data.gridWidth, data.gridHeight, data.shapes);
  grid.buildOccupancy(anchors);
  size_t illegalAt = SIZE_MAX;
  for (size_t i = 0; i < turns.size(); i++) {
    const uint8_t b = turns[i].blockId;
    if (b >= anchors.size()) {
      illegalAt = i;
      break;
    }
    const Position from = anchors[b];
    const int d = static_cast<int>(turns[i].direction);
    const Position to{static_cast<int8_t>(from.x + BitGrid::DX[d]),
                      static_cast<int8_t>(from.y + BitGrid::DY[d])};
    grid.removeBlock(b, from);
    if (!grid.canPlace(b, to.x, to.y)) {
      grid.addBlock(b, from);
      illegalAt = i;
      break;
    }
    grid.addBlock(b, to);
    anchors[b] = to;
  }
  const bool legal = illegalAt == SIZE_MAX;
  const auto &g = anchors[data.goalIndex];
  const bool solved =
      legal && g.x == data.goalAnchor.x && g.y == data.goalAnchor.y;
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
    return std::uniform_int_distribution<int>(lo, hi)(rng);
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
      const auto &[bx, by] = cells[randInt(0, static_cast<int>(cells.size()) - 1)];
      const int d = randInt(0, 3);
      const int nx = bx + BitGrid::DX[d];
      const int ny = by + BitGrid::DY[d];
      if (std::find(cells.begin(), cells.end(), std::make_pair(nx, ny)) ==
          cells.end())
        cells.emplace_back(nx, ny);
    }
    int mx = INT32_MAX, my = INT32_MAX;
    for (const auto &[x, y] : cells) {
      mx = std::min(mx, x);
      my = std::min(my, y);
    }
    std::vector<Position> shape;
    shape.reserve(cells.size());
    for (const auto &[x, y] : cells)
      shape.push_back({static_cast<int8_t>(x - mx), static_cast<int8_t>(y - my)});
    return shape;
  };

  const auto tryPlace = [&](const std::vector<Position> &shape) {
    int bw = 0, bh = 0;
    for (const auto &c : shape) {
      bw = std::max(bw, c.x + 1);
      bh = std::max(bh, c.y + 1);
    }
    if (bw > W || bh > H)
      return false;
    for (int tries = 0; tries < 200; tries++) {
      const int ax = randInt(0, W - bw);
      const int ay = randInt(0, H - bh);
      bool free = true;
      for (const auto &c : shape)
        if (cellUsed[(ax + c.x) * H + (ay + c.y)]) {
          free = false;
          break;
        }
      if (!free)
        continue;
      for (const auto &c : shape)
        cellUsed[(ax + c.x) * H + (ay + c.y)] = 1;
      anchors.push_back({static_cast<int8_t>(ax), static_cast<int8_t>(ay)});
      return true;
    }
    return false;
  };

  for (int b = 0; b < targetBlocks; b++) {
    const auto shape = randomShape(12);
    if (tryPlace(shape))
      shapes.push_back(shape);
  }
  if (shapes.empty()) {
    // Degenerate tight board: guarantee at least a 1-cell goal block.
    const std::vector<Position> unit{{0, 0}};
    if (!tryPlace(unit)) {
      std::cerr << "generate: could not place any block (seed " << seed
                << ")\n";
      return 1;
    }
    shapes.push_back(unit);
  }

  const Position goalAnchor = anchors[0]; // goal starts ON its goal
  // Scramble with a long random walk of valid unit moves.
  BitGrid grid(static_cast<uint8_t>(W), static_cast<uint8_t>(H), shapes);
  grid.buildOccupancy(anchors);
  uint32_t accepted = 0;
  uint64_t attempts = 0;
  const uint64_t maxAttempts = static_cast<uint64_t>(shuffleMoves) * 4;
  while (accepted < shuffleMoves && attempts < maxAttempts) {
    attempts++;
    const auto b = static_cast<uint8_t>(randInt(0, static_cast<int>(shapes.size()) - 1));
    const int d = randInt(0, 3);
    const Position from = anchors[b];
    const Position to = {static_cast<int8_t>(from.x + BitGrid::DX[d]),
                         static_cast<int8_t>(from.y + BitGrid::DY[d])};
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
    for (const auto &c : s)
      cells.push_back({{"x", c.x}, {"y", c.y}});
    shapesJson.push_back(cells);
  }
  fixture["shapes"] = shapesJson;
  json anchorsJson = json::array();
  for (const auto &a : anchors)
    anchorsJson.push_back({{"x", a.x}, {"y", a.y}});
  fixture["initialAnchors"] = anchorsJson;
  fixture["goalIndex"] = 0;
  fixture["goalAnchor"] = {{"x", goalAnchor.x}, {"y", goalAnchor.y}};

  std::ofstream out(outPath);
  if (!out.is_open()) {
    std::cerr << "generate: cannot write " << outPath << "\n";
    return 1;
  }
  out << fixture.dump();

  const bool goalDisplaced =
      anchors[0].x != goalAnchor.x || anchors[0].y != goalAnchor.y;
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

} // namespace

int main(int argc, char **argv) {
  std::string fixturePath;
  std::string engine = "unit";
  std::string dumpPath;
  std::string generatePath;
  uint32_t seed = 0;
  uint32_t shuffleMoves = 100000;
  bool emitJson = false;
  bool settledOnly = false;
  uint16_t pea = 0;
  uint8_t packingWeight = 0;
  uint8_t consolidationGain = 0;
  bool slotHeuristic = false;
  bool requireAllSlots = false;
  bool lockOnSlot = false;
  bool sleepSets = false;
  bool relevantOnly = false;
  bool bands = false;
  uint8_t bandMinPath = DragSolver::Config{}.corridorBandMinPath;
  uint64_t maxStates = 0;    // 0 = unlimited (unchanged behaviour)
  uint64_t maxHeapBytes = 0; // 0 = unlimited; measured bytes, not a proxy
  uint32_t seqTotalMs = 0;   // total cap for the sequential phase; 0 = none
  uint8_t jamAspect16 = DragSolver::Config{}.jamAspect16;   // x16 ratio
  uint8_t jamDensityPct = DragSolver::Config{}.jamDensityPct; // percent
  int armIndex = -1;          // --engine arm: which race arm to run alone
  bool armGated = false;      // apply jamProfile() to arms 6/7 (phase 2 does not)
  std::vector<cascade::ArmOutcome> armOutcomes;
  // Decomposition of a stalled jam board: dump the deepest elite as a residual
  // fixture (+ the root→elite prefix) so the remainder can be solved
  // separately and the two halves stitched.
  std::string dumpElitePath;
  std::string dumpEliteTurnsPath;
  std::string verifyPath;
  uint8_t jamPenalty = 4;
  uint8_t jamGuide = 0;
  bool jamPin = false;
  uint32_t jamRoundCap = 0;
  uint32_t jamElites = 6;
  bool jamLuby = false;
  uint32_t tieSeed = 0;
  uint32_t beamWidth = 0;

  // Production defaults (mirrors wasmBridge.ts SOLVER_CONFIG).
  AStar::Config cfg;
  cfg.weight = 3;
  cfg.pathBlockerWeight = 1;
  cfg.boundaryDistanceWeight = 1;
  cfg.axisAwareWeight = 1;
  cfg.lpDisplacementWeight = 1;
  cfg.postProcess = true;
  uint32_t budgetMs = 60000;
  uint32_t maxNodes = 20000000;

  for (int i = 1; i < argc; i++) {
    const std::string_view arg = argv[i];
    const auto next = [&]() -> const char * {
      if (i + 1 >= argc) {
        std::cerr << "Missing value for " << arg << "\n";
        std::exit(2);
      }
      return argv[++i];
    };
    if (arg == "--fixture") fixturePath = next();
    else if (arg == "--engine") engine = next();
    else if (arg == "--weight") cfg.weight = static_cast<uint8_t>(std::atoi(next()));
    else if (arg == "--budget-ms") budgetMs = static_cast<uint32_t>(std::atoll(next()));
    else if (arg == "--max-nodes") maxNodes = static_cast<uint32_t>(std::atoll(next()));
    else if (arg == "--stride") cfg.strideOverride = static_cast<uint8_t>(std::atoi(next()));
    else if (arg == "--settled") settledOnly = true;
    else if (arg == "--pea") pea = static_cast<uint16_t>(std::atoi(next()));
    else if (arg == "--packing-weight") packingWeight = static_cast<uint8_t>(std::atoi(next()));
    else if (arg == "--consolidation") consolidationGain = static_cast<uint8_t>(std::atoi(next()));
    else if (arg == "--slot-h") slotHeuristic = true;
    else if (arg == "--dump") dumpPath = next();
    else if (arg == "--all-slots") requireAllSlots = true;
    else if (arg == "--ratchet") lockOnSlot = true;
    else if (arg == "--por") sleepSets = true;
    else if (arg == "--relevant") relevantOnly = true;
    else if (arg == "--bands") bands = true;
    else if (arg == "--band-min-path") bandMinPath = static_cast<uint8_t>(std::atoi(next()));
    else if (arg == "--max-states") { maxStates = std::strtoull(next(), nullptr, 10); cfg.maxStatesStored = maxStates; }
    else if (arg == "--arm") armIndex = std::atoi(next());
    else if (arg == "--arm-gated") armGated = true;
    else if (arg == "--jam-density") jamDensityPct = static_cast<uint8_t>(std::atoi(next()));
    else if (arg == "--jam-aspect") jamAspect16 = static_cast<uint8_t>(std::atoi(next()));
    else if (arg == "--seq-total-ms") seqTotalMs = static_cast<uint32_t>(std::strtoul(next(), nullptr, 10));
    else if (arg == "--max-heap-bytes") { maxHeapBytes = std::strtoull(next(), nullptr, 10); cfg.maxHeapBytes = maxHeapBytes; }
    else if (arg == "--dump-elite") dumpElitePath = next();
    else if (arg == "--dump-elite-turns") dumpEliteTurnsPath = next();
    else if (arg == "--verify") verifyPath = next();
    else if (arg == "--jam-penalty") jamPenalty = static_cast<uint8_t>(std::atoi(next()));
    else if (arg == "--jam-guide") jamGuide = static_cast<uint8_t>(std::atoi(next()));
    else if (arg == "--jam-pin") jamPin = true;
    else if (arg == "--jam-round-cap") jamRoundCap = static_cast<uint32_t>(std::atoll(next()));
    else if (arg == "--jam-elites") jamElites = static_cast<uint32_t>(std::atoll(next()));
    else if (arg == "--jam-luby") jamLuby = true;
    else if (arg == "--tie-seed") tieSeed = static_cast<uint32_t>(std::atoll(next()));
    else if (arg == "--beam") beamWidth = static_cast<uint32_t>(std::atoll(next()));
    else if (arg == "--generate") generatePath = next();
    else if (arg == "--seed") seed = static_cast<uint32_t>(std::atoll(next()));
    else if (arg == "--shuffle") shuffleMoves = static_cast<uint32_t>(std::atoll(next()));
    else if (arg == "--no-post") cfg.postProcess = false;
    else if (arg == "--json") emitJson = true;
    else {
      std::cerr << "Unknown argument: " << arg << "\n";
      return usage(argv[0]);
    }
  }
  if (!generatePath.empty())
    return runGenerate(generatePath, seed, shuffleMoves, emitJson);
  if (fixturePath.empty())
    return usage(argv[0]);
  if (engine != "unit" && engine != "drag" && engine != "hier" &&
      engine != "assembly" && engine != "corridor" && engine != "jam" &&
      engine != "beam" && engine != "cascade" && engine != "parallel" &&
      engine != "sequential" && engine != "twophase" && engine != "arm") {
    std::cerr << "Unknown engine '" << engine << "'\n";
    return 2;
  }
  Fixture data;
  try {
    data = loadFixture(fixturePath);
  } catch (const std::exception &e) {
    std::cerr << e.what() << "\n";
    return 1;
  }
  if (!verifyPath.empty())
    return runVerify(data, verifyPath);

  uint64_t t0 = 0, t1 = 0, t2 = 0;
  std::vector<Turn> turns;
  uint32_t nodesExpanded = 0;
  uint64_t statesStored = 0;
  uint8_t passes = 0;
  uint32_t minJamTerm = UINT32_MAX;
  uint32_t maxProgress = 0;
  // True when any search stopped on the measured-memory ceiling rather than
  // the clock or exhaustion — the stdout message is verbose-gated, so the stat
  // is the only reliable signal.
  bool stoppedOnMemory = false;
  std::string stage = engine;
  if (engine == "parallel") {
    // THE SHIPPED PATH. solveArmsParallel is the exact function the threaded
    // wasm build calls for a cross-origin-isolated page (wasm_bindings.cpp
    // under __EMSCRIPTEN_PTHREADS__): 8 arms racing on real threads, first
    // non-empty plan wins and cancels the rest. --engine cascade is the
    // SEQUENTIAL chain and answers a different question — use this one to
    // measure what a browser actually does.
    t0 = nowMs();
    t1 = t0;
    turns = solveArmsParallel(data.gridWidth, data.gridHeight, data.shapes,
                              data.initialAnchors, data.goalIndex,
                              data.goalAnchor, budgetMs, maxNodes,
                              cfg.postProcess, [](uint32_t) {}, maxHeapBytes,
                              jamAspect16, jamDensityPct, &armOutcomes);
    t2 = nowMs();
  } else if (engine == "arm") {
    // Runs ONE race arm with its REAL configuration, via the same runArm the
    // race and the sequential phase use. Necessary because --engine jam/beam
    // build their own default configs and are NOT arms 6/7 — measuring those
    // and calling the result "per-arm" silently compares the wrong solver
    // (it is why an earlier study concluded no arm could solve seed 45501,
    // which arm 6 in fact wins). Ungated by default, matching phase 2.
    if (armIndex < 0 || armIndex >= cascade::ARMS) {
      std::cerr << "--engine arm needs --arm 0.." << (cascade::ARMS - 1)
                << std::endl;
      return 2;
    }
    t0 = nowMs();
    t1 = t0;
    turns = cascade::runArm(armIndex, data.gridWidth, data.gridHeight,
                            data.shapes, data.initialAnchors, data.goalIndex,
                            data.goalAnchor, budgetMs, maxNodes,
                            cfg.postProcess, maxHeapBytes, nullptr,
                            [](uint32_t) {}, armGated, jamAspect16,
                            jamDensityPct);
    t2 = nowMs();
    stage = cascade::armName(armIndex);
  } else if (engine == "sequential" || engine == "twophase") {
    // "sequential" = phase 2 alone (each arm gets the whole heap, ungated).
    // "twophase"   = what the browser will do: race first, fall back second.
    t0 = nowMs();
    t1 = t0;
    if (engine == "twophase")
      turns = solveArmsParallel(data.gridWidth, data.gridHeight, data.shapes,
                                data.initialAnchors, data.goalIndex,
                                data.goalAnchor, budgetMs, maxNodes,
                                cfg.postProcess, [](uint32_t) {}, maxHeapBytes,
                                jamAspect16, jamDensityPct, &armOutcomes);
    if (turns.empty()) {
      if (engine == "twophase")
        std::cout << "cascade: parallel race found nothing - falling back to "
                     "sequential arms (slower; each arm gets the whole heap)\n";
      turns = solveArmsSequential(
          data.gridWidth, data.gridHeight, data.shapes, data.initialAnchors,
          data.goalIndex, data.goalAnchor, budgetMs, seqTotalMs, maxNodes,
          cfg.postProcess, [](uint32_t) {}, maxHeapBytes, nullptr, jamAspect16,
          jamDensityPct, &armOutcomes);
      if (!turns.empty())
        stage = "sequential";
    } else {
      stage = "parallel";
    }
    t2 = nowMs();
  } else if (engine == "cascade") {
    // The production chain (mirrors wasm_bindings' cascade): assembly →
    // hier → deep flat drag → unit, each with the full per-stage budget.
    t0 = nowMs();
    t1 = t0;
    const auto accumulate = [&](const DragSolver &s) {
      nodesExpanded += s.lastStats().nodesExpanded;
      statesStored += s.lastStats().statesStored;
      stoppedOnMemory = stoppedOnMemory || s.lastStats().stoppedOnMemory;
      passes = static_cast<uint8_t>(passes + s.lastStats().passes);
    };
    {
      DragSolver::Config c;
      c.postProcess = cfg.postProcess;
      DragSolver s(data.gridWidth, data.gridHeight, data.shapes,
                   data.initialAnchors, data.goalIndex, data.goalAnchor, c);
      turns = s.searchAssembly(budgetMs, maxNodes);
      accumulate(s);
      if (!turns.empty()) stage = "assembly";
    }
    if (turns.empty()) {
      // Corridor arm: instant-declines unless the goal has no real cuts but a
      // long journey (then synthetic bands make hier decompose the corridor).
      DragSolver::Config c;
      c.weight = 3;
      c.settledOnly = true;
      c.partialExpansionWidth = 48;
      c.corridorBands = true;
      c.postProcess = cfg.postProcess;
      DragSolver s(data.gridWidth, data.gridHeight, data.shapes,
                   data.initialAnchors, data.goalIndex, data.goalAnchor, c);
      turns = s.searchHierarchical(budgetMs, maxNodes);
      accumulate(s);
      if (!turns.empty()) stage = "corridor";
    }
    if (turns.empty()) {
      DragSolver::Config c;
      c.weight = 3;
      c.settledOnly = true;
      c.partialExpansionWidth = 48;
      c.postProcess = cfg.postProcess;
      DragSolver s(data.gridWidth, data.gridHeight, data.shapes,
                   data.initialAnchors, data.goalIndex, data.goalAnchor, c);
      turns = s.searchHierarchical(budgetMs, maxNodes);
      accumulate(s);
      if (!turns.empty()) stage = "hier";
    }
    if (turns.empty()) {
      DragSolver::Config c;
      c.weight = 4;
      c.settledOnly = true;
      c.partialExpansionWidth = 64;
      c.postProcess = cfg.postProcess;
      DragSolver s(data.gridWidth, data.gridHeight, data.shapes,
                   data.initialAnchors, data.goalIndex, data.goalAnchor, c);
      turns = s.search(budgetMs, maxNodes);
      accumulate(s);
      if (!turns.empty()) stage = "drag";
    }
    if (turns.empty()) {
      // Jam arm: relevance filter + commutativity pruning for compact dense
      // boards where the unrestricted searches drown.
      DragSolver::Config c;
      c.weight = 4;
      c.settledOnly = true;
      c.partialExpansionWidth = 64;
      c.sleepSets = true;
      c.relevantOnly = true;
      c.postProcess = cfg.postProcess;
      DragSolver s(data.gridWidth, data.gridHeight, data.shapes,
                   data.initialAnchors, data.goalIndex, data.goalAnchor, c);
      turns = s.search(budgetMs, maxNodes);
      accumulate(s);
      if (!turns.empty()) stage = "relevant";
    }
    if (turns.empty()) {
      // Jam-restart arm: dig-cost-guided diversified rounds for compact
      // dense 0-cut boards; declines instantly outside the jam profile.
      // Luby-shaped caps (20k base / 64 elites): -46% ratchet depth vs stock
      // at the 300s browser budget on the hard-instance family (HARD-BOARDS.md).
      DragSolver::Config c;
      c.corridorBands = true;
      c.jamRoundNodeCap = 20000;
      c.jamMaxElites = 64;
      c.jamLubyRestarts = true;
      c.postProcess = cfg.postProcess;
      DragSolver s(data.gridWidth, data.gridHeight, data.shapes,
                   data.initialAnchors, data.goalIndex, data.goalAnchor, c);
      if (s.jamProfile()) {
        turns = s.searchJamRestarts(budgetMs, maxNodes);
        accumulate(s);
        if (!turns.empty()) stage = "jamrestart";
      }
    }
    if (turns.empty()) {
      // Guided-beam arm: breadth against the jam plateaus the restart
      // rounds dive past. Same gate. The wide-beam/heavy-penalty config is
      // the one that cracked seed 3870 (own process — can afford the RAM).
      DragSolver::Config c;
      c.corridorBands = true;
      c.jamGuideWeight = 8;
      c.jamBlockerPenalty = 8;
      c.beamWidth = 500000;
      c.postProcess = cfg.postProcess;
      DragSolver s(data.gridWidth, data.gridHeight, data.shapes,
                   data.initialAnchors, data.goalIndex, data.goalAnchor, c);
      if (s.jamProfile()) {
        turns = s.searchBeamJam(budgetMs, maxNodes);
        accumulate(s);
        if (!turns.empty()) stage = "jambeam";
      }
    }
    if (turns.empty()) {
      AStar s(data.gridWidth, data.gridHeight, data.shapes,
              data.initialAnchors, data.goalIndex, data.goalAnchor, cfg);
      turns = s.search(budgetMs, maxNodes);
      nodesExpanded += s.lastStats().nodesExpanded;
      statesStored += s.lastStats().statesStored;
      stoppedOnMemory = stoppedOnMemory || s.lastStats().stoppedOnMemory;
      passes = static_cast<uint8_t>(passes + s.lastStats().passes);
      if (!turns.empty()) stage = "unit";
    }
    if (turns.empty())
      stage = "none";
    t2 = nowMs();
  } else if (engine == "drag" || engine == "hier" || engine == "assembly" ||
             engine == "corridor" || engine == "jam" || engine == "beam") {
    DragSolver::Config dcfg;
    dcfg.weight = cfg.weight;
    dcfg.postProcess = cfg.postProcess;
    dcfg.settledOnly = settledOnly;
    dcfg.partialExpansionWidth = pea;
    dcfg.packingWeight = packingWeight;
    dcfg.consolidationGain = consolidationGain;
    dcfg.slotHeuristic = slotHeuristic;
    dcfg.requireAllSlots = requireAllSlots;
    dcfg.lockOnSlot = lockOnSlot;
    dcfg.sleepSets = sleepSets;
    dcfg.relevantOnly = relevantOnly;
    dcfg.corridorBands = (engine == "corridor") || bands;
    dcfg.corridorBandMinPath = bandMinPath;
    dcfg.maxStatesStored = maxStates;
    dcfg.maxHeapBytes = maxHeapBytes;
    dcfg.jamAspect16 = jamAspect16;
    dcfg.jamDensityPct = jamDensityPct;
    dcfg.jamGuideWeight = jamGuide;
    dcfg.jamPinRoute = jamPin;
    dcfg.jamRoundNodeCap = jamRoundCap;
    dcfg.jamMaxElites = jamElites;
    dcfg.jamLubyRestarts = jamLuby;
    dcfg.jamBlockerPenalty = jamPenalty;
    dcfg.tieBreakSeed = tieSeed;
    dcfg.beamWidth = beamWidth;
    t0 = nowMs();
    DragSolver solver(data.gridWidth, data.gridHeight, data.shapes,
                      data.initialAnchors, data.goalIndex, data.goalAnchor,
                      dcfg);
    t1 = nowMs();
    turns = (engine == "hier" || engine == "corridor")
                ? solver.searchHierarchical(budgetMs, maxNodes)
            : engine == "assembly"
                ? solver.searchAssembly(budgetMs, maxNodes)
            : engine == "jam"
                ? solver.searchJamRestarts(budgetMs, maxNodes)
            : engine == "beam"
                ? solver.searchBeamJam(budgetMs, maxNodes)
                : solver.search(budgetMs, maxNodes);
    t2 = nowMs();
    nodesExpanded = solver.lastStats().nodesExpanded;
    statesStored = solver.lastStats().statesStored;
    stoppedOnMemory = solver.lastStats().stoppedOnMemory;
    passes = solver.lastStats().passes;
    minJamTerm = solver.lastStats().minJamTerm;
    maxProgress = solver.lastStats().maxProgress;
    // Decomposition hand-off: on a stalled jam run, write the deepest elite as
    // a residual fixture and its root→elite prefix, so the remainder can be
    // attacked separately and the halves stitched (verify with --verify).
    if (!solver.lastEliteAnchors().empty()) {
      if (!dumpElitePath.empty()) {
        if (writeFixtureAt(data, solver.lastEliteAnchors(), dumpElitePath))
          std::cerr << "elite residual fixture dumped to " << dumpElitePath
                    << "\n";
        else
          std::cerr << "cannot write " << dumpElitePath << "\n";
      }
      if (!dumpEliteTurnsPath.empty()) {
        const auto prefix = solver.lastElitePrefixTurns();
        writeTurnsFile(prefix, dumpEliteTurnsPath);
        std::cerr << "elite prefix (" << prefix.size() << " turns) dumped to "
                  << dumpEliteTurnsPath << "\n";
      }
    }
  } else {
    t0 = nowMs();
    AStar solver(data.gridWidth, data.gridHeight, data.shapes,
                 data.initialAnchors, data.goalIndex, data.goalAnchor, cfg);
    t1 = nowMs();
    turns = solver.search(budgetMs, maxNodes);
    t2 = nowMs();
    nodesExpanded = solver.lastStats().nodesExpanded;
    statesStored = solver.lastStats().statesStored;
    stoppedOnMemory = solver.lastStats().stoppedOnMemory;
    passes = solver.lastStats().passes;
  }

  const auto &goalStart = data.initialAnchors[data.goalIndex];
  const bool alreadySolved = goalStart.x == data.goalAnchor.x &&
                             goalStart.y == data.goalAnchor.y;
  const bool solved = !turns.empty() || alreadySolved;
  const bool valid = !solved || alreadySolved || replaySolves(data, turns);

  json out = {
      {"fixture", std::filesystem::path(fixturePath).filename().string()},
      {"engine", engine},
      {"solved", solved},
      {"valid", valid},
      {"turns", turns.size()},
      {"steps", countPlayerSteps(turns)},
      {"dirRuns", countDirRuns(turns)},
      {"stage", stage},
      {"nodesExpanded", nodesExpanded},
      {"statesStored", statesStored},
      {"passes", passes},
      {"constructMs", t1 - t0},
      {"searchMs", t2 - t1},
      {"wallMs", t2 - t0},
      {"weight", cfg.weight},
      {"minJamTerm", minJamTerm == UINT32_MAX
                         ? -1
                         : static_cast<int64_t>(minJamTerm)},
      {"maxProgress", maxProgress},
      {"stoppedOnMemory", stoppedOnMemory},
      {"jamAspect16", jamAspect16},
      {"jamDensityPct", jamDensityPct},
  };

  // Per-arm telemetry (parallel/sequential/twophase only): which arms solved,
  // which won, and how long each took. Feeds the fuzz aggregation that decides
  // the sequential phase's arm ORDER — without it that order is guesswork.
  if (!armOutcomes.empty()) {
    json arms = json::array();
    for (const auto &a : armOutcomes)
      arms.push_back({{"arm", a.arm},
                      {"name", cascade::armName(a.arm)},
                      {"solved", a.solved},
                      {"won", a.won},
                      {"declined", a.declined},
                      {"wallMs", a.wallMs}});
    out["arms"] = arms;
  }

  if (!dumpPath.empty() && !turns.empty()) {
    json turnsJson = json::array();
    for (const auto &t : turns)
      turnsJson.push_back({{"blockId", t.blockId},
                           {"direction", static_cast<int>(t.direction)}});
    std::ofstream dump(dumpPath);
    dump << turnsJson.dump();
    std::cerr << "turns dumped to " << dumpPath << "\n";
  }

  if (emitJson) {
    std::cout << out.dump() << "\n";
  } else {
    std::cout << out["fixture"].get<std::string>() << ": "
              << (solved ? "SOLVED" : "unsolved") << (valid ? "" : " (INVALID)")
              << ", " << turns.size() << " turns, "
              << countPlayerSteps(turns) << " steps, "
              << nodesExpanded << " nodes, " << (t2 - t0) << " ms\n";
  }
  return 0;
}
