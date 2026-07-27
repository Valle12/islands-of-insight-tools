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
    {"--fixture", [](BenchOptions &o, ArgCursor &c) { o.fixturePath = c.value(); }},
    {"--engine", [](BenchOptions &o, ArgCursor &c) { o.engine = c.value(); }},
    {"--weight",
     [](BenchOptions &o, ArgCursor &c) {
       o.cfg.weight = static_cast<uint8_t>(c.valueU());
     }},
    {"--budget-ms",
     [](BenchOptions &o, ArgCursor &c) {
       o.budgetMs = static_cast<uint32_t>(c.valueU());
     }},
    {"--max-nodes",
     [](BenchOptions &o, ArgCursor &c) {
       o.maxNodes = static_cast<uint32_t>(c.valueU());
     }},
    {"--stride",
     [](BenchOptions &o, ArgCursor &c) {
       o.cfg.strideOverride = static_cast<uint8_t>(c.valueU());
     }},
    {"--settled", [](BenchOptions &o, ArgCursor &) { o.settledOnly = true; }},
    {"--pea",
     [](BenchOptions &o, ArgCursor &c) {
       o.pea = static_cast<uint16_t>(c.valueU());
     }},
    {"--packing-weight",
     [](BenchOptions &o, ArgCursor &c) {
       o.packingWeight = static_cast<uint8_t>(c.valueU());
     }},
    {"--consolidation",
     [](BenchOptions &o, ArgCursor &c) {
       o.consolidationGain = static_cast<uint8_t>(c.valueU());
     }},
    {"--slot-h", [](BenchOptions &o, ArgCursor &) { o.slotHeuristic = true; }},
    {"--dump", [](BenchOptions &o, ArgCursor &c) { o.dumpPath = c.value(); }},
    {"--all-slots",
     [](BenchOptions &o, ArgCursor &) { o.requireAllSlots = true; }},
    {"--ratchet", [](BenchOptions &o, ArgCursor &) { o.lockOnSlot = true; }},
    {"--por", [](BenchOptions &o, ArgCursor &) { o.sleepSets = true; }},
    {"--relevant", [](BenchOptions &o, ArgCursor &) { o.relevantOnly = true; }},
    {"--bands", [](BenchOptions &o, ArgCursor &) { o.bands = true; }},
    {"--band-min-path",
     [](BenchOptions &o, ArgCursor &c) {
       o.bandMinPath = static_cast<uint8_t>(c.valueU());
     }},
    {"--max-states",
     [](BenchOptions &o, ArgCursor &c) {
       o.maxStates = c.valueU();
       o.cfg.maxStatesStored = o.maxStates;
     }},
    {"--arm",
     [](BenchOptions &o, ArgCursor &c) {
       o.armIndex = static_cast<int>(c.valueU());
     }},
    {"--arm-gated", [](BenchOptions &o, ArgCursor &) { o.armGated = true; }},
    {"--jam-density",
     [](BenchOptions &o, ArgCursor &c) {
       o.jamDensityPct = static_cast<uint8_t>(c.valueU());
     }},
    {"--jam-aspect",
     [](BenchOptions &o, ArgCursor &c) {
       o.jamAspect16 = static_cast<uint8_t>(c.valueU());
     }},
    {"--seq-total-ms",
     [](BenchOptions &o, ArgCursor &c) {
       o.seqTotalMs = static_cast<uint32_t>(c.valueU());
     }},
    {"--max-heap-bytes",
     [](BenchOptions &o, ArgCursor &c) {
       o.maxHeapBytes = c.valueU();
       o.cfg.maxHeapBytes = o.maxHeapBytes;
     }},
    {"--dump-elite",
     [](BenchOptions &o, ArgCursor &c) { o.dumpElitePath = c.value(); }},
    {"--dump-elite-turns",
     [](BenchOptions &o, ArgCursor &c) { o.dumpEliteTurnsPath = c.value(); }},
    {"--verify", [](BenchOptions &o, ArgCursor &c) { o.verifyPath = c.value(); }},
    {"--jam-penalty",
     [](BenchOptions &o, ArgCursor &c) {
       o.jamPenalty = static_cast<uint8_t>(c.valueU());
     }},
    {"--jam-guide",
     [](BenchOptions &o, ArgCursor &c) {
       o.jamGuide = static_cast<uint8_t>(c.valueU());
     }},
    {"--jam-pin", [](BenchOptions &o, ArgCursor &) { o.jamPin = true; }},
    {"--jam-round-cap",
     [](BenchOptions &o, ArgCursor &c) {
       o.jamRoundCap = static_cast<uint32_t>(c.valueU());
     }},
    {"--jam-elites",
     [](BenchOptions &o, ArgCursor &c) {
       o.jamElites = static_cast<uint32_t>(c.valueU());
     }},
    {"--jam-luby", [](BenchOptions &o, ArgCursor &) { o.jamLuby = true; }},
    {"--tie-seed",
     [](BenchOptions &o, ArgCursor &c) {
       o.tieSeed = static_cast<uint32_t>(c.valueU());
     }},
    {"--beam",
     [](BenchOptions &o, ArgCursor &c) {
       o.beamWidth = static_cast<uint32_t>(c.valueU());
     }},
    {"--generate",
     [](BenchOptions &o, ArgCursor &c) { o.generatePath = c.value(); }},
    {"--seed",
     [](BenchOptions &o, ArgCursor &c) {
       o.seed = static_cast<uint32_t>(c.valueU());
     }},
    {"--shuffle",
     [](BenchOptions &o, ArgCursor &c) {
       o.shuffleMoves = static_cast<uint32_t>(c.valueU());
     }},
    {"--no-post",
     [](BenchOptions &o, ArgCursor &) { o.cfg.postProcess = false; }},
    {"--json", [](BenchOptions &o, ArgCursor &) { o.emitJson = true; }},
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
