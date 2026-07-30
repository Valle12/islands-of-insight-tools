#pragma once

#include "AStar.h"
#include "Replay.h"

#include <functional>
#include <string>
#include <vector>

// The engine dispatch shared by the wasm bindings and the native CLI: one
// named arm, or the single-threaded cascade that chains them. Every arm is a
// configuration of the same AStar engine (weight-0 exact, weighted A*, the
// coverage cracker, the beam, greedy), so this layer owns no search logic —
// only selection, gating, budget slicing and stats aggregation.
namespace arms {

inline constexpr const char *kEngines[] = {"cascade", "wastar", "exact",
                                           "cracker", "beam",   "greedy"};

[[nodiscard]] bool knownEngine(const std::string &engine);

struct ArmSpec {
  std::string engine = "cascade";
  uint32_t beamWidth = 0; // 0 = the beam's own default
  bool gated = false;     // cracker only: decline outside coverageProfile
};

struct Outcome {
  std::vector<Turn> turns;
  // The arm that produced the plan (cascade reports its winning step).
  std::string arm;
  AStar::SearchStats stats;
};

Outcome solve(const replay::Puzzle &puzzle, const ArmSpec &spec,
              const AStar::Config &cfg,
              const std::function<void(uint32_t)> &onProgress = {},
              const std::function<void(const std::string &)> &onArmStart = {});

#ifdef __EMSCRIPTEN_PTHREADS__
// The threads build's cascade: every portfolio arm races on its own thread
// inside ONE module (and one shared heap — each arm gets an 85% heap cap so
// a greedy arm cannot abort the whole race). First non-empty result wins and
// cancels the rest; if every arm comes back empty, the single-threaded chain
// re-runs sequentially with a 90% cap, announced through onArmStart as
// "sequential" so the page can say the strategy changed.
Outcome solveParallel(
    const replay::Puzzle &puzzle, const AStar::Config &cfg,
    const std::function<void(uint32_t)> &onProgress = {},
    const std::function<void(const std::string &)> &onArmStart = {});
#endif

} // namespace arms
