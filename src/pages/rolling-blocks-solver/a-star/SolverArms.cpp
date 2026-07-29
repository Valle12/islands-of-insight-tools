#include "SolverArms.h"

#include "MemoryProbe.h"
#include "Node.h"
#include "PuzzleProfile.h"
#include "SolverClock.h"

#include <algorithm>
#include <string_view>

#ifdef __EMSCRIPTEN_PTHREADS__
#include <array>
#include <atomic>
#include <chrono>
#include <thread>
#endif

namespace {

struct SingleArm {
  std::string_view engine;
  bool gated = false;
  uint32_t beamWidth = 0;
  uint32_t seed = 0;
  uint8_t weight = 2;
  bool overrideWeight = false;
};

std::vector<Turn> runSingle(const replay::Puzzle &puzzle, const SingleArm &arm,
                            const AStar::Config &base,
                            AStar::SearchStats &statsOut,
                            const std::function<void(uint32_t)> &onProgress,
                            const uint64_t progressBase) {
  if (arm.gated) {
    const auto features = puzzleprofile::analyze(puzzle);
    if (arm.engine == "cracker" &&
        !puzzleprofile::coverageProfile(features)) {
      return {};
    }
    if (arm.engine == "exact" && !puzzleprofile::exactProfile(features)) {
      return {};
    }
  }

  AStar::Config cfg = base;
  if (arm.overrideWeight) {
    cfg.weight = arm.weight;
  }
  if (arm.seed != 0) {
    cfg.seed = arm.seed;
  }
  if (arm.engine == "exact") {
    // Weight 0 makes f = g: uniform-cost search, optimal when it finishes.
    // Self-limits by node budget instead of a structural gate — it retires
    // gracefully on boards too big to enumerate.
    cfg.weight = 0;
    if (cfg.maxNodes == 0 || cfg.maxNodes > 2000000) {
      cfg.maxNodes = 2000000;
    }
  } else if (arm.engine == "greedy") {
    // Heavily weighted best-first: depth at all costs, the optimizer cleans
    // up afterwards.
    cfg.weight = 64;
  }

  AStar solver(puzzle.gridWidth, puzzle.gridHeight, puzzle.cells, cfg);
  if (onProgress) {
    solver.setOnProgress([&onProgress, progressBase](uint32_t n) {
      // Offset by the expansions earlier arms already reported, so the
      // page's readout never moves backwards at an arm boundary.
      onProgress(static_cast<uint32_t>(progressBase + n));
    });
  }

  std::vector<Turn> turns;
  if (arm.engine == "cracker") {
    turns = solver.searchCracker(Node(puzzle.blocks));
  } else if (arm.engine == "beam") {
    turns = solver.searchBeam(Node(puzzle.blocks), arm.beamWidth);
  } else {
    turns = solver.search(Node(puzzle.blocks));
  }

  statsOut.nodesExpanded += solver.stats().nodesExpanded;
  statsOut.statesStored =
      std::max(statsOut.statesStored, solver.stats().statesStored);
  statsOut.stoppedOnMemory =
      statsOut.stoppedOnMemory || solver.stats().stoppedOnMemory;
  return turns;
}

// The single-threaded cascade: specialists first (they decline or finish
// fast), the zero-regression weighted arm in the middle, breadth and
// diversified retries after. Fractions are of the TOTAL budget and sum past
// 1 on purpose: later arms only see time that earlier arms declined to use.
struct ChainStep {
  SingleArm arm;
  double budgetShare = 0;
};

// Order re-measured on the first fuzz campaign (30 boards, seeds 5000-5029):
// greedy sat behind wastar+beam and never ran, yet solo it cracked the two
// single-region boards nothing else touched (seed 5012 goal in 6s, seed 5028
// two-block coverage in ~20s) — so it now runs directly after the
// zero-regression arm, whose share shrank to make room.
constexpr double kExactShare = 0.10;
constexpr double kCrackerShare = 0.25;
constexpr double kWastarShare = 0.40;
constexpr double kGreedyShare = 0.25;
constexpr double kBeamShare = 0.25;
constexpr double kRetryShare = 0.20;
constexpr double kTailShare = 0.15;

constexpr ChainStep kCascade[] = {
    {{.engine = "exact", .gated = true}, kExactShare},
    {{.engine = "cracker", .gated = true}, kCrackerShare},
    {{.engine = "wastar", .weight = 2, .overrideWeight = true}, kWastarShare},
    {{.engine = "greedy"}, kGreedyShare},
    {{.engine = "beam", .beamWidth = 50000}, kBeamShare},
    {{.engine = "cracker", .seed = 1}, kRetryShare},
    {{.engine = "wastar", .weight = 4, .overrideWeight = true}, kTailShare},
    {{.engine = "wastar", .weight = 1, .overrideWeight = true}, kTailShare},
};

} // namespace

