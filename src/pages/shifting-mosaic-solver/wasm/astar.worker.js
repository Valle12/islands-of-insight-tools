// Worker that loads the Shifting Mosaic solver WASM module and runs ONE
// solver arm off the main thread. Message in: { puzzle, config } — see
// wasm_bindings.cpp::solve for the config schema (engine: unit | drag |
// hier | cascade; every field optional). The WASM itself posts
// {type:"progress"} messages via its onProgress callback; this worker posts
// {type:"done"|"error"}. The bridge identifies arms by Worker instance, so
// no message ids are needed.

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
          // The solver's C++ narrates every pass, segment and 100k-node
          // milestone on stdout. That is the bench CLI's interface and is
          // genuinely useful there, but emscripten maps it to console.log, so
          // in the browser it floods devtools with per-step internals no user
          // can act on. Progress reaches the UI through the structured
          // {type:"progress"} / {type:"phase"} messages instead.
          print: () => {},
          // stderr stays visible: it is where a real failure would surface.
          printErr: msg => console.error(msg),
        });
      })(),
    );
  }
  return modulePromises.get(name);
}

// Variant → module file. "threads" = pthreads build (cross-origin isolated
// pages); "threads-mem64" = pthreads + 8GB shared MEMORY64 heap; "mem64" =
// single-threaded 8GB MEMORY64 build; anything else = the portable wasm32 build.
const MODULE_BY_VARIANT = {
  threads: "astar.threads.mjs",
  "threads-mem64": "astar.threads.mem64.mjs",
  mem64: "astar.mem64.mjs",
};

// The bridge picks a variant from a WebAssembly.validate() probe, which only
// proves the engine's VALIDATOR accepts a 64-bit / shared memory declaration —
// instantiation can still fail (memory descriptor spelling, shared-growable
// 64-bit memory). Fall back to the portable wasm32 build on any load failure,
// which is the behaviour buildWasm.ts already documents; without this the arm
// reported a hard "Solver error" even though astar.mjs would have worked.
async function loadModule(variant) {
  const preferred = MODULE_BY_VARIANT[variant];
  if (!preferred) return getModule("astar.mjs");
  try {
    return await getModule(preferred);
  } catch (err) {
    console.warn(`${preferred} failed to load, falling back to astar.mjs:`, err);
    modulePromises.delete(preferred);
    return getModule("astar.mjs");
  }
}

self.onmessage = async event => {
  const { puzzle, config, variant } = event.data;
  try {
    const module = await loadModule(variant);
    const result = module.solve(puzzle, config ?? {});

    const path = [];
    for (let i = 0; i < result.length; i++) {
      path.push({ blockId: result[i].blockId, direction: result[i].direction });
    }
    self.postMessage({ type: "done", path });
  } catch (err) {
    self.postMessage({ type: "error", error: String(err) });
  }
};
