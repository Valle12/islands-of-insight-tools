import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Position, ShiftingMosaicTest } from "../../src/util/types";
import { instantiateFromDisk } from "../../src/util/wasmModule";
import { requireMemory64 } from "../memory64";

/**
 * MEMORY64 build smoke test. The wasm32 suites can never exercise
 * `astar.mem64` — the bridge picks ONE build per runtime — so this proves the
 * 64-bit build (a) is what the bridge's feature-detect selects, (b)
 * instantiates with 64-bit pointers, and (c) returns a VALID solution on a
 * real fixture, i.e. MEMORY64 codegen did not silently corrupt the search.
 * The 8GB heap ceiling itself is measured separately; here only correctness.
 *
 * Under bun since 1.4 — it needed `node --test` before, which is why the
 * instantiation shim used to be inlined here. See test/memory64.ts for the
 * switch this depends on.
 */

const WASM_DIR = resolve(
  import.meta.dir,
  "../../src/pages/shifting-mosaic-solver/wasm",
);

interface WasmTurn {
  blockId: number;
  direction: number;
}

interface WasmModule {
  // Object-config entry; schema in wasm_bindings.cpp::solve.
  solve(
    puzzle: ShiftingMosaicTest,
    config: Record<string, unknown>,
  ): ArrayLike<WasmTurn>;
}

// The wasm posts progress via emscripten val::global("self").postMessage;
// happy-dom's window is `self` under the test preload, and a no-op sink is
// enough anywhere else.
const globals = globalThis as Record<string, unknown>;
globals.self ??= { postMessage() {} };

// direction ints match the C++ enum: 0=UP 1=RIGHT 2=DOWN 3=LEFT.
const DX = [0, 1, 0, -1];
const DY = [-1, 0, 1, 0];

function replaySolves(fixture: ShiftingMosaicTest, turns: WasmTurn[]) {
  const anchors: Position[] = fixture.initialAnchors.map(a => ({ ...a }));
  for (const { blockId, direction } of turns) {
    const anchor = anchors[blockId];
    const dx = DX[direction];
    const dy = DY[direction];
    if (!anchor || dx === undefined || dy === undefined) return false;
    anchor.x += dx;
    anchor.y += dy;
  }
  const goal = anchors[fixture.goalIndex];
  return goal?.x === fixture.goalAnchor.x && goal.y === fixture.goalAnchor.y;
}

test(
  "MEMORY64 build solves a real fixture with a valid plan",
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
          "../resources/shifting-mosaic-solver/shiftingMosaicTest2.json",
        ),
        "utf8",
      ),
    ) as ShiftingMosaicTest;

    const result = module.solve(
      {
        gridWidth: fixture.gridWidth,
        gridHeight: fixture.gridHeight,
        shapes: fixture.shapes,
        initialAnchors: fixture.initialAnchors,
        goalIndex: fixture.goalIndex,
        goalAnchor: fixture.goalAnchor,
      },
      { engine: "cascade", maxMs: 60_000, maxNodes: 0, postProcess: true },
    );
    const turns = Array.from({ length: result.length }, (_, i) => ({
      blockId: result[i]!.blockId,
      direction: result[i]!.direction,
    }));

    expect(turns.length).toBeGreaterThan(0);
    expect(replaySolves(fixture, turns)).toBeTrue();
  },
  90_000,
);
