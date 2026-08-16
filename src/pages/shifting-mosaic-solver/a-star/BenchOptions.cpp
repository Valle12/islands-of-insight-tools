#include "BenchOptions.h"

#include <algorithm>
#include <array>
#include <cerrno>
#include <cstdlib>
#include <iostream>
#include <string_view>

std::string_view ArgCursor::takeFlag() {
  flag_ = argv_[index_];
  index_++;
  return flag_;
}

const char *ArgCursor::value() {
  if (index_ >= argc_) {
    error_ = "Missing value for ";
    error_ += flag_;
    return "";
  }
  const char *const raw = argv_[index_];
  index_++;
  return raw;
}

uint64_t ArgCursor::valueU() {
  const char *const raw = value();
  if (!error_.empty())
    return 0;
  char *end = nullptr;
  errno = 0;
  const unsigned long long parsed = std::strtoull(raw, &end, 10);
  // strtoull happily wraps a leading '-' into a huge value, so reject the sign
  // explicitly rather than letting "-1" mean 18446744073709551615.
  if (end == raw || *end != '\0' || errno == ERANGE || raw[0] == '-') {
    error_ = "Invalid number for ";
    error_ += flag_;
    error_ += ": ";
    error_ += raw;
    return 0;
  }
  return parsed;
}

