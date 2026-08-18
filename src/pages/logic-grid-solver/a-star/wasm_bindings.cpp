#ifdef __EMSCRIPTEN__

#include "MemoryProbe.h"
#include "Puzzle.h"
#include "Rules.h"
#include "Search.h"
#include "SolverArms.h"
#include "SolverClock.h"
#include "Types.h"
#include "Verify.h"

#include <cstdint>
#include <emscripten/bind.h>
#include <emscripten/val.h>
#include <string>
#include <utility>
#include <vector>

// The page's side of the solver.
//
// Errors come back IN BAND on the result object: the build is exception-free,
// and a throw would surface to the page as an aborted module rather than as a
// message it can show.
//
// Two layout notes, both of which the bridge mirrors. `cells` crosses as a
// FLAT row-major array of gridWidth * gridHeight entries — the editor stores
// the grid column-major, and `flatten` in wasmBridge.ts transposes it. Clues
// cross as {x, y, type, value} with a letter already reduced to 0..25, because
// nothing in the search ever wants the glyph.
namespace {

using emscripten::val;
using namespace lg;

template <typename T> T opt(const val &object, const char *key, const T def) {
  const val held = object[key];
  return held.isUndefined() || held.isNull() ? def : held.as<T>();
}

val errorResult(const char *message) {
  val result = val::object();
  result.set("cells", val::array());
  result.set("error", val(std::string(message)));
  return result;
}

bool readCells(const val &puzzleVal, Puzzle &puzzle, const char *&error) {
  const val cells = puzzleVal["cells"];
  const int count = cells["length"].as<int>();
  if (count != puzzle.width * puzzle.height) {
    error = "cells must hold gridWidth * gridHeight entries";
    return false;
  }
  puzzle.givens.fill(kUnplayable);
  for (int i = 0; i < count; i++) {
    const int value = cells[i].as<int>();
    if (value < 0 || value >= kColorLimit) {
      error = "A cell value is outside the known colors";
      return false;
    }
    const int x = i % puzzle.width;
    const int y = i / puzzle.width;
    puzzle.givens[slot(cellIndex(x, y))] = static_cast<uint8_t>(value);
  }
  return true;
}

bool readRules(const val &puzzleVal, Puzzle &puzzle, const char *&error) {
  const val list = puzzleVal["rules"];
  if (list.isUndefined() || list.isNull())
    return true;
  const int count = list["length"].as<int>();
  for (int i = 0; i < count; i++) {
    const int index = list[i].as<int>();
    if (index < 0 || index >= rules::kRuleCount) {
      error = "A rule index is not one this solver knows";
      return false;
    }
    // Since format version 2 the sized indices are not legal here — their
    // families arrive as `areas`/`runs` instances, and a bit the engine no
    // longer reads must be refused rather than carried inert.
    if (rules::has(rules::kSizedRuleBits, static_cast<rules::Rule>(index))) {
      error = "A rule index names a sized rule; sized rules arrive as areas "
              "or runs";
      return false;
    }
    // And since version 3 the ten retired arrangements are not legal here
    // either — they arrive as shapes under `patterns`, for the same reason.
    if (rules::has(rules::kDrawnRuleBits, static_cast<rules::Rule>(index))) {
      error = "A rule index names a retired rule; those arrive as patterns";
      return false;
    }
    puzzle.ruleMask |= rules::RuleMask{1} << index;
  }
  return true;
}

/**
 * One sized family list, `areas` or `runs`. Absent means empty — the writers
 * omit an empty list — and what arrives must already be CANONICAL: dark
 * before light, values ascending, no duplicates. The page's validator sorts
 * on output and `fixtureio::save` writes sorted, so a disordered list here is
 * a hand-built payload, refused rather than repaired — the deliberate
 * asymmetry with the TS validator, which accepts any order.
 */
struct SizedFamily {
  const char *key = "";
  const char *valueKey = "";
  int lo = 0;
  int hi = 0;
  const char *rangeError = "";
  /// Whether a SECOND entry for one color is a contradiction. Two run bans
  /// are conjunctive and merely redundant; two area sizes hold together only
  /// where the color is absent from the board, all zero of its regions being
  /// both sizes at once, which is not a puzzle anyone means. Grouped into a
  /// struct rather than a seventh and eighth parameter: six same-typed
  /// scalars in a row is already a call nobody can read, and clang-tidy says
  /// so.
  bool onePerColor = false;
};

bool readSized(const val &puzzleVal, const SizedFamily &family,
               std::vector<rules::SizedRule> &into, const char *&error) {
  const val list = puzzleVal[family.key];
  if (list.isUndefined() || list.isNull())
    return true;
  const int count = list["length"].as<int>();
  for (int i = 0; i < count; i++) {
    const val entry = list[i];
    // `isString` doubles as the type check — there is no typeOf probing to
    // fall back on under -fno-exceptions, and any non-string is equally not
    // a color.
    const val colorVal = entry["color"];
    const std::string color =
        colorVal.isString() ? colorVal.as<std::string>() : std::string();
    if (color != "dark" && color != "light") {
      error = "A sized rule's color must be dark or light";
      return false;
    }
    // Read as a double so 2.5 is refused rather than silently truncated —
    // and bounded BEFORE narrowing, spelled so NaN fails too: casting an
    // out-of-range (or NaN) double to int is undefined behavior, so the
    // gate has to run first. In range the cast is exact, so the integrality
    // test below still catches fractions.
    const double raw = opt(entry, family.valueKey, 0.0);
    if (!(raw >= family.lo && raw <= family.hi)) {
      error = family.rangeError;
      return false;
    }
    const int value = static_cast<int>(raw);
    if (raw != static_cast<double>(value)) {
      error = family.rangeError;
      return false;
    }
    const rules::SizedRule rule{.color = color == "dark" ? kDark : kLight,
                                .value = value};
    if (!into.empty()) {
      if (into.back() == rule) {
        error = "A sized rule is listed twice";
        return false;
      }
      if (!rules::sizedLess(into.back(), rule)) {
        error = "Sized rules must be listed dark before light, then ascending";
        return false;
      }
      // Sound only because the order above is already known to be canonical:
      // every entry of one color is contiguous, so "the previous entry is
      // this color" IS "a second entry for this color".
      if (family.onePerColor && into.back().color == rule.color) {
        error = "Only one area rule per color is allowed";
        return false;
      }
    }
    into.push_back(rule);
  }
  return true;
}

constexpr SizedFamily kAreaFamily{
    .key = "areas",
    .valueKey = "size",
    .lo = rules::kMinAreaSize,
    .hi = rules::kMaxAreaSize,
    .rangeError = "An area size must be between 1 and 9999",
    .onePerColor = true};

constexpr SizedFamily kRunFamily{
    .key = "runs",
    .valueKey = "length",
    .lo = rules::kMinRunLength,
    .hi = rules::kMaxRunLength,
    .rangeError = "A run length must be between 2 and 8"};

bool readSizedLists(const val &puzzleVal, Puzzle &puzzle, const char *&error) {
  return readSized(puzzleVal, kAreaFamily, puzzle.areas, error) &&
         readSized(puzzleVal, kRunFamily, puzzle.runs, error);
}

/**
 * The `patterns` list: the forbidden arrangements the player drew, each a box
 * of `width` by `height` squares row-major holding 0 for a square the pattern
 * does not name and 1 or 2 for one it does.
 *
 * Absent means empty, and what arrives must already be CANONICAL — ascending
 * under `rules::patternLess`, which compares each pattern's smallest dihedral
 * image, so two drawings of one rule in different rotations collide as a
 * duplicate rather than both being carried. Refused rather than repaired, the
 * `readSized` asymmetry with the page's validator.
 */
bool readPatterns(const val &puzzleVal, Puzzle &puzzle, const char *&error) {
  const val list = puzzleVal["patterns"];
  if (list.isUndefined() || list.isNull())
    return true;
  const int count = list["length"].as<int>();
  for (int i = 0; i < count; i++) {
    const val entry = list[i];
    rules::DrawnPattern pattern;
    // Read as doubles and bounded BEFORE narrowing, spelled so NaN fails too,
    // for the reason `readSized` spells out at length.
    const double wide = opt(entry, "width", 0.0);
    const double tall = opt(entry, "height", 0.0);
    if (!(wide >= 1 && wide <= kMaxSide) || !(tall >= 1 && tall <= kMaxSide)) {
      error = "A pattern must be between 1 and 32 on each side";
      return false;
    }
    pattern.width = static_cast<int>(wide);
    pattern.height = static_cast<int>(tall);
    if (wide != static_cast<double>(pattern.width) ||
        tall != static_cast<double>(pattern.height)) {
      error = "A pattern must be between 1 and 32 on each side";
      return false;
    }
    const val squares = entry["cells"];
    const int held = squares.isUndefined() || squares.isNull()
                         ? 0
                         : squares["length"].as<int>();
    if (held != pattern.width * pattern.height) {
      error = "A pattern's cells must fill its box";
      return false;
    }
    for (int at = 0; at < held; at++) {
      const int square = squares[at].as<int>();
      // kUnplayable is not a color a pattern can ask for: a pattern names
      // squares that must hold a COLOR, and says nothing about the rest.
      if (square != kUnknown && square != kDark && square != kLight) {
        error = "A pattern square must be 0, 1 or 2";
        return false;
      }
      pattern.cells.push_back(static_cast<uint8_t>(square));
    }
    if (!rules::namesASquare(pattern)) {
      error = "A pattern must name at least one square";
      return false;
    }
    if (!rules::isTightBox(pattern)) {
      error = "A pattern's box must be trimmed to the squares it names";
      return false;
    }
    if (!puzzle.patterns.empty()) {
      if (rules::canonicalImage(puzzle.patterns.back()) ==
          rules::canonicalImage(pattern)) {
        error = "A pattern is listed twice";
        return false;
      }
      if (!rules::patternLess(puzzle.patterns.back(), pattern)) {
        error = "Patterns must be listed in canonical order";
        return false;
      }
    }
    puzzle.patterns.push_back(std::move(pattern));
  }
  return true;
}

bool readClues(const val &puzzleVal, Puzzle &puzzle, const char *&error) {
  const val list = puzzleVal["clues"];
  if (list.isUndefined() || list.isNull())
    return true;
  const int count = list["length"].as<int>();
  for (int i = 0; i < count; i++) {
    const val entry = list[i];
    const int x = entry["x"].as<int>();
    const int y = entry["y"].as<int>();
    const int kind = entry["type"].as<int>();
    if (x < 0 || x >= puzzle.width || y < 0 || y >= puzzle.height) {
      error = "A clue sits outside the board";
      return false;
    }
    if (kind < 0 || kind >= kClueKindCount) {
      error = "A clue names an unknown kind";
      return false;
    }
    // Read unconditionally. The bridge sends -1 for a clue that carries none,
    // so a DIRECTED kind arriving without one is refused by name in
    // `clueValueProblem` rather than silently pointing up. `value` defaults
    // instead — a lotus sends none at all and requires 0 — and `seat` defaults
    // to the square's own center, refused by name on any other kind.
    const val direction = entry["direction"];
    puzzle.clues.push_back(
        {.index = cellIndex(x, y),
         .kind = static_cast<uint8_t>(kind),
         .value = opt(entry, "value", 0),
         .direction = direction.isUndefined() || direction.isNull()
                          ? -1
                          : direction.as<int>(),
         .seat = opt(entry, "seat", 0)});
  }
  return true;
}

/**
 * The merged cells, as FLAT `y * gridWidth + x` indices — the same row-major
 * layout `cells` crosses in, and the same the config file stores.
 *
 * Only the range is checked here; that a shape is connected, does not overlap
 * another, holds at least two squares and agrees with itself about its color
 * and its clue is `structureProblem`'s job, so the fixture path gets the same
 * answers as this one.
 */
bool readShapes(const val &puzzleVal, Puzzle &puzzle, const char *&error) {
  const val list = puzzleVal["shapes"];
  if (list.isUndefined() || list.isNull())
    return true;
  const int count = list["length"].as<int>();
  for (int i = 0; i < count; i++) {
    const val entry = list[i];
    const int members = entry["length"].as<int>();
    std::vector<int> shape;
    shape.reserve(slot(members));
    for (int m = 0; m < members; m++) {
      const int flat = entry[m].as<int>();
      if (flat < 0 || flat >= puzzle.width * puzzle.height) {
        error = "A merged cell claims a square outside the board";
        return false;
      }
      shape.push_back(cellIndex(flat % puzzle.width, flat / puzzle.width));
    }
    puzzle.shapes.push_back(std::move(shape));
  }
  return true;
}

Puzzle puzzleFromVal(const val &puzzleVal, const char *&error) {
  Puzzle puzzle;
  puzzle.width = opt(puzzleVal, "gridWidth", 0);
  puzzle.height = opt(puzzleVal, "gridHeight", 0);
  if (puzzle.width < 1 || puzzle.width > kMaxSide || puzzle.height < 1 ||
      puzzle.height > kMaxSide) {
    error = "Grid must be between 1 and 32 on each side";
    return puzzle;
  }
  if (!readCells(puzzleVal, puzzle, error) ||
      !readRules(puzzleVal, puzzle, error) ||
      !readSizedLists(puzzleVal, puzzle, error) ||
      !readPatterns(puzzleVal, puzzle, error) ||
      !readClues(puzzleVal, puzzle, error) ||
      !readShapes(puzzleVal, puzzle, error))
    return puzzle;
  if (const Problem problem = structureProblem(puzzle);
      problem != Problem::None)
    error = describe(problem);
  return puzzle;
}

/// A coloring back in the flat row-major layout the page reads.
val cellsToVal(const Model &model, const Colors &colors) {
  val out = val::array();
  int at = 0;
  for (int y = 0; y < model.height(); y++) {
    for (int x = 0; x < model.width(); x++) {
      out.set(at, colors[slot(cellIndex(x, y))]);
      at++;
    }
  }
  return out;
}

const char *statusName(const Status status) {
  using enum Status;
  switch (status) {
  case Solved:
    return "solved";
  case Deduced:
    return "deduced";
  case Unsolvable:
    return "unsolvable";
  case Unsolved:
    return "unsolved";
  }
  return "unsolved";
}

struct Spec {
  std::string engine;
  uint32_t maxMs;
  uint64_t maxNodes;
  uint64_t maxHeapBytes;
  uint32_t seed;
  int witnessLimit;
};

Spec specFrom(const val &config) {
  return {.engine = opt(config, "engine", std::string("cascade")),
          .maxMs = static_cast<uint32_t>(
              opt(config, "maxMs", static_cast<double>(60000))),
          .maxNodes = static_cast<uint64_t>(
              opt(config, "maxNodes", static_cast<double>(0))),
          .maxHeapBytes = static_cast<uint64_t>(
              opt(config, "maxHeapBytes", static_cast<double>(0))),
          .seed = static_cast<uint32_t>(opt(config, "seed", 0)),
          .witnessLimit = opt(config, "witnessLimit", 8)};
}

void post(const val &message) {
  val self = val::global("self");
  self.call<void>("postMessage", message);
}

/// Streams progress out of the search. The module IS the worker, so this posts
/// on its own scope and needs no relay.
void report(const Progress &progress) {
  val message = val::object();
  message.set("type", val("progress"));
  message.set("nodes", static_cast<double>(progress.nodes));
  message.set("decided", progress.decided);
  message.set("phase", val(std::string(progress.phase)));
  post(message);
}

val statsToVal(const Outcome &outcome, const uint64_t wallMs) {
  val stats = val::object();
  stats.set("nodes", static_cast<double>(outcome.stats.nodesExpanded));
  stats.set("refutations", static_cast<double>(outcome.stats.refutations));
  stats.set("oracleRejections",
            static_cast<double>(outcome.stats.oracleRejections));
  stats.set("stoppedOnMemory", outcome.stats.stoppedOnMemory);
  stats.set("wallMs", static_cast<double>(wallMs));
  stats.set("arm", val(outcome.arm));
  return stats;
}

Outcome dispatch(const Model &model, const Spec &spec, const Config &cfg) {
#ifdef __EMSCRIPTEN_PTHREADS__
  if (spec.engine == "cascade")
    return arms::solveParallel(model, cfg);
#endif
  const arms::ArmSpec armSpec{.engine = spec.engine.c_str(),
                              .seed = spec.seed};
  return arms::solve(model, armSpec, cfg);
}

} // namespace

