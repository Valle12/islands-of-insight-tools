import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker as ArmWorker } from "node:worker_threads";
import { PORTFOLIO } from "../../src/pages/shifting-mosaic-solver/wasmBridge";
import type { Position, ShiftingMosaicTest } from "../../src/util/types";
import { instantiateFromDisk } from "../../src/util/wasmModule";

// ---------------------------------------------------------------------------
// Exercises the production WASM solver (compiled from the C++ A*) against
// every shiftingMosaicTest fixture, mirroring the native GoogleTest suite.
// ---------------------------------------------------------------------------

// Direction encoding matches the C++ `enum class Direction { UP, RIGHT,
// DOWN, LEFT }`.
const DX = [0, 1, 0, -1];
const DY = [-1, 0, 1, 0];

// Per portfolio ARM. The arms race in parallel workers (the production
// browser flow), so a fixture's wall time is its fastest winning arm — not
// a sum of stages. 90s covers the slowest ordinary fixtures: test41 solves
// in the assembly arm (~33s native, more in wasm). test37 is the
// exception: its winning arm (deep flat drag) alone needs ~250s natively,
// so it runs as a dedicated long-budget case below.
const PER_PUZZLE_BUDGET_MS = 90_000;
const PER_PUZZLE_TIMEOUT_MS = PER_PUZZLE_BUDGET_MS * 2 + 30_000;
const LONG_BUDGET_MS = 600_000;
const LONG_TIMEOUT_MS = LONG_BUDGET_MS * 2 + 30_000;

interface WasmTurn {
  blockId: number;
  direction: number;
}

type WasmTurnList = { length: number; [index: number]: WasmTurn };

interface WasmModule {
  // Object-config entry; schema in wasm_bindings.cpp::solve.
  solve(
    puzzle: {
      gridWidth: number;
      gridHeight: number;
      shapes: Position[][];
      initialAnchors: Position[];
      goalIndex: number;
      goalAnchor: Position;
    },
    config: Record<string, unknown>,
  ): WasmTurnList;
  optimize(
    gridWidth: number,
    gridHeight: number,
    shapes: Position[][],
    initialAnchors: Position[],
    goalIndex: number,
    goalAnchor: Position,
    turns: WasmTurn[],
  ): WasmTurnList;
}

// Player "steps" as the UI counts them (solutionView.ts): maximal runs of
// same-block turns — direction changes fold into one polyline drag.
function countSteps(turns: WasmTurn[]): number {
  let steps = 0;
  for (let i = 0; i < turns.length; i++) {
    const prev = turns[i - 1];
    const cur = turns[i]!;
    if (!prev || prev.blockId !== cur.blockId) {
      steps++;
    }
  }
  return steps;
}

function toTurnArray(result: WasmTurnList): WasmTurn[] {
  const turns: WasmTurn[] = [];
  for (let i = 0; i < result.length; i++) {
    turns.push({ blockId: result[i]!.blockId, direction: result[i]!.direction });
  }
  return turns;
}

async function loadWasmModule(): Promise<WasmModule> {
  const here = dirname(fileURLToPath(import.meta.url));
  const wasmDir = join(here, "../../src/pages/shifting-mosaic-solver/wasm");
  const wasmPath = join(wasmDir, "astar.mjs");
  const wasmBinPath = join(wasmDir, "astar.wasm");
  const createModule = (await import(wasmPath)).default;
  return createModule(instantiateFromDisk(wasmBinPath));
}

// Replay the turn list and confirm every move is in-bounds, collision-free,
// and that the goal block lands exactly on goalAnchor.
function validateSolution(
  data: ShiftingMosaicTest,
  turns: WasmTurn[],
): { valid: boolean; reason: string } {
  const anchors = data.initialAnchors.map(a => ({ x: a.x, y: a.y }));
  const { gridWidth: gw, gridHeight: gh, shapes } = data;

  for (let t = 0; t < turns.length; t++) {
    const { blockId, direction } = turns[t]!;
    if (blockId < 0 || blockId >= anchors.length) {
      return { valid: false, reason: `move ${t}: bad blockId ${blockId}` };
    }
    if (direction < 0 || direction > 3) {
      return { valid: false, reason: `move ${t}: bad direction ${direction}` };
    }
    const cur = anchors[blockId]!;
    const next = { x: cur.x + DX[direction]!, y: cur.y + DY[direction]! };

    const nextCells = new Set<number>();
    for (const cell of shapes[blockId]!) {
      const cx = next.x + cell.x;
      const cy = next.y + cell.y;
      if (cx < 0 || cy < 0 || cx >= gw || cy >= gh) {
        return { valid: false, reason: `move ${t}: block ${blockId} out of bounds` };
      }
      nextCells.add(cx * gh + cy);
    }
    for (let j = 0; j < anchors.length; j++) {
      if (j === blockId) continue;
      const a = anchors[j]!;
      for (const cell of shapes[j]!) {
        const enc = (a.x + cell.x) * gh + (a.y + cell.y);
        if (nextCells.has(enc)) {
          return {
            valid: false,
            reason: `move ${t}: block ${blockId} collides with block ${j}`,
          };
        }
      }
    }
    anchors[blockId] = next;
  }

  const g = anchors[data.goalIndex]!;
  if (g.x !== data.goalAnchor.x || g.y !== data.goalAnchor.y) {
    return {
      valid: false,
      reason: `goal block ended at (${g.x},${g.y}), expected (${data.goalAnchor.x},${data.goalAnchor.y})`,
    };
  }
  return { valid: true, reason: "" };
}

