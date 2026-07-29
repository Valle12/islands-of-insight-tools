#pragma once

#include "Replay.h"
#include "Types.h"

#include <cstddef>

// Cheap structural features of a puzzle, used to gate portfolio arms so a
// specialist declines instantly on boards outside its class instead of
// burning its budget (the shifting-mosaic jamProfile lesson).
namespace puzzleprofile {

struct Features {
  size_t blocks = 0;
  size_t mustTouch = 0;
  size_t goals = 0;
  size_t playable = 0;
};

inline Features analyze(const replay::Puzzle &puzzle) {
  Features f;
  f.blocks = puzzle.blocks.size();
  for (const Tile cell : puzzle.cells) {
    if (cell != Tile::Unplayable) {
      f.playable++;
    }
    if (cell == Tile::MustTouch) {
      f.mustTouch++;
    } else if (cell == Tile::Goal) {
      f.goals++;
    }
  }
  return f;
}

// The cracker's home turf: SINGLE-block must-touch-dominant boards, where
// touched-cells-become-walls makes the puzzle a self-avoiding coverage walk.
// Measured on the captured endgame fixtures: 37/38/39 fall in 106/60/7907
// expansions and 35 in the same class, while the two-block fixture 34 defeats
// the touch-greedy ordering outright (8.4M expansions, no solution) — so
// multi-block boards stay with the weighted arms until the fuzz campaign
// produces evidence for a looser gate.
inline bool coverageProfile(const Features &f) {
  return f.mustTouch >= 20 && f.mustTouch * 10 >= f.playable * 4 &&
         f.blocks == 1;
}

// Where uniform-cost enumeration (the exact arm) can plausibly finish: pure
// goal boards self-limit through the arm's node cap, but a must-touch board
// multiplies poses by 2^K — decline unless the satisfied-set space is tiny.
inline bool exactProfile(const Features &f) {
  if (f.mustTouch == 0) {
    return true;
  }
  return f.blocks == 1 && f.mustTouch <= 24;
}

} // namespace puzzleprofile
