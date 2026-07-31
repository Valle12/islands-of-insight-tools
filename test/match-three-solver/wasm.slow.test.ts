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
  proven: boolean;
  unsolvable: boolean;
  ruledOut: number;
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
 * The boards no engine proves yet. Named here for the same reason
 * engine.solve.slow.test.ts names them: the day one becomes provable, the
 * assertion below is what says so.
 */
const BEYOND_BUDGET = new Set([
  "matchThreeTest47.json",
  "matchThreeTest50.json",
  "matchThreeTest51.json",
]);

/** Proven-minimal lengths — the same table the TypeScript sweep pins. */
const PROVEN_LENGTHS: Record<string, number> = {
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
  "matchThreeTest46.json": 7,
  "matchThreeTest48.json": 7,
  "matchThreeTest49.json": 10,
};

/** Enough for the slowest board that finishes; the sweep runs in one process. */
const SOLVE_MS = 30_000;
const TIMEOUT_MS = 90_000;

describe.skipIf(Bun.env.IOI_SKIP_SLOW === "1")("Match-three wasm", () => {
  test(
    "the whole corpus solves, and every witness replays under the page's rules",
    async () => {
      const module = await loadWasmModule();
      const unproven: string[] = [];

      for (const name of FIXTURES) {
        const config = await readFixture(name);
        const puzzle = toPuzzle(config);
        const result = module.solve(puzzle, {
          engine: "cascade",
          maxMs: BEYOND_BUDGET.has(name) ? 4_000 : SOLVE_MS,
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
        if (BEYOND_BUDGET.has(name)) {
          expect(result.proven).toBeFalse();
          continue;
        }

        expect(moves.length).toBeGreaterThan(0);
        if (!result.proven) {
          unproven.push(name);
          continue;
        }
        const pinned = PROVEN_LENGTHS[name];
        if (pinned !== undefined) expect(moves).toHaveLength(pinned);
      }

      // Reported together rather than one failure at a time: a budget change
      // that costs several boards their proof should say which ones.
      expect(unproven).toBeEmpty();
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
        const result = module.solve(puzzle, { ...arm, maxMs: 10_000 });
        expect(result.error).toBeUndefined();
        const moves = plainMoves(result);
        expect(moves.length).toBeGreaterThan(0);
        expect(clearsBoard(toBoard(config), moves)).toBeTrue();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "matchThreeTest47 gets its 20-move answer, honestly labelled",
    async () => {
      // The one hard board any arm cracks: the dive finds the solution a
      // 46-minute deepening run in July confirmed is optimal, and no engine
      // here can prove that — so it must come back solved but NOT proven.
      const module = await loadWasmModule();
      const config = await readFixture("matchThreeTest47.json");
      const puzzle = toPuzzle(config);
      const result = module.solve(puzzle, { engine: "bnb", maxMs: 60_000 });

      expect(result.error).toBeUndefined();
      const moves = plainMoves(result);
      expect(moves).toHaveLength(20);
      expect(result.proven).toBeFalse();
      expect(clearsBoard(toBoard(config), moves)).toBeTrue();
    },
    TIMEOUT_MS,
  );
});
