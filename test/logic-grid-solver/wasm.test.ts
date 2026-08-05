import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { LIGHT, UNKNOWN } from "../../src/pages/logic-grid-solver/cell";
import {
  PORTFOLIO,
  toPuzzle,
} from "../../src/pages/logic-grid-solver/wasmBridge";
import { verifyLogicGrid } from "../../src/pages/logic-grid-solver/verify";
import { instantiateFromDisk } from "../../src/util/wasmModule";
import type { LogicGridTest } from "../../src/util/types";
import {
  areaFiveBoard,
  areaFourBoard,
  areaTwoBoard,
  dartBoard,
  dartInMergedBoard,
  dartOverMergedBoard,
  deepSearchBoard,
  forbiddenTripleBoard,
  impossibleBoard,
  lotusBoard,
  lotusOverMergedBoard,
  mergedCellBoard,
  runFiveBoard,
  solvableBoard,
  teeBoard,
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

async function loadWasm(): Promise<WasmModule> {
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
  ["area-four", areaFourBoard],
  // Six wide on purpose: area five implies a forbidden run of SIX, and this is
  // the only board here that six-cell clause even fits on — the first pattern
  // to need `kMaxPatternCells` above five crosses the boundary right here.
  ["area-five", areaFiveBoard],
  // The mixed-colour triple and the T: both are new pattern families, so each
  // gets the same shortest-path-through-the-module board the runs have.
  ["forbidden-triple", forbiddenTripleBoard],
  ["tee", teeBoard],
  // The two dart boards are here for the same reason the merged-cell one is:
  // `toPuzzle` is the only place a clue's `direction` crosses the boundary, and
  // a sweep over the captured corpus would go green while never once sending
  // the key — every captured board predates it. A dart that arrived without a
  // direction is refused by the module, so these fail loudly rather than
  // quietly solving a different puzzle.
  ["dart", dartBoard],
  ["dart-over-merged", dartOverMergedBoard],
  // ...and this one for where the clue SITS: a dart on a chosen square of a
  // merged cell is a different puzzle from the same dart on its neighbour, so
  // it is the one board the whole "keep the square the file names" rule can be
  // read off the answer.
  ["dart-in-merged", dartInMergedBoard],
  // The lotus rides the same argument as the darts, twice over: `direction`
  // as an AXIS and the new `seat` key cross the boundary nowhere else.
  ["lotus", lotusBoard],
  ["lotus-over-merged", lotusOverMergedBoard],
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

  /**
   * The sweep above asks what holds whatever a board turns out to be. This one
   * asks the opposite, because there is exactly one thing about merged cells
   * that can only be read off an ANSWER: which square of one a clue sits on.
   *
   * The dart is on the right-hand square of a two-square cell, so its line runs
   * down column 1 and the two cells beneath it are forced light. Moved to the
   * left square — which is where the editor re-homed every clue, and the only
   * place the validator used to allow a dart — the identical file would force
   * column 0 instead. Underclued, so the answer IS the forced set and no other
   * cell is painted to confuse the reading.
   */
  test("a dart's line starts at the square it sits on, not its cell's middle", async () => {
    const wasm = await loadWasm();
    const config = dartInMergedBoard();
    // Named rather than taken from `PORTFOLIO`: this asks one engine one
    // question, and the underclued refutation loop is the arm that answers it.
    const result = wasm.solve(toPuzzle(config), {
      engine: "cascade",
      seed: 0,
      maxMs: ARM_MS,
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe("deduced");
    expect(result.proven).toBeTrue();

    const answer = flat(result.cells);
    const at = (x: number, y: number) => answer[y * config.gridWidth + x];
    expect([at(1, 1), at(1, 2)]).toEqual([LIGHT, LIGHT]);
    // The column the old rule would have named stays undecided, which is what
    // makes this a pin rather than a coincidence.
    expect([at(0, 1), at(0, 2)]).toEqual([UNKNOWN, UNKNOWN]);
  }, 30_000);
});
