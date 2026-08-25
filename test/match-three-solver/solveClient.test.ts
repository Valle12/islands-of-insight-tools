import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { SolveProgress } from "../../src/pages/match-three-solver/engine";
import { toBoard, type Move } from "../../src/pages/match-three-solver/rules";
import {
  searchMatchThree,
  type SolveHandlers,
} from "../../src/pages/match-three-solver/solveClient";
import type { MatchThreeTest } from "../../src/util/types";
import {
  FakeWorker,
  installFakeWorker,
  setHardwareConcurrency,
} from "../fakeWorker";
import { clearsBoard } from "./boards";

/**
 * The merge point between the TypeScript arm and the wasm portfolio, driven
 * through fake workers: what each arm's messages do to the race, and the one
 * rule that matters — a candidate counts only once it has REPLAYED through
 * the page's own rules.
 *
 * Imports the real `solveClient`, which `matchThreeSolver.test.ts` mocks
 * with `mock.module`: fine under `--parallel` (every test script and CI shard),
 * where each file has its own module registry, and the reason the rule in
 * CLAUDE.md still stands for a bare `bun test`.
 */
const restore: (() => void)[] = [];

beforeEach(() => {
  restore.push(installFakeWorker());
  // One slot: the wasm side collapses to a single cascade worker, so the race
  // is exactly two arms — the TypeScript worker and one wasm worker.
  restore.push(setHardwareConcurrency(2));
});

afterEach(() => {
  for (const undo of restore.splice(0)) undo();
});

/**
 * One row, `a a b a b b` (symbols 2 and 3): swapping the middle pair leaves
 * `a a a b b b`, two runs of three, and the board is clear. Column-major, as
 * the editor stores it.
 */
const config: MatchThreeTest = {
  gridWidth: 6,
  gridHeight: 1,
  cells: [[2], [2], [3], [2], [3], [3]],
};
const clearing: Move = { a: { x: 2, y: 0 }, b: { x: 3, y: 0 } };
/** Swapping two identical cells makes no run: the rules refuse it. */
const pointless: Move = { a: { x: 0, y: 0 }, b: { x: 1, y: 0 } };

const empty: MatchThreeTest = {
  gridWidth: 2,
  gridHeight: 1,
  cells: [[0], [0]],
};

const ts = () => FakeWorker.withUrl("mt-worker/solverWorker.js")[0]!;
const wasm = () => FakeWorker.withUrl("mt-wasm/astar.worker.js")[0]!;

function handlers(overrides: Partial<SolveHandlers> = {}) {
  return {
    onProgress: mock<(progress: SolveProgress) => void>(),
    onBest: mock<(moves: Move[]) => void>(),
    onResult: mock(),
    onError: mock(),
    ...overrides,
  };
}

test("the witnesses are what the suite says they are", () => {
  expect(clearsBoard(toBoard(config), [clearing])).toBeTrue();
  expect(clearsBoard(toBoard(config), [pointless])).toBeFalse();
});

