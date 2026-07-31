#include "Budget.h"
#include "Search.h"
#include "SeededRng.h"

#include <vector>

// Restarted greedy rollouts. Proves nothing — it exists to put SOME clearing
// sequence in the bounds quickly, so the page has a best-so-far to show and the
// prover a cap to deepen against. Measured on the captured corpus: on all 49
// solvable boards this arm's first find is already the proven-minimal length,
// inside 100 ms (see bench/QUALITY.md).
namespace mt {

namespace {

/// Rollouts without an improvement before the arm gives up. What keeps easy
/// boards instant: the time budget is a cap, never a floor.
constexpr int kPatience = 60;

/// Scratch a rollout reuses so a restart allocates nothing.
struct Scratch {
  Board probe;
  Board candidate;
  Board best;
  rules::Mask mask{};
  std::vector<rules::PackedMove> moves;
};

/// One state's greedy choice. Prefers the biggest clear that does NOT strand a
/// symbol — a stranded board is dead, so such a move is taken only when every
/// move strands — with seeded noise breaking ties so restarts diverge.
struct Choice {
  rules::PackedMove move = 0;
  bool found = false;
  bool clearsAll = false;
  int cleared = 0;
};

Choice pickMove(const Board &board, const int blocks, SeededRng &rng,
                Scratch &scratch) {
  scratch.moves.clear();
  rules::legalMovesInto(board, scratch.probe, scratch.moves);

  Choice choice;
  int bestScore = -1;
  for (const rules::PackedMove move : scratch.moves) {
    const rules::ApplyResult applied = rules::applyPacked(
        board, scratch.candidate, move, scratch.mask, nullptr);
    if (applied.cleared == blocks)
      return {.move = move,
              .found = true,
              .clearsAll = true,
              .cleared = applied.cleared};
    const int alive = rules::hasStrandedSymbol(scratch.candidate) ? 0 : 1;
    const int score = alive * 1000000 + applied.cleared * 256 + rng.uniform(0, 255);
    if (score <= bestScore)
      continue;
    bestScore = score;
    choice = {.move = move,
              .found = true,
              .clearsAll = false,
              .cleared = applied.cleared};
    scratch.best = scratch.candidate;
  }
  return choice;
}

/// One greedy line from the start. Empty when it dead-ends or cannot come in
/// under `bound`.
Moves rolloutOnce(const Board &start, const int blocks, const int bound,
                  SeededRng &rng, Scratch &scratch, Budget &budget) {
  Board current = start;
  int left = blocks;
  Moves path;
  while (static_cast<int>(path.size()) < bound) {
    if (budget.exhausted())
      return {};
    const Choice choice = pickMove(current, left, rng, scratch);
    if (!choice.found)
      return {};
    const int aIndex = rules::moveIndex(choice.move);
    const int x = aIndex % start.width;
    const int y = aIndex / start.width;
    const bool down = rules::moveIsDown(choice.move);
    path.push_back({.ax = static_cast<uint8_t>(x),
                    .ay = static_cast<uint8_t>(y),
                    .bx = static_cast<uint8_t>(down ? x : x + 1),
                    .by = static_cast<uint8_t>(down ? y + 1 : y)});
    if (choice.clearsAll)
      return path;
    current = scratch.best;
    left -= choice.cleared;
  }
  return {};
}

} // namespace

Outcome runGreedy(const Board &board, const Config &cfg, Bounds &bounds) {
  Outcome outcome;
  outcome.arm = "greedy";
  Budget budget(cfg, bounds, "greedy", outcome.stats);

  const int blocks = rules::blockCount(board);
  if (blocks == 0)
    return outcome;

  Scratch scratch;
  scratch.probe.width = board.width;
  scratch.probe.height = board.height;
  scratch.candidate.width = board.width;
  scratch.candidate.height = board.height;
  scratch.best.width = board.width;
  scratch.best.height = board.height;

  SeededRng rng(cfg.seed);
  const int known = bounds.bestLength();
  int bound = known == kNoLength ? blocks / kMinRun + 1 : known;
  int sinceImprovement = 0;
  Moves best;
  while (sinceImprovement < kPatience && !budget.exhaustedNow()) {
    const Moves found = rolloutOnce(board, blocks, bound, rng, scratch, budget);
    sinceImprovement++;
    if (found.empty() || static_cast<int>(found.size()) >= bound)
      continue;
    bound = static_cast<int>(found.size());
    sinceImprovement = 0;
    best = found;
    bounds.offer(best);
  }

  outcome.moves = best;
  outcome.ruledOut = bounds.ruledOut();
  return outcome;
}

} // namespace mt
