import type { Tile } from "../../util/types";
import { pickWasmVariant } from "../../util/wasmFeatureProbes";
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

export interface SolverHandle {
  terminate(): void;
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

  const poolSize = Math.max(
    1,
    Math.min(PORTFOLIO.length, (navigator.hardwareConcurrency || 2) - 1),
  );
  const isolated =
    typeof crossOriginIsolated !== "undefined" && crossOriginIsolated;
  const variant = pickWasmVariant(isolated);
  // Every arm, always: poolSize bounds how many run CONCURRENTLY, never
  // which ones exist — arms are queued and back-filled as earlier ones
  // retire, so a small machine is slower but never less capable (the
  // shifting-mosaic lesson).
  const configs =
    isolated || poolSize === 1
      ? [{ engine: "cascade", maxMs: SOLVE_BUDGET_MS }]
      : PORTFOLIO;

  let workers: Worker[] = [];
  let finished = false;
  const progressByWorker = new Map<Worker, number>();
  // Sticky: if ANY arm searched out cleanly, the board is "no solution
  // within budget", not a solver failure.
  let anyArmCompleted = false;
  let lastError = "";
  let lastStats: SolveStats | undefined;

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

  let pending = 0;
  // Idempotent per worker: a failing arm can deliver both an error message
  // AND an onerror event, and the double decrement would settle the race
  // early.
  const retired = new Set<Worker>();
  let nextConfig = 0;
  const retire = (worker: Worker) => {
    if (finished || retired.has(worker)) return;
    retired.add(worker);
    pending--;
    worker.terminate();
    // Back-fill the freed slot before deciding we are done.
    spawnNext();
    if (pending > 0) return;
    finish(() =>
      anyArmCompleted
        ? callbacks.onDone?.([], lastStats)
        : callbacks.onError?.(lastError || "Worker failed to start"),
    );
  };

  function spawnNext() {
    if (finished || nextConfig >= configs.length) return;
    const config = configs[nextConfig++]!;
    // Page-relative, NOT root-absolute: the site is published to a GitHub
    // Pages project sub-path, so "/rb-wasm/…" would resolve against the
    // domain root and 404.
    const worker = new Worker("../rb-wasm/astar.worker.js", {
      type: "module",
    });
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
        // Posted by the wasm module itself (it runs inside this worker).
        callbacks.onPhase?.(String(event.data.arm ?? event.data.phase));
        return;
      }
      if (type === "done") {
        const path: Turn[] = event.data.path.map(
          (t: { blockId: number; direction: number }) => ({
            blockId: t.blockId,
            direction: DIRECTION_MAP[t.direction]!,
          }),
        );
        if (path.length > 0) {
          finish(() => callbacks.onDone?.(path, event.data.stats));
          return;
        }
        anyArmCompleted = true;
        lastStats = event.data.stats;
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

  for (let i = 0; i < Math.min(poolSize, configs.length); i++) spawnNext();

  return handle;
}