// The heaviest suite in the repo (~244s): 43 fixtures, each racing the full
// production arm portfolio in its own worker. Runs by DEFAULT — opt OUT with
// IOI_SKIP_SLOW=1, which reports it as skipped rather than silently dropping it.
describe.skipIf(Bun.env.IOI_SKIP_SLOW === "1")("WASM solver (shifting-mosaic)", () => {
  // test37's winning cascade arm alone exceeds the ordinary per-arm budget
  // (see LONG_BUDGET_MS above), so it runs as its own long case at the end.
  const LONG_BUDGET_FIXTURES = new Set<string>(["shiftingMosaicTest37.json"]);

  const cases: [string][] = [["shiftingMosaicTest.json"]];
  for (let i = 1; i <= 43; i++) {
    cases.push([`shiftingMosaicTest${i}.json`]);
  }
  const activeCases = cases.filter(([f]) => !LONG_BUDGET_FIXTURES.has(f));

  // The list is built from a hardcoded range and then read off disk, so a
  // mis-resolved path or a renamed fixture would shrink the sweep instead of
  // failing it. Assert the arity so that can never pass quietly.
  test("the fixture corpus is complete", () => {
    expect(cases).toHaveLength(44);
    expect(activeCases).toHaveLength(43);
  });

  // Race the FULL production portfolio (one worker thread per arm, each
  // with its own wasm module instance — an arm that exhausts the wasm32
  // address space aborts only its own worker). First non-empty plan wins
  // and the rest are terminated, exactly like wasmBridge does in the
  // browser. node:worker_threads is used explicitly because the test
  // preload's happy-dom `Worker` global is a non-functional stub.
  function racePortfolio(
    puzzle: Record<string, unknown>,
    budgetMs: number,
  ): Promise<WasmTurn[]> {
    const arms = PORTFOLIO.map(arm => ({
      ...arm,
      maxMs: budgetMs,
      postProcess: false,
    }));
    const workerPath = join(
      dirname(fileURLToPath(import.meta.url)),
      "portfolio.worker.ts",
    );
    return new Promise(resolve => {
      const workers = arms.map(() => new ArmWorker(workerPath));
      let pending = workers.length;
      let settled = false;
      const finish = (turns: WasmTurn[]) => {
        if (settled) return;
        settled = true;
        for (const w of workers) void w.terminate();
        resolve(turns);
      };
      // Each arm may only retire once — 'exit' fires after 'done'/'error' too,
      // and a double decrement would settle the race early.
      const retired = new Set<number>();
      const retire = (i: number) => {
        if (settled || retired.has(i)) return;
        retired.add(i);
        if (--pending === 0) finish([]);
      };
      workers.forEach((worker, i) => {
        worker.on("message", (data: { type: string; path?: WasmTurn[] }) => {
          if (settled) return;
          // The wasm module also posts {type:"progress"} while searching —
          // only "done"/"error" settle an arm.
          if (data.type === "done" && data.path && data.path.length > 0) {
            finish(data.path);
          } else if (data.type === "done" || data.type === "error") {
            retire(i); // this arm came back empty or errored
          }
        });
        worker.on("error", (err: unknown) => {
          console.log(`arm ${i} error:`, err instanceof Error ? err.message : String(err));
          retire(i);
        });
        // A worker whose wasm module aborts can end WITHOUT an 'error' event.
        // Without this, pending never reaches 0, the promise never settles, and
        // the timed-out test leaks every arm — live multi-GB wasm heaps — into
        // the next fixture, which then spawns a fresh set on top.
        worker.on("exit", () => retire(i));
        worker.postMessage({ puzzle, config: arms[i] });
      });
    });
  }

  async function solveFixture(filename: string, budgetMs: number) {
    const module = await loadWasmModule(); // main-thread instance: optimizer
    const data: ShiftingMosaicTest = await Bun.file(
      `${import.meta.dir}/../resources/shifting-mosaic-solver/${filename}`,
    ).json();

    // postProcess is off in the arms so the raw solution can serve as the
    // optimization baseline.
    const raw = await racePortfolio(
      {
        gridWidth: data.gridWidth,
        gridHeight: data.gridHeight,
        shapes: data.shapes,
        initialAnchors: data.initialAnchors,
        goalIndex: data.goalIndex,
        goalAnchor: data.goalAnchor,
      },
      budgetMs,
    );

    // Post-process the raw solution and compare.
    const optimized = toTurnArray(
      module.optimize(
        data.gridWidth,
        data.gridHeight,
        data.shapes,
        data.initialAnchors,
        data.goalIndex,
        data.goalAnchor,
        raw,
      ),
    );

    console.log(
      `${filename}: ${raw.length} -> ${optimized.length} moves, ` +
        `${countSteps(raw)} -> ${countSteps(optimized)} steps`,
    );

    // The raw solution must be valid, and the optimized one must still be
    // valid while never being longer in moves or in player steps.
    expect(raw.length).toBeGreaterThan(0);
    expect(validateSolution(data, raw).valid).toBe(true);

    expect(optimized.length).toBeGreaterThan(0);
    const { valid, reason } = validateSolution(data, optimized);
    expect(valid, reason).toBe(true);
    expect(optimized.length).toBeLessThanOrEqual(raw.length);
    expect(countSteps(optimized)).toBeLessThanOrEqual(countSteps(raw));
  }

  test.each(activeCases)(
    "solves %s",
    filename => solveFixture(filename, PER_PUZZLE_BUDGET_MS),
    PER_PUZZLE_TIMEOUT_MS,
  );

  for (const f of LONG_BUDGET_FIXTURES) {
    test(
      `solves ${f} (long budget)`,
      () => solveFixture(f, LONG_BUDGET_MS),
      LONG_TIMEOUT_MS,
    );
  }
});
