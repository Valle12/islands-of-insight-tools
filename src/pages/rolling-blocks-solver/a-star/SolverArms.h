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

} // namespace arms
