// Worker that loads the Shifting Mosaic A* WASM module and runs the search
// off the main thread. The WASM itself posts {type:"progress"} messages via
// its onProgress callback; this worker posts {type:"done"|"error"}.

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
  const {
    gridWidth,
    gridHeight,
    shapes,
    initialAnchors,
    goalIndex,
    goalAnchor,
    weight,
    deadlockPruning,
    maxMs,
    maxNodes,
    useIda,
    pathBlockerWeight,
    boundaryWeight,
    allWallsBfsBase,
    macroMoves,
    axisAwareWeight,
    lpDisplacementWeight,
    strideOverride,
    postProcess,
  } = event.data;

  try {
    const module = await getModule();
    const result = module.search(
      gridWidth,
      gridHeight,
      shapes,
      initialAnchors,
      goalIndex,
      goalAnchor,
      weight,
      deadlockPruning,
      maxMs,
      maxNodes,
      useIda,
      pathBlockerWeight,
      boundaryWeight,
      allWallsBfsBase,
      macroMoves,
      axisAwareWeight,
      lpDisplacementWeight,
      strideOverride,
      postProcess,
    );

    const path = [];
    for (let i = 0; i < result.length; i++) {
      path.push({ blockId: result[i].blockId, direction: result[i].direction });
    }
    self.postMessage({ type: "done", path });
  } catch (err) {
    self.postMessage({ type: "error", error: String(err) });
  }
};
