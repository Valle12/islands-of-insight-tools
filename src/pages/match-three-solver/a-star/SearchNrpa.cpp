#include "Budget.h"
#include "Search.h"
#include "SeededRng.h"

#include <cmath>
#include <vector>

// Nested Rollout Policy Adaptation.
//
// The arm that cracked matchThreeTest51 — 16 moves in 13 seconds, on a board
// where greedy, the beam, the dive and the deepening prover had between them
// never produced a single witness at any budget. NRPA holds the records on
// SameGame and Morpion Solitaire, and SameGame is close enough to this puzzle
// (clear groups of like-coloured blocks under gravity) that the transfer is not
// a coincidence.
//
// How it works: a POLICY assigns a weight to every move, playouts sample moves
// in proportion to exp(weight), and each nesting level repeatedly (a) runs the
// level below, (b) keeps the best sequence it saw, and (c) nudges the policy
// toward that sequence. Level 0 is a single playout. The nudge is what makes it
// more than random restarts: a move that appears in good lines gets easier to
// draw, so the search concentrates on a promising REGION of the space rather
// than on a promising single line.
//
// It proves nothing. Like the other fast arms it exists to find a witness, and
// the provers decide what is minimal.
namespace mt {

namespace {

/// How far the policy moves toward a good sequence per adaptation. The value
/// the original NRPA paper uses, and the one the measurement that solved
/// matchThreeTest51 ran with.
constexpr double kAlpha = 1.0;

/// Nesting depth and iterations per level. Level 3 x 30 solved test51.
constexpr int kDefaultLevel = 3;
constexpr int kDefaultIterations = 30;

/// One legal move at a state, with what it does. Boards are not kept: a Board
/// is a kilobyte, and replaying the chosen move is cheaper than storing all of
/// them.
struct Step {
  rules::PackedMove move = 0;
  int cleared = 0;
  bool finishes = false;
};

/// Weight per move code, indexed by the packed move — position-based, so a code
/// keeps its meaning across playouts, which is what NRPA needs of it.
using Policy = std::vector<double>;

/// Everything a playout reuses, so a level-0 call allocates nothing.
struct Scratch {
  Board probe;
  Board child;
  Board current;
  rules::Mask mask{};
  std::vector<rules::PackedMove> moves;
  std::vector<Step> steps;
  std::vector<double> weights;
};

void collectSteps(const Board &board, const int left, Scratch &scratch) {
  scratch.steps.clear();
  scratch.moves.clear();
  rules::legalMovesInto(board, scratch.probe, scratch.moves);
  for (const rules::PackedMove move : scratch.moves) {
    const rules::ApplyResult applied =
        rules::applyPacked(board, scratch.child, move, scratch.mask, nullptr);
    if (applied.cleared == left) {
      // A finishing move is never worth sampling against — take it.
      scratch.steps.clear();
      scratch.steps.push_back(
          {.move = move, .cleared = applied.cleared, .finishes = true});
      return;
    }
    scratch.steps.push_back(
        {.move = move, .cleared = applied.cleared, .finishes = false});
  }
}

Move decode(const rules::PackedMove packed, const int width) {
  const int aIndex = rules::moveIndex(packed);
  const int x = aIndex % width;
  const int y = aIndex / width;
  const bool down = rules::moveIsDown(packed);
  return {.ax = static_cast<uint8_t>(x),
          .ay = static_cast<uint8_t>(y),
          .bx = static_cast<uint8_t>(down ? x : x + 1),
          .by = static_cast<uint8_t>(down ? y + 1 : y)};
}

/// One line, and what it left behind.
struct Line {
  std::vector<rules::PackedMove> moves;
  int left = 0;
};

class Nrpa {
public:
  Nrpa(const Board &board, const Config &cfg, Bounds &bounds, SearchStats &stats)
      : board_(board), bounds_(bounds), rng_(cfg.seed),
        budget_(cfg, bounds, "nrpa", stats),
        level_(cfg.nrpaLevel > 0 ? cfg.nrpaLevel : kDefaultLevel),
        iterations_(cfg.nrpaIterations > 0 ? cfg.nrpaIterations
                                           : kDefaultIterations) {
    total_ = rules::blockCount(board);
    best_.left = total_;
    scratch_.probe.width = board.width;
    scratch_.probe.height = board.height;
    scratch_.child.width = board.width;
    scratch_.child.height = board.height;
    scratch_.current.width = board.width;
    scratch_.current.height = board.height;
  }

