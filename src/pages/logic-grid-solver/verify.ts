/**
 * The rules, checked here rather than taken on trust.
 *
 * This is the page's own copy of the puzzle's semantics, and it is the only
 * thing between a bad answer from the solver and the board the player is shown
 * — the same discipline the other three pages use for their witnesses. It
 * mirrors `a-star/Verify.cpp` and, like it, is written as a plain full-board
 * scan that shares nothing with the machinery that produced the answer: an
 * oracle built out of the thing it is checking only proves the two agree.
 *
 * Colourings cross as a FLAT ROW-MAJOR array — `cells[y * gridWidth + x]` —
 * which is the layout the wasm module answers in. The editor's own `cells` are
 * column-major; `toFlat` is the one place that difference is handled.
 */

import type { LogicGridTest } from "../../util/types";
import { DARK, LIGHT, UNKNOWN, UNPLAYABLE } from "./cell";
import { at, type LogicGridViolation, type RuleCheck } from "./verifyCore";
import { CLUE_CHECKS } from "./verifyClues";
import { PATTERN_CHECKS } from "./verifyPatterns";
import { REGION_CHECKS } from "./verifyRegions";

// The names the rest of the page reaches for. Re-exported rather than left
// where they landed so no caller has to know which of these files a thing is
// in: `verify.ts` is still the whole oracle's front door.
export { OFF_BY_ONE, toFlat, toGrid, UNDERCLUED } from "./verifyCore";
export type { LogicGridViolation } from "./verifyCore";

function shapeProblem(
  config: LogicGridTest,
  cells: number[],
): LogicGridViolation {
  for (let y = 0; y < config.gridHeight; y++) {
    for (let x = 0; x < config.gridWidth; x++) {
      const given = config.cells[x]![y]!;
      const found = at(config, cells, x, y);
      if (given === UNPLAYABLE) {
        if (found !== UNPLAYABLE) return "shape";
      } else if (found === UNKNOWN) return "incomplete";
      else if (found !== DARK && found !== LIGHT) return "shape";
      else if (given !== UNKNOWN && given !== found) return "given";
    }
  }
  return "none";
}

/**
 * Every square of a merged cell holds one colour.
 *
 * Nothing the solver produces can break this — its domains fan out over a
 * merged cell, so its squares are decided together — but this checker also
 * gates answers that never went through them, and it is the last thing between
 * a bad answer and the board the player is shown. It is also what entitles
 * every check below to go on reading the colouring one SQUARE at a time.
 */
function fusedProblem(
  config: LogicGridTest,
  cells: number[],
): LogicGridViolation {
  for (const shape of config.shapes ?? []) {
    const color = cells[shape[0]!];
    if (shape.some(square => cells[square] !== color)) return "cell-split";
  }
  return "none";
}

/**
 * Whether `cells` is a complete, legal solution of `config`.
 *
 * The implied checkerboard rule is deliberately absent: when both colours are
 * connected a checkerboard already breaks one of them, so the connectivity test
 * catches it — and leaving it out keeps this oracle free of anything the solver
 * derived rather than was told.
 *
 * ORDER IS LOAD-BEARING at the top. `shapeProblem` is about the board's GAPS
 * and givens and stays first, so those are still named as such, and
 * `fusedProblem` then settles what a merged cell is before anything below reads
 * the colouring square by square — which is what entitles every check in the
 * three families to go on reading one SQUARE at a time. Their order relative to
 * each other only decides which violation a board breaking several is named
 * for, which the suites assert.
 *
 * A rule family is one entry here; a new rule is one entry in its own family's
 * file, and neither costs another branch in an already-long function.
 */
const CHECKS: readonly RuleCheck[] = [
  shapeProblem,
  fusedProblem,
  ...PATTERN_CHECKS,
  ...REGION_CHECKS,
  ...CLUE_CHECKS,
];

export function verifyLogicGrid(
  config: LogicGridTest,
  cells: number[],
): LogicGridViolation {
  for (const check of CHECKS) {
    const problem = check(config, cells);
    if (problem !== "none") return problem;
  }
  return "none";
}
