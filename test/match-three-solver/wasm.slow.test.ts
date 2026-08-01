import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PORTFOLIO } from "../../src/pages/match-three-solver/wasmBridge";
import { toBoard } from "../../src/pages/match-three-solver/rules";
import type { MatchThreeTest } from "../../src/util/types";
import { instantiateFromDisk } from "../../src/util/wasmModule";
import { clearsBoard, FIXTURE_DIR, FIXTURES } from "./boards";

// ---------------------------------------------------------------------------
// The wasm engine against the captured corpus. Two things only this suite can
// catch: that the C++ rules still agree with the TypeScript ones — every
// witness here is replayed by the PAGE's own rules, which is what the solution
// viewer will do — and that the arm set the bridge ships actually works, since
// PORTFOLIO is imported rather than restated.
//
// Runs by DEFAULT, including in CI. Opt OUT with IOI_SKIP_SLOW=1.
// ---------------------------------------------------------------------------

interface WasmMove {
  a: { x: number; y: number };
  b: { x: number; y: number };
}

interface WasmResult {
  error?: string;
  moves: { length: number; [index: number]: WasmMove };
  unsolvable: boolean;
}

interface WasmModule {
  solve(
    puzzle: { gridWidth: number; gridHeight: number; cells: number[] },
    config: Record<string, unknown>,
  ): WasmResult;
  verify(
    puzzle: { gridWidth: number; gridHeight: number; cells: number[] },
    moves: WasmMove[],
  ): boolean;
}

async function loadWasmModule(): Promise<WasmModule> {
  const wasmDir = join(
    dirname(fileURLToPath(import.meta.url)),
    "../../src/pages/match-three-solver/wasm",
  );
  const createModule = (await import(join(wasmDir, "astar.mjs"))).default;
  return createModule(instantiateFromDisk(join(wasmDir, "astar.wasm")));
}

/** The bindings take cells flat and row-major; fixtures store them by column. */
function toPuzzle(config: MatchThreeTest) {
  const cells: number[] = new Array(config.gridWidth * config.gridHeight);
  for (let x = 0; x < config.gridWidth; x++) {
    for (let y = 0; y < config.gridHeight; y++) {
      cells[y * config.gridWidth + x] = config.cells[x]![y]!;
    }
  }
  return {
    gridWidth: config.gridWidth,
    gridHeight: config.gridHeight,
    cells,
  };
}

/** Embind's vector view as a plain array. */
function plainMoves(result: WasmResult): WasmMove[] {
  const moves: WasmMove[] = [];
  for (let i = 0; i < result.moves.length; i++) {
    const move = result.moves[i]!;
    moves.push({
      a: { x: move.a.x, y: move.a.y },
      b: { x: move.b.x, y: move.b.y },
    });
  }
  return moves;
}

async function readFixture(name: string): Promise<MatchThreeTest> {
  return (await Bun.file(`${FIXTURE_DIR}/${name}`).json()) as MatchThreeTest;
}

/**
 * The boards the cheap arms cannot crack, whose answers come from the
 * stochastic NRPA arm. They get their own budget in the sweep, and their own
 * positive assertion further down.
 */
const STOCHASTIC = new Set([
  "matchThreeTest47.json",
  "matchThreeTest50.json",
  "matchThreeTest51.json",
]);

/**
 * Length CEILINGS — the same table the TypeScript sweep carries.
 *
 * They were exact proven minima, and the equality across the two engines was
 * the cross-engine check. The search no longer proves anything about length, so
 * these are an upper bound instead: a quality net against an arm-ordering
 * regression. The firewall against a rules divergence is now the replay below,
 * which was always the thing that actually caught an unplayable witness.
 */
const LENGTH_CEILINGS: Record<string, number> = {
  "matchThreeTest.json": 1,
  "matchThreeTest1.json": 2,
  "matchThreeTest2.json": 2,
  "matchThreeTest3.json": 2,
  "matchThreeTest4.json": 1,
  "matchThreeTest5.json": 2,
  "matchThreeTest6.json": 2,
  "matchThreeTest7.json": 1,
  "matchThreeTest8.json": 7,
  "matchThreeTest9.json": 5,
  "matchThreeTest10.json": 6,
  "matchThreeTest11.json": 7,
  "matchThreeTest12.json": 6,
  "matchThreeTest13.json": 10,
  "matchThreeTest14.json": 7,
  "matchThreeTest15.json": 3,
  "matchThreeTest16.json": 2,
  "matchThreeTest17.json": 4,
  "matchThreeTest18.json": 6,
  "matchThreeTest19.json": 4,
  "matchThreeTest20.json": 7,
  "matchThreeTest21.json": 3,
  "matchThreeTest22.json": 1,
  "matchThreeTest23.json": 2,
  "matchThreeTest24.json": 3,
  "matchThreeTest25.json": 4,
  "matchThreeTest26.json": 4,
  "matchThreeTest27.json": 6,
  "matchThreeTest28.json": 5,
  "matchThreeTest29.json": 2,
  "matchThreeTest30.json": 3,
  "matchThreeTest31.json": 6,
  "matchThreeTest32.json": 5,
  "matchThreeTest33.json": 4,
  "matchThreeTest34.json": 3,
  "matchThreeTest35.json": 8,
  "matchThreeTest36.json": 4,
  "matchThreeTest37.json": 5,
  "matchThreeTest38.json": 4,
  "matchThreeTest39.json": 6,
  "matchThreeTest40.json": 3,
  "matchThreeTest41.json": 10,
  "matchThreeTest42.json": 6,
  "matchThreeTest43.json": 8,
  "matchThreeTest44.json": 14,
  "matchThreeTest45.json": 7,
  // The one board where the first find is not the optimum: 8, optimum 7.
  "matchThreeTest46.json": 8,
  "matchThreeTest48.json": 7,
  "matchThreeTest49.json": 10,
};

