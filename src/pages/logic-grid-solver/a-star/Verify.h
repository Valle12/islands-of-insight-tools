#pragma once

#include "Puzzle.h"

#include <cstdint>

// The oracle: given a complete colouring, is it a solution of this puzzle?
//
// Deliberately INDEPENDENT of everything the search uses. It re-scans the whole
// board per rule rather than reading the compiled clause list, and it walks
// regions from scratch rather than trusting any incremental structure. That is
// the same discipline as the match-three solver's Replay.h, and for the same
// reason: an oracle that shares code with the thing it checks only proves the
// two agree.
//
// It is the last gate before an answer leaves the solver, and it is what makes
// the propagators safe to be clever — a propagator bug that keeps a solution
// out is a missed answer, but one that lets a non-solution through would be a
// wrong answer, and this is what stops that.
namespace lg::verify {

enum class Violation : uint8_t {
  None = 0,
  Incomplete,   ///< a playable cell was left uncoloured
  ShapeChanged, ///< a gap took a colour, or a playable cell became a gap
  GivenChanged, ///< a cell the player had already painted came back different
  Square,       ///< a forbidden 2x2
  Run,          ///< a forbidden straight run
  Checkerboard,
  Disconnected,
  AreaSize,
  LetterSplit,  ///< one letter spread across two regions
  LetterShared, ///< two different letters inside one region
  /// A region of a colour that must carry exactly one clue carries none.
  AreaWithoutSymbol,
  /// ...or carries more than one.
  AreaWithManySymbols,
  /// A region is not the area its colour's area rule requires. Distinct from
  /// `AreaSize`, which is one CLUE disagreeing with the region it sits in;
  /// this one is about every region of a colour, clued or not.
  RegionSize,
  /// A merged cell came back with its squares in different colours.
  CellSplit,
  /// A dart's number does not match what its line really holds.
  DartCount,
  /// A line of three alternating colours that a triple rule forbids.
  Triple,
  /// A T-tetromino of one colour, in any of its four rotations.
  Tee,
  /// A symmetry symbol's region does not map to itself across its axis.
  LotusAsymmetric,
};

const char *describe(Violation violation);

/// Whether `colors` is a complete, legal solution of `model`'s puzzle.
Violation check(const Model &model, const Colors &colors);

} // namespace lg::verify
