import { pickWasmVariant } from "../../util/wasmFeatureProbes";
import type { MatchThreeTest } from "../../util/types";
import { SOLVE_BUDGET_MS } from "./config";
import type { Move } from "./rules";

/**
 * One arm per entry, each in its own worker with its own heap. Order is
 * priority: on a machine with few cores the later arms wait for a slot.
 *
 * Unlike the rolling-blocks portfolio these arms do NOT share bounds — a
 * separate worker is a separate module instance, and the C++ side has no way to
 * accept a bound mid-solve. That is affordable here because the two arms that
 * matter need no incumbent: `bnb` dives straight to the deepest length worth
 * trying (the only arm that produces anything at all on the hardest captured
 * boards), and `iddfs` deepens from zero (the only one that can prove a length
 * minimal or a board unsolvable). Real cooperation happens on the isolated
 * path, where one module races the same arm set over a shared `Bounds` —
 * SolverArms.cpp's kPortfolio, which this list mirrors.
 */
export const PORTFOLIO: Record<string, unknown>[] = [
  // Near-free, and remarkably good when it lands: measured over the 52 captured
  // boards it answers 38 of them, and every one of those 38 answers is already
  // the proven optimum — worst case 4 ms. It just says nothing about the other
  // 14, which is what the rest of this list is for.
  { engine: "greedy", maxMs: SOLVE_BUDGET_MS },
  // Policy-adapting rollouts: the only arm that answers the two hardest captured
  // boards — 23 moves on matchThreeTest50 and 15 on matchThreeTest51, where
  // every other arm returns nothing at any budget. There are THREE of them, and
  // both their seeds and their CONFIGS differ, because measured over eight seeds
  // at 45 s each no single configuration wins both:
  //
  //   config                          test50   test47   test51
  //   level 2 x 100 pinned             6 / 8      -      8 / 8
  //   the restart ladder (cycling)     2 / 8    5 / 8    8 / 8
  //
  // test50 wants the cheap rung over and over; test47 wants the level to vary.
  // Racing both is what a portfolio is for. Mirrors SolverArms.cpp's kPortfolio.
  //
  // test50 in 542 ms.
  { engine: "nrpa", seed: 1, nrpaLevel: 2, nrpaIterations: 100, maxMs: SOLVE_BUDGET_MS },
  // The dive. Measured: the arm that answers matchThreeTest47 fastest.
  { engine: "bnb", maxMs: SOLVE_BUDGET_MS },
  // The prover: raises the ruled-out floor, and settles easy boards outright.
  { engine: "iddfs", maxMs: SOLVE_BUDGET_MS },
  // The ladder: test47 in 1.4 s, test51 in 5.1 s.
  { engine: "nrpa", seed: 6, maxMs: SOLVE_BUDGET_MS },
  // A beam far wider than the arm's own ladder goes, for boards where the
  // frontier is what runs out rather than the budget.
  { engine: "beam", beamWidth: 8192, maxMs: SOLVE_BUDGET_MS },
  // A second draw at test50's favourite config, 15.9 s.
  { engine: "nrpa", seed: 5, nrpaLevel: 2, nrpaIterations: 100, maxMs: SOLVE_BUDGET_MS },
];

export interface SolveStats {
  nodesExpanded: number;
  statesStored: number;
  stoppedOnMemory: boolean;
  wallMs: number;
  engine?: string;
}

/** What one arm came back with, already converted out of embind values. */
export interface ArmResult {
  readonly moves: Move[];
  readonly proven: boolean;
  readonly unsolvable: boolean;
  readonly ruledOut: number;
  readonly stats?: SolveStats;
}

export interface WasmCallbacks {
  /** Cumulative work across every arm, retired ones included. */
  readonly onProgress?: (nodes: number, ruledOut: number) => void;
  /** A candidate solution, before any validation. */
  readonly onBest?: (moves: Move[]) => void;
  /** An arm that finished, whatever it found. */
  readonly onArm?: (result: ArmResult) => void;
  /** Every arm has finished or failed; nothing more will be reported. */
  readonly onSettled?: () => void;
  /** No arm produced anything, including any that failed to start. */
  readonly onError?: (message: string) => void;
}

export interface WasmHandle {
  terminate(): void;
}

/**
 * Where `src/util/build.ts` publishes the em++ output. Page-relative, NOT
 * root-absolute: the site is served from a GitHub Pages project sub-path, so
 * "/mt-wasm/…" would resolve against the domain root and 404.
 */
const WORKER_URL = "../mt-wasm/astar.worker.js";

/** Flattens the editor's column-major cells the way the bindings expect. */
function flatten(config: MatchThreeTest): number[] {
  const { gridWidth, gridHeight } = config;
  const cells: number[] = new Array(gridWidth * gridHeight);
  for (let x = 0; x < gridWidth; x++) {
    for (let y = 0; y < gridHeight; y++) {
      cells[y * gridWidth + x] = config.cells[x]![y]!;
    }
  }
  return cells;
}

