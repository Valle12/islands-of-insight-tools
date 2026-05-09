// Worker that loads the A* WASM module and runs the search off the main thread

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
  const { gridWidth, gridHeight, cells, blocks, weight } = event.data;

  try {
    const module = await getModule();
    const result = module.search(gridWidth, gridHeight, cells, blocks, weight);

    // Convert embind result to plain array before posting
    const path = [];
    for (let i = 0; i < result.length; i++) {
      path.push({ blockId: result[i].blockId, direction: result[i].direction });
    }

    self.postMessage({ type: "done", path });
  } catch (err) {
    self.postMessage({ type: "error", error: String(err) });
  }
};
