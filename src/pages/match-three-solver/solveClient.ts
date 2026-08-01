import type { SolveProgress, SolveResult } from "./engine";
import { SOLVE_BUDGET_MS } from "./config";
import { applyMove, blockCount, toBoard, type Move } from "./rules";
import type { SolveMessage, SolveRequest } from "./solverWorker";
import { searchMatchThreeWasm, type WasmHandle } from "./wasmBridge";
import type { MatchThreeTest } from "./../../util/types";

/**
 * Where `src/util/buildWorker.ts` publishes the bundled TypeScript worker. It
 * is reached page-relative rather than absolutely on purpose: from
 * `/match-three-solver` (dev, no trailing slash) and from
 * `/match-three-solver/index.html` (Pages) this resolves to the same
 * `/mt-worker/solverWorker.js`.
 */
const WORKER_URL = "../mt-worker/solverWorker.js";

export interface SolveHandlers {
  readonly onProgress?: (progress: SolveProgress) => void;
  /** Every improvement to the best-known solution, as it is found. */
  readonly onBest?: (moves: Move[]) => void;
  readonly onResult: (result: SolveResult) => void;
  readonly onError: (message: string) => void;
}

export interface SolveHandle {
  /** Stops the search. Nothing is reported afterwards. */
  cancel(): void;
}

/** A solution some arm is putting forward. */
interface Candidate {
  readonly moves: Move[];
}

/**
 * What every arm reports into, and the rule for accepting it.
 *
 * There is one rule now, and it is the load-bearing one: a candidate is
 * accepted once it has been REPLAYED through this page's own rules. The wasm
 * arms are a second implementation of those rules, and the solution viewer
 * replays whatever it is handed; a witness that disagreed would render as a
 * broken walkthrough rather than as an error, so it is refused here instead.
 *
 * With no proving left this replay is the ONLY thing between a bad witness and
 * the viewer, so it is also the last place to weaken.
 */
class Merged {
  private readonly board: ReturnType<typeof toBoard>;
  /**
   * A board with nothing on it is already solved, and the answer is the empty
   * move list — which `offer` would otherwise refuse for being empty, the same
   * way it refuses an arm that came back with nothing.
   */
  private readonly alreadyClear: boolean;
  private best: Candidate | null = null;
  private unsolvable = false;

  constructor(config: MatchThreeTest) {
    this.board = toBoard(config);
    this.alreadyClear = blockCount(this.board) === 0;
  }

  /** True once there is an answer to show, whatever it is. */
  get done(): boolean {
    return this.alreadyClear || this.unsolvable || this.best !== null;
  }

  /** A completed proof that the board cannot be cleared at all. */
  markUnsolvable(): void {
    if (!this.best) this.unsolvable = true;
  }

  /** Records the first candidate that replays. Later ones cannot improve it. */
  offer(candidate: Candidate): boolean {
    const { moves } = candidate;
    if (moves.length === 0 || this.best) return false;
    if (!this.replays(moves)) return false;
    this.best = candidate;
    return true;
  }

  /** What to hand the page once no arm can add anything. */
  result(): SolveResult {
    if (this.alreadyClear) return { status: "solved", moves: [] };
    if (this.unsolvable) return { status: "unsolvable" };
    if (!this.best) return { status: "budget" };
    return { status: "solved", moves: this.best.moves };
  }

  private replays(moves: Move[]): boolean {
    let current = this.board;
    for (const move of moves) {
      const outcome = applyMove(current, move);
      if (!outcome) return false;
      current = outcome.board;
    }
    return blockCount(current) === 0;
  }
}

/** How one arm talks back, whichever engine it is. */
interface ArmHandlers {
  onProgress: (nodes: number, phase?: SolveProgress["phase"]) => void;
  onCandidate: (candidate: Candidate) => void;
  onUnsolvable: () => void;
  onDone: () => void;
  onFailed: () => void;
}

