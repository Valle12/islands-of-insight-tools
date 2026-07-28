#ifdef __EMSCRIPTEN__

#include "AStar.h"
#include "DragSolver.h"
#ifdef __EMSCRIPTEN_PTHREADS__
#include "MemoryProbe.h"
#include "ParallelCascade.h"
#endif

#include <emscripten/bind.h>
#include <emscripten/val.h>

#include <string>

using namespace emscripten;

namespace {

std::vector<std::vector<Position>> parseShapes(val shapesJs) {
  const auto numShapes = shapesJs["length"].as<unsigned>();
  std::vector<std::vector<Position>> shapes(numShapes);
  for (unsigned i = 0; i < numShapes; i++) {
    val shape = shapesJs[i];
    const auto numCells = shape["length"].as<unsigned>();
    shapes[i].reserve(numCells);
    for (unsigned j = 0; j < numCells; j++) {
      val cell = shape[j];
      shapes[i].push_back({static_cast<int8_t>(cell["x"].as<int>()),
                           static_cast<int8_t>(cell["y"].as<int>())});
    }
  }
  return shapes;
}

std::vector<Position> parseAnchors(val anchorsJs) {
  const auto n = anchorsJs["length"].as<unsigned>();
  std::vector<Position> anchors;
  anchors.reserve(n);
  for (unsigned i = 0; i < n; i++) {
    val a = anchorsJs[i];
    anchors.push_back({static_cast<int8_t>(a["x"].as<int>()),
                       static_cast<int8_t>(a["y"].as<int>())});
  }
  return anchors;
}

val turnsToJs(const std::vector<Turn> &turns) {
  val result = val::array();
  for (const auto &t : turns) {
    val turn = val::object();
    turn.set("blockId", static_cast<unsigned int>(t.blockId));
    turn.set("direction", static_cast<unsigned int>(t.direction));
    result.call<void>("push", turn);
  }
  return result;
}

template <typename T> T opt(const val &obj, const char *key, const T def) {
  const val v = obj[key];
  return v.isUndefined() || v.isNull() ? def : v.template as<T>();
}

void postProgress(const uint32_t nodesExpanded) {
  val self = val::global("self");
  val msg = val::object();
  msg.set("type", val("progress"));
  msg.set("progress", nodesExpanded);
  self.call<void>("postMessage", msg);
}

// Tells the page which solve phase is running. The sequential fallback is
// materially slower than the race (arms run in series rather than at once), so
// the UI has to say so rather than leaving the user on an unchanged spinner.
// The wasm module runs INSIDE the worker, so `self` is the worker scope and
// this reaches wasmBridge's onmessage directly — no relay in astar.worker.js.
// (Only the pthreads build has a sequential fallback to announce, so a
// single-threaded build never calls this.)
[[maybe_unused]] void postPhase(const char *phase, const char *arm = nullptr) {
  val self = val::global("self");
  val msg = val::object();
  msg.set("type", val("phase"));
  msg.set("phase", val(phase));
  if (arm != nullptr)
    msg.set("arm", val(arm));
  self.call<void>("postMessage", msg);
}

// What every arm below needs out of solve()'s scope, so the arms can be real
// functions. They used to be lambdas inside solve(), which reads the same but
// is measured as part of it — the whole point of extracting them is that each
// is now weighed on its own.
//
// configVal is held by reference and is deliberately mutable: the cascade sets
// per-arm overrides on it. It is solve()'s shallow COPY of the caller's config,
// never the caller's own object (see solve()).
struct SolveContext {
  val &configVal;
  const std::vector<std::vector<Position>> &shapes;
  const std::vector<Position> &initialAnchors;
  Position goalAnchor;
  uint8_t gridWidth;
  uint8_t gridHeight;
  uint8_t goalIndex;
  uint32_t maxMs;
  uint32_t maxNodes;
  bool postProcess;
  bool deadlockPruning;
};

// Which drag entry point an arm wants. Replaces a bool pair whose call sites
// read `runDrag(false, true)`, and lets the dispatch below be an if-chain
// rather than the nested conditional it was.
enum class DragMode : uint8_t { Flat, Hierarchical, Assembly };

std::vector<Turn> runDrag(const SolveContext &ctx, const DragMode mode) {
  const val &configVal = ctx.configVal;
  DragSolver::Config cfg;
  cfg.weight = static_cast<uint8_t>(opt<unsigned>(configVal, "dragWeight", 3));
  cfg.deadlockPruning = ctx.deadlockPruning;
  cfg.settledOnly = opt<bool>(configVal, "settledOnly", true);
  cfg.partialExpansionWidth =
      static_cast<uint16_t>(opt<unsigned>(configVal, "pea", 0));
  cfg.packingWeight =
      static_cast<uint8_t>(opt<unsigned>(configVal, "packingWeight", 0));
  cfg.consolidationGain =
      static_cast<uint8_t>(opt<unsigned>(configVal, "consolidationGain", 0));
  cfg.slotHeuristic = opt<bool>(configVal, "slotHeuristic", false);
  cfg.requireAllSlots = opt<bool>(configVal, "requireAllSlots", false);
  cfg.lockOnSlot = opt<bool>(configVal, "lockOnSlot", false);
  cfg.corridorBands = opt<bool>(configVal, "corridorBands", false);
  cfg.sleepSets = opt<bool>(configVal, "sleepSets", false);
  cfg.relevantOnly = opt<bool>(configVal, "relevantOnly", false);
  cfg.jamGuideWeight =
      static_cast<uint8_t>(opt<unsigned>(configVal, "jamGuideWeight", 0));
  cfg.jamBlockerPenalty =
      static_cast<uint8_t>(opt<unsigned>(configVal, "jamBlockerPenalty", 4));
  cfg.tieBreakSeed = opt<unsigned>(configVal, "tieBreakSeed", 0);
  cfg.beamWidth = opt<unsigned>(configVal, "beamWidth", 0);
  cfg.postProcess = ctx.postProcess;
  DragSolver solver(ctx.gridWidth, ctx.gridHeight, ctx.shapes,
                    ctx.initialAnchors, ctx.goalIndex, ctx.goalAnchor, cfg);
  solver.setOnProgress(postProgress);
  if (mode == DragMode::Assembly)
    return solver.searchAssembly(ctx.maxMs, ctx.maxNodes);
  if (mode == DragMode::Hierarchical)
    return solver.searchHierarchical(ctx.maxMs, ctx.maxNodes);
  return solver.search(ctx.maxMs, ctx.maxNodes);
}

// Jam arms: dig-cost-guided restarts / guided beam for compact dense
// 0-cut boards; both decline instantly outside the jam profile (the
// caller-facing "jam"/"beam" engines skip the gate — explicit choice).
std::vector<Turn> runJamArm(const SolveContext &ctx, const bool beam,
                            const bool gated) {
  const val &configVal = ctx.configVal;
  DragSolver::Config cfg;
  cfg.corridorBands = true;
  cfg.deadlockPruning = ctx.deadlockPruning;
  if (beam)
    cfg.jamGuideWeight =
        static_cast<uint8_t>(opt<unsigned>(configVal, "jamGuideWeight", 8));
  cfg.jamBlockerPenalty =
      static_cast<uint8_t>(opt<unsigned>(configVal, "jamBlockerPenalty", 4));
  cfg.tieBreakSeed = opt<unsigned>(configVal, "tieBreakSeed", 0);
  cfg.beamWidth = opt<unsigned>(configVal, "beamWidth", 0);
  if (!beam) {
    // Luby-shaped restart caps: the browser's ~300s/arm gives the stock
    // 1.5M-node cap only ~4 rounds, but the elite ratchet needs many. On
    // the hard-instance family at 300s these defaults (20k base / 64
    // elites) descend the ratchet -46% deeper than stock (HARD-BOARDS.md).
    // Overridable so the caller-facing "jam" engine can still sweep.
    cfg.jamRoundNodeCap = opt<unsigned>(configVal, "jamRoundNodeCap", 20000);
    cfg.jamMaxElites = opt<unsigned>(configVal, "jamMaxElites", 64);
    cfg.jamLubyRestarts = opt<bool>(configVal, "jamLubyRestarts", true);
  }
  cfg.postProcess = ctx.postProcess;
  DragSolver solver(ctx.gridWidth, ctx.gridHeight, ctx.shapes,
                    ctx.initialAnchors, ctx.goalIndex, ctx.goalAnchor, cfg);
  if (gated && !solver.jamProfile())
    return {};
  solver.setOnProgress(postProgress);
  if (beam)
    return solver.searchBeamJam(ctx.maxMs, ctx.maxNodes);
  return solver.searchJamRestarts(ctx.maxMs, ctx.maxNodes);
}

// Corridor arm: hier with synthetic distance bands (declines instantly
// when the goal has real cut bottlenecks).
std::vector<Turn> runCorridor(const SolveContext &ctx) {
  ctx.configVal.set("corridorBands", true);
  auto turns = runDrag(ctx, DragMode::Hierarchical);
  ctx.configVal.set("corridorBands", false);
  return turns;
}

std::vector<Turn> runUnit(const SolveContext &ctx) {
  const val &configVal = ctx.configVal;
  AStar::Config cfg;
  cfg.weight = static_cast<uint8_t>(opt<unsigned>(configVal, "weight", 3));
  cfg.deadlockPruning = ctx.deadlockPruning;
  cfg.pathBlockerWeight =
      static_cast<uint8_t>(opt<unsigned>(configVal, "pathBlockerWeight", 1));
  cfg.boundaryDistanceWeight =
      static_cast<uint8_t>(opt<unsigned>(configVal, "boundaryWeight", 1));
  cfg.axisAwareWeight =
      static_cast<uint8_t>(opt<unsigned>(configVal, "axisAwareWeight", 1));
  cfg.lpDisplacementWeight =
      static_cast<uint8_t>(opt<unsigned>(configVal, "lpDisplacementWeight", 1));
  cfg.strideOverride =
      static_cast<uint8_t>(opt<unsigned>(configVal, "strideOverride", 0));
  cfg.postProcess = ctx.postProcess;
  AStar solver(ctx.gridWidth, ctx.gridHeight, ctx.shapes, ctx.initialAnchors,
               ctx.goalIndex, ctx.goalAnchor, cfg);
  solver.setOnProgress(postProgress);
  return solver.search(ctx.maxMs, ctx.maxNodes);
}

#ifdef __EMSCRIPTEN_PTHREADS__
// Threaded build: race the arms on real pthreads. Only the calling thread
// touches JS — arm progress flows through atomics, forwarded here.
std::vector<Turn> runCascade(const SolveContext &ctx) {
  // All 8 arms share ONE heap here (8GB with memory64, else 4GB), so cap each
  // arm below the ceiling: exhausting a shared wasm heap ABORTS the module
  // rather than failing one arm. 85% leaves room for the overshoot between
  // checkpoints (measured ~8% with 8 arms allocating concurrently).
  const uint64_t heapMax = memprobe::heapCeilingBytes();
  const uint64_t armHeapCap = heapMax == 0 ? 0 : (heapMax / 100) * 85;
  std::vector<Turn> turns = solveArmsParallel(
      ctx.gridWidth, ctx.gridHeight, ctx.shapes, ctx.initialAnchors,
      ctx.goalIndex, ctx.goalAnchor, ctx.maxMs, ctx.maxNodes, ctx.postProcess,
      postProgress, armHeapCap);
  if (!turns.empty())
    return turns;
  // Phase 2: the same arms one at a time, each with the whole heap and
  // ungated. Measured to recover boards the race cannot: 42889 is starved
  // (arm 2 needs 6.24GB, the race never leaves that much free) and 41193
  // is gate-excluded (arm 6 solves it in 12ms but jamProfile() rejects
  // 37x9). Costs wall-clock, hence the phase notice.
  const uint32_t seqTotalMs = opt<unsigned>(
      ctx.configVal, "seqTotalMs", ctx.maxMs == 0 ? 0 : ctx.maxMs * 4);
  postPhase("sequential");
  // Nearly the whole heap, but NEVER unlimited. Arms run one at a time so
  // each gets far more than the race's 85% slice — that is the point of
  // the phase — yet a wasm heap that runs out does not fail the arm, it
  // ABORTS the module: the user sees "RuntimeError: Aborted()" and loses
  // the whole solve. Passing 0 here (as an earlier revision did) reasoned
  // correctly that the race's slice recreates starvation, but drew the
  // wrong conclusion: the fix is a bigger bound, not no bound.
  // 90% leaves headroom for the coarse checkpoint cadence and for the
  // allocations the module itself needs to report a result.
  const uint64_t seqHeapCap = heapMax == 0 ? 0 : (heapMax / 100) * 90;
  return solveArmsSequential(
      ctx.gridWidth, ctx.gridHeight, ctx.shapes, ctx.initialAnchors,
      ctx.goalIndex, ctx.goalAnchor, ctx.maxMs, seqTotalMs, ctx.maxNodes,
      ctx.postProcess, postProgress, seqHeapCap,
      /*cancel=*/nullptr, DragSolver::Config{}.jamAspect16,
      DragSolver::Config{}.jamDensityPct,
      /*outcomes=*/nullptr,
      [](const char *arm) { postPhase("sequential", arm); });
}
#else
// Single-threaded build: the arms in turn, cheapest-to-decline first.
std::vector<Turn> runCascade(const SolveContext &ctx) {
  // Pack-then-slide puzzles fall to the assembly pipeline in about a
  // second; it fails fast when no off-sweep packing exists.
  std::vector<Turn> turns = runDrag(ctx, DragMode::Assembly);
  // Corridor puzzles (no cut bottleneck, long goal journey) — declines
  // instantly otherwise. Partial expansion 48 is what the threaded cascade
  // (ParallelCascade.h arms 0/3), the CLI cascade and the worker portfolio
  // all give these two arms; without it this path searched them wider and
  // shallower than every other chain.
  ctx.configVal.set("pea", 48u);
  if (turns.empty())
    turns = runCorridor(ctx);
  if (turns.empty())
    turns = runDrag(ctx, DragMode::Hierarchical);
  if (turns.empty()) {
    // The deep-puzzle arm: same config that cracked shiftingMosaicTest37.
    ctx.configVal.set("dragWeight", 4u);
    ctx.configVal.set("pea", 64u);
    turns = runDrag(ctx, DragMode::Flat);
  }
  if (turns.empty()) {
    // Jam arm: relevance filter + commutativity pruning for compact dense
    // boards where the unrestricted searches drown.
    ctx.configVal.set("sleepSets", true);
    ctx.configVal.set("relevantOnly", true);
    turns = runDrag(ctx, DragMode::Flat);
    ctx.configVal.set("sleepSets", false);
    ctx.configVal.set("relevantOnly", false);
  }
  // Jam-restart and guided-beam arms: serial-unlock boards (jam-profile
  // gated, instant decline elsewhere).
  if (turns.empty())
    turns = runJamArm(ctx, false, true);
  if (turns.empty()) {
    // Wide beam + heavy dig penalty — the config that cracked seed 3870.
    // Safe here because this sequential path runs one arm at a time in the
    // whole heap; the threaded cascade shares one heap across 8 arms and so
    // deliberately keeps the auto (narrower) width instead.
    ctx.configVal.set("beamWidth", 500000u);
    ctx.configVal.set("jamBlockerPenalty", 8u);
    turns = runJamArm(ctx, true, true);
  }
  if (turns.empty())
    turns = runUnit(ctx);
  return turns;
}
#endif

} // namespace

