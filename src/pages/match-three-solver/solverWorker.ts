import { solveMatchThree, type SolveProgress, type SolveResult } from "./engine";
import { toBoard, type Move } from "./rules";
import type { MatchThreeTest } from "./../../util/types";

export interface SolveRequest {
  readonly config: MatchThreeTest;
  readonly budgetMs?: number;
}

export type SolveMessage =
  | { readonly type: "progress"; readonly progress: SolveProgress }
  | { readonly type: "best"; readonly moves: Move[] }
  | { readonly type: "result"; readonly result: SolveResult };

/**
 * The search is a straight-line recursion that runs for minutes, so it gets a
 * thread of its own — on the main thread it would freeze the page outright.
 * Canceling is `terminate()` from the client side, which is why nothing here
 * has to poll for a stop flag — and why every best-so-far is streamed out the
 * moment it exists: the client keeps the latest, so killing the thread never
 * loses the answer in hand.
 */
self.onmessage = (event: MessageEvent<SolveRequest>) => {
  const { config, budgetMs } = event.data;

  const post = (message: SolveMessage) => self.postMessage(message);

  const result = solveMatchThree(toBoard(config), {
    budgetMs,
    onProgress: progress => post({ type: "progress", progress }),
    onBest: moves => post({ type: "best", moves }),
  });

  post({ type: "result", result });
};
