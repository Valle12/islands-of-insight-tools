import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  PORTFOLIO,
  toPuzzle,
} from "../../src/pages/logic-grid-solver/wasmBridge";
import { verifyLogicGrid } from "../../src/pages/logic-grid-solver/verify";
import { instantiateFromDisk } from "../../src/util/wasmModule";
import type { LogicGridTest } from "../../src/util/types";
import {
  areaTwoBoard,
  deepSearchBoard,
  impossibleBoard,
  mergedCellBoard,
  runFiveBoard,
  solvableBoard,
  undercluedBoard,
} from "./boards";

/**
 * The shipped arm set against the real C++ module.
 *
 * `PORTFOLIO` is imported rather than restated, so this races exactly what the
 * page races. Every board goes through every arm, and what is asserted is what
 * has to hold whatever the board turns out to be: the module never errors, its
 * own oracle never rejects what its propagators produced, any complete answer
 * satisfies the page's rules, and no two arms disagree about whether the board
 * can be solved at all.
 *
 * Four hand-built boards run first so the sweep still means something on a
 * checkout with no captured boards in it; everything in
 * `test/resources/logic-grid-solver/` runs after them.
 */

const WASM_DIR = resolve(
  import.meta.dir,
  "../../src/pages/logic-grid-solver/wasm",
);
const RESOURCE_DIR = resolve(
  import.meta.dir,
  "../resources/logic-grid-solver",
);

/**
 * Deliberately short, because of what this suite is FOR.
 *
 * What it checks is agreement — that the shipped module never errors, that its
 * own oracle never rejects its propagators' work, that any complete answer
 * satisfies the page's rules, and that no two arms disagree about solvability.
 * None of that needs a long budget: an arm that runs out reports `unsolved`,
 * which says nothing either way and is already left out of the vote.
 *
 * "The corpus solves" is a different claim and lives in the C++ `fixtures_test`,
 * where one engine runs once per board rather than four arms racing. Two of the
 * captured boards need seconds rather than milliseconds, so paying for them
 * four times over here would buy a slower suite and no extra coverage.
 *
 * What this suite must keep is a board deep enough to stress the wasm stack —
 * `deepSearchBoard` — because the recursion that overflowed it was a
 * wasm-ONLY failure the native lane could not have caught.
 */
const ARM_MS = 2_000;

interface WasmResult {
  error?: string;
  status: string;
  cells: ArrayLike<number>;
  proven: boolean;
  decided: number;
  playable: number;
  witnesses: ArrayLike<ArrayLike<number>>;
  stats?: { oracleRejections: number; arm: string };
}

interface WasmModule {
  solve(puzzle: unknown, config: Record<string, unknown>): WasmResult;
  verify(puzzle: unknown, cells: number[]): boolean;
}

const flat = (values: ArrayLike<number>) =>
  Array.from({ length: values.length }, (_, i) => values[i]!);

/**
 * Not a `.slow.test.ts`, unlike the other solvers' wasm sweeps, and not behind
 * `IOI_SKIP_SLOW`, so `bun run test:fast` covers it too.
 *
 * That choice was made when this measured **579 ms for 36 boards**, most of the
 * captured corpus ago. Measured again 2026-08-03: **40.7 s for 164 boards**
 * through all four arms — the board count quadrupled and the cost went up
 * about seventyfold, because the boards captured since are the ones that
 * actually branch and several now spend the whole 2 s per-arm budget.
 *
 * So this is past the "tens of seconds" mark the note here used to give as the
 * point to think again, and the decision is live rather than settled. Renaming
 * it back is not free: `bun-test` fans out one shard per `.slow.test.ts` plus
 * one for the fast remainder, so it would mean a sixth shard in CI.
 */

const captured = readdirSync(RESOURCE_DIR).filter(name =>
  name.endsWith(".json"),
);

type Case = [name: string, load: () => Promise<LogicGridTest> | LogicGridTest];

const CASES: Case[] = [
  ["solvable", solvableBoard],
  ["underclued", undercluedBoard],
  ["impossible", impossibleBoard],
  ["run-five", runFiveBoard],
  ["area-two", areaTwoBoard],
  ["merged-cells", mergedCellBoard],
  ["deep-search", deepSearchBoard],
  ...captured.map(
    (name): Case => [
      name,
      () => Bun.file(`${RESOURCE_DIR}/${name}`).json() as Promise<LogicGridTest>,
    ],
  ),
];

describe("logic-grid wasm", () => {
  test.each(CASES)(
    "every arm agrees about %s",
    async (_name, load) => {
      // The module posts progress through `self.postMessage`; outside a worker
      // there is nobody to hear it, and a sink is all it needs.
      const globals = globalThis as Record<string, unknown>;
      globals.self ??= { postMessage() {} };

      const factory = (
        await import(resolve(WASM_DIR, "astar.mjs"))
      ).default as (options: unknown) => Promise<WasmModule>;
      const wasm = await factory(
        instantiateFromDisk(resolve(WASM_DIR, "astar.wasm")),
      );

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
          expect(verifyLogicGrid(config, flat(result.witnesses[i]!))).toBe(
            "none",
          );

        // "unsolved" only means this arm ran out of budget, so it says nothing
        // either way and is left out of the vote.
        if (result.status !== "unsolved")
          verdicts.add(result.status !== "unsolvable");
      }
      expect(verdicts.size).toBeLessThanOrEqual(1);
    },
    PORTFOLIO.length * ARM_MS + 30_000,
  );
});
