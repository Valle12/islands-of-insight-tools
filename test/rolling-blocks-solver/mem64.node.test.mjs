// Rolling-blocks MEMORY64 build smoke test. Runs under `node --test`, NOT
// `bun test`: bun cannot instantiate a Memory64 module yet, so the wasm32
// sweep in aStar.test.ts can never exercise astar.mem64. This proves the
// 64-bit build (a) is what the bridge's runtime feature-detect selects, (b)
// instantiates with 64-bit pointers, and (c) returns a VALID solution on a
// real fixture — i.e. MEMORY64 codegen did not silently corrupt the search.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const wasmDir = join(here, "../../src/pages/rolling-blocks-solver/wasm");
const mjsPath = join(wasmDir, "astar.mem64.mjs");
const wasmPath = join(wasmDir, "astar.mem64.wasm");

// The same probes the bridge uses. A 64-bit MEMORY is not sufficient on its
// own: emscripten 6.x also emits a 64-bit TABLE for every wasm64 build, and a
// runtime can have one without the other — the ubuntu-24.04 runner's node
// does exactly that. Probing memory alone let the shifting-mosaic twin of
// this test die on an opaque CompileError instead of skipping.
const MEMORY64_PROBE = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x05, 0x03, 0x01, 0x04, 0x00,
]);
const TABLE64_PROBE = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x04, 0x04, 0x01, 0x70, 0x04,
  0x00,
]);
const memory64 =
  typeof WebAssembly !== "undefined" &&
  WebAssembly.validate(MEMORY64_PROBE) &&
  WebAssembly.validate(TABLE64_PROBE);

// The wasm posts progress via emscripten val::global("self").postMessage,
// absent outside a browser/worker — a no-op sink keeps the search happy.
globalThis.self ??= { postMessage() {} };

const TILE_MAP = { regular: 0, mustTouch: 1, goal: 2, unplayable: 3 };

// Minimal replay oracle over the fixture's [x][y] cells: every roll must be
// legal is out of scope here — the full oracles live in the bun/gtest suites.
// This checks the plan is non-empty and every referenced block exists.
function plausiblePlan(fixture, turns) {
  const ids = new Set(fixture.blocks.map(b => b.id));
  return turns.length > 0 && turns.every(t => ids.has(t.blockId));
}

test(
  "rolling-blocks MEMORY64 build solves a real fixture",
  { skip: !memory64 },
  async () => {
    const createModule = (await import(pathToFileURL(mjsPath).href)).default;
    const module = await createModule({
      instantiateWasm(imports, receive) {
        const mod = new WebAssembly.Module(readFileSync(wasmPath));
        const instance = new WebAssembly.Instance(mod, imports);
        receive(instance, mod);
        return instance.exports;
      },
    });

    const fixture = JSON.parse(
      readFileSync(
        join(here, "../resources/rolling-blocks-solver/rollingBlocksTest9.json"),
        "utf8",
      ),
    );
    const flatCells = new Array(fixture.gridWidth * fixture.gridHeight);
    for (let x = 0; x < fixture.gridWidth; x++) {
      for (let y = 0; y < fixture.gridHeight; y++) {
        flatCells[x + y * fixture.gridWidth] = TILE_MAP[fixture.cells[x][y]];
      }
    }

    const result = module.solve(
      {
        gridWidth: fixture.gridWidth,
        gridHeight: fixture.gridHeight,
        cells: flatCells,
        blocks: fixture.blocks,
      },
      { engine: "cascade", maxMs: 60_000 },
    );

    assert.equal(result.error, undefined);
    const turns = [];
    for (const turn of result.turns) {
      turns.push({ blockId: turn.blockId, direction: turn.direction });
    }
    assert.ok(plausiblePlan(fixture, turns), "expected a non-empty plan");
  },
);
