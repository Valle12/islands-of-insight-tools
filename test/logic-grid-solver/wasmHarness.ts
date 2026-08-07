import { expect } from "bun:test";
import { resolve } from "node:path";
import {
  PORTFOLIO,
  toPuzzle,
} from "../../src/pages/logic-grid-solver/wasmBridge";
import { verifyLogicGrid } from "../../src/pages/logic-grid-solver/verify";
import { instantiateFromDisk } from "../../src/util/wasmModule";
import type { LogicGridTest } from "../../src/util/types";

/**
 * The glue both wasm suites share: `wasm.test.ts` drives the hand-built
 * boundary boards through it and `wasm.slow.test.ts` the captured corpus.
 * A module rather than duplicated blocks, because importing one test file
 * from another would re-register its tests.
 */

export const WASM_DIR = resolve(
  import.meta.dir,
  "../../src/pages/logic-grid-solver/wasm",
);
export const RESOURCE_DIR = resolve(
  import.meta.dir,
  "../resources/logic-grid-solver",
);

/**
 * Deliberately short, because of what the agreement sweep is FOR.
 *
 * What it checks is agreement — that the shipped module never errors, that its
 * own oracle never rejects its propagators' work, that any complete answer
 * satisfies the page's rules, and that no two arms disagree about solvability.
 * None of that needs a long budget: an arm that runs out reports `unsolved`,
 * which says nothing either way and is already left out of the vote.
 *
 * "The corpus solves" is a different claim and lives in the C++ `fixtures_test`,
 * where one engine runs once per board rather than four arms racing. Several of
 * the captured boards need seconds rather than milliseconds, so paying for them
 * four times over here would buy a slower suite and no extra coverage.
 */
export const ARM_MS = 2_000;

export interface WasmResult {
  error?: string;
  status: string;
  cells: ArrayLike<number>;
  proven: boolean;
  decided: number;
  playable: number;
  witnesses: ArrayLike<ArrayLike<number>>;
  stats?: { oracleRejections: number; arm: string };
}

export interface WasmModule {
  solve(puzzle: unknown, config: Record<string, unknown>): WasmResult;
  verify(puzzle: unknown, cells: number[]): boolean;
}

export const flat = (values: ArrayLike<number>) =>
  Array.from({ length: values.length }, (_, i) => values[i]!);

export async function loadWasm(): Promise<WasmModule> {
  // The module posts progress through `self.postMessage`; outside a worker
  // there is nobody to hear it, and a sink is all it needs.
  const globals = globalThis as Record<string, unknown>;
  globals.self ??= { postMessage() {} };

  const factory = (await import(resolve(WASM_DIR, "astar.mjs"))).default as (
    options: unknown,
  ) => Promise<WasmModule>;
  return factory(instantiateFromDisk(resolve(WASM_DIR, "astar.wasm")));
}

/**
 * The agreement sweep's whole per-board body: race every arm of the shipped
 * portfolio and assert what holds whatever the board turns out to be — no
 * module error, no oracle rejection of the module's own work, every complete
 * answer and witness passing the page's own checker, and no two arms
 * disagreeing about solvability.
 */
export async function expectEveryArmAgrees(
  load: () => Promise<LogicGridTest> | LogicGridTest,
) {
  const wasm = await loadWasm();
  const config = await load();
  const puzzle = toPuzzle(config);

  const verdicts = new Set<boolean>();
  for (const arm of PORTFOLIO) {
    const result = wasm.solve(puzzle, { ...arm, maxMs: ARM_MS });
    expect(result.error).toBeUndefined();
    expect(result.stats?.oracleRejections ?? 0).toBe(0);

    if (result.status === "solved") {
      const answer = flat(result.cells);
      expect(verifyLogicGrid(config, answer)).toBe("none");
      expect(wasm.verify(puzzle, answer)).toBeTrue();
    }
    for (let i = 0; i < result.witnesses.length; i++)
      expect(verifyLogicGrid(config, flat(result.witnesses[i]!))).toBe("none");

    // "unsolved" only means this arm ran out of budget, so it says nothing
    // either way and is left out of the vote.
    if (result.status !== "unsolved")
      verdicts.add(result.status !== "unsolvable");
  }
  expect(verdicts.size).toBeLessThanOrEqual(1);
}

/** The sweeps' shared per-case timeout: every arm's budget plus load slack. */
export const SWEEP_TIMEOUT_MS = PORTFOLIO.length * ARM_MS + 30_000;
