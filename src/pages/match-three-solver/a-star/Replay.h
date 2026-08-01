#pragma once

#include "Types.h"

// The validity oracle. Deliberately independent of the search: it re-derives
// every match from scratch through the full-board scan rather than the targeted
// marking the search's kernel uses, so it cross-checks that shortcut instead of
// sharing its assumptions. Nothing — not the CLI, not a test, not the wasm
// boundary — may report a solution it has not been through.
namespace mt::replay {

struct Verdict {
  /// Every move was legal at the point it was played.
  bool legal = false;
  /// No blocks are left once the last move has been played.
  bool clearedAtEnd = false;
  /// How many moves were played before the first illegal one.
  int played = 0;
};

Verdict replayMoves(const Board &start, const Moves &moves);

} // namespace mt::replay
