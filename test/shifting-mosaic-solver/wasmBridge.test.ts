import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Direction } from "../../src/pages/shifting-mosaic-solver/directions";
import {
  PORTFOLIO,
  searchShiftingMosaicWasm,
  type ShiftingMosaicPuzzle,
  type WasmSearchCallbacks,
} from "../../src/pages/shifting-mosaic-solver/wasmBridge";
import {
  FakeWorker,
  installFakeWorker,
  setHardwareConcurrency,
} from "../fakeWorker";

/**
 * The bridge owns what it POSTS (every arm where there are slots, the
 * cascade on one) and what each worker message MEANS — in particular the two
 * readings of an empty plan, which is both "this arm found nothing" and the
 * answer to a board that was already solved. The race is the pool's, tested
 * in wasmPool.test.ts.
 */
const restore: (() => void)[] = [];

beforeEach(() => {
  restore.push(installFakeWorker());
});

afterEach(() => {
  for (const undo of restore.splice(0)) undo();
});

const puzzle: ShiftingMosaicPuzzle = {
  gridWidth: 3,
  gridHeight: 3,
  shapes: [[{ x: 0, y: 0 }]],
  initialAnchors: [{ x: 0, y: 0 }],
  goalIndex: 0,
  goalAnchor: { x: 2, y: 2 },
};

/** The same board with its goal block already on the goal anchor. */
const solvedPuzzle: ShiftingMosaicPuzzle = { ...puzzle, goalAnchor: { x: 0, y: 0 } };

const arm = () => FakeWorker.withUrl("sm-wasm/astar.worker.js")[0]!;

const NO_PLAY = "The solver returned a plan the page cannot play.";

describe("what the bridge posts", () => {
  test("races every arm of the portfolio where there are slots", () => {
    restore.push(setHardwareConcurrency(16));
    searchShiftingMosaicWasm(puzzle, {});

    const workers = FakeWorker.withUrl("sm-wasm/astar.worker.js");
    expect(workers).toHaveLength(PORTFOLIO.length);
    for (const [i, worker] of workers.entries()) {
      const posted = worker.posted[0] as { puzzle: unknown; config: unknown };
      expect(posted.puzzle).toEqual(puzzle);
      expect(posted.config).toEqual(PORTFOLIO[i]!);
    }
  });

  test("collapses to the in-wasm cascade when only one arm can run", () => {
    restore.push(setHardwareConcurrency(2));
    searchShiftingMosaicWasm(puzzle, {});

    const workers = FakeWorker.withUrl("sm-wasm/astar.worker.js");
    expect(workers).toHaveLength(1);
    const posted = workers[0]!.posted[0] as { config: { engine: string } };
    expect(posted.config.engine).toBe("cascade");
  });
});

describe("what a worker message means", () => {
  beforeEach(() => {
    restore.push(setHardwareConcurrency(2));
  });

  const search = (callbacks: WasmSearchCallbacks, board = puzzle) =>
    searchShiftingMosaicWasm(board, callbacks);

  test("progress is the arm's node count", () => {
    const onProgress = mock();
    search({ onProgress });
    arm().deliver({ type: "progress", progress: 99 });
    expect(onProgress).toHaveBeenLastCalledWith(99);
  });

  test("a phase change names the phase and the arm, primitives only", () => {
    const onPhase = mock();
    search({ onPhase });
    arm().deliver({ type: "phase", phase: "sequential", arm: 3 });
    expect(onPhase).toHaveBeenLastCalledWith("sequential", "3");
    // An object is not a label: dropped rather than shown as [object Object].
    arm().deliver({ type: "phase", phase: { nested: true }, arm: { id: 1 } });
    expect(onPhase).toHaveBeenLastCalledWith("", undefined);
  });

  test("a plan crosses with its directions named", () => {
    const onDone = mock();
    search({ onDone });
    arm().deliver({
      type: "done",
      path: [
        { blockId: 0, direction: 1 },
        { blockId: 0, direction: 2 },
      ],
    });
    expect(onDone).toHaveBeenCalledWith([
      { blockId: 0, direction: Direction.RIGHT },
      { blockId: 0, direction: Direction.DOWN },
    ]);
    expect(arm().terminated).toBe(true);
  });

  test("a plan naming a direction that does not exist is this arm failing", () => {
    const onDone = mock();
    const onError = mock();
    search({ onDone, onError });
    arm().deliver({ type: "done", path: [{ blockId: 0, direction: 7 }] });
    expect(onDone).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(NO_PLAY);
  });

  test("an empty plan from the only arm is no solution within budget", () => {
    const onDone = mock();
    const onError = mock();
    search({ onDone, onError });
    arm().deliver({ type: "done", path: [] });
    expect(onDone).toHaveBeenCalledWith([]);
    expect(onError).not.toHaveBeenCalled();
  });

  test("a build that stopped sending the path reads as an empty plan", () => {
    const onDone = mock();
    search({ onDone });
    arm().deliver({ type: "done" });
    expect(onDone).toHaveBeenCalledWith([]);
  });

  test("an empty plan for a board already on its goal is the answer", () => {
    const onDone = mock();
    search({ onDone }, solvedPuzzle);
    arm().deliver({ type: "done", path: [] });
    expect(onDone).toHaveBeenCalledWith([]);
    expect(arm().terminated).toBe(true);
  });

  test("an arm that died takes its message to the failure, when all die", () => {
    const onDone = mock();
    const onError = mock();
    search({ onDone, onError });
    arm().deliver({ type: "error", error: "out of memory" });
    expect(onError).toHaveBeenCalledWith("out of memory");
    expect(onDone).not.toHaveBeenCalled();
  });
});
