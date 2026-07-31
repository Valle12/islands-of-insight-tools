#pragma once

#include "MemoryProbe.h"
#include "Search.h"
#include "SolverClock.h"

#include <cstdint>

// The one place every arm asks "may I keep going?", and the one place progress
// leaves the search. Bundled so the four arms cannot drift on the order of the
// checks, or on which of them sets `stoppedOnMemory`.
namespace mt {

/// Work units between clock reads. Reading the clock per node costs more than
/// the search does.
inline constexpr uint64_t kCheckInterval = 2048;

/// Progress leaves the search at most this often; the page reads it at human
/// speed, and under the pthreads race the poll is 200 ms anyway.
inline constexpr uint64_t kProgressIntervalMs = 100;

class Budget {
public:
  Budget(const Config &cfg, Bounds &bounds, const char *phase,
         SearchStats &stats)
      : cfg_(cfg), bounds_(bounds), phase_(phase), stats_(stats),
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

  /// The unsampled ladder, for arms whose outer loop is coarse enough that
  /// every iteration deserves a real check.
  bool exhaustedNow() {
    sinceCheck_ = 0;
    return sample();
  }

  [[nodiscard]] bool expired() const { return expired_; }

  /// The deadline this budget was built with, or 0 for "no budget" — arms with
  /// their own inner deadlines slice against it.
  [[nodiscard]] uint64_t deadline() const { return deadline_; }

private:
  const Config &cfg_;
  Bounds &bounds_;
  const char *phase_;
  SearchStats &stats_;
  uint64_t deadline_;
  uint64_t sinceCheck_ = 0;
  uint64_t lastProgressMs_ = 0;
  uint64_t published_ = 0;
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
                                .ruledOut = bounds_.ruledOut(),
                                .bestLength = bounds_.bestLength()});
  }

  bool outOfMemory() {
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
    const uint64_t live = memprobe::liveAllocatedBytes();
    // 0 means "cannot measure here", never "no memory used".
    if (live == 0 || live < cfg_.maxHeapBytes)
      return false;
    stats_.stoppedOnMemory = true;
    return true;
  }
};

} // namespace mt