// Object-config solver entry: `puzzle` = {gridWidth, gridHeight, shapes,
// initialAnchors, goalIndex, goalAnchor}; `config` = flat object where every
// field is optional and defaults are resolved HERE (so adding a knob never
// grows a positional argument list again). config.engine selects one arm —
// "unit" (production weighted A*), "drag" (flat drag-space A*), "hier"
// (receding-horizon drag search), "assembly" (pack-then-slide), "corridor"
// (hier + synthetic bands), "jam" (dig-cost-guided restarts), "beam" (guided
// beam) — or "cascade", which runs every arm in turn (worst case 8x maxMs;
// on a pthreads build it races them instead). See DragSolver.h for the
// drag-space background.
val solve(val puzzleVal, val configValIn) {
  // Work on a shallow COPY of the caller's config. The cascade chains below
  // hand per-arm overrides to the shared runDrag/runJamArm lambdas via
  // configVal.set(...), and several of them (pea, dragWeight, beamWidth,
  // jamBlockerPenalty) are never restored — mutating the caller's object would
  // leak one call's arm tuning into the next solve() on the same object.
  val configVal =
      val::global("Object").call<val>("assign", val::object(), configValIn);
  std::vector<std::vector<Position>> shapes = parseShapes(puzzleVal["shapes"]);
  std::vector<Position> initialAnchors =
      parseAnchors(puzzleVal["initialAnchors"]);
  const val goalAnchorJs = puzzleVal["goalAnchor"];
  const Position goalAnchor{static_cast<int8_t>(goalAnchorJs["x"].as<int>()),
                            static_cast<int8_t>(goalAnchorJs["y"].as<int>())};
  const auto gridWidth =
      static_cast<uint8_t>(puzzleVal["gridWidth"].as<unsigned>());
  const auto gridHeight =
      static_cast<uint8_t>(puzzleVal["gridHeight"].as<unsigned>());
  const auto goalIndex =
      static_cast<uint8_t>(puzzleVal["goalIndex"].as<unsigned>());

  const std::string engine = opt<std::string>(configVal, "engine", "cascade");
  const auto maxMs = opt<unsigned>(configVal, "maxMs", 60000);
  const auto maxNodes = opt<unsigned>(configVal, "maxNodes", 20000000);
  const bool postProcess = opt<bool>(configVal, "postProcess", true);
  const bool deadlockPruning = opt<bool>(configVal, "deadlockPruning", true);

  const SolveContext ctx{.configVal = configVal,
                         .shapes = shapes,
                         .initialAnchors = initialAnchors,
                         .goalAnchor = goalAnchor,
                         .gridWidth = gridWidth,
                         .gridHeight = gridHeight,
                         .goalIndex = goalIndex,
                         .maxMs = maxMs,
                         .maxNodes = maxNodes,
                         .postProcess = postProcess,
                         .deadlockPruning = deadlockPruning};

  std::vector<Turn> turns;
  if (engine == "drag")
    turns = runDrag(ctx, DragMode::Flat);
  else if (engine == "hier")
    turns = runDrag(ctx, DragMode::Hierarchical);
  else if (engine == "assembly")
    turns = runDrag(ctx, DragMode::Assembly);
  else if (engine == "corridor")
    turns = runCorridor(ctx);
  else if (engine == "jam")
    turns = runJamArm(ctx, false, opt<bool>(configVal, "gated", false));
  else if (engine == "beam")
    turns = runJamArm(ctx, true, opt<bool>(configVal, "gated", false));
  else if (engine == "unit")
    turns = runUnit(ctx);
  else // cascade: assembly -> corridor -> hier -> drag -> relevant ->
       // jam-restarts -> guided beam -> unit (raced on a pthreads build)
    turns = runCascade(ctx);
  return turnsToJs(turns);
}

