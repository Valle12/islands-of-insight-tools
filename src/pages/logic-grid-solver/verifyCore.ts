// The primitives every rule checker in this family shares: the catalog
// lookups that name a rule or a clue kind, the two grid readers, and the flood
// fill.
//
// Split out of `verify.ts` so the checkers themselves can live in files grouped
// by WHAT they check. Resolving every index HERE — once, at module load — is
// what keeps `ruleIndex`'s loud failure meaningful: a mistyped or renamed id
// must break the import rather than quietly switch a rule off in the one place
// that is supposed to catch a broken answer.
//
// Colorings cross as a FLAT ROW-MAJOR array — `cells[y * gridWidth + x]` —
// which is the layout the wasm module answers in. The editor's own `cells` are
// column-major; `toFlat` is the one place that difference is handled.

import type { LogicGridTest } from "../../util/types";
import { UNKNOWN, UNPLAYABLE } from "./cell";
import { RULES } from "./rules";
import { axisIndex, SYMBOL_KINDS } from "./symbols";

export type LogicGridViolation =
  | "none"
  | "incomplete"
  | "shape"
  | "given"
  | "square"
  | "run"
  | "checkerboard"
  | "triple"
  | "tee"
  | "disconnected"
  | "area"
  | "region-size"
  | "letter-split"
  | "letter-shared"
  | "area-without-symbol"
  | "area-with-many-symbols"
  | "cell-split"
  | "dart"
  | "symmetry"
  | "three-one"
  | "diagonal"
  | "viewpoint"
  | "elbow"
  | "ell"
  | "distance-pair"
  | "mixed-tee"
  | "long-tee"
  | "knight"
  | "mixed-elbow"
  | "galaxy"
  | "region-shape-repeat"
  | "region-shape-mismatch"
  // One name for every drawn pattern, not one per pattern: what a board broke
  // is a shape the config carries, which no member of this union could spell.
  | "custom-pattern";

/** What every rule family's checker looks like. */
export type RuleCheck = (
  config: LogicGridTest,
  cells: number[],
) => LogicGridViolation;

/**
 * A rule's position in the append-only catalog, by its stable id.
 *
 * Throws rather than returning `findIndex`'s -1, and that matters here more
 * than anywhere: every constant below is resolved once at module load, and a
 * -1 would make `has()` answer false for every board — silently switching the
 * rule off in the one file that is supposed to catch a broken answer. A
 * mistyped id or a renamed rule has to fail loudly at import.
 */
function ruleIndex(id: string): number {
  const index = RULES.findIndex(rule => rule.id === id);
  if (index < 0) throw new Error(`verify.ts refers to an unknown rule: ${id}`);
  return index;
}

export const NO_DARK_2X2 = ruleIndex("no-dark-2x2");

export const NO_LIGHT_2X2 = ruleIndex("no-light-2x2");

export const CONNECT_DARK = ruleIndex("connect-dark");

export const CONNECT_LIGHT = ruleIndex("connect-light");

export const NO_CHECKERBOARD = ruleIndex("no-checkerboard");

export const NO_DARK_LIGHT_DARK = ruleIndex("no-dark-light-dark");

export const NO_LIGHT_DARK_LIGHT = ruleIndex("no-light-dark-light");

export const NO_DARK_T = ruleIndex("no-dark-t");

export const NO_LIGHT_T = ruleIndex("no-light-t");

export const NO_THREE_DARK_ONE_LIGHT = ruleIndex("no-three-dark-one-light");

export const NO_THREE_LIGHT_ONE_DARK = ruleIndex("no-three-light-one-dark");

export const NO_DARK_DIAGONAL = ruleIndex("no-dark-diagonal");

export const NO_LIGHT_DIAGONAL = ruleIndex("no-light-diagonal");

export const NO_DARK_ELBOW = ruleIndex("no-dark-elbow");

export const NO_LIGHT_ELBOW = ruleIndex("no-light-elbow");

export const NO_DARK_ELL = ruleIndex("no-dark-l");

export const NO_LIGHT_ELL = ruleIndex("no-light-l");

export const NO_DARK_ANY_DARK = ruleIndex("no-dark-any-dark");

export const NO_LIGHT_ANY_LIGHT = ruleIndex("no-light-any-light");

export const NO_LIGHT_CROSSED_DARK_T = ruleIndex("no-light-crossed-dark-t");

export const NO_DARK_CROSSED_LIGHT_T = ruleIndex("no-dark-crossed-light-t");

export const NO_DARK_LONG_T = ruleIndex("no-dark-long-t");

export const NO_LIGHT_LONG_T = ruleIndex("no-light-long-t");

export const NO_DARK_KNIGHT = ruleIndex("no-dark-knight");

export const NO_LIGHT_KNIGHT = ruleIndex("no-light-knight");

export const NO_DARK_LIGHT_DARK_ELBOW = ruleIndex("no-dark-light-dark-elbow");

export const NO_LIGHT_DARK_LIGHT_ELBOW = ruleIndex("no-light-dark-light-elbow");

export const DISTINCT_SHAPES_DARK = ruleIndex("distinct-shapes-dark");

