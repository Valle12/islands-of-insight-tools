import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { startWasmPool, type PoolArm } from "../src/util/wasmPool";

/**
 * A stand-in for the real thing: nothing here loads wasm, and every message is
 * delivered by hand. What the suite is about is the pool's bookkeeping — which
 * failures settle the race and which are dropped — so the worker only has to
 * record what was done to it.
 */
class FakeWorker {
  static instances: FakeWorker[] = [];
  /** Makes the next `postMessage` throw, as a non-cloneable payload would. */
  static postThrows: Error | null = null;

  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  readonly posted: unknown[] = [];
  terminated = false;

  constructor() {
    FakeWorker.instances.push(this);
  }

  postMessage(message: unknown) {
    if (FakeWorker.postThrows) throw FakeWorker.postThrows;
    this.posted.push(message);
  }

  terminate() {
    this.terminated = true;
  }

  /** Delivers one message from the worker, as the pool would receive it. */
  deliver(data: Record<string, unknown>) {
    this.onmessage?.({ data });
  }
}

const originalWorker = globalThis.Worker;

beforeEach(() => {
  FakeWorker.instances = [];
  FakeWorker.postThrows = null;
  globalThis.Worker = FakeWorker as unknown as typeof Worker;
});

afterEach(() => {
  globalThis.Worker = originalWorker;
});

function pool(options: {
  configs?: Record<string, unknown>[];
  onMessage?: (data: Record<string, unknown>, arm: PoolArm) => void;
  onProgress?: (nodes: number) => void;
  onExhausted?: (error: string) => void;
}) {
  return startWasmPool({
    workerUrl: "../rb-wasm/astar.worker.js",
    configs: options.configs ?? [{ engine: "one" }],
    payload: { puzzle: {} },
    startupError: "Worker failed to start",
    onMessage: options.onMessage ?? (() => undefined),
    onProgress: options.onProgress,
    onExhausted: options.onExhausted ?? (() => undefined),
  });
}

describe("progress", () => {
  test("sums the arms and reports the total", () => {
    const onProgress = mock();
    pool({
      configs: [{ engine: "one" }, { engine: "two" }],
      onProgress,
      onMessage: (data, arm) => arm.progress(Number(data.nodes)),
    });

    FakeWorker.instances[0]!.deliver({ nodes: 5 });
    expect(onProgress).toHaveBeenLastCalledWith(5);
    // A second arm only runs where there is a slot for it; where there is,
    // the readout is the sum rather than the newest arm's own count.
    const second = FakeWorker.instances[1];
    if (!second) return;
    second.deliver({ nodes: 7 });
    expect(onProgress).toHaveBeenLastCalledWith(12);
  });

  test("drops a count that is not a finite number", () => {
    const onProgress = mock();
    pool({
      onProgress,
      onMessage: (data, arm) => arm.progress(Number(data.nodes)),
    });

    FakeWorker.instances[0]!.deliver({ nodes: 5 });
    // What a build that stopped sending the field hands over. Stored, it
    // would poison every later sum — retired arms are summed forever.
    FakeWorker.instances[0]!.deliver({});
    expect(onProgress).toHaveBeenLastCalledWith(5);
    expect(onProgress).toHaveBeenCalledTimes(1);
  });
});

describe("failure paths", () => {
  test("settles when the payload cannot be posted", () => {
    FakeWorker.postThrows = new Error("could not be cloned");
    const onExhausted = mock();

    // The throw must not escape: the caller gets its handle, and the arm it
    // could not start is reported like any other failure.
    const handle = pool({ onExhausted });

    expect(handle).toBeDefined();
    expect(onExhausted).toHaveBeenCalledWith("could not be cloned");
    expect(FakeWorker.instances[0]!.terminated).toBe(true);
  });

  test("settles when a message cannot be deserialized", () => {
    const onExhausted = mock();
    pool({ onExhausted });

    // `messageerror`, not `error` — the arm has said all it will ever say.
    FakeWorker.instances[0]!.onmessageerror!();

    expect(onExhausted).toHaveBeenCalledWith("Worker failed to start");
    expect(FakeWorker.instances[0]!.terminated).toBe(true);
  });

  test("reports the message of an arm that errored", () => {
    const onExhausted = mock();
    pool({ onExhausted });

    FakeWorker.instances[0]!.onerror!({ message: "out of memory" });

    expect(onExhausted).toHaveBeenCalledWith("out of memory");
  });
});

describe("settling", () => {
  test("an arm that settles ends the race and reports once", () => {
    const report = mock();
    const onExhausted = mock();
    pool({
      onExhausted,
      onMessage: (_data, arm) => arm.settle(report),
    });

    FakeWorker.instances[0]!.deliver({ type: "done" });
    // Anything still in flight afterwards is dropped, answer included.
    FakeWorker.instances[0]!.deliver({ type: "done" });

    expect(report).toHaveBeenCalledTimes(1);
    expect(onExhausted).not.toHaveBeenCalled();
    expect(FakeWorker.instances[0]!.terminated).toBe(true);
  });

  test("terminate stops every arm and silences what is in flight", () => {
    const onMessage = mock();
    const onExhausted = mock();
    const handle = pool({ onMessage, onExhausted });

    handle.terminate();
    FakeWorker.instances[0]!.deliver({ type: "done" });

    expect(onMessage).not.toHaveBeenCalled();
    expect(onExhausted).not.toHaveBeenCalled();
    expect(FakeWorker.instances[0]!.terminated).toBe(true);
  });
});
