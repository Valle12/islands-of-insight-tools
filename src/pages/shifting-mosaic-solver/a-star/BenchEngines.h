#pragma once

#include "BenchFixture.h"
#include "BenchOptions.h"
#include "ParallelCascade.h"
#include "Types.h"

#include <cstdint>
#include <string>
#include <vector>

// Engine selection for the bench CLI, split out of main.cpp so that main() is a
// dispatcher rather than a 200-line chain of solver setups.

// What one bench run produced. The three timestamps are kept rather than the
// differences because the reported constructMs/searchMs/wallMs are all derived
// from them.
struct SolveResult {
  std::vector<Turn> turns;
  std::vector<cascade::ArmOutcome> armOutcomes;
  std::string stage;
  uint64_t t0 = 0; // before solver construction
  uint64_t t1 = 0; // construction done, search starting
  uint64_t t2 = 0; // search done
  uint64_t statesStored = 0;
  uint32_t nodesExpanded = 0;
  uint32_t minJamTerm = UINT32_MAX;
  uint32_t maxProgress = 0;
  uint8_t passes = 0;
  // True when a search stopped on the measured-memory ceiling rather than the
  // clock or exhaustion — the stdout message is verbose-gated, so the stat is
  // the only reliable signal.
  bool stoppedOnMemory = false;
};

// True for an engine name the CLI understands.
[[nodiscard]] bool isKnownEngine(const std::string &engine);

// Runs the configured engine over the fixture. Returns false when the options
// are inconsistent (the reason has already been written to stderr).
bool runBenchEngine(const BenchOptions &opt, const Fixture &data,
                    SolveResult &res);
