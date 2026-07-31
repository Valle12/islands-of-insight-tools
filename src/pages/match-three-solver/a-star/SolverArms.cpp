#include "SolverArms.h"

#include "SolverClock.h"

#include <algorithm>
#include <cstring>
#include <string>
#include <utility>

#ifdef __EMSCRIPTEN_PTHREADS__
#include <emscripten/threading.h>
#include <thread>
#endif

namespace mt::arms {

namespace {

/// One leg of the cascade: which arm, and what share of the total budget it may
/// spend as a percentage. Shares are of the TOTAL, and every leg is also capped
/// by what is actually left, so an early leg that gives up cheaply hands its
/// unused time to the ones behind it.
struct Leg {
  Outcome (*run)(const Board &, const Config &, Bounds &);
  const char *name;
  int share;
};

/// Order and shares as measured on the captured corpus: greedy alone finds a
/// minimal-length solution on all 49 solvable boards inside 100 ms, so it leads
/// and the prover behind it usually only has to confirm. bnb precedes iddfs
/// because confirming an incumbent is one pass at its depth, where deepening
/// climbs to it; iddfs comes last because it is the arm that raises the proven
/// lower bound on boards nothing can crack.
constexpr auto kCascade = std::to_array<Leg>({
    {.run = runGreedy, .name = "greedy", .share = 5},
    {.run = runBeam, .name = "beam", .share = 15},
    {.run = runBnb, .name = "bnb", .share = 40},
    {.run = proveIddfs, .name = "iddfs", .share = 100},
});

/// Whichever outcome is worth keeping: a proof beats a guess, a shorter answer
/// beats a longer one, and the ruled-out floor is the best either established.
/// The winner keeps its own `arm`, which is how the report names the leg that
/// actually produced the answer rather than the last one to run.
Outcome pickBetter(Outcome left, Outcome right) {
  const bool takeRight = [&] {
    if (right.proven != left.proven)
      return right.proven;
    if (right.moves.empty() != left.moves.empty())
      return left.moves.empty();
    return right.moves.size() < left.moves.size();
  }();
  // Everything that merges rather than being chosen is read out first: after
  // the move below, only the winner is left to speak for both.
  const int ruledOut = std::max(left.ruledOut, right.ruledOut);
  const bool unsolvable = left.unsolvable || right.unsolvable;
  const uint64_t nodes =
      left.stats.nodesExpanded + right.stats.nodesExpanded;
  const uint64_t states = left.stats.statesStored + right.stats.statesStored;
  const bool memory =
      left.stats.stoppedOnMemory || right.stats.stoppedOnMemory;

  Outcome winner = takeRight ? std::move(right) : std::move(left);
  winner.ruledOut = ruledOut;
  winner.unsolvable = unsolvable;
  winner.stats.nodesExpanded = nodes;
  winner.stats.statesStored = states;
  winner.stats.stoppedOnMemory = memory;
  return winner;
}

/// The wall-clock budget for one leg: its share of the total, never more than
/// what is left. 0 in means 0 out — no budget stays no budget.
uint32_t legBudget(const uint32_t totalMs, const int share,
                   const uint64_t deadline) {
  if (totalMs == 0)
    return 0;
  const uint64_t now = nowMs();
  if (deadline <= now)
    return 1; // expires immediately, but still reports its stats
  const uint64_t left = deadline - now;
  const uint64_t slice = static_cast<uint64_t>(totalMs) *
                         static_cast<uint64_t>(share) / 100;
  return static_cast<uint32_t>(slice < left ? slice : left);
}

Outcome runCascade(const Board &board, const Config &cfg, Bounds &bounds) {
  const uint64_t deadline = deadlineFrom(cfg.maxMs);
  Outcome best;
  best.arm = "cascade";
  for (const Leg &leg : kCascade) {
    if (cfg.callbacks != nullptr && cfg.callbacks->onArmStart)
      cfg.callbacks->onArmStart(leg.name);
    Config legCfg = cfg;
    legCfg.maxMs = legBudget(cfg.maxMs, leg.share, deadline);
    Outcome outcome = leg.run(board, legCfg, bounds);
    outcome.arm = std::string("cascade:") + leg.name;
    best = pickBetter(std::move(best), std::move(outcome));
    if (best.proven || best.unsolvable)
      return best;
    if (cfg.cancel != nullptr && cfg.cancel->load(std::memory_order_relaxed))
      return best;
    if (cfg.maxMs != 0 && nowMs() >= deadline)
      return best;
  }
  return best;
}

} // namespace

bool isEngine(const char *name) {
  return std::ranges::any_of(kEngines, [name](const char *known) {
    return std::strcmp(known, name) == 0;
  });
}

Outcome solve(const Board &board, const ArmSpec &spec, const Config &cfg,
              Bounds &bounds) {
  Config armCfg = cfg;
  armCfg.beamWidth = spec.beamWidth;
  armCfg.seed = spec.seed;

  if (std::strcmp(spec.engine, "iddfs") == 0)
    return proveIddfs(board, armCfg, bounds);
  if (std::strcmp(spec.engine, "bnb") == 0)
    return runBnb(board, armCfg, bounds);
  if (std::strcmp(spec.engine, "greedy") == 0)
    return runGreedy(board, armCfg, bounds);
  if (std::strcmp(spec.engine, "beam") == 0)
    return runBeam(board, armCfg, bounds);
  return runCascade(board, armCfg, bounds);
}

Outcome solve(const Board &board, const ArmSpec &spec, const Config &cfg) {
  Bounds bounds;
  return solve(board, spec, cfg, bounds);
}

#ifdef __EMSCRIPTEN_PTHREADS__

namespace {

/// One racing thread each. Mirrors the TS bridge's PORTFOLIO, which is what
/// the non-isolated path spreads over separate workers — keep the two lists in
/// step. The two dives differ only in seed, which changes nothing about the
/// order they search in but does change which arm gets there first when one of
/// them stalls on a heap probe.
constexpr auto kPortfolio = std::to_array<ArmSpec>({
    {.engine = "greedy", .seed = 0},
    {.engine = "beam"},
    {.engine = "bnb", .seed = 0},
    {.engine = "iddfs"},
    {.engine = "beam", .beamWidth = 8192},
    {.engine = "bnb", .seed = 1},
});
constexpr int kArmCount = static_cast<int>(std::size(kPortfolio));

/// How often the module thread looks at what the arms have done.
constexpr uint32_t kPollMs = 200;

/// Reports to JavaScript on behalf of every arm, and stops the race the moment
/// the bounds meet. Returns once every arm has finished.
void pollUntilDone(const Config &cfg, Bounds &bounds,
                   const std::atomic<uint64_t> &progress,
                   const std::atomic<int> &finished,
                   std::atomic<bool> &cancel) {
  int reportedBest = kNoLength;
  while (finished.load(std::memory_order_relaxed) < kArmCount) {
    if (cfg.callbacks != nullptr && cfg.callbacks->onProgress) {
      cfg.callbacks->onProgress(
          {.phase = "race",
           .nodes = progress.load(std::memory_order_relaxed),
           .ruledOut = bounds.ruledOut(),
           .bestLength = bounds.bestLength()});
    }
    const int best = bounds.bestLength();
    if (best != reportedBest) {
      reportedBest = best;
      if (cfg.callbacks != nullptr && cfg.callbacks->onArmStart)
        cfg.callbacks->onArmStart("improved");
    }
    // The bounds meeting IS the proof: no arm has anything left to add.
    if (bounds.proven())
      cancel.store(true, std::memory_order_relaxed);
    emscripten_thread_sleep(kPollMs);
  }
}

} // namespace

Outcome solveParallel(const Board &board, const Config &cfg, Bounds &bounds) {
  std::atomic cancel{false};
  std::atomic<uint64_t> progress{0};
  std::atomic finished{0};
  std::array<Outcome, kArmCount> results;

  {
    std::array<std::thread, kArmCount> threads;
    for (int i = 0; i < kArmCount; i++) {
      threads[slot(i)] = std::thread([&, i] {
        Config armCfg = cfg;
        armCfg.cancel = &cancel;
        armCfg.progress = &progress;
        // Arms never touch JavaScript: only the polling thread may.
        armCfg.callbacks = nullptr;
        // Every arm allocates from the SAME wasm heap, so each table gets a
        // share of it rather than the whole default ceiling.
        armCfg.tableBytes = cfg.tableBytes / kArmCount;
        results[slot(i)] =
            solve(board, kPortfolio[slot(i)], armCfg, bounds);
        finished.fetch_add(1, std::memory_order_relaxed);
      });
    }
    pollUntilDone(cfg, bounds, progress, finished, cancel);
    for (std::thread &thread : threads)
      thread.join();
  }

  Outcome best;
  best.arm = "race";
  for (Outcome &outcome : results) {
    outcome.arm = std::string("race:") + outcome.arm;
    best = pickBetter(std::move(best), std::move(outcome));
  }
  return best;
}

#endif // __EMSCRIPTEN_PTHREADS__

} // namespace mt::arms
