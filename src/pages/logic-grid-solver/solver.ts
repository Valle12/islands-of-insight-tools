import type { LogicGridTest } from "../../util/types";
import { UNKNOWN } from "./cell";
import { SOLVE_BUDGET_MS } from "./config";
import {
  searchLogicGridWasm,
  type ArmResult,
  type WasmHandle,
} from "./wasmBridge";
import { UNDERCLUED, verifyLogicGrid } from "./verify";

/**
 * The page's side of the search: it starts the C++ arms, keeps the best answer
 * any of them produced, and refuses one it cannot check.
 *
 * Checking is the point. A complete answer is replayed through `verify.ts`
 * before it can reach the board — the page's own rules, not the solver's. An
 * underclued answer cannot be checked that way (proving a cell forced is the
 * same work as finding it), so what is checked instead is the part that can
 * be: every example solution the solver sent back must itself be legal, and
 * must agree with every cell the answer claims is forced. A wrong "forced"
 * that any of those witnesses contradicts is caught here rather than shown.
 *
 * The race also ends the moment a checked answer reaches the rank nothing
 * could beat — a verified complete solution, or the proven forced set on an
 * underclued board. Waiting for the slower arms could change nothing then,
 * and on a page running the portfolio across separate workers it costs
 * minutes: an arm that cannot answer only retires when its budget runs out.
 */

export type LogicGridSolveResult =
  | {
      status: "solved";
      /** Flat row-major, one entry per cell — see `verify.ts`. */
      cells: number[];
      decided: number;
      playable: number;
    }
  | {
      status: "deduced";
      cells: number[];
      decided: number;
      playable: number;
      /** False when the budget ran out with cells still undecidable. */
      proven: boolean;
    }
  | { status: "unsolvable"; reason?: string }
  | {
      status: "budget";
      cells: number[];
      decided: number;
      playable: number;
      /** Some arm stopped because the heap ran out, not the clock. */
      stoppedOnMemory: boolean;
    }
  | { status: "failed"; error: string };

export interface SolveHandle {
  cancel(): void;
}

export interface SolveCallbacks {
  onProgress?: (nodes: number, decided: number, phase?: string) => void;
  onDone: (result: LogicGridSolveResult) => void;
}

/**
 * How much an arm's answer is worth. Only ever asked about answers that have
 * already passed `check`.
 *
 * A complete solution outranks an "unsolvable" claim deliberately: a negative
 * cannot be verified from outside the solver, and if two arms ever disagree,
 * the one holding a board that satisfies every rule is the one to believe.
 * The early settle reads the same ordering: 5 is terminal everywhere and 4 on
 * an underclued board (whose arms can only ever answer `deduced`), while 3
 * deliberately is not — an `unsolvable` claim keeps the race open, so a later
 * verified solution still overrides it.
 */
function rank(result: ArmResult): number {
  if (result.status === "solved") return 5;
  if (result.status === "deduced") return result.proven ? 4 : 2;
  if (result.status === "unsolvable") return 3;
  return result.decided > 0 ? 1 : 0;
}

/** Whether every witness is legal and agrees with what the answer claims. */
function witnessesSupport(
  config: LogicGridTest,
  result: ArmResult,
): boolean {
  // No witnesses is not "nothing to object to" — it is nothing CHECKED, and an
  // empty list would sail through the loop below and hand the board a `proven`
  // answer this file never looked at. An underclued answer is the intersection
  // of the solutions, so a real one always has at least one to show; a list
  // that arrives empty (a truncated message, an arm built with witnessLimit 0)
  // is refused rather than trusted.
  if (result.witnesses.length === 0) return false;
  for (const witness of result.witnesses) {
    if (verifyLogicGrid(config, witness) !== "none") return false;
    const disagrees = result.cells.some(
      (color, index) => color !== UNKNOWN && witness[index] !== color,
    );
    if (disagrees) return false;
  }
  return true;
}

function check(config: LogicGridTest, result: ArmResult): boolean {
  if (result.status === "solved")
    return verifyLogicGrid(config, result.cells) === "none";
  if (result.status === "deduced") return witnessesSupport(config, result);
  return true;
}

function toResult(
  result: ArmResult,
  stoppedOnMemory: boolean,
): LogicGridSolveResult {
  if (result.status === "solved") {
    return {
      status: "solved",
      cells: result.cells,
      decided: result.decided,
      playable: result.playable,
    };
  }
  if (result.status === "deduced") {
    return {
      status: "deduced",
      cells: result.cells,
      decided: result.decided,
      playable: result.playable,
      proven: result.proven,
    };
  }
  if (result.status === "unsolvable")
    return { status: "unsolvable", reason: result.reason };
  return {
    status: "budget",
    cells: result.cells,
    decided: result.decided,
    playable: result.playable,
    stoppedOnMemory,
  };
}

export function solveLogicGrid(
  config: LogicGridTest,
  callbacks: SolveCallbacks,
  budgetMs = SOLVE_BUDGET_MS,
): SolveHandle {
  let best: ArmResult | null = null;
  let bestRank = -1;
  // Sticky across arms: an out-of-memory stop colors the whole race's give-up
  // message, even when the arm's own answer was refused below.
  let sawMemoryStop = false;
  // The rank nothing later could beat — settling there is what spares the
  // multi-worker page waiting on arms that can only tie. See `rank`.
  const terminalRank = config.rules.includes(UNDERCLUED) ? 4 : 5;
  let finished = false;
  let handle: WasmHandle | null = null;
  /**
   * An answer that arrived before `searchLogicGridWasm` returned.
   *
   * It can: the bridge settles synchronously when no worker could be started at
   * all, and `handle` is only assigned once the call comes back. Reporting from
   * inside the call would hand the page a result while `handle` is still null —
   * so the portfolio never gets torn down — and would run `onDone` before the
   * caller holds anything it could cancel.
   */
  let pending: LogicGridSolveResult | null = null;
  let started = false;

  const finish = (result: LogicGridSolveResult) => {
    if (finished) return;
    finished = true;
    if (!started) {
      pending = result;
      return;
    }
    handle?.terminate();
    callbacks.onDone(result);
  };

  handle = searchLogicGridWasm(
    config,
    {
      onProgress: (nodes, decided, phase) =>
        callbacks.onProgress?.(nodes, decided, phase),
      onArm: result => {
        if (finished) return;
        // Before the checks: an arm that ran out of memory said so however
        // its answer fares below.
        if (result.stats?.stoppedOnMemory) sawMemoryStop = true;
        // An answer the page cannot confirm is not an answer. Dropping it here
        // rather than ranking it low is the difference between showing nothing
        // and showing a board that breaks the rules it was solved under.
        if (!check(config, result)) return;
        const score = rank(result);
        if (score <= bestRank) return;
        bestRank = score;
        best = result;
        if (bestRank >= terminalRank) finish(toResult(result, sawMemoryStop));
      },
      onSettled: () => {
        if (best === null) {
          finish({
            status: "budget",
            cells: [],
            decided: 0,
            playable: 0,
            stoppedOnMemory: sawMemoryStop,
          });
          return;
        }
        finish(toResult(best, sawMemoryStop));
      },
      onError: message => finish({ status: "failed", error: message }),
    },
    budgetMs,
  );
  started = true;
  if (pending !== null) {
    handle.terminate();
    callbacks.onDone(pending);
  }

  return {
    cancel: () => {
      handle?.terminate();
      finished = true;
    },
  };
}