export const DISTINCT_SHAPES_LIGHT = ruleIndex("distinct-shapes-light");

export const SAME_SHAPE_DARK = ruleIndex("same-shape-dark");

export const SAME_SHAPE_LIGHT = ruleIndex("same-shape-light");

export const ONE_SYMBOL_DARK = ruleIndex("one-symbol-dark");

export const ONE_SYMBOL_LIGHT = ruleIndex("one-symbol-light");
export const UNDERCLUED = ruleIndex("underclued");
/**
 * Exported like `UNDERCLUED`: the validator and the editor consult it to widen
 * the numeric value bounds while the rule is active.
 */
export const OFF_BY_ONE = ruleIndex("off-by-one");

/**
 * The sized families — no-1xN and regions-have-area-N — appear as no constants
 * here at all: since format version 2 they are read straight off the config own
 * `runs` and `areas` lists in `runProblem` and `regionSizeProblem`. That is
 * still the independence this oracle is built on — the lists ARE the puzzle
 * statement, not anything the search derived — and it is what lets a size the
 * catalog never named verify exactly like one it did.
 */

/**
 * A clue kind's position in its own append-only catalog, by its stable id —
 * the same trick `ruleIndex` plays, and for the same reason. A clue family
 * matched by a bare `type !== 0` silently checks the wrong kind the moment the
 * catalog grows, and this file is the last thing between a bad answer and the
 * board.
 */
function symbolIndex(id: string): number {
  const index = SYMBOL_KINDS.findIndex(kind => kind.id === id);
  if (index < 0) throw new Error(`verify.ts refers to an unknown symbol: ${id}`);
  return index;
}

export const AREA_SYMBOL = symbolIndex("area");

export const LETTER_SYMBOL = symbolIndex("letter");

export const DART_SYMBOL = symbolIndex("dart");

export const LOTUS_SYMBOL = symbolIndex("lotus");

export const VIEWPOINT_SYMBOL = symbolIndex("viewpoint");

export const GALAXY_SYMBOL = symbolIndex("galaxy");

/** The two axes with no reflection on a grid-line seat. Resolved by id like
 * every other index here, so a reorder fails loudly at import. */
export const DIAGONAL_DOWN = axisIndex("diagonal-down");

export const DIAGONAL_UP = axisIndex("diagonal-up");

export const HORIZONTAL_AXIS = axisIndex("horizontal");

export const VERTICAL_AXIS = axisIndex("vertical");

/** The editor's column-major grid as the flat row-major one answers use. */
export function toFlat(config: LogicGridTest): number[] {
  const flat: number[] = [];
  for (let y = 0; y < config.gridHeight; y++) {
    for (let x = 0; x < config.gridWidth; x++) flat.push(config.cells[x]![y]!);
  }
  return flat;
}

/** The inverse, for writing an answer back into a board. */
export function toGrid(config: LogicGridTest, flat: number[]): number[][] {
  return Array.from({ length: config.gridWidth }, (_, x) =>
    Array.from({ length: config.gridHeight }, (_, y) =>
      flat[y * config.gridWidth + x] ?? UNKNOWN,
    ),
  );
}

export function has(config: LogicGridTest, index: number): boolean {
  return config.rules.includes(index);
}

/**
 * Whether an actual count satisfies a numeric clue's DISPLAYED value. Under
 * `off-by-one` every numeric clue displays its true count ± 1 and never the
 * truth, so the test is an exact distance of one — a displayed value EQUAL to
 * the count is then a violation, not a near miss.
 */
export function matchesCount(
  config: LogicGridTest,
  actual: number,
  displayed: number | string | undefined,
): boolean {
  if (has(config, OFF_BY_ONE))
    return typeof displayed === "number" && Math.abs(actual - displayed) === 1;
  return actual === displayed;
}

export function at(config: LogicGridTest, cells: number[], x: number, y: number) {
  return cells[y * config.gridWidth + x] ?? UNPLAYABLE;
}

/** What `holds` hands back, so a shape test can take the probe as a parameter. */
export type Held = (x: number, y: number) => boolean;

/** A bounds-checked "is (x, y) on the board and holding `color`" reader — the
 * probe the center-anchored scans share, since their steps walk off the board. */
export function holds(config: LogicGridTest, cells: number[], color: number) {
  return (x: number, y: number) =>
    x >= 0 &&
    x < config.gridWidth &&
    y >= 0 &&
    y < config.gridHeight &&
    at(config, cells, x, y) === color;
}

/** The cells of one color orthogonally reachable from a starting index. */
export function region(config: LogicGridTest, cells: number[], start: number) {
  const color = cells[start];
  const seen = new Set<number>([start]);
  const queue = [start];
  while (queue.length > 0) {
    const cell = queue.pop()!;
    const x = cell % config.gridWidth;
    const y = Math.floor(cell / config.gridWidth);
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || nx >= config.gridWidth) continue;
      if (ny < 0 || ny >= config.gridHeight) continue;
      const next = ny * config.gridWidth + nx;
      if (seen.has(next) || cells[next] !== color) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
}