/**
 * Spawns the portfolio and reports every arm's outcome as it lands. Merging
 * them is the caller's job — this layer only owns the workers.
 *
 * A cross-origin isolated page collapses to ONE worker on the pthreads build,
 * whose cascade races the same arms on real threads inside a single module and
 * shares bounds between them.
 */
export function searchMatchThreeWasm(
  config: MatchThreeTest,
  callbacks: WasmCallbacks,
  budgetMs = SOLVE_BUDGET_MS,
): WasmHandle {
  const puzzle = {
    gridWidth: config.gridWidth,
    gridHeight: config.gridHeight,
    cells: flatten(config),
  };

  const isolated =
    typeof crossOriginIsolated !== "undefined" && crossOriginIsolated;
  const variant = pickWasmVariant(isolated);
  const poolSize = Math.max(
    1,
    Math.min(PORTFOLIO.length, (navigator.hardwareConcurrency || 2) - 1),
  );
  // Every arm always runs: poolSize bounds how many go at once, never which
  // ones exist — they queue and back-fill as earlier ones retire.
  const configs =
    isolated || poolSize === 1
      ? [{ engine: "cascade", maxMs: budgetMs }]
      : PORTFOLIO.map(arm => ({ ...arm, maxMs: budgetMs }));

  let workers: Worker[] = [];
  let settled = false;
  let pending = 0;
  let nextConfig = 0;
  let anyArmFinished = false;
  let lastError = "";
  const nodesByWorker = new Map<Worker, number>();
  const ruledOutByWorker = new Map<Worker, number>();
  // Idempotent per worker: a failing arm can deliver both an error message AND
  // an onerror event, and the double decrement would settle the race early.
  const retired = new Set<Worker>();

  const terminateAll = () => {
    for (const worker of workers) worker.terminate();
    workers = [];
  };

  const settle = () => {
    if (settled) return;
    settled = true;
    terminateAll();
    if (anyArmFinished) callbacks.onSettled?.();
    else callbacks.onError?.(lastError || "The solver could not be started.");
  };

  const reportProgress = () => {
    let nodes = 0;
    for (const count of nodesByWorker.values()) nodes += count;
    let ruledOut = 0;
    for (const depth of ruledOutByWorker.values()) {
      ruledOut = Math.max(ruledOut, depth);
    }
    callbacks.onProgress?.(nodes, ruledOut);
  };

  const retire = (worker: Worker) => {
    if (settled || retired.has(worker)) return;
    retired.add(worker);
    pending--;
    worker.terminate();
    spawnNext();
    if (pending === 0) settle();
  };

  const handleMessage = (worker: Worker, data: Record<string, unknown>) => {
    if (data.type === "progress") {
      nodesByWorker.set(worker, Number(data.progress));
      ruledOutByWorker.set(worker, Number(data.ruledOut ?? 0));
      reportProgress();
      return;
    }
    if (data.type === "best") {
      callbacks.onBest?.(data.moves as Move[]);
      return;
    }
    if (data.type === "done") {
      anyArmFinished = true;
      ruledOutByWorker.set(worker, Number(data.ruledOut ?? 0));
      reportProgress();
      callbacks.onArm?.({
        moves: data.moves as Move[],
        proven: data.proven === true,
        unsolvable: data.unsolvable === true,
        ruledOut: Number(data.ruledOut ?? 0),
        stats: data.stats as SolveStats | undefined,
      });
      retire(worker);
      return;
    }
    if (data.type === "error") {
      // A dying arm (a wasm heap that could not grow aborts its module) retires
      // itself; the portfolio fails only when every arm has failed.
      lastError = String(data.error);
      retire(worker);
    }
  };

  function spawnNext() {
    if (settled || nextConfig >= configs.length) return;
    const armConfig = configs[nextConfig++]!;
    let worker: Worker;
    try {
      worker = new Worker(WORKER_URL, { type: "module" });
    } catch {
      lastError = "The solver could not be started.";
      spawnNext();
      return;
    }
    workers.push(worker);
    nodesByWorker.set(worker, 0);

    worker.onmessage = (event: MessageEvent) => {
      if (settled) return;
      handleMessage(worker, event.data as Record<string, unknown>);
    };
    worker.onerror = event => {
      lastError = event.message || "The solver stopped unexpectedly.";
      retire(worker);
    };
    worker.postMessage({ puzzle, config: armConfig, variant });
    pending++;
  }

  for (let i = 0; i < Math.min(poolSize, configs.length); i++) spawnNext();
  if (pending === 0) settle();

  return { terminate: terminateAll };
}
