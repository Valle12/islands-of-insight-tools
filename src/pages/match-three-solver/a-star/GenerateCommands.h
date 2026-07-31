#pragma once

#include "Types.h"

#include <string>

// Fixture generation for the fuzz harness, native builds only.
//
// What it does NOT do is generate solvable-by-construction boards: unlike a
// rolling-blocks scramble, a match-three board cannot be built by playing a
// solution backwards — a clear destroys the blocks it consumed, so there is
// nothing to un-clear. Generated boards are therefore legal game states of
// unknown solvability, and src/util/fuzzMatchThree.ts checks the properties
// that hold regardless: any witness replays under both engines, both engines
// agree when both prove, and an "unsolvable" from one is never contradicted by
// a witness from the other.
namespace mt::generate {

struct Options {
  uint32_t seed = 0;
  /// "random" spreads symbols uniformly; "cluster" biases toward a neighbour's
  /// symbol, which makes boards far more often solvable.
  std::string kind = "random";
  int width = 0;   ///< 0 picks one
  int height = 0;  ///< 0 picks one
  int symbols = 0; ///< 0 picks one
  /// Percent of cells painted as blockades before filling.
  int blockadePercent = -1;
};

/// A settled, match-free board with at least one block and no symbol already
/// stranded. Deterministic in `opts.seed`.
Board board(const Options &opts);

/// Writes one to `path`. Returns a process exit code.
int run(const std::string &path, const Options &opts);

} // namespace mt::generate
