#pragma once

#include <chrono>
#include <cstdint>

// Steady-clock milliseconds, shared by both solvers and the bench CLI.
//
// Every budget in this tree is measured against it: per-arm and per-segment
// search budgets, the post-processor's own cap, and the bench harness's
// timings. They have to agree on one clock — a system_clock reading here
// would let an NTP step expire a search mid-flight — and before the files
// were split each translation unit carried its own private copy of this.
inline uint64_t nowMs() {
  using namespace std::chrono;
  return static_cast<uint64_t>(
      duration_cast<milliseconds>(steady_clock::now().time_since_epoch())
          .count());
}

// Absolute deadline for a wall-clock budget, or 0 for "no budget" — the
// sentinel every search entry point in this tree uses. Seven of them derived
// it with the same inline ternary; this is that one expression, named.
//
// Deliberately NOT inline and defined in SolverClock.cpp. Each search entry
// point is now alone in its translation unit with no visible caller, and with
// the ternary inline the data-flow analyzer folded maxMs to 0 and then
// reported every budget guard in the function as dead code (18 findings across
// searchAssembly, searchBeamJam and searchHierarchical). Keeping the body in
// another TU leaves the value genuinely unknown, which is the truth.
uint64_t deadlineFrom(uint32_t maxMs);
