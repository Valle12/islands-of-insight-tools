#pragma once

#include "AStar.h"
#include "DragSolver.h"
#include "Types.h"

#include <array>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <functional>
#include <thread>
#include <vector>

namespace cascade {

inline constexpr int ARMS = 8;

inline uint64_t nowMsSteady() {
  using namespace std::chrono;
  return static_cast<uint64_t>(
      duration_cast<milliseconds>(steady_clock::now().time_since_epoch())
          .count());
}

inline const char *armName(const int arm) {
  switch (arm) {
  case 0:
    return "hier";
  case 1:
    return "drag";
  case 2:
    return "unit";
  case 3:
    return "corridor";
  case 4:
    return "assembly";
  case 5:
    return "jam";
  case 6:
    return "jamrestart";
  case 7:
    return "jambeam";
  default:
    return "?";
  }
}

// A board whose goal block already sits on goalAnchor. Its solution is the
// empty plan, and the arms all return that — but "empty" is also what a failed
// arm returns, so the race would run every arm to its full budget and then
// escalate to the sequential phase before answering. Checked up front instead.
inline bool alreadySolved(const std::vector<Position> &initialAnchors,
                          const uint8_t goalIndex, const Position goalAnchor) {
  return goalIndex < initialAnchors.size() &&
         initialAnchors[goalIndex].x == goalAnchor.x &&
         initialAnchors[goalIndex].y == goalAnchor.y;
}

// Per-arm outcome, so a fuzz campaign can answer "which arms actually earn
// their slot, and how fast" instead of it being guesswork. In the race the
// losers are cancelled, so their wallMs is a lower bound; in the sequential
// phase every number is a true runtime.
struct ArmOutcome {
  int arm = -1;
  bool solved = false;   // produced a non-empty plan
  bool won = false;      // its plan is the one returned
  bool declined = false; // gate said no, or it bailed instantly
  uint32_t wallMs = 0;
};

// One production arm, extracted so the parallel race and the sequential
// fallback run byte-identical configurations — two copies would drift.
//
// `respectJamGate` is the one deliberate difference between the two callers.
// Arms 6 and 7 normally decline unless jamProfile() holds, because spending a
// racing thread on them elsewhere is usually waste. In the sequential phase
// that trade inverts: the fast attempt has already failed, nothing else is
// competing for the thread, and measurement showed the gate is what loses
// boards — seed 41193 (37x9) is solved by arm 6 in 12ms but excluded by the
// aspect test, and 42889 (25x7) likewise. So phase 2 runs every arm ungated.
inline std::vector<Turn>
runArm(const int arm, const uint8_t gridWidth, const uint8_t gridHeight,
       const std::vector<std::vector<Position>> &shapes,
       const std::vector<Position> &initialAnchors, const uint8_t goalIndex,
       const Position goalAnchor, const uint32_t maxMs, const uint32_t maxNodes,
       const bool postProcess, const uint64_t maxHeapBytes,
       std::atomic<bool> *cancel,
       const std::function<void(uint32_t)> &onArmProgress,
       // Defer to DragSolver::Config's own defaults rather than re-declaring
       // them here: the literals used to be 42/40, which silently overrode the
       // validated 66/35 relaxation for every caller that did not pass them
       // (wasm_bindings.cpp and json_test.cpp both omit these arguments), so
       // the shipped cross-origin-isolated build and the C++ test suite ran the
       // pre-relaxation gate while main.cpp ran the relaxed one.
       const bool respectJamGate,
       const uint8_t jamAspect16 = DragSolver::Config{}.jamAspect16,
       const uint8_t jamDensityPct = DragSolver::Config{}.jamDensityPct) {
  switch (arm) {
  case 0: { // receding-horizon drag search — fast on cut-structured puzzles
    DragSolver::Config cfg;
    cfg.maxHeapBytes = maxHeapBytes;
    cfg.jamAspect16 = jamAspect16;
    cfg.jamDensityPct = jamDensityPct;
    cfg.weight = 3;
    cfg.settledOnly = true;
    cfg.partialExpansionWidth = 48;
    cfg.postProcess = postProcess;
    cfg.cancel = cancel;
    DragSolver solver(gridWidth, gridHeight, shapes, initialAnchors, goalIndex,
                      goalAnchor, cfg);
    solver.setOnProgress(onArmProgress);
    return solver.searchHierarchical(maxMs, maxNodes);
  }
  case 1: { // the deep-puzzle flat drag config (cracked shiftingMosaicTest37)
    DragSolver::Config cfg;
    cfg.maxHeapBytes = maxHeapBytes;
    cfg.jamAspect16 = jamAspect16;
    cfg.jamDensityPct = jamDensityPct;
    cfg.weight = 4;
    cfg.settledOnly = true;
    cfg.partialExpansionWidth = 64;
    cfg.postProcess = postProcess;
    cfg.cancel = cancel;
    DragSolver solver(gridWidth, gridHeight, shapes, initialAnchors, goalIndex,
                      goalAnchor, cfg);
    solver.setOnProgress(onArmProgress);
    return solver.search(maxMs, maxNodes == 0 ? 0 : maxNodes);
  }
  case 2: { // the legacy unit-move production config — zero-regression arm
    AStar::Config cfg;
    cfg.maxHeapBytes = maxHeapBytes;
    // no jamAspect16 here: the unit arm is AStar and has no jam gate.
    cfg.weight = 3;
    cfg.pathBlockerWeight = 1;
    cfg.boundaryDistanceWeight = 1;
    cfg.axisAwareWeight = 1;
    cfg.lpDisplacementWeight = 1;
    cfg.postProcess = postProcess;
    cfg.cancel = cancel;
    AStar solver(gridWidth, gridHeight, shapes, initialAnchors, goalIndex,
                 goalAnchor, cfg);
    solver.setOnProgress(onArmProgress);
    return solver.search(maxMs, maxNodes);
  }
  case 3: { // corridor — synthetic distance bands (declines fast on cut boards)
    DragSolver::Config cfg;
    cfg.maxHeapBytes = maxHeapBytes;
    cfg.jamAspect16 = jamAspect16;
    cfg.jamDensityPct = jamDensityPct;
    cfg.weight = 3;
    cfg.settledOnly = true;
    cfg.partialExpansionWidth = 48;
    cfg.corridorBands = true;
    cfg.postProcess = postProcess;
    cfg.cancel = cancel;
    DragSolver solver(gridWidth, gridHeight, shapes, initialAnchors, goalIndex,
                      goalAnchor, cfg);
    solver.setOnProgress(onArmProgress);
    return solver.searchHierarchical(maxMs, maxNodes);
  }
  case 4: { // assembly — pack-then-slide (declines fast without a packing)
    DragSolver::Config cfg;
    cfg.maxHeapBytes = maxHeapBytes;
    cfg.jamAspect16 = jamAspect16;
    cfg.jamDensityPct = jamDensityPct;
    cfg.postProcess = postProcess;
    cfg.cancel = cancel;
    DragSolver solver(gridWidth, gridHeight, shapes, initialAnchors, goalIndex,
                      goalAnchor, cfg);
    solver.setOnProgress(onArmProgress);
    return solver.searchAssembly(maxMs, maxNodes);
  }
  case 5: { // jam — relevance filter + commutativity pruning for compact
            // dense boards where the unrestricted searches drown
    DragSolver::Config cfg;
    cfg.maxHeapBytes = maxHeapBytes;
    cfg.jamAspect16 = jamAspect16;
    cfg.jamDensityPct = jamDensityPct;
    cfg.weight = 4;
    cfg.settledOnly = true;
    cfg.partialExpansionWidth = 64;
    cfg.sleepSets = true;
    cfg.relevantOnly = true;
    cfg.postProcess = postProcess;
    cfg.cancel = cancel;
    DragSolver solver(gridWidth, gridHeight, shapes, initialAnchors, goalIndex,
                      goalAnchor, cfg);
    solver.setOnProgress(onArmProgress);
    return solver.search(maxMs, maxNodes);
  }
  case 6: { // jam restarts — dig-cost-guided diversified rounds for compact
            // dense 0-cut boards (cracked seeds 10276/4722; bands covers 9164)
    DragSolver::Config cfg;
    cfg.maxHeapBytes = maxHeapBytes;
    cfg.jamAspect16 = jamAspect16;
    cfg.jamDensityPct = jamDensityPct;
    cfg.corridorBands = true; // synthesizes only on 0-cut long-path boards
    // Luby-shaped round caps: at the browser's ~300s/arm budget the stock
    // 1.5M-node cap yields only ~4 restart rounds, but the elite ratchet is a
    // lottery that needs many (seed 8697: 110). Measured on the hard-instance
    // family at 300s, luby20k/e64 descends the ratchet -46% deeper than stock
    // (mean minJamTerm 40->21.7) — best of every config tried. See
    // HARD-BOARDS.md.
    cfg.jamRoundNodeCap = 20000;
    cfg.jamMaxElites = 64;
    cfg.jamLubyRestarts = true;
    cfg.postProcess = postProcess;
    cfg.cancel = cancel;
    DragSolver solver(gridWidth, gridHeight, shapes, initialAnchors, goalIndex,
                      goalAnchor, cfg);
    if (respectJamGate && !solver.jamProfile())
      return {};
    solver.setOnProgress(onArmProgress);
    return solver.searchJamRestarts(maxMs, maxNodes);
  }
  case 7: { // guided beam — breadth against the jam plateaus the restart
            // rounds dive past. Heavy penalty is the config that cracked 3870.
    DragSolver::Config cfg;
    cfg.maxHeapBytes = maxHeapBytes;
    cfg.jamAspect16 = jamAspect16;
    cfg.jamDensityPct = jamDensityPct;
    cfg.corridorBands = true;
    cfg.jamGuideWeight = 8;
    cfg.jamBlockerPenalty = 8;
    cfg.postProcess = postProcess;
    cfg.cancel = cancel;
    DragSolver solver(gridWidth, gridHeight, shapes, initialAnchors, goalIndex,
                      goalAnchor, cfg);
    if (respectJamGate && !solver.jamProfile())
      return {};
    solver.setOnProgress(onArmProgress);
    return solver.searchBeamJam(maxMs, maxNodes);
  }
  default:
    return {};
  }
}

} // namespace cascade

