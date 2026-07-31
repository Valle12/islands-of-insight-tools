#include "Budget.h"
#include "Search.h"
#include "SeededRng.h"

#include <array>
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

/// Restarts with no improvement to the best line before the arm gives up.
///
/// Restarts alone are unbounded on a board nothing can clear: `best_.left` never
/// reaches 0, so the loop spins until the deadline and the prover waits out the
/// whole slice before it can say "unsolvable". So the arm needs the greedy arm's
/// patience idea.
///
/// It counts BARREN RESTARTS and not, as would be tempting, restarts since the
/// last improvement *within* a run: on matchThreeTest50 the winning restart goes
/// from 9 blocks left straight to 0 while every other restart also reaches 9, so
/// "stop when nothing is improving" would cut off precisely the draw that wins.
/// The count is generous for the same reason — the corpus's winners land within
/// ~5 restarts and a 300 s slice only fits ~50, so this never binds on a board
/// worth searching, while on a dead one every restart is near-instant.
constexpr int kBarrenRestarts = 64;

/// One rung of the restart ladder: how deep to nest, and how many iterations
/// each level runs.
struct Rung {
  int level;
  int iterations;
};

/// What a restart cycles through, and the second reason restarts work at all.
/// A fresh policy alone only changes WHERE the search looks; the nesting level
/// changes HOW — level 2 runs many shallow adaptations, level 4 few deep ones —
/// and on matchThreeTest50 that difference decides the board. Measured, 45 s
/// each, where level 3 x 30 is the arm's long-standing default:
///
///   seed 0: level 3 no,  level 2 SOLVED 10.3 s, level 4 SOLVED 36.8 s
///   seed 1: level 3 no,  level 2 SOLVED 0.5 s,  level 4 SOLVED 36.7 s
///   seed 4: level 3 no,  level 2 no,            level 4 SOLVED 1.6 s
///
/// No single rung wins everywhere and every rung wins somewhere, which is
/// exactly the case for cycling rather than picking. At a fixed 45 s on
/// matchThreeTest50, seeds 0 and 1 answer only to level 2 and seed 4 answers
/// only to level 4.
///
/// **The rungs cost the same on purpose, and getting that wrong cost a
/// two-thirds drop in solve rate.** A rung is `iterations ^ level` playouts, so
/// the natural-looking counts are wildly unequal: level 2 x 100 is 10 000
/// playouts, level 3 x 30 is 27 000, and level 4 x 20 is 160 000 — about 94 s of
/// search, more than a whole 45 s slice. A ladder carrying that rung gets one
/// cheap restart, one medium one, and then nothing, because the expensive rung
/// swallows every second that was left. Measured on test50, eight seeds, 45 s:
/// level 2 x 100 pinned solves 6/8, and the unequal ladder solves 2/8.
///
/// Equal cost is what makes the level a diversity axis rather than a lottery on
/// how much budget the cycle happens to reach. All three rungs below are ~10 000
/// playouts, and it bought matchThreeTest47 its best rate of anything measured
/// (5/8, against 2/8 for a pinned level 3).
///
/// It did NOT rescue test50, and that matters more than the fix did: cycling
/// takes test50 2/8 where pinning level 2 x 100 takes it 6/8, while test47 runs
/// the other way. **No single configuration wins both boards** — five were tried
/// and every gain on one cost the other. So kPortfolio races a pinned arm AND a
/// ladder arm rather than tuning this list further, and tuning it further is
/// unlikely to be where the next win is.
/// See bench/HARD-BOARDS.md for the full table.
constexpr auto kLadder = std::to_array<Rung>({
    {.level = 2, .iterations = 100},
    {.level = 3, .iterations = 22},
    {.level = 4, .iterations = 10},
});

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
        budget_(cfg, bounds, "nrpa", stats), pinnedLevel_(cfg.nrpaLevel),
        pinnedIterations_(cfg.nrpaIterations) {
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
    // Nothing to look for: a symbol already down to one or two blocks can never
    // line up again, so no playout can clear this board. Exact and free, and it
    // is the difference between the prover being told immediately and the slice
    // being spent first.
    if (rules::hasStrandedSymbol(board_))
      return {};
    // RESTARTS, and they are the whole difference between finding
    // matchThreeTest50 and not. A level-N search exhausts its iterations and
    // returns; on that board the losing runs come back after ~16 s of a 45 s
    // budget and the arm used to just stop there, leaving two thirds of its
    // slice unspent. Measured over eight seeds: two of them clear the board in
    // 939 ms and 3.1 s, the other six converge on a policy whose plateau state
    // is PROVABLY dead (exact endgame search, 3 of 4 harvested plateaus
    // unsolvable). So a run that plateaus has not run out of search — it has
    // run out of THIS policy, and the answer is a fresh one.
    //
    // The RNG deliberately keeps its stream across restarts rather than being
    // re-seeded: a continued stream cannot collide with a seed already tried,
    // and the caller's seed still reproduces the whole sequence exactly.
    int barren = 0;
    while (best_.left != 0 && barren < kBarrenRestarts &&
           !budget_.exhaustedNow()) {
      const int before = best_.left;
      const Rung rung = rungFor(restarts_);
      level_ = rung.level;
      iterations_ = rung.iterations;
      // One slot per packed move: a cell index, plus the direction bit.
      Policy policy(board_.cells.size() * 2, 0.0);
      search(level_, policy);
      restarts_++;
      barren = best_.left < before ? 0 : barren + 1;
    }
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
  /// A caller-pinned level/iteration count, or 0 to cycle the ladder. The
  /// bench sweeps and the portfolio's second NRPA arm pin theirs; the cascade
  /// leaves them open so one arm covers every rung.
  int pinnedLevel_;
  int pinnedIterations_;
  int level_ = 0;
  int iterations_ = 0;
  int total_ = 0;
  int restarts_ = 0;
  Line best_;
  Scratch scratch_;

  [[nodiscard]] Rung rungFor(const int restart) const {
    if (pinnedLevel_ > 0) {
      return {.level = pinnedLevel_,
              .iterations = pinnedIterations_ > 0 ? pinnedIterations_
                                                 : kLadder.front().iterations};
    }
    return kLadder[static_cast<size_t>(restart) % kLadder.size()];
  }

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