/** The TypeScript engine as one arm of the portfolio, in its own worker. */
function spawnTsArm(
  config: MatchThreeTest,
  budgetMs: number | undefined,
  arm: ArmHandlers,
): { terminate: () => void } {
  let worker: Worker;
  try {
    worker = new Worker(WORKER_URL, { type: "module" });
  } catch {
    arm.onFailed();
    return { terminate: () => {} };
  }

  worker.onmessage = (event: MessageEvent<SolveMessage>) => {
    const message = event.data;
    if (message.type === "progress") {
      const { nodes, phase } = message.progress;
      arm.onProgress(nodes, phase);
      return;
    }
    if (message.type === "best") {
      arm.onCandidate({ moves: message.moves });
      return;
    }
    const result = message.result;
    if (result.status === "solved") {
      arm.onCandidate(result);
    } else if (result.status === "unsolvable") {
      arm.onUnsolvable();
    }
    arm.onDone();
  };
  worker.onerror = () => arm.onFailed();

  const request: SolveRequest = { config, budgetMs };
  worker.postMessage(request);
  return { terminate: () => worker.terminate() };
}

/**
 * Races the TypeScript engine against the wasm portfolio and takes the first
 * answer either of them can play. Whichever arm gets there first wins and the
 * rest are torn down; nothing waits to find out whether a shorter one exists.
 *
 * The TypeScript arm is not a fallback bolted on the side — it is arm zero: it
 * answers an easy board in milliseconds without a single wasm module being
 * fetched, and it is the entire search if those files fail to load.
 */
export function searchMatchThree(
  config: MatchThreeTest,
  handlers: SolveHandlers,
  budgetMs?: number,
): SolveHandle {
  const merged = new Merged(config);
  let live = true;
  let ts: { terminate: () => void } | null = null;
  let wasm: WasmHandle | null = null;
  const state = {
    tsDone: false,
    wasmDone: false,
    tsFailed: false,
    wasmFailed: false,
    tsNodes: 0,
    wasmNodes: 0,
    phase: "greedy" as SolveProgress["phase"],
  };

  const stop = () => {
    live = false;
    ts?.terminate();
    wasm?.terminate();
  };

  const emitProgress = () => {
    handlers.onProgress?.({
      // Once the TypeScript arm is done, what is left running is the wasm
      // portfolio working through the deepest search it has.
      phase: state.tsDone ? "exhaustive" : state.phase,
      nodes: state.tsNodes + state.wasmNodes,
    });
  };

  const finish = () => {
    if (!live) return;
    if (state.tsFailed && state.wasmFailed) {
      stop();
      handlers.onError("The solver stopped unexpectedly.");
      return;
    }
    const result = merged.result();
    stop();
    handlers.onResult(result);
  };

  /** Settles on the first playable answer, or once nothing is left running. */
  const maybeFinish = () => {
    if (merged.done || (state.tsDone && state.wasmDone)) finish();
  };

  const armHandlers = (side: "ts" | "wasm"): ArmHandlers => ({
    onProgress: (nodes, phase) => {
      if (!live) return;
      if (side === "ts") {
        state.tsNodes = nodes;
        if (phase) state.phase = phase;
      } else {
        state.wasmNodes = nodes;
      }
      emitProgress();
      if (merged.done) finish();
    },
    onCandidate: candidate => {
      if (!live) return;
      if (merged.offer(candidate)) handlers.onBest?.(candidate.moves);
      emitProgress();
      if (merged.done) finish();
    },
    onUnsolvable: () => {
      if (!live) return;
      merged.markUnsolvable();
      if (merged.done) finish();
    },
    onDone: () => {
      if (!live) return;
      if (side === "ts") state.tsDone = true;
      else state.wasmDone = true;
      maybeFinish();
    },
    onFailed: () => {
      if (!live) return;
      if (side === "ts") {
        state.tsDone = true;
        state.tsFailed = true;
      } else {
        state.wasmDone = true;
        state.wasmFailed = true;
      }
      maybeFinish();
    },
  });

  const tsArm = armHandlers("ts");
  ts = spawnTsArm(config, budgetMs, tsArm);

  const wasmArm = armHandlers("wasm");
  wasm = searchMatchThreeWasm(
    config,
    {
      onProgress: nodes => wasmArm.onProgress(nodes),
      onBest: moves => wasmArm.onCandidate({ moves }),
      onArm: result => {
        if (result.unsolvable) wasmArm.onUnsolvable();
        wasmArm.onCandidate({ moves: result.moves });
        wasmArm.onProgress(state.wasmNodes);
      },
      onSettled: () => wasmArm.onDone(),
      onError: () => wasmArm.onFailed(),
    },
    budgetMs ?? SOLVE_BUDGET_MS,
  );

  // Both arms may have failed synchronously (no worker support at all).
  maybeFinish();

  return { cancel: stop };
}
