import { readFileSync } from "node:fs";

/**
 * Emscripten `Module` options that instantiate a wasm build from a file on
 * disk, with no fetch involved.
 *
 * Handing the loader `Module.wasmBinary` used to be enough, but emscripten
 * 6.0.2 dropped `wasmBinary` from the default `INCOMING_MODULE_JS_API`, so
 * newer toolchains silently ignore it and fall back to fetching. Our builds
 * are `-sENVIRONMENT=web,worker` and the test preload registers happy-dom
 * globals, so the loader believes it is on the web and fetches an absolute
 * filesystem path against an `about:blank` document — which throws, leaving
 * "both async and sync fetching of the wasm failed". `instantiateWasm` is
 * still part of the default incoming API and short-circuits every fetch path,
 * so it works on both sides of that toolchain change.
 */
export function instantiateFromDisk(wasmBinaryPath: string) {
  return {
    instantiateWasm(
      imports: WebAssembly.Imports,
      receive: (
        instance: WebAssembly.Instance,
        module: WebAssembly.Module,
      ) => void,
    ) {
      const module = new WebAssembly.Module(readFileSync(wasmBinaryPath));
      const instance = new WebAssembly.Instance(module, imports);
      receive(instance, module);
      return instance.exports;
    },
  };
}