namespace {

// One option: its spelling and what it does to the parsed result. A table
// rather than an else-if chain, because 40-odd chained branches are 40-odd
// branches whichever function they sit in — as data they cost nothing to read
// and the parse loop below stays trivial.
struct FlagSpec {
  std::string_view name;
  void (*apply)(BenchOptions &opt, ArgCursor &cur);
};

constexpr std::array<FlagSpec, 41> FLAGS{{
    {.name = "--fixture",
     .apply = [](BenchOptions &o, ArgCursor &c) { o.paths.fixture = c.value(); }},
    {.name = "--engine",
     .apply = [](BenchOptions &o, ArgCursor &c) { o.engine = c.value(); }},
    {.name = "--weight",
     .apply =
         [](BenchOptions &o, ArgCursor &c) {
           o.cfg.weight = static_cast<uint8_t>(c.valueU());
         }},
    {.name = "--budget-ms",
     .apply =
         [](BenchOptions &o, ArgCursor &c) {
           o.limits.budgetMs = static_cast<uint32_t>(c.valueU());
         }},
    {.name = "--max-nodes",
     .apply =
         [](BenchOptions &o, ArgCursor &c) {
           o.limits.maxNodes = static_cast<uint32_t>(c.valueU());
         }},
    {.name = "--stride",
     .apply =
         [](BenchOptions &o, ArgCursor &c) {
           o.cfg.strideOverride = static_cast<uint8_t>(c.valueU());
         }},
    {.name = "--settled",
     .apply = [](BenchOptions &o, ArgCursor &) { o.drag.settledOnly = true; }},
    {.name = "--pea",
     .apply = [](BenchOptions &o,
                 ArgCursor &c) { o.drag.pea = static_cast<uint16_t>(c.valueU()); }},
    {.name = "--packing-weight",
     .apply =
         [](BenchOptions &o, ArgCursor &c) {
           o.drag.packingWeight = static_cast<uint8_t>(c.valueU());
         }},
    {.name = "--consolidation",
     .apply =
         [](BenchOptions &o, ArgCursor &c) {
           o.drag.consolidationGain = static_cast<uint8_t>(c.valueU());
         }},
    {.name = "--slot-h",
     .apply = [](BenchOptions &o, ArgCursor &) { o.drag.slotHeuristic = true; }},
    {.name = "--dump",
     .apply = [](BenchOptions &o, ArgCursor &c) { o.paths.dump = c.value(); }},
    {.name = "--all-slots",
     .apply = [](BenchOptions &o, ArgCursor &) { o.drag.requireAllSlots = true; }},
    {.name = "--ratchet",
     .apply = [](BenchOptions &o, ArgCursor &) { o.drag.lockOnSlot = true; }},
    {.name = "--por",
     .apply = [](BenchOptions &o, ArgCursor &) { o.drag.sleepSets = true; }},
    {.name = "--relevant",
     .apply = [](BenchOptions &o, ArgCursor &) { o.drag.relevantOnly = true; }},
    {.name = "--bands",
     .apply = [](BenchOptions &o, ArgCursor &) { o.drag.bands = true; }},
    {.name = "--band-min-path",
     .apply =
         [](BenchOptions &o, ArgCursor &c) {
           o.drag.bandMinPath = static_cast<uint8_t>(c.valueU());
         }},
    {.name = "--max-states",
     .apply =
         [](BenchOptions &o, ArgCursor &c) {
           o.limits.maxStates = c.valueU();
           o.cfg.maxStatesStored = o.limits.maxStates;
         }},
    {.name = "--arm",
     .apply = [](BenchOptions &o,
                 ArgCursor &c) { o.armIndex = static_cast<int>(c.valueU()); }},
    {.name = "--arm-gated",
     .apply = [](BenchOptions &o, ArgCursor &) { o.armGated = true; }},
    {.name = "--jam-density",
     .apply =
         [](BenchOptions &o, ArgCursor &c) {
           o.jam.densityPct = static_cast<uint8_t>(c.valueU());
         }},
    {.name = "--jam-aspect",
     .apply =
         [](BenchOptions &o, ArgCursor &c) {
           o.jam.aspect16 = static_cast<uint8_t>(c.valueU());
         }},
    {.name = "--seq-total-ms",
     .apply =
         [](BenchOptions &o, ArgCursor &c) {
           o.limits.seqTotalMs = static_cast<uint32_t>(c.valueU());
         }},
    {.name = "--max-heap-bytes",
     .apply =
         [](BenchOptions &o, ArgCursor &c) {
           o.limits.maxHeapBytes = c.valueU();
           o.cfg.maxHeapBytes = o.limits.maxHeapBytes;
         }},
    {.name = "--dump-elite",
     .apply = [](BenchOptions &o,
                 ArgCursor &c) { o.paths.dumpElite = c.value(); }},
    {.name = "--dump-elite-turns",
     .apply = [](BenchOptions &o,
                 ArgCursor &c) { o.paths.dumpEliteTurns = c.value(); }},
    {.name = "--verify",
     .apply = [](BenchOptions &o, ArgCursor &c) { o.paths.verify = c.value(); }},
    {.name = "--jam-penalty",
     .apply =
         [](BenchOptions &o, ArgCursor &c) {
           o.jam.penalty = static_cast<uint8_t>(c.valueU());
         }},
    {.name = "--jam-guide",
     .apply =
         [](BenchOptions &o, ArgCursor &c) {
           o.jam.guide = static_cast<uint8_t>(c.valueU());
         }},
    {.name = "--jam-pin",
     .apply = [](BenchOptions &o, ArgCursor &) { o.jam.pin = true; }},
    {.name = "--jam-round-cap",
     .apply =
         [](BenchOptions &o, ArgCursor &c) {
           o.jam.roundCap = static_cast<uint32_t>(c.valueU());
         }},
    {.name = "--jam-elites",
     .apply =
         [](BenchOptions &o, ArgCursor &c) {
           o.jam.elites = static_cast<uint32_t>(c.valueU());
         }},
    {.name = "--jam-luby",
     .apply = [](BenchOptions &o, ArgCursor &) { o.jam.luby = true; }},
    {.name = "--tie-seed",
     .apply =
         [](BenchOptions &o, ArgCursor &c) {
           o.tieSeed = static_cast<uint32_t>(c.valueU());
         }},
    {.name = "--beam",
     .apply =
         [](BenchOptions &o, ArgCursor &c) {
           o.beamWidth = static_cast<uint32_t>(c.valueU());
         }},
    {.name = "--generate",
     .apply = [](BenchOptions &o,
                 ArgCursor &c) { o.paths.generate = c.value(); }},
    {.name = "--seed",
     .apply = [](BenchOptions &o,
                 ArgCursor &c) { o.generate.seed = static_cast<uint32_t>(c.valueU()); }},
    {.name = "--shuffle",
     .apply =
         [](BenchOptions &o, ArgCursor &c) {
           o.generate.shuffleMoves = static_cast<uint32_t>(c.valueU());
         }},
    {.name = "--no-post",
     .apply = [](BenchOptions &o, ArgCursor &) { o.cfg.postProcess = false; }},
    {.name = "--json",
     .apply = [](BenchOptions &o, ArgCursor &) { o.emitJson = true; }},
}};

} // namespace

bool parseBenchOptions(const int argc, char **const argv, BenchOptions &opt) {
  ArgCursor cur(argc, argv);
  while (cur.hasMore()) {
    const std::string_view arg = cur.takeFlag();
    const auto spec = std::ranges::find_if(
        FLAGS, [arg](const FlagSpec &f) { return f.name == arg; });
    if (spec == FLAGS.end()) {
      std::cerr << "Unknown argument: " << arg << "\n";
      return false;
    }
    spec->apply(opt, cur);
  }
  if (!cur.error().empty()) {
    std::cerr << cur.error() << "\n";
    return false;
  }
  return true;
}
