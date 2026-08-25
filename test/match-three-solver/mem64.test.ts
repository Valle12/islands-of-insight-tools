import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { MatchThreeTest, Position } from "../../src/util/types";
import { instantiateFromDisk } from "../../src/util/wasmModule";
import { requireMemory64 } from "../memory64";

/**
 * Match-three MEMORY64 build smoke test. The wasm32 suites can never
 * exercise `astar.mem64` — the bridge picks ONE build per runtime — so this
 * proves the 64-bit build (a) is what the bridge's feature-detect selects,
 * (b) instantiates with 64-bit pointers, and (c) returns a VALID solution on
 * a real captured board, i.e. MEMORY64 codegen did not silently corrupt the
 * search or the packed four-bits-per-cell keys its transposition table is
 * built on.
 *
 * Under bun since 1.4 — it needed `node --test` before. See test/memory64.ts
 * for the switch this depends on.
 */

const WASM_DIR = resolve(
  import.meta.dir,
  "../../src/pages/match-three-solver/wasm",
);

interface WasmMove {
  a: Position;
  b: Position;
}

interface WasmPuzzle {
  gridWidth: number;
  gridHeight: number;
  cells: number[];
}

interface WasmModule {
  solve(
    puzzle: WasmPuzzle,
    config: Record<string, unknown>,
  ): { error?: string; moves: ArrayLike<WasmMove> };
  verify(puzzle: WasmPuzzle, moves: WasmMove[]): boolean;
}

// The wasm posts progress and best-so-far through emscripten
// val::global("self").postMessage; happy-dom's window is `self` under the
// test preload, and a no-op sink is enough anywhere else.
const globals = globalThis as Record<string, unknown>;
globals.self ??= { postMessage() {} };

test(
  "match-three MEMORY64 build solves a captured board",
  async () => {
    requireMemory64();
    const factory = (await import(resolve(WASM_DIR, "astar.mem64.mjs")))
      .default as (options: unknown) => Promise<WasmModule>;
    const module = await factory(
      instantiateFromDisk(resolve(WASM_DIR, "astar.mem64.wasm")),
    );

    // 6x6, five moves, blockades in both bottom corners — the same board the
    // page's e2e suite walks through. The fixture is column-major; the module
    // takes flat row-major.
    const fixture = JSON.parse(
      readFileSync(
        resolve(
          import.meta.dir,
          "../resources/match-three-solver/matchThreeTest28.json",
        ),
        "utf8",
      ),
    ) as MatchThreeTest;
    const cells = new Array<number>(fixture.gridWidth * fixture.gridHeight);
    for (let x = 0; x < fixture.gridWidth; x++) {
      for (let y = 0; y < fixture.gridHeight; y++) {
        cells[y * fixture.gridWidth + x] = fixture.cells[x]![y]!;
      }
    }

    const puzzle: WasmPuzzle = {
      gridWidth: fixture.gridWidth,
      gridHeight: fixture.gridHeight,
      cells,
    };
    const result = module.solve(puzzle, { engine: "cascade", maxMs: 60_000 });

    expect(result.error).toBeUndefined();
    const moves = Array.from({ length: result.moves.length }, (_, i) => ({
      a: { x: result.moves[i]!.a.x, y: result.moves[i]!.a.y },
      b: { x: result.moves[i]!.b.x, y: result.moves[i]!.b.y },
    }));
    // A CEILING, matching wasm.slow.test.ts: the search returns the first
    // solution it finds and claims nothing about minimality, so pinning 5
    // would fail this MEMORY64 smoke test over an arm-ordering change that has
    // nothing to do with 64-bit codegen. `module.verify` below is the real
    // gate.
    expect(moves.length).toBeGreaterThan(0);
    expect(moves.length).toBeLessThanOrEqual(5);
    // The module's own replay oracle, compiled into the MEMORY64 build: every
    // swap legal in turn AND no blocks left at the end.
    expect(module.verify(puzzle, moves)).toBeTrue();
  },
  90_000,
);
