import type { LogicGridTest } from "../../util/types";
import { UNKNOWN } from "./cell";
import { SOLVE_BUDGET_MS } from "./config";
import {
  searchLogicGridWasm,
  type ArmResult,
  type WasmHandle,
} from "./wasmBridge";
import { verifyLogicGrid } from "./verify";

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
  | { status: "budget"; cells: number[]; decided: number; playable: number }
  | { status: "failed"; error: string };

export interface SolveHandle {
  cancel(): void;
}

export interface SolveCallbacks {
  onProgress?: (nodes: number, decided: number) => void;
  onDone: (result: LogicGridSolveResult) => void;
}

/**
 * How much an arm's answer is worth. Only ever asked about answers that have
 * already passed `check`.
 *
 * A complete solution outranks an "unsolvable" claim deliberately: a negative
 * cannot be verified from outside the solver, and if two arms ever disagree,
 * the one holding a board that satisfies every rule is the one to believe.
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

function toResult(result: ArmResult): LogicGridSolveResult {
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
  };
}

export function solveLogicGrid(
  config: LogicGridTest,
  callbacks: SolveCallbacks,
  budgetMs = SOLVE_BUDGET_MS,
): SolveHandle {
  let best: ArmResult | null = null;
  let bestRank = -1;
  let finished = false;
  let handle: WasmHandle | null = null;

  const finish = (result: LogicGridSolveResult) => {
    if (finished) return;
    finished = true;
    handle?.terminate();
    callbacks.onDone(result);
  };

  handle = searchLogicGridWasm(
    config,
    {
      onProgress: (nodes, decided) => callbacks.onProgress?.(nodes, decided),
      onArm: result => {
        if (finished) return;
        // An answer the page cannot confirm is not an answer. Dropping it here
        // rather than ranking it low is the difference between showing nothing
        // and showing a board that breaks the rules it was solved under.
        if (!check(config, result)) return;
        const score = rank(result);
        if (score <= bestRank) return;
        bestRank = score;
        best = result;
      },
      onSettled: () => {
        if (best === null) {
          finish({
            status: "budget",
            cells: [],
            decided: 0,
            playable: 0,
          });
          return;
        }
        finish(toResult(best));
      },
      onError: message => finish({ status: "failed", error: message }),
    },
    budgetMs,
  );

  return {
    cancel: () => {
      handle?.terminate();
      finished = true;
    },
  };
}
