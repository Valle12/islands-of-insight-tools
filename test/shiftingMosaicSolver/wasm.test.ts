import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Position, ShiftingMosaicTest } from "../../src/util/types";

// ---------------------------------------------------------------------------
// Exercises the production WASM solver (compiled from the C++ A*) against
// every shiftingMosaicTest fixture, mirroring the native GoogleTest suite.
// ---------------------------------------------------------------------------

// Direction encoding matches the C++ `enum class Direction { UP, RIGHT,
// DOWN, LEFT }`.
const DX = [0, 1, 0, -1];
const DY = [-1, 0, 1, 0];

const PER_PUZZLE_BUDGET_MS = 60_000;
// A failed guided pass is followed by a BFS pass, so the solver can run for
// up to 2x the budget before giving up.
const PER_PUZZLE_TIMEOUT_MS = PER_PUZZLE_BUDGET_MS * 2 + 15_000;

interface WasmTurn {
  blockId: number;
  direction: number;
}

type WasmTurnList = { length: number; [index: number]: WasmTurn };

interface WasmModule {
  search(
    gridWidth: number,
    gridHeight: number,
    shapes: Position[][],
    initialAnchors: Position[],
    goalIndex: number,
    goalAnchor: Position,
    weight: number,
    deadlockPruning: boolean,
    maxMs: number,
    maxNodes: number,
    useIda: boolean,
    pathBlockerWeight: number,
    boundaryWeight: number,
    allWallsBfsBase: boolean,
    macroMoves: boolean,
    axisAwareWeight: number,
    lpDisplacementWeight: number,
    strideOverride: number,
    postProcess: boolean,
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

// Player "steps" = maximal runs of same-block, same-direction turns.
function countSteps(turns: WasmTurn[]): number {
  let steps = 0;
  for (let i = 0; i < turns.length; i++) {
    const prev = turns[i - 1];
    const cur = turns[i]!;
    if (!prev || prev.blockId !== cur.blockId || prev.direction !== cur.direction) {
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
  const wasmBinary = readFileSync(wasmBinPath);
  return createModule({
    locateFile(file: string) {
      return file.endsWith(".wasm") ? wasmBinPath : file;
    },
    wasmBinary,
  });
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

describe("WASM solver (shifting-mosaic)", () => {
  const cases: [string][] = [["shiftingMosaicTest.json"]];
  for (let i = 1; i <= 43; i++) {
    cases.push([`shiftingMosaicTest${i}.json`]);
  }

  test.each(cases)(
    "solves %s",
    async filename => {
      // A fresh module per puzzle: a hard puzzle that exhausts the wasm32
      // address space aborts only its own instance — it never poisons the
      // tests that run after it.
      const module = await loadWasmModule();
      const data: ShiftingMosaicTest = await Bun.file(
        `${import.meta.dir}/../resources/${filename}`,
      ).json();

      // Production config: weighted A* (w=3) + the full additive heuristic
      // stack, stride auto-detection on (strideOverride = 0). postProcess is
      // off here so the raw solution can serve as the optimization baseline.
      const rawResult = module.search(
        data.gridWidth,
        data.gridHeight,
        data.shapes,
        data.initialAnchors,
        data.goalIndex,
        data.goalAnchor,
        /* weight */ 3,
        /* deadlockPruning */ true,
        /* maxMs */ PER_PUZZLE_BUDGET_MS,
        /* maxNodes */ 20_000_000,
        /* useIda */ false,
        /* pathBlockerWeight */ 1,
        /* boundaryWeight */ 1,
        /* allWallsBfsBase */ false,
        /* macroMoves */ false,
        /* axisAwareWeight */ 1,
        /* lpDisplacementWeight */ 1,
        /* strideOverride */ 0,
        /* postProcess */ false,
      );
      const raw = toTurnArray(rawResult);

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
    },
    PER_PUZZLE_TIMEOUT_MS,
  );
});
