import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { SYMBOL_KINDS } from "../../src/pages/logic-grid-solver/symbols";
import { toPuzzle } from "../../src/pages/logic-grid-solver/wasmBridge";
import { instantiateFromDisk } from "../../src/util/wasmModule";
import { requireMemory64 } from "../memory64";
import { solvableBoard } from "./boards";
import { flat, type WasmModule } from "./wasmHarness";

/**
 * Logic-grid MEMORY64 build smoke test. The wasm32 suites can never exercise
 * `astar.mem64` — the bridge picks ONE build per runtime — so this proves the
 * 64-bit build instantiates, reads every optional key of the format and
 * returns an answer its own oracle accepts.
 *
 * Under bun since 1.4 — it needed `node --test` before, which is why this
 * file used to carry its own copy of the board, of the catalog indices and of
 * the puzzle conversion. All three now come from where everything else gets
 * them. See test/memory64.ts for the switch this depends on.
 */

const WASM_DIR = resolve(
  import.meta.dir,
  "../../src/pages/logic-grid-solver/wasm",
);

function kindIndex(id: string): number {
  const index = SYMBOL_KINDS.findIndex(kind => kind.id === id);
  if (index === -1) throw new Error(`no symbol kind ${id}`);
  return index;
}

/**
 * `solvableBoard` — a 5x5 with both colors connected, no dark 2x2 and one
 * area of nine — with the format's optional keys added, so the 64-bit build
 * is exercised on each of them without changing what the board's answer is:
 *
 *   - a dart aimed off the top edge from the corner, sending `direction`: its
 *     line is empty, so a value of zero is satisfied by every coloring;
 *   - a viewpoint of three in the far corner, a count the board's answer
 *     satisfies (found by solving this board through the native CLI);
 *   - one drawn pattern, deliberately the 2x2 that no-dark-2x2 already
 *     forbids, sending `patterns`;
 *   - the two squares of the top-left corner merged into ONE cell, sending
 *     `shapes` — flat row-major, like the boundary's `cells`.
 *
 * A combination no coloring could satisfy would still load and answer
 * Unsolvable, which is why every addition is chosen to keep the board
 * solvable.
 */
function mem64Board() {
  const config = solvableBoard();
  config.symbols.push(
    { x: 0, y: 0, type: kindIndex("dart"), value: 0, direction: 0 },
    { x: 4, y: 4, type: kindIndex("viewpoint"), value: 3 },
  );
  config.patterns = [{ width: 2, height: 2, cells: [1, 1, 1, 1] }];
  config.shapes = [[0, 1]];
  return config;
}

test(
  "logic-grid MEMORY64 build solves a captured board",
  async () => {
    requireMemory64();
    // The module posts progress through `self.postMessage`; happy-dom's
    // window is `self` under the test preload, and a sink is all it needs.
    const globals = globalThis as Record<string, unknown>;
    globals.self ??= { postMessage() {} };

    const factory = (await import(resolve(WASM_DIR, "astar.mem64.mjs")))
      .default as (options: unknown) => Promise<WasmModule>;
    const module = await factory(
      instantiateFromDisk(resolve(WASM_DIR, "astar.mem64.wasm")),
    );

    const puzzle = toPuzzle(mem64Board());
    const result = module.solve(puzzle, { engine: "cascade", maxMs: 60_000 });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe("solved");
    expect(result.decided).toBe(result.playable);

    const answer = flat(result.cells);
    // Checked through the module's own oracle rather than against a pinned
    // board: this puzzle has many solutions, so any legal one will do.
    expect(module.verify(puzzle, answer)).toBeTrue();
    // ...and the merged cell really did act as one: both its squares came
    // back the same color, which `verify` above is also entitled to refuse.
    expect(answer[0]).toBe(answer[1]!);
  },
  90_000,
);