// Standalone post-processor: takes a found solution and returns a shortened,
// still-valid one. Lets callers measure the raw search output (run search with
// postProcess=false) and the optimized output independently.
val optimize(unsigned int gridWidth, unsigned int gridHeight, val shapesJs,
             val initialAnchorsJs, unsigned int goalIndex, val goalAnchorJs,
             val turnsJs) {
  std::vector<std::vector<Position>> shapes = parseShapes(shapesJs);
  std::vector<Position> initialAnchors = parseAnchors(initialAnchorsJs);
  const Position goalAnchor{static_cast<int8_t>(goalAnchorJs["x"].as<int>()),
                            static_cast<int8_t>(goalAnchorJs["y"].as<int>())};

  const auto numTurns = turnsJs["length"].as<unsigned>();
  std::vector<Turn> turns;
  turns.reserve(numTurns);
  for (unsigned i = 0; i < numTurns; i++) {
    val t = turnsJs[i];
    turns.push_back({static_cast<uint8_t>(t["blockId"].as<unsigned>()),
                     static_cast<Direction>(t["direction"].as<unsigned>())});
  }

  AStar aStar(static_cast<uint8_t>(gridWidth), static_cast<uint8_t>(gridHeight),
              std::move(shapes), std::move(initialAnchors),
              static_cast<uint8_t>(goalIndex), goalAnchor, AStar::Config{});
  return turnsToJs(aStar.optimizeSolution(turns));
}

EMSCRIPTEN_BINDINGS(shifting_mosaic_astar_module) {
  function("solve", &solve);
  function("optimize", &optimize);
}

#endif // __EMSCRIPTEN__