describe("the race", () => {
  test("posts the board and the budget to the TypeScript arm", () => {
    searchMatchThree(config, handlers(), 1234);
    expect(ts().posted[0]).toEqual({ config, budgetMs: 1234 });
    expect(FakeWorker.instances).toHaveLength(2);
  });

  test("the first candidate that replays wins, and both arms stop", () => {
    const h = handlers();
    searchMatchThree(config, h);

    ts().deliver({ type: "best", moves: [clearing] });

    expect(h.onBest).toHaveBeenCalledWith([clearing]);
    expect(h.onResult).toHaveBeenCalledWith({
      status: "solved",
      moves: [clearing],
    });
    expect(ts().terminated).toBe(true);
    expect(wasm().terminated).toBe(true);
  });

  test("a witness the rules refuse is dropped, and the race goes on", () => {
    const h = handlers();
    searchMatchThree(config, h);

    ts().deliver({ type: "best", moves: [pointless] });
    expect(h.onBest).not.toHaveBeenCalled();
    expect(h.onResult).not.toHaveBeenCalled();

    wasm().deliver({ type: "done", moves: [clearing], unsolvable: false });
    expect(h.onBest).toHaveBeenCalledTimes(1);
    expect(h.onResult).toHaveBeenCalledWith({
      status: "solved",
      moves: [clearing],
    });
  });

  test("a proof that the board cannot be cleared ends the race on its own", () => {
    const h = handlers();
    searchMatchThree(config, h);

    ts().deliver({ type: "result", result: { status: "unsolvable" } });

    expect(h.onResult).toHaveBeenCalledWith({ status: "unsolvable" });
    expect(wasm().terminated).toBe(true);
  });

  test("the wasm side can prove it too", () => {
    const h = handlers();
    searchMatchThree(config, h);

    wasm().deliver({ type: "done", moves: [], unsolvable: true });

    expect(h.onResult).toHaveBeenCalledWith({ status: "unsolvable" });
    expect(ts().terminated).toBe(true);
  });

  test("both arms out of budget with nothing to show is a budget result", () => {
    const h = handlers();
    searchMatchThree(config, h);

    ts().deliver({ type: "result", result: { status: "budget" } });
    expect(h.onResult).not.toHaveBeenCalled();
    wasm().deliver({ type: "done", moves: [], unsolvable: false });

    expect(h.onResult).toHaveBeenCalledWith({ status: "budget" });
    expect(h.onError).not.toHaveBeenCalled();
  });

  test("both arms dying is a failure, not a result", () => {
    const h = handlers();
    searchMatchThree(config, h);

    ts().crash("worker crashed");
    expect(h.onError).not.toHaveBeenCalled();
    wasm().deliver({ type: "error", error: "heap exhausted" });

    expect(h.onError).toHaveBeenCalledWith("The solver stopped unexpectedly.");
    expect(h.onResult).not.toHaveBeenCalled();
  });

  test("a board with nothing on it is its own answer", () => {
    const h = handlers();
    searchMatchThree(empty, h);

    expect(h.onResult).toHaveBeenCalledWith({ status: "solved", moves: [] });
    expect(ts().terminated).toBe(true);
    expect(wasm().terminated).toBe(true);
  });

  test("no worker support at all fails cleanly with a handle", () => {
    FakeWorker.faults.construct = new Error("module workers unsupported");
    const h = handlers();

    const handle = searchMatchThree(config, h);

    expect(handle).toBeDefined();
    expect(h.onError).toHaveBeenCalledWith("The solver stopped unexpectedly.");
    expect(FakeWorker.instances).toHaveLength(0);
  });
});

describe("progress", () => {
  test("sums both arms and follows the TypeScript arm's phase", () => {
    const h = handlers();
    searchMatchThree(config, h);

    ts().deliver({ type: "progress", progress: { phase: "beam", nodes: 10 } });
    expect(h.onProgress).toHaveBeenLastCalledWith({ phase: "beam", nodes: 10 });

    wasm().deliver({ type: "progress", progress: 5 });
    expect(h.onProgress).toHaveBeenLastCalledWith({ phase: "beam", nodes: 15 });
  });

  test("reads as exhaustive once only the wasm portfolio is left", () => {
    const h = handlers();
    searchMatchThree(config, h);

    ts().deliver({ type: "result", result: { status: "budget" } });
    wasm().deliver({ type: "progress", progress: 7 });

    expect(h.onProgress).toHaveBeenLastCalledWith({
      phase: "exhaustive",
      nodes: 7,
    });
  });
});

describe("cancel", () => {
  test("stops both arms and silences whatever was in flight", () => {
    const h = handlers();
    const handle = searchMatchThree(config, h);

    handle.cancel();
    ts().deliver({ type: "best", moves: [clearing] });
    wasm().deliver({ type: "done", moves: [clearing], unsolvable: false });

    expect(ts().terminated).toBe(true);
    expect(wasm().terminated).toBe(true);
    expect(h.onBest).not.toHaveBeenCalled();
    expect(h.onResult).not.toHaveBeenCalled();
  });
});
