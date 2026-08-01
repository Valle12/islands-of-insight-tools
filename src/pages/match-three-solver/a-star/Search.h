#pragma once

#include "Types.h"

#include <atomic>
#include <cstdint>
#include <functional>
#include <mutex>
#include <string>

// The solver's arms and the state they share. Every arm reports a clearing
// sequence it does not claim is minimal; only the exhaustive arm ever says
// `unsolvable`, and that is about existence rather than length.
namespace mt {

/// Failed-state table ceiling, per arm. Past it the table evicts instead of
/// growing — the search slows down rather than dying, which matters most in
/// the browser, where an allocation failure aborts the whole module.
inline constexpr uint64_t kDefaultTableBytes = 256ULL * 1024 * 1024;

/// Length sentinel for "no solution known yet".
inline constexpr int kNoLength = -1;

struct Progress {
  const char *phase = "";
  uint64_t nodes = 0;
  int bestLength = kNoLength;
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
  uint64_t tableBytes = kDefaultTableBytes;
  uint64_t maxHeapBytes = 0;
  uint32_t seed = 0;
  int beamWidth = 0;      ///< 0 = the arm's own ladder
  int nrpaLevel = 0;      ///< 0 = the arm's default nesting depth
  int nrpaIterations = 0; ///< 0 = the arm's default iterations per level
  std::atomic<bool> *cancel = nullptr;
  const Callbacks *callbacks = nullptr;
  /**
   * Where an arm publishes the work it has done, when it may not call back
   * directly. Under the in-module thread race only the module's own thread is
   * allowed to cross into JavaScript, so the racing arms get this counter and
   * `callbacks` stays null; the module thread polls and reports.
   */
  std::atomic<uint64_t> *progress = nullptr;
};

struct SearchStats {
  uint64_t nodesExpanded = 0;
  uint64_t statesStored = 0;
  /// Distinguishes "too big for this heap" from "genuinely searched out".
  bool stoppedOnMemory = false;
};

struct Outcome {
  Moves moves;
  /// A completed proof that the board cannot be cleared at all. The only proof
  /// left here, and it is about EXISTENCE: nothing claims a length is minimal.
  bool unsolvable = false;
  SearchStats stats;
  std::string arm;
};

/// The best solution known and the depths ruled out, shared by cooperating
/// arms: a bound one arm finds caps every other arm's work. Sequential arms
/// pass one instance along; racing threads share it.
class Bounds {
public:
  /// Records `moves` when it beats the incumbent. True when it improved.
  bool offer(const Moves &moves) {
    const int length = static_cast<int>(moves.size());
    const std::lock_guard guard(mutex_);
    if (bestLength_ != kNoLength && length >= bestLength_)
      return false;
    best_ = moves;
    bestLength_ = length;
    length_.store(length, std::memory_order_relaxed);
    return true;
  }

  /// Length of the best solution known, or kNoLength.
  [[nodiscard]] int bestLength() const {
    return length_.load(std::memory_order_relaxed);
  }

  [[nodiscard]] Moves best() const {
    const std::lock_guard guard(mutex_);
    return best_;
  }

  /// True once any arm has an answer, which is when every other arm can stop.
  /// It used to mean "the incumbent is proven minimal"; now the first witness
  /// ends the race, because measured over the captured corpus that witness is
  /// already the shortest on 48 of 49 boards.
  [[nodiscard]] bool settled() const { return bestLength() != kNoLength; }

private:
  mutable std::mutex mutex_;
  Moves best_;
  int bestLength_ = kNoLength;
  std::atomic<int> length_{kNoLength};
};

/// Restarted greedy rollouts: biggest clear first, refusing to strand a
/// symbol unless every move does, sampling among the rest after the first.
Outcome runGreedy(const Board &board, const Config &cfg, Bounds &bounds);

/// A level-synchronous beam over move count, widening while the budget lasts.
Outcome runBeam(const Board &board, const Config &cfg, Bounds &bounds);

/// The exhaustive search: one pass at the deepest length worth trying,
/// returning the moment it finds anything. If it searches that depth out with
/// nothing found, the board is provably unclearable — the only proof left.
Outcome runExhaustive(const Board &board, const Config &cfg, Bounds &bounds);

/// Nested Rollout Policy Adaptation: playouts that sample from a learned
/// per-move policy, each nesting level adapting toward the best line it saw.
/// The only arm that has produced a witness for matchThreeTest51.
Outcome runNrpa(const Board &board, const Config &cfg, Bounds &bounds);

} // namespace mt
