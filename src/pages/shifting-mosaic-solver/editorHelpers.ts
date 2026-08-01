import { parsePositiveInt as parseBounded } from "../../util/editorShell";
import type { Position } from "../../util/types";
import { MAX_GRID_SIDE } from "./config";

// Pure helpers for ShiftingMosaicSolverEditor. Split out of
// shiftingMosaicSolver.ts for size; none of them read editor state, so they
// take what they need as arguments.

/**
 * A grid dimension, bounded by this page's own cap. The bound matters: the
 * solver's BitGrid packs one row per uint64_t (64 columns max) and the wasm
 * boundary narrows dimensions to uint8_t and coordinates to int8_t, so an
 * unbounded value here silently solves a *different* board — and the editor
 * would try to build width x height DOM cells first.
 */
export function parsePositiveInt(value: string): number | null {
  return parseBounded(value, MAX_GRID_SIDE);
}


export function computeGoalAnchor(cells: Position[]): Position {
  let minX = cells[0]!.x;
  let minY = cells[0]!.y;
  for (const cell of cells) {
    if (cell.x < minX) minX = cell.x;
    if (cell.y < minY) minY = cell.y;
  }
  return { x: minX, y: minY };
}
