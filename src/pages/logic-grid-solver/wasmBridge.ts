import type { LogicGridTest } from "../../util/types";
import { pickWasmVariant } from "../../util/wasmFeatureProbes";
import { SOLVE_BUDGET_MS } from "./config";
import { symbolKindAt } from "./symbols";
import { toFlat } from "./verify";

/**
 * The C++ arms, raced.
 *
 * Mirrors `kPortfolio` in `a-star/SolverArms.cpp`: a cross-origin isolated
 * page runs that list on real threads inside ONE module, and everywhere else
 * this spreads the same list over separate workers. The two have to stay in
 * step, which is why both carry this table.
 *
 * `deduce` is first because it is nearly free and often finishes the board;
 * the rest are the full cascade under different seeds, which matters on an
 * underclued board where the order candidates are refuted in decides how much
 * of the budget each one gets.
 */
export const PORTFOLIO: Record<string, unknown>[] = [
  { engine: "deduce" },
  { engine: "cascade", seed: 0 },
  { engine: "cascade", seed: 1 },
  { engine: "cascade", seed: 2 },
];

export type LogicGridStatus =
  | "solved"
  | "deduced"
  | "unsolvable"
  | "unsolved";

export interface SolveStats {
  nodes: number;
  refutations: number;
  oracleRejections: number;
  stoppedOnMemory: boolean;
  wallMs: number;
  arm?: string;
}

export interface ArmResult {
  readonly status: LogicGridStatus;
  /** Why the board is unsolvable, when a named check found out without searching. */
  readonly reason?: string;
  /** The answer, flat row-major. Empty when the arm has nothing to say. */
  readonly cells: number[];
  /** Underclued: every remaining cell was PROVED undecidable, not just left. */
  readonly proven: boolean;
  readonly decided: number;
  readonly playable: number;
  /** Complete solutions the answer can be checked against. */
  readonly witnesses: number[][];
  readonly stats?: SolveStats;
}

export interface WasmCallbacks {
  readonly onProgress?: (nodes: number, decided: number) => void;
  readonly onArm?: (result: ArmResult) => void;
  readonly onSettled?: () => void;
  readonly onError?: (message: string) => void;
}

export interface WasmHandle {
  terminate(): void;
}

/**
 * Where `src/util/build.ts` publishes the em++ output. Page-relative, NOT
 * root-absolute: the site is served from a GitHub Pages project sub-path, so
 * "/lg-wasm/…" would resolve against the domain root and 404.
 */
const WORKER_URL = "../lg-wasm/astar.worker.js";

const LETTER_A = "A".codePointAt(0)!;

/** "A" becomes 0: nothing in the search ever wants the glyph. */
function letterIndex(value: number | string): number {
  return (String(value).codePointAt(0) ?? LETTER_A) - LETTER_A;
}

/**
 * The puzzle exactly as the module takes it.
 *
 * Exported for the same reason `PORTFOLIO` is: `test/logic-grid-solver/
 * wasm.test.ts` drives the shipped module directly, and a second copy of this
 * would silently stop sending whatever was added last — which is how a sweep
 * over the whole corpus can pass while never exercising the new key at all.
 */
export function toPuzzle(config: LogicGridTest) {
  return {
    gridWidth: config.gridWidth,
    gridHeight: config.gridHeight,
    cells: toFlat(config),
    rules: [...config.rules],
    clues: config.symbols.map(symbol => ({
      x: symbol.x,
      y: symbol.y,
      type: symbol.type,
      value:
        symbolKindAt(symbol.type)?.valueKind === "letter"
          ? letterIndex(symbol.value)
          : Number(symbol.value),
      // Sent as -1 rather than omitted when a clue has none: the module reads
      // the key unconditionally and validates it against the kind, so a missing
      // direction on a kind that needs one has to arrive as a value it can
      // refuse rather than as `undefined`.
      direction: symbol.direction ?? -1,
    })),
    // Already flat row-major, the same layout `cells` crosses in, so this one
    // passes straight through. Omitted rather than sent empty, matching the
    // config format the module also reads from a fixture file.
    ...(config.shapes ? { shapes: config.shapes.map(shape => [...shape]) } : {}),
  };
}

export function searchLogicGridWasm(
  config: LogicGridTest,
  callbacks: WasmCallbacks,
  budgetMs = SOLVE_BUDGET_MS,
): WasmHandle {
  const puzzle = toPuzzle(config);

  const isolated =
    typeof crossOriginIsolated !== "undefined" && crossOriginIsolated;
  const variant = pickWasmVariant(isolated);
  const poolSize = Math.max(
    1,
    Math.min(PORTFOLIO.length, (navigator.hardwareConcurrency || 2) - 1),
  );
  // Every arm always runs: poolSize bounds how many go at once, never which
  // ones exist — they queue and back-fill as earlier ones retire. That is why
  // only the ISOLATED case collapses the list: there the pthreads module races
  // `kPortfolio` on real threads inside one worker, so spawning the arms out
  // here as well would run each of them twice. A small `poolSize` is not a
  // reason to drop any — it just means they take longer to all get a turn, and
  // dropping them would cost a one- or two-core machine the near-free `deduce`
  // arm that finishes most boards on its own.
  const configs = isolated
    ? [{ engine: "cascade", maxMs: budgetMs }]
    : PORTFOLIO.map(arm => ({ ...arm, maxMs: budgetMs }));

  let workers: Worker[] = [];
  let settled = false;
  let pending = 0;
  let nextConfig = 0;
  let anyArmFinished = false;
  let lastError = "";
  const nodesByWorker = new Map<Worker, number>();
  const decidedByWorker = new Map<Worker, number>();
  // Idempotent per worker: a failing arm can deliver both an error message AND
  // an onerror event, and the double decrement would settle the race early.
  const retired = new Set<Worker>();

  const terminateAll = () => {
    // Sets the flag as well as killing the workers. `retire` and `spawnNext`
    // guard only on this, so a `done` that reaches here synchronously would
    // otherwise back-fill a fresh worker after the portfolio was torn down.
    settled = true;
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
    let decided = 0;
    for (const count of decidedByWorker.values())
      decided = Math.max(decided, count);
    callbacks.onProgress?.(nodes, decided);
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
      nodesByWorker.set(worker, Number(data.nodes));
      decidedByWorker.set(worker, Number(data.decided ?? 0));
      reportProgress();
      return;
    }
    if (data.type === "done") {
      anyArmFinished = true;
      const result: ArmResult = {
        status: (data.status as LogicGridStatus) ?? "unsolved",
        reason: data.reason as string | undefined,
        cells: (data.cells as number[]) ?? [],
        proven: data.proven === true,
        decided: Number(data.decided ?? 0),
        playable: Number(data.playable ?? 0),
        witnesses: (data.witnesses as number[][]) ?? [],
        stats: data.stats as SolveStats | undefined,
      };
      decidedByWorker.set(worker, result.decided);
      reportProgress();
      callbacks.onArm?.(result);
      retire(worker);
      return;
    }
    if (data.type === "error") {
      // A dying arm (a wasm heap that could not grow aborts its module)
      // retires itself; the portfolio fails only when every arm has failed.
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
