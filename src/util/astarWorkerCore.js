// The half of every solver's `astar.worker.js` that is not about its puzzle.
//
// All four workers used to carry their own copy of this: the same variant
// table, the same memoised dynamic import, the same "validation is not
// instantiation, fall back to wasm32" rule, the same try/catch around one
// `module.solve`. Four copies meant four places for that rule to be true in
// three of them — and it showed: only one of the four ever silenced the C++
// side's stdout narration.
//
// What stays per worker is the only genuinely per-puzzle part: turning the
// embind result into something `postMessage` can carry.
//
// PLAIN JS, not TypeScript, and it lives here rather than beside the workers
// because `src/pages/*/wasm/` is generated and gitignored. `src/util/build.ts`
// copies this file into every solver's published wasm directory and
// `src/util/serve.ts` serves it from the same list, so each worker reaches it
// as `./astar.workerCore.js` — page-relative, exactly like `astar.mjs` beside
// it. See `WASM_SHARED_FILES` in `src/util/wasmAssets.ts`.

/** One promise per module file: an arm loads its variant at most once. */
const modulePromises = new Map();

/**
 * Variant name → module file. "threads" is the pthreads build (cross-origin
 * isolated pages); "threads-mem64" adds an 8 GB shared MEMORY64 heap; "mem64"
 * is the single-threaded 8 GB build. Anything else is the portable wasm32 one.
 */
const MODULE_BY_VARIANT = {
  threads: "astar.threads.mjs",
  "threads-mem64": "astar.threads.mem64.mjs",
  mem64: "astar.mem64.mjs",
};

function getModule(name, options) {
  if (!modulePromises.has(name)) {
    modulePromises.set(
      name,
      (async () => {
        const url = new URL(`./${name}`, self.location.href).href;
        const createModule = (await import(url)).default;
        return createModule({
          locateFile: path => new URL(`./${path}`, self.location.href).href,
          // The solvers narrate passes, segments and node milestones on stdout.
          // That is the bench CLI's interface and genuinely useful there, but
          // emscripten maps it to console.log, so in the browser it floods
          // devtools with per-step internals no user can act on. Progress
          // reaches the UI through the structured {type:"progress"} /
          // {type:"phase"} messages instead.
          print: () => {},
          // stderr stays visible: it is where a real failure would surface.
          printErr: message => console.error(message),
          ...options,
        });
      })(),
    );
  }
  return modulePromises.get(name);
}

/**
 * The requested build, or the portable one when it will not load.
 *
 * The bridge picks a variant from a `WebAssembly.validate()` probe, which only
 * proves the engine's VALIDATOR accepts a 64-bit or shared memory declaration —
 * instantiation can still fail (memory descriptor spelling, shared-growable
 * 64-bit memory). Falling back is the behaviour `buildWasm.ts` already
 * documents; without it an arm reported a hard solver error on a page where
 * `astar.mjs` would have worked perfectly.
 */
async function loadModule(variant, options) {
  const preferred = MODULE_BY_VARIANT[variant];
  if (!preferred) return getModule("astar.mjs", options);
  try {
    return await getModule(preferred, options);
  } catch (err) {
    console.warn(`${preferred} failed to load, falling back to astar.mjs:`, err);
    modulePromises.delete(preferred);
    return getModule("astar.mjs", options);
  }
}

/**
 * Installs the worker's message handler.
 *
 * Message in: `{ puzzle, config, variant }`. The wasm module runs in THIS
 * scope, so anything it posts itself — progress, phase, best — reaches the
 * bridge directly and never passes through here. What this posts is the
 * terminal message: whatever `toDone` builds, or `{type:"error"}`.
 *
 * @param {(result: unknown) => Record<string, unknown>} toDone Converts the
 *   embind result into the plain `done` payload for this solver. Embind values
 *   are not structured-cloneable, so every field has to be copied out.
 * @param {Record<string, unknown>} [moduleOptions] Extra emscripten module
 *   options, merged over the defaults above.
 */
export function runSolverWorker(toDone, moduleOptions) {
  self.onmessage = async event => {
    const { puzzle, config, variant } = event.data;
    try {
      const module = await loadModule(variant, moduleOptions);
      const result = module.solve(puzzle, config ?? {});

      // In-band, because the builds are -fno-exceptions: a C++ throw would
      // reach the page as an aborted module rather than a message.
      if (result && result.error) {
        self.postMessage({ type: "error", error: String(result.error) });
        return;
      }
      self.postMessage({ type: "done", ...toDone(result) });
    } catch (err) {
      // A wasm heap that cannot grow ABORTS the module, which arrives here as a
      // RuntimeError — the bridge retires this one arm and the race goes on.
      self.postMessage({ type: "error", error: String(err) });
    }
  };
}

/** The stats block the three A*-shaped solvers report, or undefined. */
export function plainSearchStats(stats) {
  return stats
    ? {
        nodesExpanded: stats.nodesExpanded,
        statesStored: stats.statesStored,
        stoppedOnMemory: stats.stoppedOnMemory,
        wallMs: stats.wallMs,
        engine: stats.engine,
      }
    : undefined;
}

/**
 * Copies an embind sequence into a real array.
 *
 * `Array.from` rather than a spread or a for-of: the bindings build these with
 * `val::array()`, so they are real arrays here, but copying by length and index
 * also works for anything array-LIKE if that ever changes.
 */
export function plainArray(values, map) {
  return map ? Array.from(values, map) : Array.from(values);
}
