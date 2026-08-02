#pragma once

#include <chrono>
#include <cstdint>

// Steady-clock milliseconds, shared by the search, its post-processing and the
// CLI. Every budget in this solver is measured against it — they have to agree
// on one clock, and a system_clock reading here would let an NTP step expire a
// search mid-flight. Same design as the shifting-mosaic solver's clock.
inline uint64_t nowMs() {
  using namespace std::chrono;
  return static_cast<uint64_t>(
      duration_cast<milliseconds>(steady_clock::now().time_since_epoch())
          .count());
}

// Absolute deadline for a wall-clock budget, or 0 for "no budget" — the
// sentinel every search entry point uses.
//
// Deliberately NOT inline and defined in SolverClock.cpp. With the ternary
// visible, a data-flow analyser can fold maxMs to 0 for callers it can see and
// then report the budget guards in the search as dead code (this happened in
// the shifting-mosaic solver, 18 findings). Keeping the body in another TU
// leaves the value genuinely unknown, which is the truth.
uint64_t deadlineFrom(uint32_t maxMs);
