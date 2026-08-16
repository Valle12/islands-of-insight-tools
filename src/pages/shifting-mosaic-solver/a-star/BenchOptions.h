#pragma once

#include "AStar.h"
#include "DragSolver.h"

#include <cstdint>
#include <filesystem>
#include <string>

// Command-line surface of the bench CLI, split out of main.cpp so that main()
// is a dispatcher rather than a 45-branch parser. See main.cpp's header comment
// for what each flag means.

// Every option the CLI accepts, with the production defaults already applied
// (these mirror wasmBridge.ts SOLVER_CONFIG).
//
// Grouped rather than flat: 39 fields in one struct is cpp:S1820, and the
// groups below are the ones the flag table already implies. Nothing else
// changed — each nested field keeps its old default and meaning.
struct BenchOptions {
  // Where a run reads from and writes to.
  struct Paths {
    std::filesystem::path fixture;
    std::filesystem::path dump;
    std::filesystem::path generate;
    std::filesystem::path verify;
    // Decomposition of a stalled jam board: dump the deepest elite as a
    // residual fixture (+ the root->elite prefix) so the remainder can be
    // solved separately and the two halves stitched.
    std::filesystem::path dumpElite;
    std::filesystem::path dumpEliteTurns;
  };

  // What stops a run.
  struct Limits {
    uint32_t budgetMs = 60000;
    uint32_t maxNodes = 20000000;
    uint32_t seqTotalMs = 0;   // total cap for the sequential phase; 0 = none
    uint64_t maxStates = 0;    // 0 = unlimited (unchanged behaviour)
    uint64_t maxHeapBytes = 0; // 0 = unlimited; measured bytes, not a proxy
  };

  // The jam and beam family's knobs.
  struct Jam {
    uint32_t roundCap = 0;
    uint32_t elites = 6;
    uint8_t aspect16 = DragSolver::Config{}.jam.aspect16;     // x16 ratio
    uint8_t densityPct = DragSolver::Config{}.jam.densityPct; // percent
    uint8_t penalty = 4;
    uint8_t guide = 0;
    bool pin = false;
    bool luby = false;
  };

  // The drag-space engines' knobs.
  struct Drag {
    uint16_t pea = 0;
    uint8_t packingWeight = 0;
    uint8_t consolidationGain = 0;
    uint8_t bandMinPath = DragSolver::Config{}.corridorBandMinPath;
    bool settledOnly = false;
    bool slotHeuristic = false;
    bool requireAllSlots = false;
    bool lockOnSlot = false;
    bool sleepSets = false;
    bool relevantOnly = false;
    bool bands = false;
  };

  // --generate only.
  struct Generate {
    uint32_t seed = 0;
    uint32_t shuffleMoves = 100000;
  };

  Paths paths;
  Limits limits;
  Jam jam;
  Drag drag;
  Generate generate;

  std::string engine = "unit";

  AStar::Config cfg = [] {
    AStar::Config c;
    c.weight = 3;
    c.pathBlockerWeight = 1;
    c.boundaryDistanceWeight = 1;
    c.axisAwareWeight = 1;
    c.lpDisplacementWeight = 1;
    c.postProcess = true;
    return c;
  }();

  uint32_t tieSeed = 0;
  uint32_t beamWidth = 0;
  int armIndex = -1;     // --engine arm: which race arm to run alone
  bool emitJson = false;
  bool armGated = false; // apply jamProfile() to arms 6/7 (phase 2 does not)
};

// Walks argv. The index lives here rather than in a for-loop counter that the
// body also advances: options that take a value have to consume the next
// element, and a loop whose counter is written inside it is exactly the shape
// static analysis (and readers) trip over.
//
// Errors are recorded rather than thrown or exited: the first failure stops the
// walk, and the caller reports it once.
class ArgCursor {
public:
  ArgCursor(const int argc, char **const argv) : argc_(argc), argv_(argv) {}

  [[nodiscard]] bool hasMore() const { return index_ < argc_ && error_.empty(); }

  // Consumes the next element as an option name and remembers it for messages.
  std::string_view takeFlag();

  // Consumes the current option's value.
  const char *value();

  // Consumes the current option's value as a number. atoi()/atoll() report
  // nothing: a typo'd or out-of-range value silently becomes 0 and the sweep
  // looks like it honoured the flag while measuring something else.
  uint64_t valueU();

  [[nodiscard]] const std::string &error() const { return error_; }

private:
  int argc_;
  char **argv_;
  int index_ = 1;
  std::string_view flag_;
  std::string error_;
};

// Fills opt from argv. Returns true when every argument was understood; on
// failure the reason has already been written to stderr.
bool parseBenchOptions(int argc, char **argv, BenchOptions &opt);
