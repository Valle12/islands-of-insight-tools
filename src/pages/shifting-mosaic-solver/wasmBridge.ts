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
// maxNodes 0 = unbounded (hier's per-segment searches bound memory);
// the flat arms keep a node cap as their wasm-heap safety valve.
const SOLVE_BUDGET_MS = 300_000;
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

/**
 * Spawns a portfolio of WASM solver workers racing diverse engine configs
 * (drag-space hierarchical/flat + the legacy unit-move A*). The first worker
 * to return a non-empty plan wins and the others are terminated; if every
 * arm comes back empty, the UI gets an empty path ("no solution within
 * budget"). Progress reports are summed across live arms.
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
  const variant = isolated ? "threads" : "default";
  const configs =
    isolated || poolSize === 1
      ? [{ engine: "cascade", maxMs: SOLVE_BUDGET_MS, maxNodes: 0 }]
      : PORTFOLIO.slice(0, poolSize);

  let workers: Worker[] = [];
  let finished = false;
  const progressByWorker = new Map<Worker, number>();

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

  let pending = configs.length;
  for (const config of configs) {
    const worker = new Worker("/sm-wasm/astar.worker.js", { type: "module" });
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
        pending--;
        worker.terminate();
        if (pending === 0) finish(() => callbacks.onDone?.([]));
        return;
      }
      if (type === "error") {
        // A dying arm (e.g. wasm OOM) only retires itself; the portfolio
        // fails only when every arm has failed or come back empty.
        pending--;
        worker.terminate();
        if (pending === 0)
          finish(() => callbacks.onError?.(event.data.error));
      }
    };

    worker.onerror = event => {
      pending--;
      worker.terminate();
      if (pending === 0)
        finish(() =>
          callbacks.onError?.(event.message || "Worker failed to start"),
        );
    };

    worker.postMessage({ puzzle, config, variant });
  }

  return handle;
}
