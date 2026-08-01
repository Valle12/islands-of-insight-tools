// Worker that loads the requested match-three WASM build variant and runs one
// solve. Message in: { puzzle, config, variant }; messages out: progress and
// best (posted by the wasm module itself, which runs in this scope), then
// done { moves, unsolvable, stats } or error.
//
// There is deliberately no per-arm "phase" message: wasmBridge.ts has no use
// for one — the page's phase readout comes from the TypeScript arm — and a
// message nobody reads is a contract nobody maintains. The native CLI still
// narrates arm starts through the same `Callbacks::onArmStart` hook.
//
// Hand-written source living in an otherwise generated directory — the
// astar*.mjs/wasm files beside it are em++ output and gitignored.

const modulePromises = new Map();

function getModule(name) {
  if (!modulePromises.has(name)) {
    modulePromises.set(
      name,
      (async () => {
        const url = new URL(`./${name}`, self.location.href).href;
        const createModule = (await import(url)).default;
        return createModule({
          locateFile: path => new URL(`./${path}`, self.location.href).href,
        });
      })(),
    );
  }
  return modulePromises.get(name);
}

const MODULE_BY_VARIANT = {
  threads: "astar.threads.mjs",
  "threads-mem64": "astar.threads.mem64.mjs",
  mem64: "astar.mem64.mjs",
};

// The bridge only requests variants its probes validated, but validation is
// not instantiation — fall back to the universal wasm32 build if the preferred
// module fails to load.
async function loadModule(variant) {
  const preferred = MODULE_BY_VARIANT[variant];
  if (preferred) {
    try {
      return await getModule(preferred);
    } catch (err) {
      console.error(`Falling back to astar.mjs: ${err}`);
      modulePromises.delete(preferred);
    }
  }
  return getModule("astar.mjs");
}

/** Embind values have to become plain structures before they can be posted. */
function plainMoves(moves) {
  const out = [];
  for (const move of moves) {
    out.push({
      a: { x: move.a.x, y: move.a.y },
      b: { x: move.b.x, y: move.b.y },
    });
  }
  return out;
}

self.onmessage = async event => {
  const { puzzle, config, variant } = event.data;

  try {
    const module = await loadModule(variant);
    const result = module.solve(puzzle, config ?? {});

    if (result.error) {
      self.postMessage({ type: "error", error: String(result.error) });
      return;
    }

    const stats = result.stats
      ? {
          nodesExpanded: result.stats.nodesExpanded,
          statesStored: result.stats.statesStored,
          stoppedOnMemory: result.stats.stoppedOnMemory,
          wallMs: result.stats.wallMs,
          engine: result.stats.engine,
        }
      : undefined;

    self.postMessage({
      type: "done",
      moves: plainMoves(result.moves),
      unsolvable: result.unsolvable === true,
      stats,
    });
  } catch (err) {
    // A wasm heap that cannot grow ABORTS the module, which arrives here as a
    // RuntimeError — the bridge retires this one arm and the race goes on.
    self.postMessage({ type: "error", error: String(err) });
  }
};
