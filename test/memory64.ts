import { supportsMemory64 } from "../src/util/wasmFeatureProbes";

/**
 * The gate of the four MEMORY64 smoke tests — a hard failure, not a skip.
 *
 * With bun pinned through `packageManager`, whether this runtime loads a
 * 64-bit build is deterministic, and a skip here is exactly the trap the old
 * `node --test` lane warned about: an under-capable runtime quietly testing
 * nothing. Under bun 1.4 Memory64 sits behind the JSC option
 * `useWasmMemory64` (the default once oven-sh/bun#35740 ships), which every
 * `bun test` script in package.json and CI's bun-test job set as
 * `BUN_JSC_useWasmMemory64=1`. A bare `bun test` typed by hand does not, and
 * lands here with the remedy in the message.
 */
export function requireMemory64(): void {
  if (supportsMemory64()) return;
  throw new Error(
    "this runtime refuses a 64-bit wasm memory or table. Under bun 1.4 " +
      "Memory64 is behind BUN_JSC_useWasmMemory64=1, which the package.json " +
      "test scripts set — run `bun run test:mem64` (or any test:* script) " +
      "rather than a bare `bun test`.",
  );
}
