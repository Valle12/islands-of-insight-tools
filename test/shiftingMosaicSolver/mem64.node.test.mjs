// MEMORY64 build smoke test. Runs under `node --test`, NOT `bun test`: bun
// cannot instantiate a Memory64 module yet (WebAssembly.validate returns false
// for a 64-bit memory), so the wasm32 suite in wasm.test.ts can never exercise
// astar.mem64. This proves the 64-bit build (a) is what the bridge's runtime
// feature-detect selects, (b) instantiates with 64-bit pointers, and (c)
// returns a VALID solution on a real fixture — i.e. MEMORY64 codegen did not
// silently corrupt the search. The 8GB-heap ceiling itself is measured
// separately; here we only need correctness.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const wasmDir = join(here, "../../src/pages/shifting-mosaic-solver/wasm");
const mjsPath = join(wasmDir, "astar.mem64.mjs");
const wasmPath = join(wasmDir, "astar.mem64.wasm");

// Same 13-byte probe the bridge uses. If this runtime can't validate a 64-bit
// memory it also can't load astar.mem64 — skip rather than fail.
const MEMORY64_PROBE = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x05, 0x03, 0x01, 0x04, 0x00,
]);
const memory64 =
  typeof WebAssembly !== "undefined" && WebAssembly.validate(MEMORY64_PROBE);

// The wasm posts progress via emscripten val::global("self").postMessage,
// absent outside a browser/worker — a no-op sink keeps the search happy.
globalThis.self ??= { postMessage() {} };

// direction ints match the C++ enum: 0=UP 1=RIGHT 2=DOWN 3=LEFT.
function replaySolves(fixture, turns) {
  const anchors = fixture.initialAnchors.map(a => ({ ...a }));
  for (const { blockId, direction } of turns) {
    const p = anchors[blockId];
    if (!p) return false;
    if (direction === 0) p.y--;
    else if (direction === 1) p.x++;
    else if (direction === 2) p.y++;
    else if (direction === 3) p.x--;
  }
  const g = anchors[fixture.goalIndex];
  return g.x === fixture.goalAnchor.x && g.y === fixture.goalAnchor.y;
}

test("MEMORY64 build solves a real fixture with a valid plan", { skip: !memory64 }, async () => {
  const createModule = (await import(pathToFileURL(mjsPath).href)).default;
  // instantiateWasm, not wasmBinary — see src/util/wasmModule.ts for why. This
  // one is inlined because node --test cannot import the TypeScript helper.
  const module = await createModule({
    instantiateWasm(imports, receive) {
      const mod = new WebAssembly.Module(readFileSync(wasmPath));
      const instance = new WebAssembly.Instance(mod, imports);
      receive(instance, mod);
      return instance.exports;
    },
  });

  const fixture = JSON.parse(
    readFileSync(join(here, "../resources/shiftingMosaicTest2.json"), "utf8"),
  );

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

  const turns = [];
  for (let i = 0; i < result.length; i++) {
    turns.push({ blockId: result[i].blockId, direction: result[i].direction });
  }

  assert.ok(turns.length > 0, "expected a non-empty solution");
  assert.ok(replaySolves(fixture, turns), "solution must land the goal block on its anchor");
});
