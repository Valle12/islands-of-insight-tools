// Worker that loads the requested A* WASM build variant and runs one solve.
// Message in: { puzzle, config, variant }; messages out: progress and phase
// (posted by the wasm module itself), done { path, stats }, or error.

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
// not instantiation — fall back to the universal wasm32 build if the
// preferred module fails to load.
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

self.onmessage = async event => {
  const { puzzle, config, variant } = event.data;

  try {
    const module = await loadModule(variant);
    const result = module.solve(puzzle, config ?? {});

    if (result.error) {
      self.postMessage({ type: "error", error: String(result.error) });
      return;
    }

    // Convert the embind result to plain structures before posting.
    const path = [];
    for (const turn of result.turns) {
      path.push({ blockId: turn.blockId, direction: turn.direction });
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

    self.postMessage({ type: "done", path, stats });
  } catch (err) {
    self.postMessage({ type: "error", error: String(err) });
  }
};
