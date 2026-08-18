#pragma once

#include "Budget.h"
#include "Domains.h"
#include "Puzzle.h"

#include <cstdint>

// Singleton look-ahead: try a color on one cell, deduce, and see whether the
// board falls apart.
//
// This is where the game's own hand techniques come from. "Connected colors
// must escape", "bottlenecks", "pattern near-misses", "don't trap areas",
// "avoid incompatible colors" — every one of them is the same move, and none
// of them has to be written down: coloring the cell the wrong way makes some
// propagator contradict itself, so the other color follows.
namespace lg {

enum class ProbeResult : uint8_t {
  /// Nothing more can be deduced this way.
  Fixpoint,
  /// The board contradicts itself as it stands, so it has no solution.
  Conflict,
  /// The budget stopped the pass. This proves NOTHING — in particular it is
  /// not a refutation, which is the mistake that makes look-ahead unsound.
  Aborted,
};

/// Looks ahead from every undecided cell, over and over, until a pass decides
/// nothing new.
ProbeResult probeToFixpoint(const Model &model, Domains &domains,
                            Budget &budget);

} // namespace lg
