import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { RollingBlocksTest, Tile } from "../../src/util/types";
import { instantiateFromDisk } from "../../src/util/wasmModule";
import { requireMemory64 } from "../memory64";

/**
 * Rolling-blocks MEMORY64 build smoke test. The wasm32 sweep in aStar.test.ts
 * can never exercise `astar.mem64` — the bridge picks ONE build per runtime —
 * so this proves the 64-bit build (a) is what the bridge's feature-detect
 * selects, (b) instantiates with 64-bit pointers, and (c) returns a VALID
 * solution on a real fixture, i.e. MEMORY64 codegen did not silently corrupt
 * the search.
 *
 * Under bun since 1.4 — it needed `node --test` before. See test/memory64.ts
 * for the switch this depends on.
 */

const WASM_DIR = resolve(
  import.meta.dir,
  "../../src/pages/rolling-blocks-solver/wasm",
);

interface WasmTurn {
  blockId: number;
  direction: number;
}

interface WasmPuzzle {
  gridWidth: number;
  gridHeight: number;
  cells: number[];
  blocks: RollingBlocksTest["blocks"];
}

interface WasmModule {
  solve(
    puzzle: WasmPuzzle,
    config: Record<string, unknown>,
  ): { error?: string; turns: ArrayLike<WasmTurn> };
  verify(puzzle: WasmPuzzle, turns: WasmTurn[]): boolean;
}

// The same encoding wasmBridge.ts uses at the boundary.
const TILE_MAP: Record<Tile, number> = {
  regular: 0,
  mustTouch: 1,
  goal: 2,
  unplayable: 3,
};

// The wasm posts progress via emscripten val::global("self").postMessage;
// happy-dom's window is `self` under the test preload, and a no-op sink is
// enough anywhere else.
const globals = globalThis as Record<string, unknown>;
globals.self ??= { postMessage() {} };

test(
  "rolling-blocks MEMORY64 build solves a real fixture",
  async () => {
    requireMemory64();
    const factory = (await import(resolve(WASM_DIR, "astar.mem64.mjs")))
      .default as (options: unknown) => Promise<WasmModule>;
    const module = await factory(
      instantiateFromDisk(resolve(WASM_DIR, "astar.mem64.wasm")),
    );

    const fixture = JSON.parse(
      readFileSync(
        resolve(
          import.meta.dir,
          "../resources/rolling-blocks-solver/rollingBlocksTest9.json",
        ),
        "utf8",
      ),
    ) as RollingBlocksTest;
    const flatCells = new Array<number>(fixture.gridWidth * fixture.gridHeight);
    for (let x = 0; x < fixture.gridWidth; x++) {
      for (let y = 0; y < fixture.gridHeight; y++) {
        flatCells[x + y * fixture.gridWidth] = TILE_MAP[fixture.cells[x]![y]!];
      }
    }

    const puzzle: WasmPuzzle = {
      gridWidth: fixture.gridWidth,
      gridHeight: fixture.gridHeight,
      cells: flatCells,
      blocks: fixture.blocks,
    };
    const result = module.solve(puzzle, { engine: "cascade", maxMs: 60_000 });

    expect(result.error).toBeUndefined();
    const turns = Array.from({ length: result.turns.length }, (_, i) => ({
      blockId: result.turns[i]!.blockId,
      direction: result.turns[i]!.direction,
    }));
    expect(turns.length).toBeGreaterThan(0);
    // The module's own replay oracle (replay::replayTurns compiled into the
    // MEMORY64 build): every roll legal AND the final state solves the board.
    expect(module.verify(puzzle, turns)).toBeTrue();
  },
  90_000,
);
