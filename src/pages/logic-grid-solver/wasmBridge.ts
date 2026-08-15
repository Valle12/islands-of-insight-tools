import type { LogicGridTest } from "../../util/types";
import {
  crossOriginIsolatedPage,
  startWasmPool,
  type WasmPoolHandle,
} from "../../util/wasmPool";
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

/** The one way to stop the race — see `src/util/wasmPool.ts`. */
export type WasmHandle = WasmPoolHandle;

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
      // A letter crosses as 0..25; the valueless lotus as the 0 the module
      // requires of it.
      value:
        symbolKindAt(symbol.type)?.valueKind === "letter"
          ? letterIndex(symbol.value ?? "A")
          : Number(symbol.value ?? 0),
      // Sent as -1 rather than omitted when a clue has none: the module reads
      // the key unconditionally and validates it against the kind, so a missing
      // direction on a kind that needs one has to arrive as a value it can
      // refuse rather than as `undefined`. A lotus's direction is its AXIS.
      direction: symbol.direction ?? -1,
      // The lotus's half-square offsets; the centre for everything else.
      seat: symbol.seat ?? 0,
    })),
    // The sized rules cross in the config's own shape — string colours and
    // all — because the module reads the identical JSON from a fixture file,
    // and two encodings of one key is how the readers drift. Omitted rather
    // than sent empty, like `shapes` below.
    ...(config.areas ? { areas: config.areas.map(rule => ({ ...rule })) } : {}),
    ...(config.runs ? { runs: config.runs.map(rule => ({ ...rule })) } : {}),
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

  // Every arm always runs: the pool bounds how many go at once, never which
  // ones exist — they queue and back-fill as earlier ones retire. That is why
  // only the ISOLATED case collapses the list: there the pthreads module races
  // `kPortfolio` on real threads inside one worker, so spawning the arms out
  // here as well would run each of them twice. A small pool is NOT a reason to
  // drop any — it just means they take longer to all get a turn, and dropping
  // them would cost a one- or two-core machine the near-free `deduce` arm that
  // finishes most boards on its own.
  const configs = crossOriginIsolatedPage()
    ? [{ engine: "cascade", maxMs: budgetMs }]
    : PORTFOLIO.map(arm => ({ ...arm, maxMs: budgetMs }));

  // Sticky: an arm that searched out cleanly means "no answer within budget",
  // which is a result. Only a portfolio where every arm DIED is a failure.
  let anyArmFinished = false;
  // Nodes are summed by the pool; `decided` is the deduction pass's count, so
  // the most any one arm settled is the number to show — summing four arms'
  // views of the same board would multiply it.
  const decidedByArm = new Map<number, number>();

  // Held so a `done` can re-report without disturbing it: that message carries
  // no node count, and feeding it 0 would drop the arm's whole contribution out
  // of the running total the moment it finished.
  let lastNodes = 0;
  const reportProgress = (nodes: number) => {
    lastNodes = nodes;
    let decided = 0;
    for (const count of decidedByArm.values())
      decided = Math.max(decided, count);
    callbacks.onProgress?.(nodes, decided);
  };

  return startWasmPool({
    workerUrl: WORKER_URL,
    configs,
    payload: { puzzle },
    startupError: "The solver could not be started.",
    onProgress: reportProgress,
    onMessage: (data, arm) => {
      if (data.type === "progress") {
        decidedByArm.set(arm.index, Number(data.decided ?? 0));
        arm.progress(Number(data.nodes));
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
        decidedByArm.set(arm.index, result.decided);
        reportProgress(lastNodes);
        callbacks.onArm?.(result);
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
