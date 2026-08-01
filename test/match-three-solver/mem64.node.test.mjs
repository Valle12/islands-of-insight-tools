// Match-three MEMORY64 build smoke test. Runs under `node --test`, NOT
// `bun test`: bun cannot instantiate a Memory64 module yet, so the wasm32
// suites can never exercise astar.mem64. This proves the 64-bit build (a) is
// what the bridge's runtime feature-detect selects, (b) instantiates with
// 64-bit pointers, and (c) returns a VALID solution on a real captured board —
// i.e. MEMORY64 codegen did not silently corrupt the search or the packed
// four-bits-per-cell keys its transposition table is built on.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const wasmDir = join(here, "../../src/pages/match-three-solver/wasm");
const mjsPath = join(wasmDir, "astar.mem64.mjs");
const wasmPath = join(wasmDir, "astar.mem64.wasm");

// The same probes the bridge uses. A 64-bit MEMORY is not sufficient on its
// own: emscripten 6.x also emits a 64-bit TABLE for every wasm64 build, and a
// runtime can have one without the other — the ubuntu-24.04 runner's node does
// exactly that, and probing memory alone turns a skip into an opaque
// CompileError.
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

// The wasm posts progress and best-so-far through
// emscripten val::global("self").postMessage, absent outside a browser or
// worker — a no-op sink keeps the search happy.
globalThis.self ??= { postMessage() {} };

test(
  "match-three MEMORY64 build solves a captured board",
  { skip: !memory64 },
  async () => {
    const createModule = (await import(pathToFileURL(mjsPath).href)).default;
    const module = await createModule({
      // instantiateWasm, not wasmBinary: emscripten 6.0.2 dropped the latter
      // from the default INCOMING_MODULE_JS_API.
      instantiateWasm(imports, receive) {
        const mod = new WebAssembly.Module(readFileSync(wasmPath));
        const instance = new WebAssembly.Instance(mod, imports);
        receive(instance, mod);
        return instance.exports;
      },
    });

    // 6x6, five moves, blockades in both bottom corners — the same board the
    // page's e2e suite walks through.
    const fixture = JSON.parse(
      readFileSync(
        join(here, "../resources/match-three-solver/matchThreeTest28.json"),
        "utf8",
      ),
    );
    const cells = new Array(fixture.gridWidth * fixture.gridHeight);
    for (let x = 0; x < fixture.gridWidth; x++) {
      for (let y = 0; y < fixture.gridHeight; y++) {
        cells[y * fixture.gridWidth + x] = fixture.cells[x][y];
      }
    }

    const puzzle = {
      gridWidth: fixture.gridWidth,
      gridHeight: fixture.gridHeight,
      cells,
    };
    const result = module.solve(puzzle, { engine: "cascade", maxMs: 60_000 });

    assert.equal(result.error, undefined);
    const moves = [];
    for (let i = 0; i < result.moves.length; i++) {
      const move = result.moves[i];
      moves.push({
        a: { x: move.a.x, y: move.a.y },
        b: { x: move.b.x, y: move.b.y },
      });
    }
    assert.equal(moves.length, 5, "the board's known-shortest length");
    // The module's own replay oracle, compiled into the MEMORY64 build: every
    // swap legal in turn AND no blocks left at the end.
    assert.ok(
      module.verify(puzzle, moves),
      "solution must replay legally to a cleared board",
    );
  },
);
