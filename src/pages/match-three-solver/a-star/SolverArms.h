#pragma once

#include "Search.h"
#include "Types.h"

#include <array>
#include <cstdint>

// The portfolio. `cascade` is what the page and the CLI use by default; the
// single-arm names exist so the bench and the tests can measure one strategy at
// a time.
namespace mt::arms {

inline constexpr auto kEngines = std::to_array<const char *>(
    {"cascade", "iddfs", "bnb", "greedy", "beam"});

/// One arm's identity and knobs. Kept separate from Config, which carries the
/// budgets every arm shares.
struct ArmSpec {
  const char *engine = "cascade";
  int beamWidth = 0;
  uint32_t seed = 0;
};

bool isEngine(const char *name);

/// Runs one arm, or the whole cascade. Anytime throughout: the returned
/// outcome carries whatever was found, and `proven` says whether the length was
/// established rather than merely reached.
Outcome solve(const Board &board, const ArmSpec &spec, const Config &cfg,
              Bounds &bounds);

/// The same with bounds of its own, for callers that do not share state across
/// several arms.
Outcome solve(const Board &board, const ArmSpec &spec, const Config &cfg);

#ifdef __EMSCRIPTEN_PTHREADS__
/// Races the whole portfolio on real threads inside one module, all arms
/// sharing one `Bounds` so the first find caps everyone's work and the first
/// proof ends the race. Only the CALLING thread ever crosses into JavaScript:
/// the arms publish through `Config::progress` and the shared bounds, and this
/// function polls them.
Outcome solveParallel(const Board &board, const Config &cfg, Bounds &bounds);
#endif

} // namespace mt::arms
