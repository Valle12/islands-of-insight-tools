import {
  armPoolSize,
  crossOriginIsolatedPage,
  startWasmPool,
  type WasmPoolHandle,
} from "../../util/wasmPool";
import type { MatchThreeTest } from "../../util/types";
import { SOLVE_BUDGET_MS } from "./config";
import type { Move } from "./rules";

/**
 * One arm per entry, each in its own worker with its own heap. Order is
 * priority: on a machine with few cores the later arms wait for a slot.
 *
 * Unlike the rolling-blocks portfolio these arms do NOT share bounds — a
 * separate worker is a separate module instance, and the C++ side has no way to
 * accept a bound mid-solve. That costs nothing now: the race ends at the first
 * answer any arm produces, so there is no incumbent for the others to benefit
 * from. Real cooperation happens on the isolated path, where one module races
 * the same arm set over a shared `Bounds` — SolverArms.cpp's kPortfolio, which
 * this list mirrors.
 */
export const PORTFOLIO: Record<string, unknown>[] = [
  // Near-free, and remarkably good when it lands: measured over the 52 captured
  // boards it answers 38 of them, worst case 4 ms, and every one of those 38 is
  // what an exhaustive search would have called optimal anyway. It just says
  // nothing about the other 14, which is what the rest of this list is for.
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
  // The exhaustive search: the finder of last resort, and the only arm that can
  // report a board unclearable. Measured: it answers matchThreeTest47.
  { engine: "exhaustive", maxMs: SOLVE_BUDGET_MS },
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
  readonly unsolvable: boolean;
  readonly stats?: SolveStats;
}

export interface WasmCallbacks {
  /** Cumulative work across every arm, retired ones included. */
  readonly onProgress?: (nodes: number) => void;
  /** A candidate solution, before any validation. */
  readonly onBest?: (moves: Move[]) => void;
  /** An arm that finished, whatever it found. */
  readonly onArm?: (result: ArmResult) => void;
  /** Every arm has finished or failed; nothing more will be reported. */
  readonly onSettled?: () => void;
  /** No arm produced anything, including any that failed to start. */
  readonly onError?: (message: string) => void;
}

/** The one way to stop the race — see `src/util/wasmPool.ts`. */
export type WasmHandle = WasmPoolHandle;

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

  // Every arm always runs: the pool bounds how many go at once, never which
  // ones exist. The list collapses only where one module races the same arms
  // itself — on an isolated page, or on a machine with a single slot, where
  // spawning them one at a time would just serialise the portfolio.
  const isolated = crossOriginIsolatedPage();
  const configs =
    isolated || armPoolSize(PORTFOLIO.length) === 1
      ? [{ engine: "cascade", maxMs: budgetMs }]
      : PORTFOLIO.map(arm => ({ ...arm, maxMs: budgetMs }));

  // Sticky: an arm that searched out cleanly means "no answer within budget",
  // which is a result. Only a portfolio where every arm DIED is a failure.
  let anyArmFinished = false;

  return startWasmPool({
    workerUrl: WORKER_URL,
    configs,
    payload: { puzzle },
    startupError: "The solver could not be started.",
    onProgress: nodes => callbacks.onProgress?.(nodes),
    onMessage: (data, arm) => {
      if (data.type === "progress") {
        arm.progress(Number(data.progress));
        return;
      }
      if (data.type === "best") {
        callbacks.onBest?.((data.moves as Move[]) ?? []);
        return;
      }
      if (data.type === "done") {
        anyArmFinished = true;
        callbacks.onArm?.({
          // `?? []` because the cast is a promise, not a check: a build that
          // stopped sending the field would otherwise be walked as `undefined`
          // inside the pool's message handler, which has no `try` — and an arm
          // that throws never retires, so the race would never settle.
          moves: (data.moves as Move[]) ?? [],
          unsolvable: data.unsolvable === true,
          stats: data.stats as SolveStats | undefined,
        });
        arm.retire();
        return;
      }
      if (data.type === "error") {
        // A dying arm (a wasm heap that could not grow aborts its module)
        // retires itself; the portfolio fails only when every arm has failed.
        arm.fail(String(data.error));
        arm.retire();
      }
    },
    onExhausted: lastError => {
      if (anyArmFinished) callbacks.onSettled?.();
      else callbacks.onError?.(lastError);
    },
  });
}
