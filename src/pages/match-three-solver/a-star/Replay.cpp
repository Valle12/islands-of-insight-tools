#include "Replay.h"

#include "Rules.h"

namespace mt::replay {

Verdict replayMoves(const Board &start, const Moves &moves) {
  Board current = start;
  Board next;
  rules::Mask mask{};
  Verdict verdict;

  for (const Move &move : moves) {
    rules::ApplyResult applied;
    if (!rules::applyMove(current, move, next, mask, applied))
      return verdict;
    current = next;
    verdict.played++;
  }

  verdict.legal = true;
  verdict.clearedAtEnd = rules::blockCount(current) == 0;
  return verdict;
}

} // namespace mt::replay
