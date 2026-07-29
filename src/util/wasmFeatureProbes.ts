// WebAssembly capability probes shared by the solver bridges.
//
// Tiny modules declaring a single 64-bit memory. If the engine validates one,
// it can load the matching MEMORY64 build, whose heap ceiling is 8GB instead
// of the wasm32 4GB wall — enough that deep searches stop aborting mid-budget
// on the hardest boards. Browsers enable Memory64 behind a flag today and
// natively soon; bun cannot load either yet.
//   - NON-SHARED (flags 0x04 = is64): the single-threaded *.mem64 builds.
//   - SHARED (flags 0x07 = is64|shared|has_max, min 0 max 1): the pthreads
//     *.threads.mem64 builds, whose arms race inside one shared 64-bit heap.
//     This is a distinct capability — an engine can have one without the
//     other.
const MEMORY64_PROBE = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x05, 0x03, 0x01, 0x04, 0x00,
]);
const SHARED_MEMORY64_PROBE = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x05, 0x04, 0x01, 0x07, 0x00,
  0x01,
]);
// A 64-bit memory is necessary but NOT sufficient: emscripten 6.x emits a
// 64-bit TABLE (section 4, funcref 0x70, limits flags 0x04 = is64) in every
// wasm64 build, and an engine can validate a 64-bit memory while still
// rejecting that table — the ubuntu-24.04 runner's node does. Handing such an
// engine a mem64 build costs a failed compile before the worker's fallback
// catches it, so both gates below require the table too.
const TABLE64_PROBE = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x04, 0x04, 0x01, 0x70, 0x04,
  0x00,
]);

function validates(bytes: Uint8Array): boolean {
  try {
    return typeof WebAssembly !== "undefined" && WebAssembly.validate(bytes);
  } catch {
    return false;
  }
}

export const supportsMemory64 = () =>
  validates(MEMORY64_PROBE) && validates(TABLE64_PROBE);
export const supportsSharedMemory64 = () =>
  validates(SHARED_MEMORY64_PROBE) && validates(TABLE64_PROBE);

export type WasmVariant = "threads-mem64" | "threads" | "mem64" | "default";

/**
 * The biggest-heap build each execution path can load, in the bridges'
 * shared priority order: threads-mem64 > threads when cross-origin isolated,
 * mem64 > default otherwise.
 */
export function pickWasmVariant(isolated: boolean): WasmVariant {
  if (isolated) {
    return supportsSharedMemory64() ? "threads-mem64" : "threads";
  }
  return supportsMemory64() ? "mem64" : "default";
}
