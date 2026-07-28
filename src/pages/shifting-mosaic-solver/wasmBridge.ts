import type { Position } from "../../util/types";
import { Direction } from "./directions";
import type { Turn } from "./turn";

// Direction integers as encoded by the C++ `enum class Direction`.
const DIRECTION_MAP: Record<number, Direction> = {
  0: Direction.UP,
  1: Direction.RIGHT,
  2: Direction.DOWN,
  3: Direction.LEFT,
};

export interface WasmSearchCallbacks {
  onProgress?: (nodesExpanded: number) => void;
  onDone?: (path: Turn[]) => void;
  onError?: (error: string) => void;
  /**
   * Fired when the solver moves to a different strategy. Currently only
   * "sequential": the parallel race found nothing, so the arms are being
   * re-run one at a time, each with the whole heap. That recovers boards the
   * race cannot (measured: one starved of memory, one excluded by an arm
   * gate) but is materially slower, so the UI must say so rather than leaving
   * an unchanged spinner.
   */
  onPhase?: (phase: string, arm?: string) => void;
}

export interface ShiftingMosaicPuzzle {
  gridWidth: number;
  gridHeight: number;
  shapes: Position[][];
  initialAnchors: Position[];
  goalIndex: number;
  goalAnchor: Position;
}

export interface SolverHandle {
  /** Cancel every solver worker still running. */
  terminate: () => void;
}

// One portfolio arm = one worker running one engine config (schema:
// wasm_bindings.cpp::solve). Arms race; the first non-empty solution wins
// and the rest are terminated. Order = priority when fewer cores are
// available. The unit arm is the pre-drag-engine production config, kept
// verbatim as the zero-regression fallback.
//
// Budgets follow the "anytime" UX: hard puzzles may search minutes; the UI
// shows live progress and its Cancel path calls SolverHandle.terminate().
const SOLVE_BUDGET_MS = 300_000;
// On the memory: a FLAT search (drag / unit) keeps every expanded node's state
// map + per-expansion scratch resident, ~2.0-2.4KB/node measured, so its heap
// grows ~linearly with nodes and hits the wasm32 4GB wall at ~1.7M nodes on a
// hard board. When an arm hits the wall it aborts — but each arm is its own
// worker, so the bridge just retires that one worker (see onmessage/onerror
// below) and the portfolio races on; a hard board simply ends "no solution".
// A node cap is NOT a useful safety valve here: the wall already self-enforces
// and the abort is already contained, while any cap low enough to matter also
// cuts legitimate deep solves that run right up to the wall (shiftingMosaicTest37
// finds its 41-drag plan on the flat drag arm at ~1.3M nodes / ~3GB). The real
// ceiling-lift is the MEMORY64 build (astar.mem64, 8GB heap), preferred below
// wherever the runtime can load it. maxNodes here stays a loose runaway guard.
// Exported so the wasm test suite can race the EXACT production arm set.
export const PORTFOLIO: Record<string, unknown>[] = [
  // Pack-then-slide pipeline — solves shiftingMosaicTest41-class puzzles in
  // seconds and fails fast when no off-sweep packing exists.
  { engine: "assembly", maxMs: SOLVE_BUDGET_MS, maxNodes: 0 },
  // Corridor arm — synthetic distance bands for narrow open boards with no
  // cut bottleneck but a long goal journey; declines instantly otherwise.
  { engine: "corridor", dragWeight: 3, settledOnly: true, pea: 48, maxMs: SOLVE_BUDGET_MS, maxNodes: 0 },
  // The deep-puzzle cracker: flat drag-space WA*, settled parking, partial
  // expansion. This exact config solved shiftingMosaicTest37 (41 drags).
  { engine: "drag", dragWeight: 4, settledOnly: true, pea: 64, maxMs: SOLVE_BUDGET_MS, maxNodes: 0 },
  // Jam-restart arm — dig-cost-guided diversified rounds (IIT-21: cracked
  // fuzz jams 10276/4722/9164 in <60s). Gated to the compact-dense 0-cut
  // jam profile, declines instantly elsewhere.
  { engine: "jam", gated: true, maxMs: SOLVE_BUDGET_MS, maxNodes: 0 },
  // The pre-drag production unit-move config — zero-regression arm.
  { engine: "unit", weight: 3, maxMs: SOLVE_BUDGET_MS, maxNodes: 20_000_000 },
  // Receding-horizon drag search — fast on cut-structured puzzles.
  { engine: "hier", dragWeight: 3, settledOnly: true, pea: 48, maxMs: SOLVE_BUDGET_MS, maxNodes: 0 },
  // Jam arm: relevance filter (goal-path blockers + their 1-ring only) +
  // commutativity pruning — cracks compact dense boards where every
  // unrestricted search drowns (found via the 10k-board jam post-mortem).
  { engine: "drag", dragWeight: 4, settledOnly: true, pea: 64, sleepSets: true, relevantOnly: true, maxMs: SOLVE_BUDGET_MS, maxNodes: 0 },
  // Low-weight drag arm — near-optimal step counts on small puzzles.
  { engine: "drag", dragWeight: 2, settledOnly: true, pea: 48, maxMs: SOLVE_BUDGET_MS, maxNodes: 20_000_000 },
  // Guided-beam arm — breadth against jam plateaus the restart rounds dive
  // past; jam-profile gated like the jam arm. Wide beam + heavy dig penalty
  // = the config that cracked fuzz seed 3870 (own 4GB worker heap).
  { engine: "beam", gated: true, beamWidth: 500_000, jamBlockerPenalty: 8, maxMs: SOLVE_BUDGET_MS, maxNodes: 0 },
];

