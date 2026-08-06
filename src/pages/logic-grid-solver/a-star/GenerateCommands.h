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
  /// 64-bit because a plain `int` cannot name bit 31, the 32nd rule's.
  int64_t rules = -1;
  /// "clued" for a board with plenty of clues, "underclued" for a sparse one
  /// with the underclued rule switched on.
  std::string kind = "clued";
  /**
   * Roughly what percentage of the board's squares to fuse into merged cells,
   * 0 for none.
   *
   * Off by default, and drawn from its OWN rng, so every seed that ever
   * produced a board still produces the same one — the main stream feeds a
   * local search whose every draw would otherwise shift.
   */
  int shapes = 0;
  /**
   * How often a region that would otherwise carry no clue gets a DART instead,
   * as a percentage, 0 for none.
   *
   * Off by default, and the roll is appended after the letter roll and skipped
   * outright at zero, so a campaign without it draws no random number for a
   * dart and reproduces exactly the boards it always did.
   */
  int darts = 0;
  /**
   * The same again for a symmetry symbol, appended after the dart roll with
   * the same zero-skip contract. Unlike a dart there is no value to derive:
   * the axis is drawn, and the clue lands only where the region really does
   * mirror across it — the check reads the colouring and draws nothing.
   */
  int lotus = 0;
  /**
   * And once more for a viewpoint, appended after the lotus roll with the
   * same zero-skip contract. Like a dart there is a value to derive — the
   * count is read off the colouring, so every roll that fires places a clue
   * that is satisfiable by construction.
   */
  int viewpoints = 0;
  /**
   * And a fourth time for a galaxy, appended after the viewpoint roll with
   * the same zero-skip contract. Like the lotus there is no value to derive:
   * the clue lands only where the region really maps to itself under a half
   * turn about the spot — the check reads the colouring and draws nothing.
   */
  int galaxies = 0;
};

/// 0 when a puzzle was written, 1 when no attempt produced one. Nothing is
/// written on failure — a file saved under a failure line is worse than none.
int run(const Options &options);

} // namespace lg::generate
