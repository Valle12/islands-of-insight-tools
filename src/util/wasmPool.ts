// The worker race every wasm-backed solver page runs, in one place.
//
// All four bridges (`src/pages/*/wasmBridge.ts`) used to carry their own copy
// of this: the same `workers`/`pending`/`nextConfig`/`retired` bookkeeping, the
// same back-fill, the same teardown. Four copies of a lifecycle is four places
// for a rule to be true in three of them — which is exactly what happened, with
// two of the four forgetting to mark the race dead in `terminate()` and two
// letting a Worker constructor throw straight through the page.
//
// What stays per page is what is genuinely per page: which arms exist, what the
// puzzle payload looks like, and what an arm's message MEANS. This module owns
// everything else and knows nothing about any puzzle.
//
// The shape of the race, which every page depends on:
//
//   * Every arm always runs. `poolSize` bounds how many go at once, never which
//     ones exist — arms queue and back-fill as earlier ones retire, so a small
//     machine is slower but never less capable.
//   * An arm that dies retires itself. The pool fails only when every arm has
//     failed, which is why the error is remembered rather than reported.
//   * A cross-origin isolated page collapses the list to ONE arm: there the
//     pthreads build races the same portfolio on real threads inside a single
//     module, so spawning the arms out here as well would run each one twice.

import { pickWasmVariant } from "./wasmFeatureProbes";

/** What a caller holds onto: the one way to stop the race. */
export interface WasmPoolHandle {
  /** Stops every arm. Nothing is reported afterwards. */
  terminate(): void;
}

/** One running arm, as the page's message handler sees it. */
export interface PoolArm {
  /**
   * A stable 0-based slot for this arm, for per-arm state a page wants to keep
   * itself. Slots are not reused: a back-filled arm gets the next number.
   */
  readonly index: number;
  /**
   * This arm's latest work counter. The pool keeps one per arm and hands the
   * SUM to `onProgress` — retired arms included, so the readout never jumps
   * backwards.
   *
   * A count that is not a finite number is DROPPED rather than stored. Every
   * bridge reads it off a worker message with `Number(...)`, so a build that
   * omits the field hands over `NaN` — and one `NaN` in the sum poisons the
   * readout for the rest of the race, since retired arms are summed forever.
   */
  progress(nodes: number): void;
  /** Nothing more from this arm: free its slot, back-fill, settle when empty. */
  retire(): void;
  /**
   * End the whole race now, whatever the other arms are doing. `report` runs
   * once, after every worker is torn down.
   */
  settle(report: () => void): void;
  /** Why this arm died, kept for the message used when they all do. */
  fail(message: string): void;
}

export interface WasmPoolOptions {
  /**
   * Page-relative, NOT root-absolute: the site is served from a GitHub Pages
   * project sub-path, so "/rb-wasm/…" would resolve against the domain root.
   */
  readonly workerUrl: string;
  /** The arms, in priority order. One worker each. */
  readonly configs: readonly Record<string, unknown>[];
  /** Posted to every arm as `{...payload, config, variant}`. */
  readonly payload: Record<string, unknown>;
  /** Shown when not one arm could be started and nothing else went wrong. */
  readonly startupError: string;
  /** One message from one arm. Deciding what it means is the page's job. */
  readonly onMessage: (data: Record<string, unknown>, arm: PoolArm) => void;
  /** Cumulative work across every arm, retired ones included. */
  readonly onProgress?: (nodes: number) => void;
  /**
   * Every arm has retired and nobody called `settle`. `lastError` is the last
   * failure seen, or `startupError` when there was none — the page decides
   * whether that reads as "no solution" or as a failure, because only it knows
   * whether an arm ever searched out cleanly.
   */
  readonly onExhausted: (lastError: string) => void;
}

/**
 * Whether this page can run the pthreads build, which races the whole portfolio
 * on real threads inside ONE module.
 *
 * Guarded rather than read directly: `crossOriginIsolated` is undefined in the
 * test DOM and in a worker on older engines.
 */
export function crossOriginIsolatedPage(): boolean {
  return typeof crossOriginIsolated !== "undefined" && crossOriginIsolated;
}

/**
 * How many arms may run at once: one per core, less the main thread, and never
 * more arms than exist or fewer than one.
 *
 * `|| 2` rather than `?? 2` on purpose — `hardwareConcurrency` is 0 on engines
 * that decline to say, and 0 cores is not an answer.
 */
export function armPoolSize(armCount: number): number {
  return Math.max(
    1,
    Math.min(armCount, (navigator.hardwareConcurrency || 2) - 1),
  );
}