namespace {

// Region decomposition. A block's footprint is a rectangle and may never
// cover an Unplayable cell, so a block can neither straddle nor jump a wall:
// every block stays inside its starting 4-connected playable region forever.
// Regions are therefore fully independent sub-puzzles — solving each alone
// and concatenating the plans is sound, and it collapses the product state
// space that defeats every arm on multi-region boards (found by the fuzz
// campaign's mixed boards, where a single-block coverage region gated the
// cracker out purely because ANOTHER region's blocks raised the count).
struct Region {
  replay::Puzzle sub;   // full-size board, other regions' goals/must-touch
                        // neutralized, only this region's blocks
  bool needsWork = false;
  bool impossible = false; // goals with no blocks to cover them
};

std::vector<Region> decompose(const replay::Puzzle &puzzle) {
  const size_t totalCells = puzzle.cells.size();
  std::vector<int> component(totalCells, -1);
  int componentCount = 0;
  std::vector<uint16_t> stack;
  for (size_t start = 0; start < totalCells; start++) {
    if (puzzle.cells[start] == Tile::Unplayable || component[start] != -1) {
      continue;
    }
    const int id = componentCount++;
    component[start] = id;
    stack.push_back(static_cast<uint16_t>(start));
    while (!stack.empty()) {
      const uint16_t idx = stack.back();
      stack.pop_back();
      const int cx = idx % puzzle.gridWidth;
      const int cy = idx / puzzle.gridWidth;
      constexpr std::array<std::pair<int, int>, 4> kSteps = {
          {{1, 0}, {-1, 0}, {0, 1}, {0, -1}}};
      for (const auto &[dx, dy] : kSteps) {
        const int nx = cx + dx;
        const int ny = cy + dy;
        if (nx < 0 || nx >= puzzle.gridWidth || ny < 0 ||
            ny >= puzzle.gridHeight) {
          continue;
        }
        const auto nidx = static_cast<uint16_t>(nx + ny * puzzle.gridWidth);
        if (puzzle.cells[nidx] == Tile::Unplayable || component[nidx] != -1) {
          continue;
        }
        component[nidx] = id;
        stack.push_back(nidx);
      }
    }
  }
  if (componentCount <= 1) {
    return {};
  }

  std::vector<Region> regions(static_cast<size_t>(componentCount));
  for (size_t r = 0; r < regions.size(); r++) {
    Region &region = regions[r];
    region.sub.gridWidth = puzzle.gridWidth;
    region.sub.gridHeight = puzzle.gridHeight;
    region.sub.cells = puzzle.cells;
    for (size_t i = 0; i < totalCells; i++) {
      if (component[i] != static_cast<int>(r) &&
          (region.sub.cells[i] == Tile::MustTouch ||
           region.sub.cells[i] == Tile::Goal)) {
        region.sub.cells[i] = Tile::Regular;
      }
      if (component[i] == static_cast<int>(r) &&
          (puzzle.cells[i] == Tile::MustTouch ||
           puzzle.cells[i] == Tile::Goal)) {
        region.needsWork = true;
      }
    }
  }
  for (const auto &block : puzzle.blocks) {
    const auto anchor =
        static_cast<size_t>(block.x + block.y * puzzle.gridWidth);
    const int id = component[anchor];
    if (id >= 0) {
      regions[static_cast<size_t>(id)].sub.blocks.push_back(block);
    }
  }
  for (auto &region : regions) {
    bool hasGoal = false;
    for (size_t i = 0; i < totalCells; i++) {
      if (region.sub.cells[i] == Tile::Goal) {
        hasGoal = true;
        break;
      }
    }
    if ((hasGoal || region.needsWork) && region.sub.blocks.empty()) {
      region.impossible = true;
    }
  }
  return regions;
}

} // namespace

