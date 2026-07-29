// Worker that loads the A* WASM module and runs the search off the main
// thread. Message in: { puzzle, config }; messages out: progress (posted by
// the wasm module itself), done { path, stats }, or error.

let modulePromise = null;

function getModule() {
  if (!modulePromise) {
    modulePromise = (async () => {
      const url = new URL("./astar.mjs", self.location.href).href;
      const createModule = (await import(url)).default;
      return createModule({
        locateFile: path => new URL(`./${path}`, self.location.href).href,
      });
    })();
  }
  return modulePromise;
}

self.onmessage = async event => {
  const { puzzle, config } = event.data;

  try {
    const module = await getModule();
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
        }
      : undefined;

    self.postMessage({ type: "done", path, stats });
  } catch (err) {
    self.postMessage({ type: "error", error: String(err) });
  }
};