/**
 * Starts the race and returns the handle that stops it.
 *
 * Nothing is reported after `terminate()`, including from a message already in
 * flight — see `terminateAll` below for why that has to be a flag rather than
 * just killing the workers.
 */
export function startWasmPool(options: WasmPoolOptions): WasmPoolHandle {
  const { workerUrl, configs, payload, startupError } = options;
  const variant = pickWasmVariant(crossOriginIsolatedPage());

  let workers: Worker[] = [];
  let done = false;
  let pending = 0;
  let nextConfig = 0;
  let lastError = "";
  const nodesByWorker = new Map<Worker, number>();
  // Idempotent per worker: a failing arm can deliver both an error MESSAGE and
  // an onerror EVENT, and the double decrement would settle the race early.
  const retired = new Set<Worker>();

  // Marks the race dead as well as killing the workers. `retire` and
  // `spawnNext` guard only on this flag, so without it a `done` or `onerror`
  // still in flight when the caller tore the pool down would back-fill a FRESH
  // worker — one that then runs its whole budget with nobody listening, and can
  // still deliver an answer for a board the page has already discarded.
  const terminateAll = () => {
    done = true;
    for (const worker of workers) worker.terminate();
    workers = [];
  };

  /** Ends the race once, after teardown, or does nothing if it already ended. */
  const conclude = (report: () => void) => {
    if (done) return;
    terminateAll();
    report();
  };

  const reportProgress = () => {
    if (!options.onProgress) return;
    let nodes = 0;
    for (const count of nodesByWorker.values()) nodes += count;
    options.onProgress(nodes);
  };

  const retire = (worker: Worker) => {
    if (done || retired.has(worker)) return;
    retired.add(worker);
    pending--;
    worker.terminate();
    // Back-fill the freed slot before deciding we are finished, so the queued
    // arms still get their turn on a machine that cannot run them all at once.
    spawnNext();
    if (pending > 0) return;
    conclude(() => options.onExhausted(lastError || startupError));
  };

  function armFor(worker: Worker, index: number): PoolArm {
    return {
      index,
      progress(nodes) {
        if (!Number.isFinite(nodes)) return;
        nodesByWorker.set(worker, nodes);
        reportProgress();
      },
      retire() {
        retire(worker);
      },
      settle(report) {
        conclude(report);
      },
      fail(message) {
        lastError = message;
      },
    };
  }

  function spawnNext() {
    if (done || nextConfig >= configs.length) return;
    const index = nextConfig++;
    const config = configs[index]!;

    // In band, never thrown: a runtime with no module workers, or a CSP that
    // blocks the URL, throws HERE. An exception escaping the initial fill loop
    // would leave the page spinning with no handle to cancel and no error to
    // show, so the arm is recorded as failed and the next one is tried.
    let worker: Worker;
    try {
      worker = new Worker(workerUrl, { type: "module" });
    } catch {
      lastError = startupError;
      spawnNext();
      return;
    }

    workers.push(worker);
    nodesByWorker.set(worker, 0);
    const arm = armFor(worker, index);

    worker.onmessage = (event: MessageEvent) => {
      if (done) return;
      options.onMessage(event.data as Record<string, unknown>, arm);
    };
    worker.onerror = event => {
      lastError = event.message || startupError;
      retire(worker);
    };
    // A message the page cannot deserialize fires `messageerror`, NOT `error`.
    // Without this the arm would sit there having said nothing: `pending` never
    // reaches 0, no terminal callback runs, and the spinner turns until the
    // user cancels.
    worker.onmessageerror = () => {
      lastError = startupError;
      retire(worker);
    };

    // Counted BEFORE the post, so the failure below retires a pending arm
    // rather than one the pool never knew it had.
    pending++;
    try {
      worker.postMessage({ ...payload, config, variant });
    } catch (error) {
      // `payload` is the page's own object, and a value that cannot be
      // structured-cloned throws HERE. Escaping would take the whole initial
      // fill loop with it, leaving the page with a live worker, no handle to
      // stop it and no error to show — the one thing this module promises
      // cannot happen.
      lastError = error instanceof Error ? error.message : startupError;
      retire(worker);
    }
  }

  for (let i = 0; i < Math.min(armPoolSize(configs.length), configs.length); i++)
    spawnNext();
  // Nothing started at all — every construction threw, so `retire` can never
  // run and this is the only place left to say so.
  if (pending === 0) {
    conclude(() => options.onExhausted(lastError || startupError));
  }

  return { terminate: terminateAll };
}
