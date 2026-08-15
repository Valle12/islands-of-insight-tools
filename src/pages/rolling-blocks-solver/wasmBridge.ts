import type { Tile } from "../../util/types";
import {
  armPoolSize,
  crossOriginIsolatedPage,
  startWasmPool,
  type WasmPoolHandle,
} from "../../util/wasmPool";
import type { Block } from "./block";
import { Direction } from "./directions";
import type { Turn } from "./turn";

const TILE_MAP: Record<Tile, number> = {
  regular: 0,
  mustTouch: 1,
  goal: 2,
  unplayable: 3,
};

const DIRECTION_MAP: Record<number, Direction> = {
  0: Direction.UP,
  1: Direction.RIGHT,
  2: Direction.DOWN,
  3: Direction.LEFT,
};

/** The one way to stop the race — see `src/util/wasmPool.ts`. */
export type SolverHandle = WasmPoolHandle;

/** A turn as the worker posts it, before the direction is named. */
type RawTurn = { blockId: number; direction: number };

/**
 * Where `src/util/build.ts` publishes the em++ output. Page-relative, NOT
 * root-absolute: the site is served from a GitHub Pages project sub-path, so
 * "/rb-wasm/…" would resolve against the domain root and 404.
 */
const WORKER_URL = "../rb-wasm/astar.worker.js";

function toTurns(raw: RawTurn[]): Turn[] {
  return raw.map(t => ({
    blockId: t.blockId,
    direction: DIRECTION_MAP[t.direction]!,
  }));
}

export interface SolveStats {
  nodesExpanded: number;
  statesStored: number;
  stoppedOnMemory: boolean;
  wallMs: number;
  engine?: string;
}

export interface WasmSearchCallbacks {
  onProgress?: (nodesExpanded: number) => void;
  onDone?: (path: Turn[], stats?: SolveStats) => void;
  onError?: (error: string) => void;
  /**
   * Fired when the solver switches strategy. "sequential" means the isolated
   * in-module race found nothing and the arms are re-running one at a time;
   * any other value names the arm a cascade just started.
   */
  onPhase?: (phase: string) => void;
}

const SOLVE_BUDGET_MS = 300_000;

// One arm per entry; racing workers each take one config, first non-empty
// solution wins. Order = priority when fewer cores are available. Exported so
// the tests can race the exact production arm set. The pthreads build's
// in-module race (SolverArms.cpp kPortfolio) mirrors this list — keep them
// in sync.
export const PORTFOLIO: Record<string, unknown>[] = [
  // Uniform-cost enumeration: optimal plans on boards small enough to
  // enumerate; declines instantly elsewhere (gated).
  { engine: "exact", gated: true, maxMs: SOLVE_BUDGET_MS },
  // The endgame specialist: single-block must-touch coverage boards
  // (fixtures 37/38/39 fall in 106/60/7907 expansions).
  { engine: "cracker", gated: true, maxMs: SOLVE_BUDGET_MS },
  // The zero-regression arm: the production weighted A*.
  { engine: "wastar", weight: 2, maxMs: SOLVE_BUDGET_MS, maxNodes: 20_000_000 },
  // Depth at all costs, the optimizer cleans up: fuzz campaign 1 measured it
  // cracking single-region boards wastar and beam both miss.
  { engine: "greedy", maxMs: SOLVE_BUDGET_MS },
  // Memory-bounded breadth for boards whose state space outgrows the heap.
  { engine: "beam", maxMs: SOLVE_BUDGET_MS },
  // Ungated cracker retry with a different restart seed.
  { engine: "cracker", seed: 1, maxMs: SOLVE_BUDGET_MS },
  { engine: "wastar", weight: 4, maxMs: SOLVE_BUDGET_MS },
  // Near-optimal low-weight arm for small boards.
  { engine: "wastar", weight: 1, maxMs: SOLVE_BUDGET_MS },
];

/**
 * Spawns a portfolio of WASM solver workers racing diverse engine configs.
 * The first worker to return a non-empty plan wins and the others are
 * terminated; if every arm comes back empty, the UI gets an empty path ("no
 * solution within budget"). Progress is the cumulative node count across
 * every arm, retired ones included, so the readout never moves backwards.
 * Cross-origin isolated pages collapse to ONE worker on the pthreads build,
 * whose cascade races the same arms on real threads inside one module.
 */
export function searchRollingBlocksWasm(
  gridWidth: number,
  gridHeight: number,
  cells: Tile[][],
  blocks: Block[],
  callbacks: WasmSearchCallbacks,
): SolverHandle {
  const flatCells: number[] = new Array(gridWidth * gridHeight);
  for (let x = 0; x < gridWidth; x++) {
    for (let y = 0; y < gridHeight; y++) {
      flatCells[x + y * gridWidth] = TILE_MAP[cells[x]![y]!];
    }
  }
  const puzzle = {
    gridWidth,
    gridHeight,
    cells: flatCells,
    blocks: blocks.map(b => ({
      id: b.id,
      x: b.x,
      y: b.y,
      width: b.width,
      depth: b.depth,
      height: b.height,
    })),
  };

  // Every arm, always: the pool bounds how many run CONCURRENTLY, never which
  // ones exist — arms are queued and back-filled as earlier ones retire, so a
  // small machine is slower but never less capable (the shifting-mosaic
  // lesson). The list collapses only where one module races the same arms
  // itself: on an isolated page, or on a machine with a single slot, where
  // spawning them one at a time would just serialise the portfolio.
  const configs =
    crossOriginIsolatedPage() || armPoolSize(PORTFOLIO.length) === 1
      ? [{ engine: "cascade", maxMs: SOLVE_BUDGET_MS }]
      : PORTFOLIO;

  // Sticky: if ANY arm searched out cleanly, the board is "no solution within
  // budget", not a solver failure.
  let anyArmCompleted = false;
  let lastStats: SolveStats | undefined;

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
        // Posted by the wasm module itself (it runs inside this worker).
        callbacks.onPhase?.(String(data.arm ?? data.phase));
        return;
      }
      if (data.type === "done") {
        const path = toTurns(data.path as RawTurn[]);
        // First non-empty plan wins and ends the race outright.
        if (path.length > 0) {
          arm.settle(() => callbacks.onDone?.(path, data.stats as SolveStats));
          return;
        }
        anyArmCompleted = true;
        lastStats = data.stats as SolveStats | undefined;
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
      if (anyArmCompleted) callbacks.onDone?.([], lastStats);
      else callbacks.onError?.(lastError);
    },
  });
}
