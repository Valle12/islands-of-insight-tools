#pragma once

#include "Puzzle.h"

#include <atomic>
#include <cstdint>
#include <functional>
#include <string>
#include <utility>
#include <vector>

// What a solve is asked for, what it reports, and the one search primitive
// everything else is built on.
namespace lg {

enum class Status : uint8_t {
  /// Nothing found and nothing proved — the budget ran out.
  Unsolved = 0,
  /// A complete coloring, verified.
  Solved,
  /// An underclued board's forced cells.
  Deduced,
  /// No coloring of this board is a solution.
  Unsolvable,
};

struct Progress {
  const char *phase = "";
  uint64_t nodes = 0;
  /// Cells decided so far, and cells still to be settled either way. Both are
  /// meaningful to a player watching an underclued board being worked out.
  int decided = 0;
  int pending = 0;
};

/// Where an arm reports to. Under the pthreads race only the module's own
/// thread ever invokes these, so nothing here has to be thread-safe.
struct Callbacks {
  std::function<void(const Progress &)> onProgress;
  std::function<void(const char *)> onArmStart;
};

struct Config {
  uint32_t maxMs = 0; ///< 0 = no wall-clock budget
  uint64_t maxNodes = 0;
  uint64_t maxHeapBytes = 0;
  uint32_t seed = 0;
  /// How many example solutions an underclued answer may carry back, so the
  /// page can check the claim against its own rules.
  int witnessLimit = 8;
  std::atomic<bool> *cancel = nullptr;
  const Callbacks *callbacks = nullptr;
  /// Where an arm publishes its work when it may not call back directly —
  /// under the in-module race only the module's thread crosses into JavaScript.
  std::atomic<uint64_t> *progress = nullptr;
};

struct SearchStats {
  uint64_t nodesExpanded = 0;
  /// How many "prove this cell cannot be the other color" searches ran.
  uint64_t refutations = 0;
  /// Complete assignments propagation accepted but the oracle rejected. Always
  /// zero; a non-zero count means a propagator and `Verify` disagree, which is
  /// a bug rather than a puzzle.
  uint64_t oracleRejections = 0;
  bool stoppedOnMemory = false;
};

struct Outcome {
  Status status = Status::Unsolved;
  /// The answer: a complete coloring, or — underclued — the cells that hold
  /// the same color in every solution, with the rest left kUnknown.
  Colors colors{};
  /**
   * Underclued only: whether every remaining cell was PROVED to be undecidable
   * rather than merely not yet decided. False means the budget ran out with
   * work left, and the page must say so rather than presenting a partial
   * deduction as the answer.
   */
  bool proven = false;
  int decided = 0;
  /// Complete solutions the page can check the answer against.
  std::vector<Colors> witnesses;
  SearchStats stats;
  std::string arm;
};

/// A cell pinned to a color for one run, on top of the puzzle's own givens.
using Assumption = std::pair<int, uint8_t>;

struct SearchOptions {
  uint32_t seed = 0;
  /// Start each cell from a random color rather than a fixed one. Only worth
  /// it when the point is to collect DIFFERENT solutions.
  bool randomPhase = false;
  /// Stop once this many solutions are in hand.
  int solutionLimit = 1;
  std::vector<Assumption> assumptions;
};

struct SearchResult {
  /// The budget or a cancel stopped the walk, so nothing at all is proved.
  bool aborted = false;
  /// The space was walked out. With no solutions, that is a proof there are
  /// none — the single primitive an underclued answer rests on.
  bool exhausted = false;
  std::vector<Colors> solutions;
};

/// Walks the assignments, deducing as far as it can before every branch.
SearchResult search(const Model &model, const Config &cfg,
                    const SearchOptions &options, SearchStats &stats);

/**
 * Deduction only: propagation, then singleton look-ahead to a fixpoint.
 *
 * Look-ahead is what turns the propagators into the game's own hand
 * techniques: trying a color and finding it contradictory proves the other,
 * which covers bottlenecks, near-misses, escapes and the rest without any of
 * them being written down. Nothing here branches, so it terminates quickly and
 * anything it decides is decided in every solution — as long as one exists.
 */
Outcome runDeduce(const Model &model, const Config &cfg);

/// One solution, or a proof there is none.
Outcome runDfs(const Model &model, const Config &cfg);

/// The cells that hold the same color in every solution.
Outcome runForced(const Model &model, const Config &cfg);

} // namespace lg