val solve(const val puzzleVal, const val configVal) {
  const char *error = nullptr;
  const Puzzle puzzle = puzzleFromVal(puzzleVal, error);
  if (error != nullptr)
    return errorResult(error);

  const Spec spec = specFrom(configVal);
  if (!arms::isEngine(spec.engine.c_str()))
    return errorResult("Unknown engine");

  const Model model = buildModel(puzzle);
  if (const Problem problem = contradiction(model); problem != Problem::None) {
    val result = val::object();
    result.set("status", val(std::string("unsolvable")));
    result.set("reason", val(std::string(describe(problem))));
    result.set("cells", val::array());
    result.set("proven", true);
    result.set("decided", 0);
    result.set("playable", model.playableCount);
    result.set("witnesses", val::array());
    result.set("stats", val::object());
    return result;
  }

  Callbacks callbacks;
  callbacks.onProgress = [](const Progress &progress) { report(progress); };

  Config cfg;
  cfg.maxMs = spec.maxMs;
  cfg.maxNodes = spec.maxNodes;
  cfg.seed = spec.seed;
  cfg.witnessLimit = spec.witnessLimit;
  cfg.callbacks = &callbacks;
  // Nearly the whole heap, but NEVER unlimited: a wasm heap that cannot grow
  // aborts the module rather than failing an allocation.
  cfg.maxHeapBytes = spec.maxHeapBytes != 0
                         ? spec.maxHeapBytes
                         : memprobe::heapCeilingBytes() / 100 * 90;

  const uint64_t startMs = nowMs();
  const Outcome outcome = dispatch(model, spec, cfg);
  const uint64_t wallMs = nowMs() - startMs;

  val witnesses = val::array();
  int at = 0;
  for (const Colors &witness : outcome.witnesses) {
    witnesses.set(at, cellsToVal(model, witness));
    at++;
  }

  val result = val::object();
  result.set("status", val(std::string(statusName(outcome.status))));
  result.set("cells", cellsToVal(model, outcome.colors));
  result.set("proven", outcome.proven);
  result.set("decided", outcome.decided);
  result.set("playable", model.playableCount);
  result.set("witnesses", witnesses);
  result.set("stats", statsToVal(outcome, wallMs));
  return result;
}

/// The oracle, exported so a test can check an answer without trusting the
/// same code path that produced it.
bool verifyColors(const val puzzleVal, const val colorsVal) {
  const char *error = nullptr;
  const Puzzle puzzle = puzzleFromVal(puzzleVal, error);
  if (error != nullptr)
    return false;
  const Model model = buildModel(puzzle);

  Colors colors{};
  colors.fill(kUnplayable);
  const int count = colorsVal["length"].as<int>();
  if (count != model.width() * model.height())
    return false;
  for (int i = 0; i < count; i++) {
    const int value = colorsVal[i].as<int>();
    if (value < 0 || value >= kColorLimit)
      return false;
    const int x = i % model.width();
    const int y = i / model.width();
    colors[slot(cellIndex(x, y))] = static_cast<uint8_t>(value);
  }
  return verify::check(model, colors) == verify::Violation::None;
}

EMSCRIPTEN_BINDINGS(logic_grid_module) {
  emscripten::function("solve", &solve);
  emscripten::function("verify", &verifyColors);
}

#endif // __EMSCRIPTEN__