function isAlreadySolved(p: ShiftingMosaicPuzzle): boolean {
  const g = p.initialAnchors[p.goalIndex]!;
  return g.x === p.goalAnchor.x && g.y === p.goalAnchor.y;
}

// Tiny modules declaring a single 64-bit memory. If the engine validates one,
// it can load the matching MEMORY64 build, whose heap ceiling is 8GB instead of
// the wasm32 4GB wall — enough that the deep arms stop aborting mid-search on
// the hardest boards. Browsers enable Memory64 behind a flag today and natively
// soon; bun cannot load either yet.
//   - NON-SHARED (flags 0x04 = is64): the single-threaded astar.mem64 build.
//   - SHARED (flags 0x07 = is64|shared|has_max, min 0 max 1): the pthreads
//     astar.threads.mem64 build, whose arms race inside one shared 64-bit heap.
//     This is a distinct capability — an engine can have one without the other.
const MEMORY64_PROBE = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x05, 0x03, 0x01, 0x04, 0x00,
]);
const SHARED_MEMORY64_PROBE = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x05, 0x04, 0x01, 0x07, 0x00,
  0x01,
]);
// A 64-bit memory is necessary but NOT sufficient: emscripten 6.x emits a
// 64-bit TABLE (section 4, funcref 0x70, limits flags 0x04 = is64) in every
// wasm64 build, and an engine can validate a 64-bit memory while still
// rejecting that table — the ubuntu-24.04 runner's node does. Handing such an
// engine a mem64 build costs a failed compile before the worker's fallback
// catches it, so both gates below require the table too.
const TABLE64_PROBE = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x04, 0x04, 0x01, 0x70, 0x04,
  0x00,
]);
function validates(bytes: Uint8Array): boolean {
  try {
    return typeof WebAssembly !== "undefined" && WebAssembly.validate(bytes);
  } catch {
    return false;
  }
}
const supportsMemory64 = () =>
  validates(MEMORY64_PROBE) && validates(TABLE64_PROBE);
const supportsSharedMemory64 = () =>
  validates(SHARED_MEMORY64_PROBE) && validates(TABLE64_PROBE);

/**
 * Spawns a portfolio of WASM solver workers racing diverse engine configs
 * (drag-space hierarchical/flat + the legacy unit-move A*). The first worker
 * to return a non-empty plan wins and the others are terminated; if every
 * arm comes back empty, the UI gets an empty path ("no solution within
 * budget"). Progress is the cumulative node count across every arm, retired
 * ones included, so the readout never moves backwards.
 */