  Moves run() {
    if (total_ == 0)
      return {};
    // One slot per packed move: a cell index, plus the direction bit.
    Policy policy(board_.cells.size() * 2, 0.0);
    search(level_, policy);
    // ONLY a complete line. `best_` tracks the fewest blocks left because that
    // is the score NRPA optimises, so it is usually a partial line — and an
    // arm's `moves` is a solution or nothing at all. Returning the partial one
    // sent a move list that does not clear the board out through the CLI, which
    // is exactly what the corpus test caught.
    if (best_.left != 0)
      return {};
    Moves out;
    out.reserve(best_.moves.size());
    for (const rules::PackedMove packed : best_.moves)
      out.push_back(decode(packed, board_.width));
    return out;
  }

private:
  const Board &board_;
  Bounds &bounds_;
  SeededRng rng_;
  Budget budget_;
  int level_;
  int iterations_;
  int total_ = 0;
  Line best_;
  Scratch scratch_;

  Line playout(const Policy &policy) {
    copyBoard(board_, scratch_.current);
    Line line;
    line.left = total_;
    while (line.left > 0) {
      if (budget_.exhausted())
        break;
      collectSteps(scratch_.current, line.left, scratch_);
      if (scratch_.steps.empty())
        break;
      const Step chosen = sample(policy);
      line.moves.push_back(chosen.move);
      rules::applyPacked(scratch_.current, scratch_.child, chosen.move,
                         scratch_.mask, nullptr);
      copyBoard(scratch_.child, scratch_.current);
      line.left -= chosen.cleared;
      if (line.left > 0 && rules::hasStrandedSymbol(scratch_.current))
        break;
    }
    keep(line);
    return line;
  }

  Step sample(const Policy &policy) {
    if (scratch_.steps.size() == 1)
      return scratch_.steps.front();
    double total = 0;
    scratch_.weights.clear();
    for (const Step &step : scratch_.steps) {
      const double weight = std::exp(policy[slot(step.move)]);
      scratch_.weights.push_back(weight);
      total += weight;
    }
    double target = rng_.real() * total;
    for (size_t i = 0; i < scratch_.steps.size(); i++) {
      target -= scratch_.weights[i];
      if (target <= 0)
        return scratch_.steps[i];
    }
    return scratch_.steps.back();
  }

  void keep(const Line &line) {
    if (line.left >= best_.left)
      return;
    best_ = line;
    if (line.left != 0)
      return;
    Moves found;
    found.reserve(line.moves.size());
    for (const rules::PackedMove packed : line.moves)
      found.push_back(decode(packed, board_.width));
    bounds_.offer(found);
  }

  /// Nudges the policy toward `line`: the taken move gains, and every move that
  /// was available loses in proportion to how likely the policy already was to
  /// take it. Replaying the line is what makes "was available" meaningful.
  Policy adapt(const Policy &policy, const Line &line) {
    Policy next = policy;
    Board current;
    copyBoard(board_, current);
    int left = total_;
    for (const rules::PackedMove taken : line.moves) {
      collectSteps(current, left, scratch_);
      if (scratch_.steps.empty())
        break;
      double total = 0;
      scratch_.weights.clear();
      for (const Step &step : scratch_.steps) {
        const double weight = std::exp(policy[slot(step.move)]);
        scratch_.weights.push_back(weight);
        total += weight;
      }
      next[slot(taken)] += kAlpha;
      for (size_t i = 0; i < scratch_.steps.size(); i++) {
        next[slot(scratch_.steps[i].move)] -=
            kAlpha * scratch_.weights[i] / total;
      }
      const auto step = std::ranges::find_if(
          scratch_.steps, [taken](const Step &s) { return s.move == taken; });
      if (step == scratch_.steps.end())
        break;
      left -= step->cleared;
      rules::applyPacked(current, scratch_.child, taken, scratch_.mask, nullptr);
      copyBoard(scratch_.child, current);
    }
    return next;
  }

  Line search(const int depth, const Policy &policy) {
    if (depth == 0)
      return playout(policy);
    Line levelBest;
    levelBest.left = total_;
    Policy current = policy;
    for (int i = 0; i < iterations_; i++) {
      if (budget_.exhaustedNow())
        break;
      Line result = search(depth - 1, current);
      // `<=` rather than `<`: re-adapting toward an equally good sequence is
      // what lets the policy keep sharpening instead of stalling.
      if (result.left <= levelBest.left)
        levelBest = std::move(result);
      if (levelBest.left == 0)
        return levelBest;
      current = adapt(current, levelBest);
    }
    return levelBest;
  }
};

} // namespace

Outcome runNrpa(const Board &board, const Config &cfg, Bounds &bounds) {
  Outcome outcome;
  outcome.arm = "nrpa";
  Nrpa nrpa(board, cfg, bounds, outcome.stats);
  outcome.moves = nrpa.run();
  outcome.ruledOut = bounds.ruledOut();
  return outcome;
}

} // namespace mt
