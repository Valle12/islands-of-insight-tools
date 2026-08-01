import type { LogicGridTest } from "../../util/types";

/**
 * A stub. The search itself is not written yet — this exists so the page has a
 * real call site to grow it behind, and so "Solve" says something honest rather
 * than nothing.
 */
export type LogicGridSolveResult = {
  /** The only status there is until the search exists. */
  status: "unimplemented";
  /** What the solver was handed, so the panel can show the board was read. */
  summary: string;
};

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

export function solveLogicGrid(config: LogicGridTest): LogicGridSolveResult {
  return {
    status: "unimplemented",
    summary: `${config.gridWidth}x${config.gridHeight}, ${count(
      config.rules.length,
      "rule",
    )}, ${count(config.symbols.length, "symbol")}`,
  };
}
