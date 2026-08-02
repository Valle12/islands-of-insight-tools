import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { PORTFOLIO } from "../../src/pages/logic-grid-solver/wasmBridge";
import { verifyLogicGrid } from "../../src/pages/logic-grid-solver/verify";
import { instantiateFromDisk } from "../../src/util/wasmModule";
import type { LogicGridTest } from "../../src/util/types";
import {
  deepSearchBoard,
  impossibleBoard,
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

function toPuzzle(config: LogicGridTest) {
  const cells: number[] = [];
  for (let y = 0; y < config.gridHeight; y++) {
    for (let x = 0; x < config.gridWidth; x++) cells.push(config.cells[x]![y]!);
  }
  return {
    gridWidth: config.gridWidth,
    gridHeight: config.gridHeight,
    cells,
    rules: config.rules,
    clues: config.symbols.map(symbol => ({
      x: symbol.x,
      y: symbol.y,
      type: symbol.type,
      value:
        symbol.type === 1
          ? (String(symbol.value).codePointAt(0) ?? 65) - 65
          : Number(symbol.value),
    })),
  };
}

const flat = (values: ArrayLike<number>) =>
  Array.from({ length: values.length }, (_, i) => values[i]!);

/**
 * Not a `.slow.test.ts`, unlike the other solvers' wasm sweeps, and not behind
 * `IOI_SKIP_SLOW`: measured at **579 ms** for all 36 boards through all four
 * arms, because 31 of the captured boards never branch at all. It runs in the
 * fast lane so `bun run test:fast` covers it too. If a future capture drags
 * this into the tens of seconds, rename it back and give it a CI shard — the
 * opt-out gate is for suites that genuinely cost something.
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
