#pragma once

#include "MemoryProbe.h"
#include "Search.h"
#include "SolverClock.h"

#include <cstdint>

// The one place every arm asks "may I keep going?", and the one place progress
// leaves the search. Bundled so the arms cannot drift on the order of the
// checks, or on which of them sets `stoppedOnMemory`.
//
// The same shape as the match-three solver's Budget, with one difference: an
// abort here is never allowed to read as a proof. A look-ahead that ran out of
// time has shown nothing at all, and the underclued mode rests entirely on
// telling "no solution exists" apart from "I stopped looking".
namespace lg {

/// Work units between clock reads. Reading the clock per node costs more than
/// the search does.
inline constexpr uint64_t kCheckInterval = 2048;

/// Progress leaves the search at most this often; the page reads it at human
/// speed, and under the pthreads race the poll is 200 ms anyway.
inline constexpr uint64_t kProgressIntervalMs = 100;

class Budget {
public:
  Budget(const Config &cfg, const char *phase, SearchStats &stats)
      : cfg_(cfg), phase_(phase), stats_(stats),
        deadline_(deadlineFrom(cfg.maxMs)) {}

  /// Counts one unit of work and answers whether the arm must stop. Sampled:
  /// the ladder itself runs once every kCheckInterval calls.
  bool exhausted() {
    stats_.nodesExpanded++;
    if (++sinceCheck_ < kCheckInterval)
      return expired_;
    sinceCheck_ = 0;
    return sample();
  }

  /// The unsampled ladder, for loops whose every iteration is coarse enough to
  /// deserve a real check — a look-ahead pass over one cell, say.
  bool exhaustedNow() {
    sinceCheck_ = 0;
    return sample();
  }

  [[nodiscard]] bool expired() const { return expired_; }

  /// The deadline this budget was built with, or 0 for "no budget".
  [[nodiscard]] uint64_t deadline() const { return deadline_; }

  /// What the next progress report should say about the answer taking shape.
  void note(const int decided, const int pending) {
    decided_ = decided;
    pending_ = pending;
  }

private:
  const Config &cfg_;
  const char *phase_;
  SearchStats &stats_;
  uint64_t deadline_;
  uint64_t sinceCheck_ = 0;
  uint64_t lastProgressMs_ = 0;
  uint64_t published_ = 0;
  int decided_ = 0;
  int pending_ = 0;
  bool expired_ = false;

  bool sample() {
    publishProgress();
    if (cfg_.cancel != nullptr &&
        cfg_.cancel->load(std::memory_order_relaxed)) {
      expired_ = true;
      return true;
    }
    const uint64_t now = nowMs();
    emitProgress(now);
    if (deadline_ != 0 && now >= deadline_)
      expired_ = true;
    if (cfg_.maxNodes != 0 && stats_.nodesExpanded >= cfg_.maxNodes)
      expired_ = true;
    if (outOfMemory())
      expired_ = true;
    return expired_;
  }

  /// Hands this arm's new work to the shared counter, for a caller that polls
  /// rather than being called back.
  void publishProgress() {
    if (cfg_.progress == nullptr)
      return;
    const uint64_t done = stats_.nodesExpanded;
    cfg_.progress->fetch_add(done - published_, std::memory_order_relaxed);
    published_ = done;
  }

  void emitProgress(const uint64_t now) {
    if (cfg_.callbacks == nullptr || !cfg_.callbacks->onProgress)
      return;
    if (now - lastProgressMs_ < kProgressIntervalMs)
      return;
    lastProgressMs_ = now;
    cfg_.callbacks->onProgress({.phase = phase_,
                                .nodes = stats_.nodesExpanded,
                                .decided = decided_,
                                .pending = pending_});
  }

  [[nodiscard]] bool outOfMemory() const {
#if defined(__EMSCRIPTEN__)
    // A wasm heap that cannot grow ABORTS the module rather than failing an
    // allocation, so this tripwire runs even with no budget configured.
    if (memprobe::nearHeapLimit()) {
      stats_.stoppedOnMemory = true;
      return true;
    }
#endif
    if (cfg_.maxHeapBytes == 0)
      return false;
    // 0 means "cannot measure here", never "no memory used".
    if (const uint64_t live = memprobe::liveAllocatedBytes();
        live == 0 || live < cfg_.maxHeapBytes)
      return false;
    stats_.stoppedOnMemory = true;
    return true;
  }
};

} // namespace lg
