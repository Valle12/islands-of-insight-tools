#pragma once

#include "Puzzle.h"

#include <cstdint>

// Brute force: every colouring, checked by the oracle, with nothing clever in
// between.
//
// This exists because of the one bug class the rest of the design cannot see.
// `Verify` catches an answer that is not a solution. Nothing catches a
// propagator that removes a colouring which WAS a solution — in normal mode
// that just returns a different valid answer, and in underclued mode it
// silently paints cells that are not actually forced. So the tests compare the
// engine's whole solution set, and its forced set, against this.
//
// Native only, and deliberately not one of the engines: it is exponential, it
// is the thing being trusted, and it must never be reachable from the page.
namespace lg::reference {

/// The most undecided cells this will take on. 2^24 verifications is already
/// tens of seconds; past that it refuses rather than hanging a test.
inline constexpr int kMaxFreeCells = 24;

struct Answer {
  /// False when the board was too big to enumerate — every other field is then
  /// meaningless, which is not the same as "no solutions".
  bool ranToCompletion = false;
  uint64_t solutionCount = 0;
  /// The lowest-numbered solution, meaningful when solutionCount > 0.
  Colors first{};
  /// The colour every solution agrees on per cell, kUnknown where they differ.
  /// This is exactly what an underclued puzzle asks for.
  Colors forced{};
};

Answer enumerate(const Model &model);

} // namespace lg::reference
