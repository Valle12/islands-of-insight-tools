import type { SolveProgress, SolveResult } from "./engine";
import type { SolveMessage, SolveRequest } from "./solverWorker";
import type { MatchThreeTest } from "./../../util/types";

/**
 * Where `src/util/buildWorker.ts` publishes the bundled worker. It is reached
 * page-relative rather than absolutely on purpose: from `/match-three-solver`
 * (dev, no trailing slash) and from `/match-three-solver/index.html` (Pages)
 * this resolves to the same `/mt-worker/solverWorker.js`.
 */
const WORKER_URL = "../mt-worker/solverWorker.js";

export interface SolveHandlers {
  readonly onProgress?: (progress: SolveProgress) => void;
  readonly onResult: (result: SolveResult) => void;
  readonly onError: (message: string) => void;
}

export interface SolveHandle {
  /** Stops the search. Nothing is reported afterwards. */
  cancel(): void;
}

export function searchMatchThree(
  config: MatchThreeTest,
  handlers: SolveHandlers,
  budgetMs?: number,
): SolveHandle {
  let worker: Worker;
  try {
    worker = new Worker(WORKER_URL, { type: "module" });
  } catch {
    handlers.onError("The solver could not be started.");
    return { cancel: () => {} };
  }

  let live = true;
  const stop = () => {
    live = false;
    worker.terminate();
  };

  worker.onmessage = (event: MessageEvent<SolveMessage>) => {
    if (!live) return;
    const message = event.data;
    if (message.type === "progress") {
      handlers.onProgress?.(message.progress);
      return;
    }
    stop();
    handlers.onResult(message.result);
  };

  worker.onerror = () => {
    if (!live) return;
    stop();
    handlers.onError("The solver stopped unexpectedly.");
  };

  const request: SolveRequest = { config, budgetMs };
  worker.postMessage(request);

  return { cancel: stop };
}
