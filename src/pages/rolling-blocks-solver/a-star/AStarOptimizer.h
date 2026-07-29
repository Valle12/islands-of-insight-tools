#pragma once

#include "Replay.h"

#include <cstdint>
#include <vector>

// Solution post-processing: shortens a valid solution without ever trusting
// the rewrite itself — every candidate is accepted only when a full replay
// (the same oracle the tests use) proves it still legal and solving. The
// searches run inadmissible heuristics, so their solutions routinely carry
// removable detours.
namespace optimizer {

// Rewrites applied greedily to a fixpoint under the wall-clock budget:
//   1. truncation to the earliest solving prefix
//   2. state-loop cutting (an exact repeat of the full id-aware state did
//      zero useful work — the satisfied set only ever grows)
//   3. adjacent inverse-pair cancellation
//   4. single-move removal
//   5. windowed exact re-solve (BFS between two replay states, replacing a
//      window with a provably shortest connection)
// Returns the input unchanged when it does not replay to a solution.
std::vector<Turn> optimize(const replay::Puzzle &puzzle,
                           std::vector<Turn> turns, uint32_t maxMs);

} // namespace optimizer
