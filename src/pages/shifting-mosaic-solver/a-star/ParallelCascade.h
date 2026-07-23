#pragma once

#include "AStar.h"
#include "DragSolver.h"
#include "Types.h"

#include <atomic>
#include <chrono>
#include <cstdint>
#include <functional>
#include <thread>
#include <vector>

// Races the three production solver arms on std::threads and returns the
// first non-empty plan (the others are cancelled cooperatively). Works both
// natively and under emscripten pthreads. The caller's thread blocks in
// here, polling per-arm progress atomics and forwarding their sum to
// `onProgress` — arms themselves never touch the callback, so under
// emscripten only the calling (module) thread ever crosses into JS.
inline std::vector<Turn> solveArmsParallel(
    const uint8_t gridWidth, const uint8_t gridHeight,
    const std::vector<std::vector<Position>> &shapes,
    const std::vector<Position> &initialAnchors, const uint8_t goalIndex,
    const Position goalAnchor, const uint32_t maxMs, const uint32_t maxNodes,
    const bool postProcess,
    const std::function<void(uint32_t)> &onProgress) {
  constexpr int ARMS = 8;
  std::atomic<bool> cancel{false};
  std::atomic<int> winner{-1};
  std::atomic<int> finished{0};
  std::atomic<uint32_t> progress[ARMS] = {};
  std::vector<Turn> results[ARMS];

  const auto claimWin = [&](const int arm) {
    int expected = -1;
    if (winner.compare_exchange_strong(expected, arm))
      cancel.store(true, std::memory_order_relaxed);
  };
  const auto armProgress = [&progress](const int arm) {
    return [&progress, arm](const uint32_t n) {
      progress[arm].store(n, std::memory_order_relaxed);
    };
  };

  std::thread threads[ARMS];
  // Arm 0: receding-horizon drag search — fast on cut-structured puzzles.
  threads[0] = std::thread([&] {
    DragSolver::Config cfg;
    cfg.weight = 3;
    cfg.settledOnly = true;
    cfg.partialExpansionWidth = 48;
    cfg.postProcess = postProcess;
    cfg.cancel = &cancel;
    DragSolver solver(gridWidth, gridHeight, shapes, initialAnchors,
                      goalIndex, goalAnchor, cfg);
    solver.onProgress = armProgress(0);
    results[0] = solver.searchHierarchical(maxMs, maxNodes);
    if (!results[0].empty())
      claimWin(0);
    finished.fetch_add(1);
  });
  // Arm 1: the deep-puzzle flat drag config (cracked shiftingMosaicTest37).
  threads[1] = std::thread([&] {
    DragSolver::Config cfg;
    cfg.weight = 4;
    cfg.settledOnly = true;
    cfg.partialExpansionWidth = 64;
    cfg.postProcess = postProcess;
    cfg.cancel = &cancel;
    DragSolver solver(gridWidth, gridHeight, shapes, initialAnchors,
                      goalIndex, goalAnchor, cfg);
    solver.onProgress = armProgress(1);
    results[1] = solver.search(maxMs, maxNodes == 0 ? 0 : maxNodes);
    if (!results[1].empty())
      claimWin(1);
    finished.fetch_add(1);
  });
  // Arm 2: the legacy unit-move production config — zero-regression arm.
  threads[2] = std::thread([&] {
    AStar::Config cfg;
    cfg.weight = 3;
    cfg.pathBlockerWeight = 1;
    cfg.boundaryDistanceWeight = 1;
    cfg.axisAwareWeight = 1;
    cfg.lpDisplacementWeight = 1;
    cfg.postProcess = postProcess;
    cfg.cancel = &cancel;
    AStar solver(gridWidth, gridHeight, shapes, initialAnchors, goalIndex,
                 goalAnchor, cfg);
    solver.onProgress = armProgress(2);
    results[2] = solver.search(maxMs, maxNodes);
    if (!results[2].empty())
      claimWin(2);
    finished.fetch_add(1);
  });
  // Arm 3: corridor — synthetic distance bands (declines fast on cut boards).
  threads[3] = std::thread([&] {
    DragSolver::Config cfg;
    cfg.weight = 3;
    cfg.settledOnly = true;
    cfg.partialExpansionWidth = 48;
    cfg.corridorBands = true;
    cfg.postProcess = postProcess;
    cfg.cancel = &cancel;
    DragSolver solver(gridWidth, gridHeight, shapes, initialAnchors,
                      goalIndex, goalAnchor, cfg);
    solver.onProgress = armProgress(3);
    results[3] = solver.searchHierarchical(maxMs, maxNodes);
    if (!results[3].empty())
      claimWin(3);
    finished.fetch_add(1);
  });
  // Arm 4: assembly — pack-then-slide (declines fast without a packing).
  threads[4] = std::thread([&] {
    DragSolver::Config cfg;
    cfg.postProcess = postProcess;
    cfg.cancel = &cancel;
    DragSolver solver(gridWidth, gridHeight, shapes, initialAnchors,
                      goalIndex, goalAnchor, cfg);
    solver.onProgress = armProgress(4);
    results[4] = solver.searchAssembly(maxMs, maxNodes);
    if (!results[4].empty())
      claimWin(4);
    finished.fetch_add(1);
  });
  // Arm 5: jam — relevance filter + commutativity pruning for compact
  // dense boards where the unrestricted searches drown.
  threads[5] = std::thread([&] {
    DragSolver::Config cfg;
    cfg.weight = 4;
    cfg.settledOnly = true;
    cfg.partialExpansionWidth = 64;
    cfg.sleepSets = true;
    cfg.relevantOnly = true;
    cfg.postProcess = postProcess;
    cfg.cancel = &cancel;
    DragSolver solver(gridWidth, gridHeight, shapes, initialAnchors,
                      goalIndex, goalAnchor, cfg);
    solver.onProgress = armProgress(5);
    results[5] = solver.search(maxMs, maxNodes);
    if (!results[5].empty())
      claimWin(5);
    finished.fetch_add(1);
  });

  // Arm 6: jam restarts — dig-cost-guided diversified rounds for compact
  // dense 0-cut boards (cracked seeds 10276/4722; bands round covers 9164).
  // Declines instantly outside the jam profile.
  threads[6] = std::thread([&] {
    DragSolver::Config cfg;
    cfg.corridorBands = true; // synthesizes only on 0-cut long-path boards
    // Luby-shaped round caps: at the browser's ~300s/arm budget the stock
    // 1.5M-node cap yields only ~4 restart rounds, but the elite ratchet is a
    // lottery that needs many (seed 8697: 110). Measured on the hard-instance
    // family at 300s, luby20k/e64 descends the ratchet -46% deeper than stock
    // (mean minJamTerm 40->21.7) — best of every config tried. See
    // HARD-BOARDS.md. Zero-touch on non-jam boards (this arm gate-declines).
    cfg.jamRoundNodeCap = 20000;
    cfg.jamMaxElites = 64;
    cfg.jamLubyRestarts = true;
    cfg.postProcess = postProcess;
    cfg.cancel = &cancel;
    DragSolver solver(gridWidth, gridHeight, shapes, initialAnchors,
                      goalIndex, goalAnchor, cfg);
    if (solver.jamProfile()) {
      solver.onProgress = armProgress(6);
      results[6] = solver.searchJamRestarts(maxMs, maxNodes);
      if (!results[6].empty())
        claimWin(6);
    }
    finished.fetch_add(1);
  });
  // Arm 7: guided beam — breadth against jam plateaus the restart rounds
  // dive past. Same jam-profile gate. Auto beam width (shared heap); the
  // heavy penalty is from the config that cracked seed 3870.
  threads[7] = std::thread([&] {
    DragSolver::Config cfg;
    cfg.corridorBands = true;
    cfg.jamGuideWeight = 8;
    cfg.jamBlockerPenalty = 8;
    cfg.postProcess = postProcess;
    cfg.cancel = &cancel;
    DragSolver solver(gridWidth, gridHeight, shapes, initialAnchors,
                      goalIndex, goalAnchor, cfg);
    if (solver.jamProfile()) {
      solver.onProgress = armProgress(7);
      results[7] = solver.searchBeamJam(maxMs, maxNodes);
      if (!results[7].empty())
        claimWin(7);
    }
    finished.fetch_add(1);
  });

  while (finished.load() < ARMS) {
    std::this_thread::sleep_for(std::chrono::milliseconds(200));
    if (onProgress) {
      uint32_t sum = 0;
      for (const auto &p : progress)
        sum += p.load(std::memory_order_relaxed);
      onProgress(sum);
    }
  }
  for (auto &t : threads)
    t.join();

  const int w = winner.load();
  if (w >= 0)
    return results[w];
  for (const auto &r : results)
    if (!r.empty())
      return r;
  return {};
}
