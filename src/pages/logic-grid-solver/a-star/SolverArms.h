#pragma once

#include "Puzzle.h"
#include "Search.h"

#include <array>
#include <cstdint>

// The arms, and the order the cascade runs them in.
//
// `kEngines` below is just the set of names `--engine` and the wasm boundary
// accept. The list that has to stay in step with the page is `kPortfolio` in
// SolverArms.cpp, mirrored by `PORTFOLIO` in
// src/pages/logic-grid-solver/wasmBridge.ts — same arms, same order, same
// seeds: on a cross-origin isolated page one module races them on real threads,
// and everywhere else the bridge spreads them over separate workers.
namespace lg::arms {

inline constexpr auto kEngines = std::to_array<const char *>(
    {"cascade", "deduce", "dfs", "forced", "profile"});

struct ArmSpec {
  const char *engine = "cascade";
  uint32_t seed = 0;
};

bool isEngine(const char *name);

Outcome solve(const Model &model, const ArmSpec &spec, const Config &cfg);

/// How far along an answer is. Only a top-rank answer ends a race: a partial
/// underclued deduction is worth showing, but never worth stopping for.
int rank(const Outcome &outcome);

#ifdef __EMSCRIPTEN_PTHREADS__
/// Every arm at once inside one module, sharing a cancel flag.
Outcome solveParallel(const Model &model, const Config &cfg);
#endif

} // namespace lg::arms
