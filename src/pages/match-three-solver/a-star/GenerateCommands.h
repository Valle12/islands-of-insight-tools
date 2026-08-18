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
  /// "random" spreads symbols uniformly; "cluster" biases toward a neighbor's
  /// symbol, which makes boards far more often solvable.
  std::string kind = "random";
  /// 0 picks one. A pinned value is CLAMPED to the engine's ceiling — `width`
  /// and `height` to kMaxSide, `symbols` to kSymbolCount — because Board::cells
  /// is a fixed kMaxCells array and the per-symbol counters are kSymbolCount
  /// wide, so an unclamped value would write past both.
  int width = 0;
  int height = 0;
  int symbols = 0;
  /// Percent of cells painted as blockades before filling.
  int blockadePercent = -1;
};

/// What one generation run produced.
struct Result {
  Board board;
  /// True when `board` is what the declaration below promises. False when the
  /// attempt limit ran out: `board` is then the last candidate — a legal grid,
  /// but possibly stranded, unsettled, empty or with no move to make. Callers
  /// must not present an unusable board as a fixture.
  bool usable = false;
};

/// A settled, match-free board with at least one block and no symbol already
/// stranded, when `Result::usable`. Deterministic in `opts.seed`.
Result board(const Options &opts);

/// Writes one to `path`. Returns a process exit code.
int run(const std::string &path, const Options &opts);

} // namespace mt::generate
