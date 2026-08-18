#pragma once

#include "Domains.h"
#include "Puzzle.h"

// Deduction: everything that can be worked out without guessing.
//
// Every propagator here must be SOUND — it may never take a color away from a
// cell that some real solution gives it. It is allowed to be incomplete, and
// all of them are: what they miss, the search finds by branching, and
// `Verify` is the last word on any answer either of them produces.
//
// That asymmetry is not symmetric in its consequences, which is worth saying
// plainly. An incomplete propagator costs time. An UNSOUND one silently
// returns a different answer in normal mode and a wrong answer in underclued
// mode, where "this cell is forced" is exactly a claim that no other solution
// exists. Nothing at runtime can catch that, which is why the tests compare
// whole solution sets against `Reference`.
namespace lg {

/// Deduces until nothing more follows. False when the board is contradictory.
bool propagate(const Model &model, Domains &domains);

/// Fixes every cell the player already painted, then propagates. False when
/// the painted cells cannot be part of any solution.
bool applyGivens(const Model &model, Domains &domains);

} // namespace lg