namespace arms {

bool knownEngine(const std::string &engine) {
  return std::ranges::any_of(kEngines,
                             [&](const char *e) { return engine == e; });
}

namespace {

Outcome solveUndecomposed(
    const replay::Puzzle &puzzle, const ArmSpec &spec,
    const AStar::Config &cfg,
    const std::function<void(uint32_t)> &onProgress,
    const std::function<void(const std::string &)> &onArmStart) {
  Outcome outcome;

  if (spec.engine != "cascade") {
    const SingleArm arm{.engine = spec.engine,
                        .gated = spec.gated,
                        .beamWidth = spec.beamWidth};
    if (onArmStart) {
      onArmStart(spec.engine);
    }
    outcome.turns =
        runSingle(puzzle, arm, cfg, outcome.stats, onProgress, 0);
    outcome.arm = spec.engine;
    return outcome;
  }

  // An unlimited cascade would let its first non-declining arm run forever;
  // give it the browser's default ceiling instead.
  const uint32_t totalMs = cfg.maxMs == 0 ? 300000 : cfg.maxMs;
  const uint64_t deadline = nowMs() + totalMs;

  for (const auto &[arm, budgetShare] : kCascade) {
    const uint64_t now = nowMs();
    if (now >= deadline) {
      break;
    }
    AStar::Config armCfg = cfg;
    armCfg.maxMs = static_cast<uint32_t>(
        std::min<uint64_t>(deadline - now,
                           static_cast<uint64_t>(budgetShare * totalMs)));
    if (onArmStart) {
      onArmStart(std::string(arm.engine));
    }
    const uint64_t progressBase = outcome.stats.nodesExpanded;
    auto turns =
        runSingle(puzzle, arm, armCfg, outcome.stats, onProgress, progressBase);
    if (!turns.empty()) {
      outcome.turns = std::move(turns);
      outcome.arm = arm.engine;
      return outcome;
    }
  }
  outcome.arm = "none";
  return outcome;
}

} // namespace

Outcome solve(const replay::Puzzle &puzzle, const ArmSpec &spec,
              const AStar::Config &cfg,
              const std::function<void(uint32_t)> &onProgress,
              const std::function<void(const std::string &)> &onArmStart) {
  // Independent playable regions decompose into independent sub-puzzles
  // solved one after another (cascade only, so a named engine still measures
  // exactly one engine on the whole board).
  if (spec.engine == "cascade") {
    const auto regions = decompose(puzzle);
    if (!regions.empty()) {
      Outcome outcome;
      const uint32_t totalMs = cfg.maxMs == 0 ? 300000 : cfg.maxMs;
      const uint64_t deadline = nowMs() + totalMs;
      for (const auto &region : regions) {
        if (region.impossible) {
          outcome.turns.clear();
          outcome.arm = "decompose:impossible";
          return outcome;
        }
        if (!region.needsWork) {
          continue;
        }
        const uint64_t now = nowMs();
        if (now >= deadline) {
          outcome.turns.clear();
          outcome.arm = "none";
          return outcome;
        }
        AStar::Config regionCfg = cfg;
        regionCfg.maxMs = static_cast<uint32_t>(deadline - now);
        const uint64_t progressBase = outcome.stats.nodesExpanded;
        const Outcome sub = solveUndecomposed(
            region.sub, spec, regionCfg,
            onProgress ? std::function<void(uint32_t)>(
                             [&onProgress, progressBase](uint32_t n) {
                               onProgress(static_cast<uint32_t>(
                                   progressBase + n));
                             })
                       : std::function<void(uint32_t)>{},
            onArmStart);
        outcome.stats.nodesExpanded += sub.stats.nodesExpanded;
        outcome.stats.stoppedOnMemory =
            outcome.stats.stoppedOnMemory || sub.stats.stoppedOnMemory;
        if (sub.turns.empty()) {
          outcome.turns.clear();
          outcome.arm = "none";
          return outcome;
        }
        outcome.turns.insert(outcome.turns.end(), sub.turns.begin(),
                             sub.turns.end());
        outcome.arm = outcome.arm.empty() || outcome.arm == sub.arm
                          ? sub.arm
                          : outcome.arm + "+" + sub.arm;
      }
      if (!outcome.turns.empty()) {
        outcome.arm = "decompose:" + outcome.arm;
      }
      return outcome;
    }
  }
  return solveUndecomposed(puzzle, spec, cfg, onProgress, onArmStart);
}

#ifdef __EMSCRIPTEN_PTHREADS__

namespace {

// One entry per racing thread; mirrors the TS bridge's PORTFOLIO so the
// isolated and non-isolated paths run the same arm set.
constexpr SingleArm kPortfolio[] = {
    {.engine = "exact", .gated = true},
    {.engine = "cracker", .gated = true},
    {.engine = "wastar", .weight = 2, .overrideWeight = true},
    {.engine = "greedy"},
    {.engine = "beam", .beamWidth = 50000},
    {.engine = "cracker", .seed = 1},
    {.engine = "wastar", .weight = 4, .overrideWeight = true},
    {.engine = "wastar", .weight = 1, .overrideWeight = true},
};
constexpr int kArmCount = static_cast<int>(std::size(kPortfolio));

} // namespace

Outcome solveParallel(
    const replay::Puzzle &puzzle, const AStar::Config &cfg,
    const std::function<void(uint32_t)> &onProgress,
    const std::function<void(const std::string &)> &onArmStart) {
  // Multi-region boards go through the decomposition path: per-region
  // cascades beat racing eight arms against the regions' product space.
  if (!decompose(puzzle).empty()) {
    return solve(puzzle, ArmSpec{}, cfg, onProgress, onArmStart);
  }
  Outcome outcome;
  const uint32_t totalMs = cfg.maxMs == 0 ? 300000 : cfg.maxMs;
  const uint64_t heapMax = memprobe::heapCeilingBytes();

  std::atomic<bool> cancel{false};
  std::atomic<int> winner{-1};
  std::atomic<int> finished{0};
  std::array<std::atomic<uint32_t>, kArmCount> progress{};
  std::array<std::vector<Turn>, kArmCount> results;
  std::array<AStar::SearchStats, kArmCount> armStats{};

  {
    std::array<std::thread, kArmCount> threads;
    for (int i = 0; i < kArmCount; i++) {
      threads[static_cast<size_t>(i)] = std::thread([&, i] {
        AStar::Config armCfg = cfg;
        armCfg.maxMs = totalMs;
        armCfg.cancel = &cancel;
        if (heapMax != 0) {
          // 85%: all arms allocate into ONE heap, and the probe's live-bytes
          // reading trails the true peak between checkpoints.
          armCfg.maxHeapBytes = heapMax / 100 * 85;
        }
        auto turns = runSingle(
            puzzle, kPortfolio[static_cast<size_t>(i)], armCfg,
            armStats[static_cast<size_t>(i)],
            [&progress, i](uint32_t n) {
              progress[static_cast<size_t>(i)].store(
                  n, std::memory_order_relaxed);
            },
            0);
        if (!turns.empty()) {
          int expected = -1;
          if (winner.compare_exchange_strong(expected, i)) {
            results[static_cast<size_t>(i)] = std::move(turns);
            cancel.store(true);
          }
        }
        finished.fetch_add(1);
      });
    }

    // Only this (the module's own) thread may talk to JS: poll the arm
    // progress atomics and forward the sum.
    while (finished.load() < kArmCount) {
      std::this_thread::sleep_for(std::chrono::milliseconds(200));
      if (onProgress) {
        uint64_t sum = 0;
        for (const auto &p : progress) {
          sum += p.load(std::memory_order_relaxed);
        }
        onProgress(static_cast<uint32_t>(sum));
      }
    }
    for (auto &t : threads) {
      t.join();
    }
  }

  for (int i = 0; i < kArmCount; i++) {
    outcome.stats.nodesExpanded += armStats[static_cast<size_t>(i)].nodesExpanded;
    outcome.stats.stoppedOnMemory =
        outcome.stats.stoppedOnMemory ||
        armStats[static_cast<size_t>(i)].stoppedOnMemory;
  }

  if (const int w = winner.load(); w >= 0) {
    outcome.turns = std::move(results[static_cast<size_t>(w)]);
    outcome.arm = kPortfolio[static_cast<size_t>(w)].engine;
    return outcome;
  }

  // Every arm came back empty inside the race; retry the arms one at a time
  // with the whole heap to themselves.
  if (onArmStart) {
    onArmStart("sequential");
  }
  AStar::Config seqCfg = cfg;
  if (heapMax != 0) {
    seqCfg.maxHeapBytes = heapMax / 100 * 90;
  }
  const uint64_t progressBase = outcome.stats.nodesExpanded;
  ArmSpec cascade;
  const Outcome seq = solve(
      puzzle, cascade, seqCfg,
      onProgress
          ? std::function<void(uint32_t)>(
                [&onProgress, progressBase](uint32_t n) {
                  onProgress(static_cast<uint32_t>(progressBase + n));
                })
          : std::function<void(uint32_t)>{},
      onArmStart);
  outcome.turns = seq.turns;
  outcome.arm = seq.arm;
  outcome.stats.nodesExpanded += seq.stats.nodesExpanded;
  outcome.stats.stoppedOnMemory =
      outcome.stats.stoppedOnMemory || seq.stats.stoppedOnMemory;
  return outcome;
}

#endif // __EMSCRIPTEN_PTHREADS__

} // namespace arms
