#include "Bitboard.h"
#include "Budget.h"
#include "Domains.h"
#include "Probe.h"
#include "Propagate.h"
#include "Puzzle.h"
#include "Search.h"
#include "SolverClock.h"
#include "Types.h"

#include <algorithm>
#include <cstdint>
#include <vector>

// An underclued board does not ask for a solution. It asks which cells hold
// the same colour in EVERY solution — the ones a player can paint knowing they
// cannot be wrong — and leaves the rest blank.
//
// The shape of the answer is a sandwich:
//
//   what deduction proved  ⊆  what is really forced  ⊆  what every solution
//                                                       found so far agrees on
//
// The two ends are cheap. Deduction gives the lower one for nothing, and it is
// usually most of the answer, because these puzzles are built to be worked out
// by hand. Every solution found narrows the upper one, and a cell two
// solutions disagree on is settled as "not forced" for good.
//
// Only the gap between them costs anything: for each cell still in it, the
// colour every known solution happens to share has to be PROVED — by searching
// out the whole space with that cell painted the other way and finding
// nothing. When a search does find something instead, the answer is not wasted:
// it goes into the pool and knocks out every other candidate it disagrees with.
//
// If the budget runs out with the gap still open, the answer says so
// (`proven == false`) rather than presenting the lower end as the whole
// deduction. That distinction is the entire point of the mode.
namespace lg {
namespace {

/// Diversifying runs before the refutations start. Each one is a whole search,
/// but a cheap one, and between them they usually settle most of the board.
inline constexpr int kPoolRuns = 4;

bool outOfTime(const Config &cfg, const uint64_t deadline) {
  if (cfg.cancel != nullptr && cfg.cancel->load(std::memory_order_relaxed))
    return true;
  return deadline != 0 && nowMs() >= deadline;
}

/**
 * The same config with only the time still left on it.
 *
 * Every stage below runs its own `search`, and each of those builds a budget
 * from `maxMs` — so handing them the original config would give each one a
 * fresh full budget and let a board with two hundred candidates run for two
 * hundred times the time it was allowed. They all measure against one deadline
 * instead.
 */
Config sliceTo(const Config &cfg, const uint64_t deadline) {
  Config sliced = cfg;
  if (deadline == 0)
    return sliced;
  const uint64_t now = nowMs();
  // Never 0 on the way out: that is the sentinel for "no budget at all".
  sliced.maxMs = now >= deadline ? 1 : static_cast<uint32_t>(deadline - now);
  return sliced;
}

/// Cells still undecided that every known solution happens to agree on. These
/// are the only ones worth proving anything about.
std::vector<int> candidatesFrom(const Model &model, const Colors &known,
                                const std::vector<Colors> &pool,
                                Colors &agreed) {
  std::vector<int> candidates;
  // One candidate per CELL: a refutation is the most expensive thing this
  // solver does, and every square of a merged cell would run the identical one.
  for (int i = model.representatives.nextSet(0); i >= 0;
       i = model.representatives.nextSet(i + 1)) {
    if (known[slot(i)] != kUnknown)
      continue;
    const uint8_t first = pool.front()[slot(i)];
    // Unanimous among the solutions found SO FAR, which is necessary for a cell
    // to be forced and nowhere near sufficient. The refutation loop is what
    // proves it; this only says which cells are worth the attempt.
    if (!std::ranges::all_of(pool, [i, first](const Colors &one) {
          return one[slot(i)] == first;
        }))
      continue;
    agreed[slot(i)] = first;
    candidates.push_back(i);
  }
  return candidates;
}

void dropDisagreements(std::vector<int> &candidates, const Colors &agreed,
                       const Colors &found) {
  std::erase_if(candidates, [&agreed, &found](const int cell) {
    return found[slot(cell)] != agreed[slot(cell)];
  });
}

/**
 * Example solutions for the page to check the answer against.
 *
 * Greedy on disagreement rather than "the first few": a witness that differs
 * from the ones already chosen is what demonstrates a cell is genuinely not
 * forced, and identical witnesses demonstrate nothing.
 */
std::vector<Colors> selectWitnesses(const Model &model,
                                    const std::vector<Colors> &pool,
                                    const int limit) {
  std::vector<Colors> chosen;
  if (pool.empty() || limit <= 0)
    return chosen;
  chosen.push_back(pool.front());

  std::vector taken(pool.size(), false);
  taken[0] = true;
  while (static_cast<int>(chosen.size()) < limit) {
    int best = -1;
    int bestGain = 0;
    for (size_t i = 0; i < pool.size(); i++) {
      if (taken[i])
        continue;
      int gain = 0;
      for (int cell = model.playable.nextSet(0); cell >= 0;
           cell = model.playable.nextSet(cell + 1)) {
        const bool differs = std::ranges::any_of(
            chosen, [&pool, i, cell](const Colors &one) {
              return one[slot(cell)] != pool[i][slot(cell)];
            });
        gain += differs ? 1 : 0;
      }
      if (gain > bestGain) {
        bestGain = gain;
        best = static_cast<int>(i);
      }
    }
    if (best < 0)
      break;
    taken[slot(best)] = true;
    chosen.push_back(pool[slot(best)]);
  }
  return chosen;
}

int countDecided(const Model &model, const Colors &colors) {
  int decided = 0;
  for (int i = model.playable.nextSet(0); i >= 0;
       i = model.playable.nextSet(i + 1))
    decided += colors[slot(i)] == kUnknown ? 0 : 1;
  return decided;
}

/// Everything deduction alone settles, which is proven forced the moment a
/// solution is known to exist at all.
Outcome deduceRoot(const Model &model, const Config &cfg, Colors &known) {
  Outcome outcome;
  outcome.arm = "forced";
  Domains domains(model);
  if (Budget budget(cfg, "deduce", outcome.stats);
      !applyGivens(model, domains) ||
      probeToFixpoint(model, domains, budget) == ProbeResult::Conflict) {
    outcome.status = Status::Unsolvable;
    return outcome;
  }
  known = domains.toColors();
  return outcome;
}

/// The refutation loop's working set. `known` and `pool` outlive it; the rest
/// is scratch it consumes.
struct Refuting {
  const Model &model;
  const Config &cfg;
  uint64_t deadline = 0;
  const Colors &agreed;
  Colors &known;
  std::vector<int> &candidates;
  std::vector<Colors> &pool;
};

/**
 * Settles each candidate cell by searching the whole space with that cell
 * painted the OTHER way: finding nothing proves it, and finding a solution
 * instead knocks out every other candidate that solution disagrees with.
 *
 * False when it gave up with candidates still standing — the budget went, or a
 * search aborted. An aborted search proves NOTHING, so that case must reach the
 * caller as "not proven" rather than being folded in with a clean finish; it is
 * exactly the distinction `Outcome::proven` exists to carry.
 */
bool refuteCandidates(const Refuting &work, SearchStats &stats) {
  std::vector<Assumption> proven;
  while (!work.candidates.empty()) {
    if (outOfTime(work.cfg, work.deadline))
      return false;
    const int cell = work.candidates.back();
    work.candidates.pop_back();
    const uint8_t want = work.agreed[slot(cell)];

    SearchOptions options{.seed = work.cfg.seed, .assumptions = proven};
    options.assumptions.emplace_back(cell, opposite(want));
    // Named rather than passed inline: `Budget` keeps a reference to the config
    // it was built with, and a temporary would only be alive for the call.
    const Config sliced = sliceTo(work.cfg, work.deadline);
    const SearchResult attempt = search(work.model, sliced, options, stats);
    stats.refutations++;

    if (!attempt.solutions.empty()) {
      dropDisagreements(work.candidates, work.agreed,
                        attempt.solutions.front());
      work.pool.push_back(attempt.solutions.front());
      continue;
    }
    if (!attempt.exhausted)
      return false;
    // Every square of the cell, not just the representative: this is the answer
    // the page draws, and a merged cell reported half painted would be drawn
    // half painted. One assumption is still enough — `assign` fans out.
    const Bits mask = work.model.cellMask(cell);
    for (int i = mask.nextSet(0); i >= 0; i = mask.nextSet(i + 1))
      work.known[slot(i)] = want;
    proven.emplace_back(cell, want);
  }
  return true;
}

void fillPool(const Model &model, const Config &cfg, std::vector<Colors> &pool,
              SearchStats &stats, const uint64_t deadline) {
  for (int run = 1; run <= kPoolRuns; run++) {
    if (outOfTime(cfg, deadline))
      return;
    const SearchOptions options{.seed = cfg.seed + static_cast<uint32_t>(run),
                                .randomPhase = true};
    // Named rather than passed inline: `Budget` keeps a reference to the config
    // it was built with, and a temporary would only be alive for the call.
    const Config sliced = sliceTo(cfg, deadline);
    if (const SearchResult result = search(model, sliced, options, stats);
        !result.solutions.empty())
      pool.push_back(result.solutions.front());
  }
}

} // namespace

Outcome runForced(const Model &model, const Config &cfg) {
  const uint64_t deadline = deadlineFrom(cfg.maxMs);
  Colors known{};
  Outcome outcome = deduceRoot(model, cfg, known);
  if (outcome.status == Status::Unsolvable)
    return outcome;

  // Nothing above counts as forced until a solution is known to exist: on a
  // board with none, every cell is vacuously "the same in all zero of them".
  const SearchOptions firstOptions{.seed = cfg.seed};
  const Config firstBudget = sliceTo(cfg, deadline);
  const SearchResult first =
      search(model, firstBudget, firstOptions, outcome.stats);
  if (first.solutions.empty()) {
    outcome.status = first.exhausted ? Status::Unsolvable : Status::Unsolved;
    return outcome;
  }

  std::vector<Colors> pool = first.solutions;
  fillPool(model, cfg, pool, outcome.stats, deadline);

  Colors agreed{};
  std::vector<int> candidates = candidatesFrom(model, known, pool, agreed);
  const Refuting work{.model = model,
                      .cfg = cfg,
                      .deadline = deadline,
                      .agreed = agreed,
                      .known = known,
                      .candidates = candidates,
                      .pool = pool};
  const bool settledEverything = refuteCandidates(work, outcome.stats);

  outcome.status = Status::Deduced;
  outcome.colors = known;
  outcome.decided = countDecided(model, known);
  outcome.proven = settledEverything;
  outcome.witnesses = selectWitnesses(model, pool, cfg.witnessLimit);
  return outcome;
}

} // namespace lg
