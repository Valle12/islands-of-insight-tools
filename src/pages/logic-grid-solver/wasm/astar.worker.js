// Worker that loads the requested logic-grid WASM build variant and runs one
// solve. Message in: { puzzle, config, variant }; messages out: progress
// (posted by the wasm module itself, which runs in this scope), then
// done { status, cells, proven, decided, playable, witnesses, stats } or error.
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
function plainCells(cells) {
  const out = [];
  for (let i = 0; i < cells.length; i++) out.push(cells[i]);
  return out;
}

function plainWitnesses(witnesses) {
  const out = [];
  for (let i = 0; i < witnesses.length; i++) out.push(plainCells(witnesses[i]));
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
          nodes: result.stats.nodes,
          refutations: result.stats.refutations,
          oracleRejections: result.stats.oracleRejections,
          stoppedOnMemory: result.stats.stoppedOnMemory,
          wallMs: result.stats.wallMs,
          arm: result.stats.arm,
        }
      : undefined;

    self.postMessage({
      type: "done",
      status: result.status,
      reason: result.reason,
      cells: plainCells(result.cells),
      proven: result.proven === true,
      decided: result.decided,
      playable: result.playable,
      witnesses: plainWitnesses(result.witnesses),
      stats,
    });
  } catch (err) {
    // A wasm heap that cannot grow ABORTS the module, which arrives here as a
    // RuntimeError — the bridge retires this one arm and the race goes on.
    self.postMessage({ type: "error", error: String(err) });
  }
};
