#include "SolverArms.h"

#include "Profile.h"
#include "Puzzle.h"
#include "Rules.h"
#include "Search.h"
#include "SolverClock.h"

#include <algorithm>
#include <array>
#include <cstdint>
#include <cstring>
#include <string>
#include <utility>

#ifdef __EMSCRIPTEN_PTHREADS__
#include <atomic>
#include <emscripten/threading.h>
#include <thread>
#endif

namespace lg::arms {
namespace {

/// What share of the budget the cheap deduction pass may spend before the
/// search proper starts. It usually finishes in milliseconds; the cap is only
/// there so a board whose look-ahead is expensive still leaves time to search.
inline constexpr uint32_t kDeduceSharePercent = 25;

uint32_t legBudget(const uint32_t totalMs, const uint32_t share,
                   const uint64_t deadline) {
  if (totalMs == 0)
    return 0;
  const uint64_t slice = static_cast<uint64_t>(totalMs) * share / 100;
  const uint64_t now = nowMs();
  if (deadline == 0 || now >= deadline)
    return 1;
  return static_cast<uint32_t>(std::min(slice, deadline - now));
}

Config withBudget(const Config &cfg, const uint32_t maxMs) {
  Config sliced = cfg;
  sliced.maxMs = maxMs;
  return sliced;
}

void announce(const Config &cfg, const char *name) {
  if (cfg.callbacks != nullptr && cfg.callbacks->onArmStart)
    cfg.callbacks->onArmStart(name);
}

/**
 * Deduce first, then either work out the forced cells or find one solution.
 *
 * An underclued board goes straight to `forced`, which does its own deduction
 * pass — running one here as well would only repeat it. Every other board gets
 * the cheap pass first, because on a properly clued puzzle it very often
 * finishes the board outright.
 */
Outcome runCascade(const Model &model, const Config &cfg) {
  if (model.hasRule(rules::Rule::Underclued)) {
    // The sweep first, where it applies. It enumerates the whole space, so it
    // reads the forced set straight off one backward pass instead of proving
    // each candidate cell with its own search — and a letter-only board with no
    // rules gives that search nothing to prune with, which is exactly where
    // `runForced` stalls. Measured: three captured boards that never finished
    // now answer in milliseconds.
    if (cfg.seed == 0 && profile::applicable(model)) {
      announce(cfg, "profile");
      const Config sweepCfg = withBudget(cfg, cfg.maxMs);
      if (Outcome swept = profile::runProfileForced(model, sweepCfg);
          swept.status == Status::Deduced ||
          swept.status == Status::Unsolvable) {
        swept.arm = "cascade:profile";
        return swept;
      }
    }
    announce(cfg, "forced");
    Outcome outcome = runForced(model, cfg);
    outcome.arm = "cascade:forced";
    return outcome;
  }

  const uint64_t deadline = deadlineFrom(cfg.maxMs);
  announce(cfg, "deduce");
  // Named rather than passed inline: `Budget` keeps a reference to the config
  // it was built with, and a temporary would only be alive for the call.
  const Config deduceCfg =
      withBudget(cfg, legBudget(cfg.maxMs, kDeduceSharePercent, deadline));
  Outcome deduced = runDeduce(model, deduceCfg);
  if (deduced.status == Status::Solved ||
      deduced.status == Status::Unsolvable) {
    deduced.arm = "cascade:deduce";
    return deduced;
  }

  // The profile sweep before the DFS, and only where it applies. On a board
  // whose constraints are pure connectivity it answers outright — measured, it
  // takes `logicGridTest47` from about eight seconds to a few milliseconds and
  // settles `logicGridTest67`, which the DFS never finishes. Where it does not
  // apply it costs one predicate, and where it runs out of room it says so and
  // falls through with nothing claimed.
  //
  // Seed 0 only, because the sweep is deterministic: the other cascade arms
  // would repeat identical work, and on the widest board each copy wants a few
  // hundred megabytes at once. `armIsUseful` below stops those arms being
  // started at all in the in-module race, for the same reason.
  if (cfg.seed == 0 && profile::applicable(model)) {
    announce(cfg, "profile");
    const Config profileCfg =
        withBudget(cfg, legBudget(cfg.maxMs, 100, deadline));
    Outcome swept = profile::runProfile(model, profileCfg);
    if (swept.status == Status::Solved ||
        swept.status == Status::Unsolvable) {
      swept.stats.nodesExpanded += deduced.stats.nodesExpanded;
      swept.arm = "cascade:profile";
      return swept;
    }
    deduced.stats.nodesExpanded += swept.stats.nodesExpanded;
  }

  announce(cfg, "dfs");
  const Config searchCfg = withBudget(cfg, legBudget(cfg.maxMs, 100, deadline));
  Outcome found = runDfs(model, searchCfg);
  found.stats.nodesExpanded += deduced.stats.nodesExpanded;
  if (found.status == Status::Unsolved) {
    // Nothing was found, but the deduction still holds and is worth showing.
    found.colors = deduced.colors;
    found.decided = deduced.decided;
  }
  found.arm = "cascade:dfs";
  return found;
}

} // namespace

bool isEngine(const char *name) {
  return std::ranges::any_of(kEngines, [name](const char *known) {
    return std::strcmp(known, name) == 0;
  });
}

int rank(const Outcome &outcome) {
  using enum Status;
  switch (outcome.status) {
  case Solved:
  case Unsolvable:
    return 4;
  case Deduced:
    // Only a PROVEN deduction ranks top and ends a race. A partial one is
    // worth showing but never worth stopping for, since another arm may still
    // settle the cells it left blank.
    return outcome.proven ? 4 : 2;
  case Unsolved:
    return outcome.decided > 0 ? 1 : 0;
  }
  return 0;
}

Outcome solve(const Model &model, const ArmSpec &spec, const Config &cfg) {
  Config armCfg = cfg;
  armCfg.seed = spec.seed;
  if (std::strcmp(spec.engine, "deduce") == 0)
    return runDeduce(model, armCfg);
  if (std::strcmp(spec.engine, "dfs") == 0)
    return runDfs(model, armCfg);
  if (std::strcmp(spec.engine, "forced") == 0)
    return runForced(model, armCfg);
  if (std::strcmp(spec.engine, "profile") == 0)
    return model.hasRule(rules::Rule::Underclued)
               ? profile::runProfileForced(model, armCfg)
               : profile::runProfile(model, armCfg);
  return runCascade(model, armCfg);
}

#ifdef __EMSCRIPTEN_PTHREADS__
namespace {

constexpr auto kPortfolio = std::to_array<ArmSpec>({
    {.engine = "deduce"},
    {.engine = "cascade", .seed = 0},
    {.engine = "cascade", .seed = 1},
    {.engine = "cascade", .seed = 2},
});
constexpr int kArmCount = static_cast<int>(std::size(kPortfolio));
constexpr uint32_t kPollMs = 200;

/// Merges two arms' answers, keeping the better one and every arm's counters.
/// Everything needed from both is read BEFORE either is moved from.
Outcome pickBetter(Outcome left, Outcome right) {
  const uint64_t nodes =
      left.stats.nodesExpanded + right.stats.nodesExpanded;
  const uint64_t refutations =
      left.stats.refutations + right.stats.refutations;
  const uint64_t rejections =
      left.stats.oracleRejections + right.stats.oracleRejections;
  const bool memory =
      left.stats.stoppedOnMemory || right.stats.stoppedOnMemory;
  const int leftRank = rank(left);
  const int rightRank = rank(right);
  const bool takeRight = rightRank > leftRank ||
                         (rightRank == leftRank && right.decided > left.decided);

  Outcome winner = takeRight ? std::move(right) : std::move(left);
  winner.stats.nodesExpanded = nodes;
  winner.stats.refutations = refutations;
  winner.stats.oracleRejections = rejections;
  winner.stats.stoppedOnMemory = memory;
  return winner;
}

/// Everything the polling thread watches. Bundled because the poll needs all
/// of it and a seven-parameter signature is its own kind of bug.
struct RaceState {
  std::atomic<bool> cancel{false};
  std::atomic<uint64_t> progress{0};
  std::atomic<int> finished{0};
  /// The most cells any arm has settled, for the progress line.
  std::atomic<int> decided{0};
  /// Set once an arm has an answer worth stopping every other arm for.
  std::atomic<bool> settled{false};
};

void pollUntilDone(const Config &cfg, RaceState &state) {
  while (state.finished.load(std::memory_order_relaxed) < kArmCount) {
    if (cfg.callbacks != nullptr && cfg.callbacks->onProgress) {
      cfg.callbacks->onProgress(
          {.phase = "race",
           .nodes = state.progress.load(std::memory_order_relaxed),
           .decided = state.decided.load(std::memory_order_relaxed),
           .pending = 0});
    }
    if (state.settled.load(std::memory_order_relaxed))
      state.cancel.store(true, std::memory_order_relaxed);
    emscripten_thread_sleep(kPollMs);
  }
}

} // namespace

/**
 * Whether this arm is worth a thread on this board.
 *
 * When the profile sweep applies and is going to run, the extra cascade seeds
 * are dead weight: they differ only in how the DFS below orders its guesses,
 * and the DFS cannot finish the boards the sweep exists for. Worse than
 * useless, in fact — every thread here shares one wasm heap and one allocator
 * lock, and the sweep allocates hard. Measured in the browser on
 * `logicGridTest67`, leaving them out is the difference between finishing
 * inside the page's budget and not.
 *
 * They stay for every other board, where the seeds are exactly what diversifies
 * the search.
 */
bool armIsUseful(const Model &model, const ArmSpec &spec) {
  if (spec.seed == 0 || std::strcmp(spec.engine, "cascade") != 0)
    return true;
  return !profile::applicable(model);
}

Outcome solveParallel(const Model &model, const Config &cfg) {
  RaceState state;
  std::array<Outcome, kArmCount> results;

  {
    std::array<std::thread, kArmCount> threads;
    for (int i = 0; i < kArmCount; i++) {
      if (!armIsUseful(model, kPortfolio[slot(i)])) {
        state.finished.fetch_add(1, std::memory_order_relaxed);
        continue;
      }
      threads[slot(i)] = std::thread([&state, &results, &model, &cfg, i] {
        Config armCfg = cfg;
        armCfg.cancel = &state.cancel;
        armCfg.progress = &state.progress;
        // Arms never touch JavaScript: only the module's own thread may.
        armCfg.callbacks = nullptr;
        Outcome outcome = solve(model, kPortfolio[slot(i)], armCfg);
        if (rank(outcome) == 4)
          state.settled.store(true, std::memory_order_relaxed);
        if (outcome.decided > state.decided.load(std::memory_order_relaxed))
          state.decided.store(outcome.decided, std::memory_order_relaxed);
        results[slot(i)] = std::move(outcome);
        state.finished.fetch_add(1, std::memory_order_relaxed);
      });
    }
    pollUntilDone(cfg, state);
    for (std::thread &thread : threads) {
      if (thread.joinable())
        thread.join();
    }
  }

  Outcome merged;
  merged.arm = "race";
  for (Outcome &outcome : results) {
    outcome.arm = std::string("race:") + outcome.arm;
    merged = pickBetter(std::move(merged), std::move(outcome));
  }
  return merged;
}
#endif

} // namespace lg::arms
