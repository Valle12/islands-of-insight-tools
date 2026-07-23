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
        });
      })(),
    );
  }
  return modulePromises.get(name);
}

self.onmessage = async event => {
  // `variant: "threads"` selects the pthreads build (requires the page to be
  // cross-origin isolated — the bridge only asks for it then).
  const { puzzle, config, variant } = event.data;
  try {
    const module = await getModule(
      variant === "threads" ? "astar.threads.mjs" : "astar.mjs",
    );
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
