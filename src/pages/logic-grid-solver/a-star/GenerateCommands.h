#pragma once

#include <cstdint>
#include <string>

// `--generate`: puzzles that are solvable by construction.
//
// The board is coloured FIRST — a legal colouring is found by local search
// under whatever rules were asked for — and the clues are then read off the
// regions that colouring produced. Every clue is therefore satisfiable
// together, and a witness exists before the solver has seen the file.
//
// What that does NOT give is uniqueness: the same clue set usually admits
// other colourings, so nothing may pin the solver's answer to the generated
// one. The property that always holds, and the one the campaign leans on, is
// narrower and stronger — every cell the solver reports as FORCED must match
// the generated colouring, because that colouring is a solution.
namespace lg::generate {

struct Options {
  std::string out;
  uint32_t seed = 0;
  /// 0 for a random draw. A pinned dimension consumes no random number, so
  /// pinning one leaves every other draw where it was.
  int width = 0;
  int height = 0;
  /// -1 for a random subset of the colouring rules; otherwise a literal mask.
  int rules = -1;
  /// "clued" for a board with plenty of clues, "underclued" for a sparse one
  /// with the underclued rule switched on.
  std::string kind = "clued";
};

/// 0 when a puzzle was written, 1 when no attempt produced one. Nothing is
/// written on failure — a file saved under a failure line is worse than none.
int run(const Options &options);

} // namespace lg::generate
