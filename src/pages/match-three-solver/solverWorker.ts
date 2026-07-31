import { solveMatchThree, type SolveProgress, type SolveResult } from "./engine";
import { toBoard } from "./rules";
import type { MatchThreeTest } from "./../../util/types";

export interface SolveRequest {
  readonly config: MatchThreeTest;
  readonly budgetMs?: number;
}

export type SolveMessage =
  | { readonly type: "progress"; readonly progress: SolveProgress }
  | { readonly type: "result"; readonly result: SolveResult };

/**
 * The search is a straight-line recursion that runs for seconds, so it gets a
 * thread of its own — on the main thread it would freeze the page outright.
 * Cancelling is `terminate()` from the client side, which is why nothing here
 * has to poll for a stop flag.
 */
self.onmessage = (event: MessageEvent<SolveRequest>) => {
  const { config, budgetMs } = event.data;

  const post = (message: SolveMessage) => self.postMessage(message);

  const result = solveMatchThree(toBoard(config), {
    budgetMs,
    onProgress: progress => post({ type: "progress", progress }),
  });

  post({ type: "result", result });
};