// Races the production solver arms on std::threads and returns the first
// non-empty plan (the others are cancelled cooperatively). Works both natively
// and under emscripten pthreads. The caller's thread blocks in here, polling
// per-arm progress atomics and forwarding their sum to `onProgress` — arms
// themselves never touch the callback, so under emscripten only the calling
// (module) thread ever crosses into JS.
inline std::vector<Turn> solveArmsParallel(
    const uint8_t gridWidth, const uint8_t gridHeight,
    const std::vector<std::vector<Position>> &shapes,
    const std::vector<Position> &initialAnchors, const uint8_t goalIndex,
    const Position goalAnchor, const uint32_t maxMs, const uint32_t maxNodes,
    const bool postProcess, const std::function<void(uint32_t)> &onProgress,
    // Measured-bytes ceiling applied to EVERY arm. 0 = unlimited. This matters
    // most here and nowhere else: under emscripten pthreads all 8 arms share
    // ONE heap, so an unbounded arm does not merely fail itself — exhausting a
    // shared wasm heap ABORTS the module, taking down arms that were winning.
    const uint64_t maxHeapBytes = 0,
    const uint8_t jamAspect16 = DragSolver::Config{}.jamAspect16,
    const uint8_t jamDensityPct = DragSolver::Config{}.jamDensityPct,
    std::vector<cascade::ArmOutcome> *outcomes = nullptr) {
  using cascade::ARMS;
  if (cascade::alreadySolved(initialAnchors, goalIndex, goalAnchor)) {
    if (outcomes)
      outcomes->clear();
    return {};
  }
  std::atomic cancel{false};
  std::atomic winner{-1};
  std::atomic finished{0};
  std::array<std::atomic<uint32_t>, ARMS> progress = {};
  std::vector<Turn> results[ARMS];

  const auto claimWin = [&](const int arm) {
    if (int expected = -1; winner.compare_exchange_strong(expected, arm))
      cancel.store(true);
  };

  std::array<std::atomic<uint32_t>, ARMS> armMs = {};
  std::array<std::thread, ARMS> threads;
  for (int i = 0; i < ARMS; i++) {
    threads[i] = std::thread([&, i] {
      const uint64_t started = cascade::nowMsSteady();
      results[i] = cascade::runArm(
          i, gridWidth, gridHeight, shapes, initialAnchors, goalIndex,
          goalAnchor, maxMs, maxNodes, postProcess, maxHeapBytes, &cancel,
          [&progress, i](const uint32_t n) {
            progress[i].store(n);
          },
          /*respectJamGate=*/true, jamAspect16, jamDensityPct);
      armMs[i].store(static_cast<uint32_t>(cascade::nowMsSteady() - started));
      if (!results[i].empty())
        claimWin(i);
      finished.fetch_add(1);
    });
  }

  while (finished.load() < ARMS) {
    std::this_thread::sleep_for(std::chrono::milliseconds(200));
    if (onProgress) {
      uint32_t sum = 0;
      for (const auto &p : progress)
        sum += p.load();
      onProgress(sum);
    }
  }
  for (auto &t : threads)
    t.join();

  const int w = winner.load();
  if (outcomes) {
    outcomes->clear();
    for (int i = 0; i < ARMS; i++) {
      const uint32_t ms = armMs[i].load();
      outcomes->push_back({.arm = i,
                           .solved = !results[i].empty(),
                           .won = i == w,
                           // <5ms with no plan means it gate-declined or
                           // short-circuited rather than actually searching.
                           .declined = results[i].empty() && ms < 5,
                           .wallMs = ms});
    }
  }
  if (w >= 0)
    return results[w];
  for (const auto &r : results)
    if (!r.empty())
      return r;
  return {};
}

