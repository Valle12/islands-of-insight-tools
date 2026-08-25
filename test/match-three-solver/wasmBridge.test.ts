import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  PORTFOLIO,
  searchMatchThreeWasm,
  type ArmResult,
  type WasmCallbacks,
} from "../../src/pages/match-three-solver/wasmBridge";
import type { MatchThreeTest } from "../../src/util/types";
import {
  FakeWorker,
  installFakeWorker,
  setHardwareConcurrency,
} from "../fakeWorker";

/**
 * The bridge owns two things and this suite checks both: what it POSTS (the
 * flattened puzzle, one arm per slot or the cascade on one) and what each
 * worker message MEANS to the caller. The race itself is the pool's, tested
 * in wasmPool.test.ts.
 */
const restore: (() => void)[] = [];

beforeEach(() => {
  restore.push(installFakeWorker());
});

afterEach(() => {
  for (const undo of restore.splice(0)) undo();
});

// Column-major, as the editor stores it: x=0 holds [2, 0], x=1 holds [3, 4].
const config: MatchThreeTest = {
  gridWidth: 2,
  gridHeight: 2,
  cells: [
    [2, 0],
    [3, 4],
  ],
};

const move = { a: { x: 0, y: 0 }, b: { x: 1, y: 0 } };

function search(callbacks: WasmCallbacks = {}, budgetMs?: number) {
  return searchMatchThreeWasm(config, callbacks, budgetMs);
}

const posted = (worker: FakeWorker) =>
  worker.posted[0] as {
    puzzle: { gridWidth: number; gridHeight: number; cells: number[] };
    config: Record<string, unknown>;
  };

describe("what the bridge posts", () => {
  test("flattens the cells row-major and races every arm where there are slots", () => {
    restore.push(setHardwareConcurrency(8));
    search({}, 1234);

    const workers = FakeWorker.withUrl("mt-wasm/astar.worker.js");
    expect(workers).toHaveLength(PORTFOLIO.length);
    expect(posted(workers[0]!).puzzle).toEqual({
      gridWidth: 2,
      gridHeight: 2,
      cells: [2, 3, 0, 4],
    });
    // Every arm carries the caller's budget, whatever the catalog says.
    for (const [i, worker] of workers.entries()) {
      expect(posted(worker).config).toEqual({ ...PORTFOLIO[i], maxMs: 1234 });
    }
  });

  test("collapses to the cascade when only one arm can run at a time", () => {
    restore.push(setHardwareConcurrency(2));
    search({}, 500);

    const workers = FakeWorker.withUrl("mt-wasm/astar.worker.js");
    expect(workers).toHaveLength(1);
    expect(posted(workers[0]!).config).toEqual({ engine: "cascade", maxMs: 500 });
  });
});

describe("what a worker message means", () => {
  const arm = () => FakeWorker.withUrl("mt-wasm/astar.worker.js")[0]!;

  beforeEach(() => {
    restore.push(setHardwareConcurrency(2));
  });

  test("progress is the arm's node count", () => {
    const onProgress = mock();
    search({ onProgress });
    arm().deliver({ type: "progress", progress: 42 });
    expect(onProgress).toHaveBeenLastCalledWith(42);
  });

  test("a best-so-far is handed over as it is, an absent one as empty", () => {
    const onBest = mock();
    search({ onBest });
    arm().deliver({ type: "best", moves: [move] });
    expect(onBest).toHaveBeenLastCalledWith([move]);
    arm().deliver({ type: "best" });
    expect(onBest).toHaveBeenLastCalledWith([]);
  });

  test("an arm that finished reports its result, and the race settles", () => {
    const results: ArmResult[] = [];
    const onSettled = mock();
    const onError = mock();
    search({ onArm: result => results.push(result), onSettled, onError });

    const stats = { nodesExpanded: 7, statesStored: 3, stoppedOnMemory: false, wallMs: 9 };
    arm().deliver({ type: "done", moves: [move], unsolvable: false, stats });

    expect(results).toHaveLength(1);
    expect(results[0]!.moves).toEqual([move]);
    expect(results[0]!.unsolvable).toBe(false);
    expect(results[0]!.stats).toEqual(stats);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    expect(arm().terminated).toBe(true);
  });

  test("a proof of unsolvability crosses as such, with no moves", () => {
    const results: ArmResult[] = [];
    search({ onArm: result => results.push(result) });
    arm().deliver({ type: "done", unsolvable: true });
    expect(results[0]!.unsolvable).toBe(true);
    expect(results[0]!.moves).toEqual([]);
  });

  test("a portfolio where every arm died is a failure, not a result", () => {
    const onSettled = mock();
    const onError = mock();
    search({ onSettled, onError });
    arm().deliver({ type: "error", error: "wasm heap exhausted" });
    expect(onError).toHaveBeenCalledWith("wasm heap exhausted");
    expect(onSettled).not.toHaveBeenCalled();
  });

  test("nothing is reported after the caller stops the race", () => {
    const onArm = mock();
    const handle = search({ onArm });
    handle.terminate();
    arm().deliver({ type: "done", moves: [move] });
    expect(onArm).not.toHaveBeenCalled();
    expect(arm().terminated).toBe(true);
  });
});