export function searchShiftingMosaicWasm(
  puzzle: ShiftingMosaicPuzzle,
  callbacks: WasmSearchCallbacks,
): SolverHandle {
  const poolSize = Math.max(
    1,
    Math.min(PORTFOLIO.length, (navigator.hardwareConcurrency || 2) - 1),
  );
  // Cross-origin isolated (via the coi-serviceworker shim): one worker with
  // the pthreads build — its cascade races the arms on real threads sharing
  // a single 4GB heap. Otherwise: multi-worker portfolio (works everywhere),
  // or the sequential in-wasm cascade when only one core is available.
  const isolated =
    typeof crossOriginIsolated !== "undefined" && crossOriginIsolated;
  // Pick the biggest heap each path can load. On the hardest boards a deep arm
  // exhausts the 4GB wasm32 heap and aborts partway through its budget; the 8GB
  // MEMORY64 builds let it run to the end instead.
  //   - isolated (threads cascade, one SHARED heap for all 8 arms): the 8GB
  //     shared-memory64 build if the engine validates it, else the wasm32 one.
  //   - non-isolated (one heap per worker): the 8GB non-shared build, else
  //     wasm32. An arm that hits even the 8GB wall still only retires itself.
  let variant: string;
  if (isolated) {
    variant = supportsSharedMemory64() ? "threads-mem64" : "threads";
  } else {
    variant = supportsMemory64() ? "mem64" : "default";
  }
  // Every arm, always. poolSize bounds how many run CONCURRENTLY, never which
  // ones exist: slicing the portfolio by core count made capability shrink as
  // the machine improved — a 4-core box raced only the first three arms and
  // reported "no solution" on boards that the 1-core in-wasm cascade and the
  // isolated 8-arm race both solve. Arms are queued and back-filled as earlier
  // ones retire, so a small machine is slower but never less capable.
  const configs =
    isolated || poolSize === 1
      ? [{ engine: "cascade", maxMs: SOLVE_BUDGET_MS, maxNodes: 0 }]
      : PORTFOLIO;

  let workers: Worker[] = [];
  let finished = false;
  const progressByWorker = new Map<Worker, number>();
  // Sticky: if ANY arm searched out cleanly, the board is "no solution within
  // budget", not a solver failure — otherwise which terminal message the user
  // saw depended purely on which arm happened to settle last.
  let anyArmCompleted = false;
  let lastError = "";

  const terminateAll = () => {
    for (const w of workers) w.terminate();
    workers = [];
  };
  const handle: SolverHandle = { terminate: terminateAll };

  const finish = (fn: () => void) => {
    if (finished) return;
    finished = true;
    terminateAll();
    fn();
  };

  // Live workers, not queued arms: spawnNext() increments, retire() decrements.
  let pending = 0;

  // One arm is done for good: stop it and settle the portfolio once every arm
  // has retired. A retired arm's last node count deliberately STAYS in
  // progressByWorker — the readout is cumulative work done, and dropping it
  // would make the displayed total jump backwards.
  //
  // `retired` makes this idempotent per worker: a failing arm can deliver both
  // an {type:"error"} message AND an onerror event, and the double decrement
  // would settle the portfolio while other arms were still searching.
  const retired = new Set<Worker>();
  let nextConfig = 0;
  const retire = (worker: Worker) => {
    if (finished || retired.has(worker)) return;
    retired.add(worker);
    pending--;
    worker.terminate();
    // Back-fill the freed slot before deciding we are done, so the queued arms
    // still get their turn on a machine that cannot run them all at once.
    spawnNext();
    if (pending > 0) return;
    finish(() =>
      anyArmCompleted
        ? callbacks.onDone?.([])
        : callbacks.onError?.(lastError || "Worker failed to start"),
    );
  };

  function spawnNext() {
    if (finished || nextConfig >= configs.length) return;
    const config = configs[nextConfig++]!;
    // Page-relative, NOT root-absolute: the site is published to a GitHub
    // Pages project sub-path (https://<user>.github.io/<repo>/), so "/sm-wasm/…"
    // would resolve against the domain root and 404. Pages live one level
    // below the site root, so "../" lands on it in dev and in production
    // alike — the same form rolling-blocks-solver/wasmBridge.ts uses.
    const worker = new Worker("../sm-wasm/astar.worker.js", { type: "module" });
    workers.push(worker);
    progressByWorker.set(worker, 0);

    worker.onmessage = (event: MessageEvent) => {
      const { type } = event.data;
      if (type === "progress") {
        progressByWorker.set(worker, event.data.progress);
        let total = 0;
        for (const n of progressByWorker.values()) total += n;
        callbacks.onProgress?.(total);
        return;
      }
      if (type === "phase") {
        // Posted by the wasm module itself (it runs inside this worker, so its
        // self.postMessage lands here directly).
        callbacks.onPhase?.(
          String(event.data.phase),
          event.data.arm === undefined ? undefined : String(event.data.arm),
        );
        return;
      }
      if (type === "done") {
        const path: Turn[] = event.data.path.map(
          (t: { blockId: number; direction: number }) => ({
            blockId: t.blockId,
            direction: DIRECTION_MAP[t.direction]!,
          }),
        );
        if (path.length > 0 || isAlreadySolved(puzzle)) {
          finish(() => callbacks.onDone?.(path));
          return;
        }
        // This arm found nothing — let the others keep racing.
        anyArmCompleted = true;
        retire(worker);
        return;
      }
      if (type === "error") {
        // A dying arm (e.g. wasm OOM) only retires itself; the portfolio
        // fails only when every arm has failed or come back empty.
        lastError = String(event.data.error);
        retire(worker);
      }
    };

    worker.onerror = event => {
      lastError = event.message || "Worker failed to start";
      retire(worker);
    };

    worker.postMessage({ puzzle, config, variant });
    pending++;
  }

  // Fill the initial slots; retire() back-fills from the queue thereafter.
  for (let i = 0; i < Math.min(poolSize, configs.length); i++) spawnNext();

  return handle;
}
