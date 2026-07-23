// Worker-thread arm runner for the wasm test suite: loads the production
// wasm module and runs ONE solver arm, mirroring the browser's
// wasm/astar.worker.js protocol ({ puzzle, config } in, { type, path } out).
// Uses node:worker_threads explicitly — the test preload registers
// happy-dom globals whose web `Worker` is a non-functional stub. The module
// binary is read from disk because workers have no browser fetch context.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parentPort } from "node:worker_threads";

const here = dirname(fileURLToPath(import.meta.url));
const wasmDir = join(here, "../../src/pages/shifting-mosaic-solver/wasm");

const modulePromise = (async () => {
  const wasmPath = join(wasmDir, "astar.mjs");
  const wasmBinPath = join(wasmDir, "astar.wasm");
  const createModule = (await import(wasmPath)).default;
  const wasmBinary = readFileSync(wasmBinPath);
  return createModule({
    locateFile(file: string) {
      return file.endsWith(".wasm") ? wasmBinPath : file;
    },
    wasmBinary,
  });
})();

parentPort!.on("message", async ({ puzzle, config }) => {
  try {
    const module = await modulePromise;
    const result = module.solve(puzzle, config ?? {});
    const path: { blockId: number; direction: number }[] = [];
    for (let i = 0; i < result.length; i++) {
      path.push({ blockId: result[i].blockId, direction: result[i].direction });
    }
    parentPort!.postMessage({ type: "done", path });
  } catch (err) {
    parentPort!.postMessage({ type: "error", error: String(err) });
  }
});