// Last-resort fallback: run the same arms ONE AT A TIME, so each gets the whole
// heap instead of a contested slice of it, and run them UNGATED.
//
// Why this exists (measured, seeds regenerated from the v4 campaign):
//   42889 — the race fails at 351s; arm 2 (unit) solves it alone in 108s using
//           6.24GB. In the race, arms 0/1/3 fill the shared 8GB and everything
//           stops before unit can get there. Pure starvation.
//   41193 — solved by arm 6 in 12ms, but the aspect leg of jamProfile() (37x9)
//           excludes that arm from the race entirely.
// Neither needs a better algorithm; both need resources or permission.
//
// Cost is wall-clock: arms run in series. It is bounded in practice because a
// memory-bound arm self-terminates early (on 45501 the hungry arms hit 8GB at
// 66-221s rather than running their full budget), and `totalMaxMs` caps the
// phase outright. Callers must tell the user this phase has started — it is
// materially slower than the race.
inline std::vector<Turn> solveArmsSequential(
    const uint8_t gridWidth, const uint8_t gridHeight,
    const std::vector<std::vector<Position>> &shapes,
    const std::vector<Position> &initialAnchors, const uint8_t goalIndex,
    const Position goalAnchor, const uint32_t maxMsPerArm,
    const uint32_t totalMaxMs, const uint32_t maxNodes, const bool postProcess,
    const std::function<void(uint32_t)> &onProgress,
    const uint64_t maxHeapBytes = 0, std::atomic<bool> *cancel = nullptr,
    const uint8_t jamAspect16 = DragSolver::Config{}.jamAspect16,
    const uint8_t jamDensityPct = DragSolver::Config{}.jamDensityPct,
    std::vector<cascade::ArmOutcome> *outcomes = nullptr,
    // Called as each arm starts. The browser surfaces this so the slow phase
    // visibly progresses; without it the UI sits on one unchanged line for
    // minutes and reads as a hang.
    const std::function<void(const char *)> &onArmStart = {}) {
  // Own the buffer the way solveArmsParallel does. main.cpp's --engine twophase
  // hands the SAME vector to both phases, so appending here without clearing
  // produced 8 race rows followed by up to 8 sequential rows: duplicate arm
  // ids, two `won:true` entries, and cancelled-loser wallMs (a lower bound)
  // mixed with true standalone runtimes — corrupting the very telemetry the
  // ORDER below is derived from.
  if (outcomes)
    outcomes->clear();
  if (cascade::alreadySolved(initialAnchors, goalIndex, goalAnchor))
    return {};

  const uint64_t deadline =
      totalMaxMs == 0 ? 0 : cascade::nowMsSteady() + totalMaxMs;
  uint32_t carried = 0; // progress from arms already finished

  // ORDER is MEASURED, not assumed: all 8 arms were run standalone against
  // every one of 12 boards the race loses (96 runs, 300s and an 8GB cap each,
  // ungated exactly as here) — test-results/arm-study.
  //
  //   arm         wins/12   median win   fastest
  //   jamrestart      7        81s          11ms
  //   unit            1        52s
  //   jam             1        77s
  //   corridor        1       251s
  //   hier/drag/assembly/jambeam   0
  //
  // jamrestart wins 7 of 12 and no other arm wins more than one; on 56676,
  // where three arms can win, it is also the fastest (20s vs 52s vs 251s).
  // Ordering by win rate, then median time; the four arms that never win are
  // ordered cheapest-first, with assembly early because it declines in
  // milliseconds when no packing exists and drag last as the memory glutton.
  //
  // NOTE the easy-board distribution is nearly the INVERSE of this (unit 45%
  // and corridor 35% of wins over 2,000 fuzz boards, jamrestart 1.5%). Phase 2
  // only ever runs on boards the race already lost, so ordering it from
  // general fuzz statistics would put the one arm that matters last.
  //
  // 4 of the 12 (41926, 48368, 60672, 60758) are solved by no arm at all, so
  // no ordering rescues them.
  for (constexpr std::array ORDER = {6, 2, 5, 3, 4, 7, 0, 1};
       const int arm : ORDER) {
    if (cancel && cancel->load())
      return {};
    uint32_t budget = maxMsPerArm;
    if (deadline != 0) {
      const uint64_t now = cascade::nowMsSteady();
      if (now >= deadline)
        break;
      const auto left = static_cast<uint32_t>(deadline - now);
      budget = maxMsPerArm == 0 ? left : std::min(maxMsPerArm, left);
    }
    const uint32_t armBase = carried;
    if (onArmStart)
      onArmStart(cascade::armName(arm));
    // Last value this arm reported, so `carried` can advance by the arm's real
    // node count when it finishes. Written and read only on this thread — the
    // arms run in series here.
    uint32_t armLast = 0;
    const uint64_t started = cascade::nowMsSteady();
    auto turns = cascade::runArm(
        arm, gridWidth, gridHeight, shapes, initialAnchors, goalIndex,
        goalAnchor, budget, maxNodes, postProcess, maxHeapBytes, cancel,
        [&onProgress, &armLast, armBase](const uint32_t n) {
          armLast = n;
          if (onProgress)
            onProgress(armBase + n);
        },
        /*respectJamGate=*/false, jamAspect16, jamDensityPct);
    const auto ms = static_cast<uint32_t>(cascade::nowMsSteady() - started);
    if (outcomes)
      outcomes->push_back({.arm = arm,
                           .solved = !turns.empty(),
                           .won = !turns.empty(),
                           .declined = turns.empty() && ms < 5,
                           .wallMs = ms});
    if (!turns.empty())
      return turns;
    // Carry the arm's OWN last count, not a constant: `carried += 1` made the
    // forwarded total collapse to ~0 at every one of the eight arm boundaries,
    // so the UI's "N nodes explored" readout jumped backwards from millions to
    // single digits during the very phase the code announces as the slow one.
    carried += armLast;
  }
  return {};
}
