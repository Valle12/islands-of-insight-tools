#include "Search.h"

#include "Bitboard.h"
#include "Budget.h"
#include "Domains.h"
#include "Probe.h"
#include "Propagate.h"
#include "Puzzle.h"
#include "SeededRng.h"
#include "Types.h"
#include "Verify.h"

#include <array>
#include <cstddef>
#include <cstdint>
#include <queue>
#include <vector>

namespace lg {
namespace {

/**
 * One guessed cell, on the walk's OWN stack.
 *
 * `descend()` used to recurse, one machine frame per guessed cell. That is the
 * natural way to write it and it does not survive wasm: the compiler inlines
 * `pickCell`'s several `Bits` temporaries into the frame, which measured about
 * 900 bytes, and emscripten's default stack is 64 KB — so a board of roughly
 * seventy cells overflowed it and trapped as "Out of bounds memory access".
 * A 10x7 puzzle did exactly that while the native build, with its megabyte of
 * stack, solved the same board in 32 ms.
 *
 * Raising `STACK_SIZE` would not have been an answer. The depth bound is the
 * number of PLAYABLE CELLS — up to `kMaxCells`, 1024 — so the worst case is
 * near a megabyte of frames on a board the editor will happily accept, and the
 * native build is not far off its own limit either. The walk therefore keeps
 * its stack on the heap, where the bound is a `reserve` rather than a trap.
 */
struct Frame {
  Domains::Snapshot snapshot;
  int cell = 0;
  /// The color tried first here — the last one that worked at this cell.
  uint8_t first = kDark;
  /// How many of the two colors have been taken; 2 means the frame is spent.
  uint8_t tried = 0;
};

/**
 * Deduce, then guess, then deduce again.
 *
 * There are no restarts here on purpose. A restarting search that keeps
 * nothing it learned is not complete, and "there is no solution" — the claim
 * every underclued answer is built out of — is only worth anything from a
 * search that walked the whole space. Diversity comes from starting each run
 * at a different color instead (`randomPhase`), which changes the order the
 * space is walked in without changing what walking it out proves.
 */
class Dfs {
public:
  Dfs(const Model &model, const Config &cfg, const SearchOptions &options,
      SearchStats &stats)
      : model_(model), options_(options), stats_(stats),
        budget_(cfg, "search", stats), domains_(model), rng_(options.seed) {
    buildOrder();
    seedPhase();
  }

  SearchResult run() {
    if (!setup()) {
      // The givens and the assumptions already contradict each other, which is
      // as complete a proof as walking the space out.
      result_.exhausted = true;
      return result_;
    }
    const bool stoppedEarly = descend();
    result_.aborted = aborted_;
    result_.exhausted = !aborted_ && !stoppedEarly;
    return result_;
  }

private:
  const Model &model_;
  const SearchOptions &options_;
  SearchStats &stats_;
  Budget budget_;
  Domains domains_;
  SeededRng rng_;
  SearchResult result_;
  std::vector<int> order_;
  std::array<uint8_t, kMaxCells> phase_{};
  bool aborted_ = false;

  /// Cells in the order the search prefers to settle them: outwards from the
  /// clues, which is where every constraint that can bite actually lives.
  void buildOrder() {
    Bits seen;
    std::queue<int> queue;
    // A merged cell enters the frontier whole — every square of it marked and
    // queued together, so a 1x5 bar is ONE hop from a clue rather than five,
    // which is what "outwards from the clues" means in the puzzle's own
    // topology. Only its representative reaches the order: the order is a list
    // of choices, and a merged cell is one choice.
    const auto discover = [&](const int index) {
      if (seen.test(index))
        return;
      if (model_.shapeAt[slot(index)] < 0) {
        seen.set(index);
        queue.push(index);
        return;
      }
      const Bits mask = model_.cellMask(index);
      for (int i = mask.nextSet(0); i >= 0; i = mask.nextSet(i + 1)) {
        seen.set(i);
        queue.push(i);
      }
    };

    for (const Clue &clue : model_.puzzle.clues)
      discover(clue.index);
    while (!queue.empty()) {
      const int cell = queue.front();
      queue.pop();
      if (model_.representatives.test(cell))
        order_.push_back(cell);
      const int x = columnOf(cell);
      const int y = rowOf(cell);
      for (const auto &[dx, dy] : kSteps) {
        const int nx = x + dx;
        const int ny = y + dy;
        if (nx < 0 || nx >= kStride || ny < 0 || ny >= kMaxSide)
          continue;
        if (const int next = cellIndex(nx, ny); model_.playable.test(next))
          discover(next);
      }
    }
    for (int i = model_.representatives.nextSet(0); i >= 0;
         i = model_.representatives.nextSet(i + 1)) {
      if (!seen.test(i))
        order_.push_back(i);
    }
  }

  void seedPhase() {
    phase_.fill(kDark);
    if (!options_.randomPhase)
      return;
    for (const int cell : order_)
      phase_[slot(cell)] = rng_.uniform(0, 1) == 0 ? kDark : kLight;
  }

  bool setup() {
    if (!applyGivens(model_, domains_))
      return false;
    for (const auto &[cell, color] : options_.assumptions) {
      if (!domains_.assign(cell, color))
        return false;
    }
    return propagate(model_, domains_);
  }