/** Enough for the slowest board that finishes; the sweep runs in one process. */
const SOLVE_MS = 30_000;
const TIMEOUT_MS = 90_000;

/**
 * Per-arm budget in the portfolio sweep, and a deadline DERIVED from it.
 * PORTFOLIO lives in wasmBridge.ts, so an arm added there would otherwise push
 * that sweep's worst case past a fixed timeout — and the failure would read as
 * a test timeout rather than as the arm it belongs to.
 */
const ARM_MS = 10_000;
const ARM_SWEEP_TIMEOUT_MS = PORTFOLIO.length * ARM_MS + 30_000;

describe.skipIf(Bun.env.IOI_SKIP_SLOW === "1")("Match-three wasm", () => {
  test(
    "the whole corpus solves, and every witness replays under the page's rules",
    async () => {
      const module = await loadWasmModule();

      for (const name of FIXTURES) {
        const config = await readFixture(name);
        const puzzle = toPuzzle(config);
        const result = module.solve(puzzle, {
          engine: "cascade",
          maxMs: STOCHASTIC.has(name) ? 4_000 : SOLVE_MS,
        });

        expect(result.error).toBeUndefined();
        // A captured board comes from the game; calling one unsolvable would be
        // a proof that contradicts its own existence.
        expect(result.unsolvable).toBeFalse();

        const moves = plainMoves(result);
        if (moves.length > 0) {
          // THE cross-engine check: the C++ arms produced this, and the page's
          // own TypeScript rules have to accept it move for move.
          expect(clearsBoard(toBoard(config), moves)).toBeTrue();
          expect(module.verify(puzzle, moves)).toBeTrue();
        }
        if (STOCHASTIC.has(name)) continue;

        expect(moves.length).toBeGreaterThan(0);
        const ceiling = LENGTH_CEILINGS[name];
        if (ceiling !== undefined) {
          expect(moves.length).toBeLessThanOrEqual(ceiling);
        }
      }
    },
    TIMEOUT_MS,
  );

  test(
    "every arm the bridge ships answers a captured board",
    async () => {
      const module = await loadWasmModule();
      const config = await readFixture("matchThreeTest28.json");
      const puzzle = toPuzzle(config);

      for (const arm of PORTFOLIO) {
        const result = module.solve(puzzle, { ...arm, maxMs: ARM_MS });
        expect(result.error).toBeUndefined();
        const moves = plainMoves(result);
        expect(moves.length).toBeGreaterThan(0);
        expect(clearsBoard(toBoard(config), moves)).toBeTrue();
      }
    },
    ARM_SWEEP_TIMEOUT_MS,
  );

  test(
    "matchThreeTest47 gets an answer from the exhaustive search",
    async () => {
      // The one hard board a systematic arm cracks. 20 is the known optimum — a
      // 46-minute deepening run in July confirmed it, back when this engine
      // could still prove such a thing — and the search returns 21, because it
      // takes the first line it reaches at maxDepth instead of re-diving under
      // a tighter bound. One of the two boards in the corpus where stopping
      // early costs a move; matchThreeTest46 is the other.
      const module = await loadWasmModule();
      const config = await readFixture("matchThreeTest47.json");
      const puzzle = toPuzzle(config);
      const result = module.solve(puzzle, {
        engine: "exhaustive",
        maxMs: 60_000,
      });

      expect(result.error).toBeUndefined();
      const moves = plainMoves(result);
      expect(moves.length).toBeGreaterThan(0);
      expect(moves.length).toBeLessThanOrEqual(21);
      expect(clearsBoard(toBoard(config), moves)).toBeTrue();
    },
    TIMEOUT_MS,
  );

  /**
   * The two boards nothing found a witness for until NRPA, pinned as a POSITIVE
   * assertion rather than as a tolerated maybe. The sweep above skips them, so
   * it stays green if the arms lose the ability to answer them at all — and
   * losing that ability quietly is exactly what this catches.
   *
   * Each entry names the arm configuration and the seed measured to answer that
   * board, and the budget is roughly 20x the measured time — a stochastic search
   * asserted with a thin margin is a flake, and a thick one is a regression test.
   * Both configurations are in the shipped `PORTFOLIO`; the seed is pinned here
   * so the test does not depend on which arm of a race happens to land first.
   */
  const NRPA_WITNESSES = [
    { name: "matchThreeTest50.json", moves: 23, seed: 1, level: 2,
      iterations: 100, measuredMs: 542 },
    { name: "matchThreeTest51.json", moves: 15, seed: 3, level: 0,
      iterations: 0, measuredMs: 1929 },
  ];

  test.each(NRPA_WITNESSES)(
    "$name yields its $moves-move NRPA witness",
    async ({ name, moves: expected, seed, level, iterations }) => {
      const module = await loadWasmModule();
      const config = await readFixture(name);
      const puzzle = toPuzzle(config);
      const result = module.solve(puzzle, {
        engine: "nrpa",
        seed,
        nrpaLevel: level,
        nrpaIterations: iterations,
        maxMs: 40_000,
      });

      expect(result.error).toBeUndefined();
      const moves = plainMoves(result);
      // The whole point: a witness EXISTS. Length is pinned too, because every
      // seed and level that solves these returns the same count.
      expect(moves).toHaveLength(expected);
      // And it has to survive the page's own rules, move for move.
      expect(clearsBoard(toBoard(config), moves)).toBeTrue();
      expect(module.verify(puzzle, moves)).toBeTrue();
    },
    TIMEOUT_MS,
  );
});
