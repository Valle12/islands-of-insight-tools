#include "Budget.h"
#include "Rules.h"
#include "Search.h"
#include "SeededRng.h"

#include <algorithm>
#include <cmath>
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
  /// The board a chosen move leaves behind. Not a best-so-far — `runGreedy`
  /// has its own `best` move list, which is a different thing entirely.
  Board next;
  rules::Mask mask{};
  std::vector<rules::PackedMove> moves;
};

/// How sharply a sampling rollout still prefers the bigger clear. Measured over
/// four policies on matchThreeTest51: this one produced the most distinct
/// outcomes and got the furthest.
constexpr double kTemperature = 3.0;

/// One state's choice: which move, what it clears, and whether it kills the
/// board by stranding a symbol.
struct Choice {
  rules::PackedMove move = 0;
  bool found = false;
  bool clearsAll = false;
  int cleared = 0;
  bool alive = true;
};

/// Every legal move at this state, scored but WITHOUT keeping its board — a
/// Board is a kilobyte, and the chosen one is cheaper to replay than all of
/// them are to store.
void collectChoices(const Board &board, const int blocks, Scratch &scratch,
                    std::vector<Choice> &out) {
  out.clear();
  scratch.moves.clear();
  rules::legalMovesInto(board, scratch.probe, scratch.moves);
  for (const rules::PackedMove move : scratch.moves) {
    const int cleared =
        rules::applyPacked(board, scratch.candidate, move, scratch.mask,
                           nullptr)
            .cleared;
    if (cleared == blocks) {
      out.clear();
      out.push_back({.move = move,
                     .found = true,
                     .clearsAll = true,
                     .cleared = cleared,
                     .alive = true});
      return;
    }
    out.push_back({.move = move,
                   .found = true,
                   .clearsAll = false,
                   .cleared = cleared,
                   .alive = !rules::hasStrandedSymbol(scratch.candidate)});
  }
}

/// The biggest clear that does not strand a symbol, or the biggest if all do.
Choice bestChoice(const std::vector<Choice> &choices) {
  Choice best;
  for (const Choice &choice : choices) {
    if (!best.found) {
      best = choice;
      continue;
    }
    if (choice.alive != best.alive) {
      if (choice.alive)
        best = choice;
      continue;
    }
    if (choice.cleared > best.cleared)
      best = choice;
  }
  return best;
}

/// Samples a move with probability rising in the clear size, so a restart
/// really takes a different line.
///
/// The obvious cheaper thing — adding noise to the greedy score — does NOT
/// diversify, and that is not a subtlety: with `cleared * 256 + uniform(0, 255)`
/// the noise is strictly smaller than one unit of `cleared`, so it can only
/// break exact ties. Measured on matchThreeTest51, 4000 restarts of that policy
/// produced TWO distinct outcomes. A noise term smaller than one unit of the
/// score it perturbs is not randomisation.
Choice sampleChoice(const std::vector<Choice> &choices, SeededRng &rng) {
  if (choices.empty())
    return {};
  const bool anyAlive =
      std::ranges::any_of(choices, [](const Choice &c) { return c.alive; });

  double total = 0;
  std::vector<double> weights;
  weights.reserve(choices.size());
  for (const Choice &choice : choices) {
    // A move that strands a symbol is only ever taken when every move does.
    const double weight = anyAlive && !choice.alive
                              ? 0.0
                              : std::exp(choice.cleared / kTemperature);
    weights.push_back(weight);
    total += weight;
  }
  if (total <= 0)
    return bestChoice(choices);

  double target = rng.real() * total;
  for (size_t i = 0; i < choices.size(); i++) {
    target -= weights[i];
    if (target <= 0)
      return choices[i];
  }
  return choices.back();
}

/// One line from the start. Empty when it dead-ends or cannot come in under
/// `bound`.
///
/// `sample` false plays the pure greedy line, which is what the first rollout
/// does: on every solvable captured board that alone lands the minimal length
/// inside 100 ms, and nothing here may cost the page that.
Moves rolloutOnce(const Board &start, const int blocks, const int bound,
                  const bool sample, SeededRng &rng, Scratch &scratch,
                  Budget &budget) {
  Board current;
  copyBoard(start, current);
  int left = blocks;
  Moves path;
  std::vector<Choice> choices;
  while (static_cast<int>(path.size()) < bound) {
    if (budget.exhausted())
      return {};
    collectChoices(current, left, scratch, choices);
    const Choice choice = sample && !choices.empty() && !choices.front().clearsAll
                              ? sampleChoice(choices, rng)
                              : bestChoice(choices);
    if (!choice.found)
      return {};
    path.push_back(rules::decodeMove(choice.move, start.width));
    if (choice.clearsAll)
      return path;
    // Replayed rather than kept: see collectChoices.
    rules::applyPacked(current, scratch.next, choice.move, scratch.mask, nullptr);
    // copyBoard, never plain assignment: `=` moves the whole 1024-byte inline
    // array whatever the board's size, once per rollout step. See Types.h.
    copyBoard(scratch.next, current);
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
  scratch.next.width = board.width;
  scratch.next.height = board.height;

  SeededRng rng(cfg.seed);
  const int known = bounds.bestLength();
  int bound = known == kNoLength ? blocks / kMinRun + 1 : known;
  int sinceImprovement = 0;
  int rollouts = 0;
  Moves best;
  while (sinceImprovement < kPatience && !budget.exhaustedNow()) {
    // Rollout one is the greedy line; every restart after it samples.
    const Moves found =
        rolloutOnce(board, blocks, bound, rollouts > 0, rng, scratch, budget);
    rollouts++;
    sinceImprovement++;
    if (found.empty() || static_cast<int>(found.size()) >= bound)
      continue;
    bound = static_cast<int>(found.size());
    sinceImprovement = 0;
    best = found;
    bounds.offer(best);
  }

  outcome.moves = best;
  return outcome;
}

} // namespace mt
