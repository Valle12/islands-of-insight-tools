#include "SolverArms.h"

#include "Node.h"
#include "PuzzleProfile.h"
#include "SolverClock.h"

#include <algorithm>
#include <string_view>

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

constexpr double kExactShare = 0.10;
constexpr double kCrackerShare = 0.25;
constexpr double kWastarShare = 0.60;
constexpr double kBeamShare = 0.30;
constexpr double kRetryShare = 0.20;
constexpr double kTailShare = 0.15;

constexpr ChainStep kCascade[] = {
    {{.engine = "exact", .gated = true}, kExactShare},
    {{.engine = "cracker", .gated = true}, kCrackerShare},
    {{.engine = "wastar", .weight = 2, .overrideWeight = true}, kWastarShare},
    {{.engine = "beam", .beamWidth = 50000}, kBeamShare},
    {{.engine = "cracker", .seed = 1}, kRetryShare},
    {{.engine = "wastar", .weight = 4, .overrideWeight = true}, kTailShare},
    {{.engine = "greedy"}, kTailShare},
    {{.engine = "wastar", .weight = 1, .overrideWeight = true}, kTailShare},
};

} // namespace

namespace arms {

bool knownEngine(const std::string &engine) {
  return std::ranges::any_of(kEngines,
                             [&](const char *e) { return engine == e; });
}

Outcome solve(const replay::Puzzle &puzzle, const ArmSpec &spec,
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

} // namespace arms
