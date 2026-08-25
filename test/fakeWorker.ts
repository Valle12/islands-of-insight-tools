/**
 * A stand-in for `Worker`, shared by every suite that drives a wasm bridge or
 * the pool under it: nothing here loads wasm, and every message is delivered
 * by hand. What those suites are about is bookkeeping — which messages settle
 * a race, what gets posted to which arm — so the worker only has to record
 * what was done to it and let the test speak for it.
 */
export class FakeWorker {
  static instances: FakeWorker[] = [];
  /** Makes the next `postMessage` throw, as a non-cloneable payload would. */
  static postThrows: Error | null = null;
  /** Makes the constructor throw, as a runtime without module workers does. */
  static constructorThrows: Error | null = null;

  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  readonly posted: unknown[] = [];
  terminated = false;

  constructor(readonly url: string | URL) {
    if (FakeWorker.constructorThrows) throw FakeWorker.constructorThrows;
    FakeWorker.instances.push(this);
  }

  postMessage(message: unknown) {
    if (FakeWorker.postThrows) throw FakeWorker.postThrows;
    this.posted.push(message);
  }

  terminate() {
    this.terminated = true;
  }

  /** Delivers one message from the worker, as the page would receive it. */
  deliver(data: Record<string, unknown>) {
    this.onmessage?.({ data });
  }

  /** The worker's `error` event. */
  crash(message: string) {
    this.onerror?.({ message });
  }

  /** The instances whose url ends with `suffix` — one bridge's workers. */
  static withUrl(suffix: string): FakeWorker[] {
    return FakeWorker.instances.filter(w => String(w.url).endsWith(suffix));
  }
}

/**
 * Swaps the global `Worker` for the fake and resets its bookkeeping. Returns
 * the function that puts the real one back — call it from `afterEach`.
 */
export function installFakeWorker(): () => void {
  const original = globalThis.Worker;
  FakeWorker.instances = [];
  FakeWorker.postThrows = null;
  FakeWorker.constructorThrows = null;
  globalThis.Worker = FakeWorker as unknown as typeof Worker;
  return () => {
    globalThis.Worker = original;
  };
}

/**
 * Pins `navigator.hardwareConcurrency`, which is what decides how many arms a
 * bridge starts at once and whether it collapses the portfolio to the cascade.
 * Returns the function that restores the real value.
 */
export function setHardwareConcurrency(value: number): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(
    navigator,
    "hardwareConcurrency",
  );
  Object.defineProperty(navigator, "hardwareConcurrency", {
    value,
    configurable: true,
  });
  return () => {
    if (descriptor) {
      Object.defineProperty(navigator, "hardwareConcurrency", descriptor);
    } else {
      delete (navigator as unknown as Record<string, unknown>)
        .hardwareConcurrency;
    }
  };
}