  /**
   * The next cell to guess at: one touching what is already settled, so the
   * frontier stays short and the pattern clauses and region floods bite
   * immediately rather than at the very end.
   */
  [[nodiscard]] int pickCell() const {
    const Bits undecided = domains_.undecided();
    const Bits settled = domains_.definite(kDark) | domains_.definite(kLight);
    const Bits frontier = settled.grown() & undecided;
    int fallback = -1;
    for (const int cell : order_) {
      if (!undecided.test(cell))
        continue;
      if (frontier.test(cell))
        return cell;
      if (fallback < 0)
        fallback = cell;
    }
    return fallback;
  }

  /// True when enough solutions are in hand and the walk should stop.
  bool accept() {
    const Colors colors = domains_.toColors();
    if (verify::check(model_, colors) != verify::Violation::None) {
      // Propagation let something through that is not a solution. That is a
      // bug rather than a puzzle, so it is counted and refused — never
      // returned.
      stats_.oracleRejections++;
      return false;
    }
    result_.solutions.push_back(colors);
    budget_.note(model_.playableCount, 0);
    return static_cast<int>(result_.solutions.size()) >= options_.solutionLimit;
  }

  /// Looks at a node nobody has expanded yet: either the assignment is complete
  /// and gets accepted, or a cell is chosen and pushed as a new frame to branch
  /// on. True when enough solutions are in hand and the walk should stop.
  bool expandFresh(std::vector<Frame> &stack) {
    const int cell = domains_.complete() ? -1 : pickCell();
    if (cell < 0)
      return accept();
    stack.push_back(Frame{.snapshot = domains_.snapshot(),
                          .cell = cell,
                          .first = phase_[slot(cell)],
                          .tried = 0});
    return false;
  }

  /// Takes the next color at the deepest open frame, dropping it when both are
  /// spent. True when the branch propagated, which is the one case that leaves
  /// a fresh node to look at.
  bool takeNextBranch(std::vector<Frame> &stack) {
    auto &[snapshot, cell, first, tried] = stack.back();
    // Unconditionally, and before anything else: this is the undo the
    // recursion used to get from unwinding. On a frame that has just been
    // pushed it restores to itself and costs nothing.
    domains_.restore(snapshot);
    if (tried == 2) {
      stack.pop_back();
      return false;
    }
    const uint8_t color = tried == 0 ? first : opposite(first);
    tried++;
    if (!domains_.assign(cell, color) || !propagate(model_, domains_))
      return false;
    phase_[slot(cell)] = color;
    return true;
  }

  /**
   * Walks the space. True when it stopped early with enough solutions in hand;
   * false when the stack emptied (the space is walked out) or the budget went.
   *
   * This is a LOOP over a heap-allocated stack and must stay one. Written the
   * natural recursive way it costs a machine frame per guessed cell — measured
   * at roughly 900 bytes once `pickCell`'s `Bits` temporaries are inlined in —
   * and emscripten's default stack is 64 KB, so a board of about seventy cells
   * trapped as "Out of bounds memory access" while the native build solved it
   * in 32 ms. The helpers above are called and returned within one iteration,
   * so they cost one frame at a time rather than one per depth.
   *
   * One iteration does at most one `propagate`, so the budget is checked as
   * often as it was when this recursed. `fresh` says whether the current
   * domains are a node nobody has expanded yet: true right after a branch was
   * taken and propagated, false when the last thing that happened was a
   * failure, a leaf, or a frame running out of colors — all of which mean
   * back up and take the next branch.
   */
  bool descend() {
    std::vector<Frame> stack;
    // One frame per guessed CELL, which is the real depth bound.
    stack.reserve(static_cast<std::size_t>(model_.cellCount) + 1);
    bool fresh = true;

    for (;;) {
      if (budget_.exhausted()) {
        aborted_ = true;
        return false;
      }
      if (fresh) {
        if (expandFresh(stack))
          return true;
        fresh = false;
        continue;
      }
      if (stack.empty())
        return false;
      fresh = takeNextBranch(stack);
    }
  }
};

} // namespace

SearchResult search(const Model &model, const Config &cfg,
                    const SearchOptions &options, SearchStats &stats) {
  Dfs dfs(model, cfg, options, stats);
  return dfs.run();
}

Outcome runDeduce(const Model &model, const Config &cfg) {
  Outcome outcome;
  outcome.arm = "deduce";
  Domains domains(model);
  Budget budget(cfg, "deduce", outcome.stats);
  if (!applyGivens(model, domains)) {
    outcome.status = Status::Unsolvable;
    return outcome;
  }
  if (probeToFixpoint(model, domains, budget) == ProbeResult::Conflict) {
    outcome.status = Status::Unsolvable;
    return outcome;
  }

  outcome.colors = domains.toColors();
  outcome.decided = domains.decidedCount();
  if (domains.complete() &&
      verify::check(model, outcome.colors) == verify::Violation::None) {
    outcome.status = Status::Solved;
    outcome.witnesses.push_back(outcome.colors);
  }
  return outcome;
}

Outcome runDfs(const Model &model, const Config &cfg) {
  Outcome outcome;
  outcome.arm = "dfs";
  const SearchOptions options{.seed = cfg.seed};
  const SearchResult result = search(model, cfg, options, outcome.stats);
  if (!result.solutions.empty()) {
    outcome.status = Status::Solved;
    outcome.colors = result.solutions.front();
    outcome.decided = model.playableCount;
    outcome.witnesses.push_back(outcome.colors);
    return outcome;
  }
  if (result.exhausted)
    outcome.status = Status::Unsolvable;
  return outcome;
}

} // namespace lg
