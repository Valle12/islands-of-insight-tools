import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// Under node, not bun: bun cannot instantiate a Memory64 module, so this file
// is `.mjs` precisely so `bun test` never picks it up. It is named explicitly
// in the `test:mem64` script and in the CI job's `run:` line — a solver whose
// test is missing from either is a MEMORY64 build nothing ever instantiates.

const here = dirname(fileURLToPath(import.meta.url));
const wasmDir = join(here, "../../src/pages/logic-grid-solver/wasm");
const mjsPath = join(wasmDir, "astar.mem64.mjs");
const wasmPath = join(wasmDir, "astar.mem64.wasm");

// Written out rather than imported from `boards.ts`: this file runs under node,
// which cannot load the TypeScript that everything else shares. It is the
// `solvableBoard` from there — a 5x5 with both colours connected, no dark 2x2
// and one area of nine.
//
// The rule numbers are therefore COPIES of the catalogue's indices, and the one
// place in the tree where that cannot be avoided. When `RULES` in rules.ts
// changes, this list has to change with it — the regroup that moved
// connect-dark from 2 to 11 turned this board into "no runs of two of either
// colour", which is unsolvable, and this test is what said so.
const BOARD = {
  gridWidth: 5,
  gridHeight: 5,
  // no-dark-2x2, connect-dark, connect-light
  rules: [0, 11, 12],
  cells: Array.from({ length: 5 }, () => Array.from({ length: 5 }, () => 0)),
  symbols: [{ x: 2, y: 2, type: 0, value: 9 }],
};

// The same probes the bridge uses. A 64-bit MEMORY is not sufficient on its
// own: emscripten 6.x emits a 64-bit TABLE in every wasm64 build, and a runtime
// can validate the first while rejecting the second.
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

// The wasm posts progress through emscripten's val::global("self").postMessage,
// which is absent outside a browser or worker — a no-op sink keeps it happy.
globalThis.self ??= { postMessage() {} };

test(
  "logic-grid MEMORY64 build solves a captured board",
  { skip: !memory64 },
  async () => {
    const createModule = (await import(pathToFileURL(mjsPath).href)).default;
    const module = await createModule({
      // instantiateWasm, not wasmBinary: emscripten 6.0.2 dropped the latter
      // from the default INCOMING_MODULE_JS_API.
      instantiateWasm(imports, receive) {
        const compiled = new WebAssembly.Module(readFileSync(wasmPath));
        const instance = new WebAssembly.Instance(compiled, imports);
        receive(instance, compiled);
        return instance.exports;
      },
    });

    const config = BOARD;
    // The editor stores the grid column-major; the module answers row-major.
    const cells = [];
    for (let y = 0; y < config.gridHeight; y++) {
      for (let x = 0; x < config.gridWidth; x++) cells.push(config.cells[x][y]);
    }
    const puzzle = {
      gridWidth: config.gridWidth,
      gridHeight: config.gridHeight,
      cells,
      rules: config.rules,
      clues: config.symbols.map(symbol => ({
        x: symbol.x,
        y: symbol.y,
        type: symbol.type,
        value:
          symbol.type === 1
            ? (String(symbol.value).codePointAt(0) ?? 65) - 65
            : Number(symbol.value),
      })),
      // A merged cell: the two squares of the top-left corner as ONE cell, so
      // the 64-bit build is exercised on the `shapes` key too. Flat row-major,
      // like `cells` above and unlike the config's column-major grid.
      shapes: [[0, 1]],
    };

    const result = module.solve(puzzle, { engine: "cascade", maxMs: 60_000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, "solved");
    assert.equal(result.decided, result.playable);

    const answer = Array.from(
      { length: result.cells.length },
      (_, i) => result.cells[i],
    );
    // Checked through the module's own oracle rather than by comparing against
    // a pinned board: this puzzle has many solutions, so any legal one will do.
    assert.equal(module.verify(puzzle, answer), true);
    // ...and the merged cell really did act as one: both its squares came back
    // the same colour, which `verify` above is also entitled to refuse.
    assert.equal(answer[0], answer[1]);
  },
);
