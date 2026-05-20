import { beforeAll, describe, expect, test } from "bun:test";
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
const PER_PUZZLE_TIMEOUT_MS = PER_PUZZLE_BUDGET_MS + 10_000;

interface WasmTurn {
  blockId: number;
  direction: number;
}

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
  ): { length: number; [index: number]: WasmTurn };
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
  let module: WasmModule;

  beforeAll(async () => {
    module = await loadWasmModule();
  });

  const cases: [string][] = [["shiftingMosaicTest.json"]];
  for (let i = 1; i <= 30; i++) {
    cases.push([`shiftingMosaicTest${i}.json`]);
  }

  test.each(cases)(
    "solves %s",
    async filename => {
      const data: ShiftingMosaicTest = await Bun.file(
        `${import.meta.dir}/../resources/${filename}`,
      ).json();

      // Production config: weighted A* (w=3) + the full additive heuristic
      // stack, stride auto-detection on (strideOverride = 0).
      const result = module.search(
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
      );

      const turns: WasmTurn[] = [];
      for (let i = 0; i < result.length; i++) {
        turns.push({
          blockId: result[i]!.blockId,
          direction: result[i]!.direction,
        });
      }
      console.log(`${filename}: ${turns.length} moves`);

      expect(turns.length).toBeGreaterThan(0);
      const { valid, reason } = validateSolution(data, turns);
      expect(valid, reason).toBe(true);
    },
    PER_PUZZLE_TIMEOUT_MS,
  );
});
