import type { Position } from "../../util/types";
import {
  armPoolSize,
  crossOriginIsolatedPage,
  startWasmPool,
  type WasmPoolHandle,
} from "../../util/wasmPool";
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

/** The one way to stop the race — see `src/util/wasmPool.ts`. */
export type SolverHandle = WasmPoolHandle;

/** A turn as the worker posts it, before the direction is named. */
type RawTurn = { blockId: number; direction: number };

/**
 * Where `src/util/build.ts` publishes the em++ output. Page-relative, NOT
 * root-absolute: the site is published to a GitHub Pages project sub-path
 * (https://<user>.github.io/<repo>/), so "/sm-wasm/…" would resolve against
 * the domain root and 404. Pages live one level below the site root, so "../"
 * lands on it in dev and in production alike.
 */
const WORKER_URL = "../sm-wasm/astar.worker.js";

/**
 * The plan as the page can play it, or null when a turn names a direction that
 * is not one of the four.
 *
 * Checked rather than asserted: the map covers 0..3, and a `!` on it would let
 * anything else through as `direction: undefined` — which type-checks, reaches
 * the solution view and animates a move nothing can replay. A malformed plan is
 * this arm having failed, and is reported as one.
 */
function toTurns(raw: RawTurn[]): Turn[] | null {
  const turns: Turn[] = [];
  for (const turn of raw) {
    const direction = DIRECTION_MAP[turn.direction];
    if (direction === undefined) return null;
    turns.push({ blockId: turn.blockId, direction });
  }
  return turns;
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

// The Memory64/table64 capability probes live in src/util/wasmFeatureProbes,
// shared with the rolling-blocks bridge.

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
  // Cross-origin isolated (via the coi-serviceworker shim): one worker with the
  // pthreads build — its cascade races the arms on real threads sharing a
  // single 4GB heap. Otherwise: multi-worker portfolio (works everywhere), or
  // the sequential in-wasm cascade when only one core is available.
  //
  // Every arm, always. The pool bounds how many run CONCURRENTLY, never which
  // ones exist: slicing the portfolio by core count made capability shrink as
  // the machine improved — a 4-core box raced only the first three arms and
  // reported "no solution" on boards that the 1-core in-wasm cascade and the
  // isolated 8-arm race both solve. Arms are queued and back-filled as earlier
  // ones retire, so a small machine is slower but never less capable.
  //
  // The pool picks the biggest heap each path can load. On the hardest boards a
  // deep arm exhausts the 4GB wasm32 heap and aborts partway through its
  // budget; the 8GB MEMORY64 builds let it run to the end instead.
  const configs =
    crossOriginIsolatedPage() || armPoolSize(PORTFOLIO.length) === 1
      ? [{ engine: "cascade", maxMs: SOLVE_BUDGET_MS, maxNodes: 0 }]
      : PORTFOLIO;

  // Sticky: if ANY arm searched out cleanly, the board is "no solution within
  // budget", not a solver failure — otherwise which terminal message the user
  // saw depended purely on which arm happened to settle last.
  let anyArmCompleted = false;

  return startWasmPool({
    workerUrl: WORKER_URL,
    configs,
    payload: { puzzle },
    startupError: "Worker failed to start",
    onProgress: nodes => callbacks.onProgress?.(nodes),
    onMessage: (data, arm) => {
      if (data.type === "progress") {
        arm.progress(Number(data.progress));
        return;
      }
      if (data.type === "phase") {
        // Posted by the wasm module itself (it runs inside this worker, so its
        // self.postMessage lands here directly).
        callbacks.onPhase?.(
          String(data.phase),
          data.arm === undefined ? undefined : String(data.arm),
        );
        return;
      }
      if (data.type === "done") {
        // `?? []` because the cast is a promise, not a check: a build that
        // stopped sending the field would otherwise throw inside the pool's
        // message handler, which has no `try` — and an arm that throws never
        // retires, so the race would never settle at all.
        const path = toTurns((data.path as RawTurn[]) ?? []);
        if (!path) {
          arm.fail("The solver returned a plan the page cannot play.");
          arm.retire();
          return;
        }
        // A board whose goal block already sits on the goal anchor is solved by
        // the EMPTY plan, which is also what a failed arm returns — so it has
        // to be told apart here rather than read as "this arm found nothing".
        if (path.length > 0 || isAlreadySolved(puzzle)) {
          arm.settle(() => callbacks.onDone?.(path));
          return;
        }
        // This arm found nothing — let the others keep racing.
        anyArmCompleted = true;
        arm.retire();
        return;
      }
      if (data.type === "error") {
        // A dying arm (e.g. wasm OOM) only retires itself; the portfolio fails
        // only when every arm has failed or come back empty.
        arm.fail(String(data.error));
        arm.retire();
      }
    },
    onExhausted: lastError => {
      if (anyArmCompleted) callbacks.onDone?.([]);
      else callbacks.onError?.(lastError);
    },
  });
}
