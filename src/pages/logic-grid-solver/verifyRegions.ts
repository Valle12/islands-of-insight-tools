// The rules about REGIONS — maximal orthogonally-connected runs of one color —
// and the clues that count them.
//
// What makes these a family is that none of them can be answered from a cell:
// "exactly one clue per region" and "every region has N cells" both have a
// too-few half that is only visible from the region's own side, since nothing
// points at a region that is empty or missing. So every checker here walks the
// board region by region rather than clue by clue.

import type { LogicGridTest } from "../../util/types";
import { DARK, LIGHT } from "./cell";
import {
  AREA_SYMBOL,
  CONNECT_DARK,
  CONNECT_LIGHT,
  DISTINCT_SHAPES_DARK,
  DISTINCT_SHAPES_LIGHT,
  has,
  LETTER_SYMBOL,
  matchesCount,
  ONE_SYMBOL_DARK,
  ONE_SYMBOL_LIGHT,
  region,
  SAME_SHAPE_DARK,
  SAME_SHAPE_LIGHT,
  type LogicGridViolation,
  type RuleCheck,
} from "./verifyCore";

/**
 * The eight dihedral maps, as `[a, b, c, d]` meaning `(x, y) -> (ax + by,
 * cx + dy)`: the four rotations and the four reflections. Entry 4 onwards are
 * what make an S and a Z one shape, and an L and a J one shape.
 */
const DIHEDRAL = [
  [1, 0, 0, 1],
  [0, -1, 1, 0],
  [-1, 0, 0, -1],
  [0, 1, -1, 0],
  [-1, 0, 0, 1],
  [1, 0, 0, -1],
  [0, 1, 1, 0],
  [0, -1, -1, 0],
] as const;

/**
 * A region's shape, as the one key two regions compare equal on exactly when
 * they are CONGRUENT: the lexicographically smallest of its eight dihedral
 * images, each slid against the top-left corner and read row by row.
 *
 * Every image is a bijection of the region, so all eight hold the same number
 * of squares — the size is IN the key, which is why "the same shape and size"
 * needs no separate size test. Which of the eight is picked is arbitrary and
 * only has to be deterministic: keys are compared for equality and never for
 * order, so any total order names the same representative for congruent
 * regions.
 *
 * SQUARES, not merged cells. Every other geometric predicate in this file
 * counts squares, and a merged cell is itself a polyomino rather than a point,
 * so a region "as a set of cells" has no shape to compare in the first place.
 * Two regions with the same footprint are therefore the same shape however the
 * merges beneath them differ, which is what a player sees.
 */
function shapeKey(config: LogicGridTest, spread: Set<number>): string {
  const squares = [...spread].map(cell => [
    cell % config.gridWidth,
    Math.floor(cell / config.gridWidth),
  ]);
  let best: number[][] | null = null;
  for (const [a, b, c, d] of DIHEDRAL) {
    const image = squares.map(([x, y]) => [a * x! + b * y!, c * x! + d * y!]);
    const minX = Math.min(...image.map(([x]) => x!));
    const minY = Math.min(...image.map(([, y]) => y!));
    const slid = image
      .map(([x, y]) => [x! - minX, y! - minY])
      .sort((one, two) => one[1]! - two[1]! || one[0]! - two[0]!);
    if (best === null || less(slid, best)) best = slid;
  }
  return best!.map(([x, y]) => `${x},${y}`).join(";");
}

/** Row-major order over two square lists of the same length. */
function less(one: number[][], two: number[][]): boolean {
  for (let i = 0; i < one.length; i++) {
    const [ax, ay] = one[i]!;
    const [bx, by] = two[i]!;
    if (ay !== by) return ay! < by!;
    if (ax !== bx) return ax! < bx!;
  }
  return false;
}

/** Every maximal region of `color`, each as its own set of flat indices. */
function regionsOf(
  config: LogicGridTest,
  cells: number[],
  color: number,
): Set<number>[] {
  const seen = new Set<number>();
  const found: Set<number>[] = [];
  for (let index = 0; index < cells.length; index++) {
    if (cells[index] !== color || seen.has(index)) continue;
    const spread = region(config, cells, index);
    for (const cell of spread) seen.add(cell);
    found.push(spread);
  }
  return found;
}

function connectivityProblem(
  config: LogicGridTest,
  cells: number[],
): LogicGridViolation {
  for (const [index, color] of [
    [CONNECT_DARK, DARK],
    [CONNECT_LIGHT, LIGHT],
  ] as const) {
    if (!has(config, index)) continue;
    const held = cells.flatMap((cell, i) => (cell === color ? [i] : []));
    // An empty color is vacuously one region, which is what lets an all-dark
    // board be legal while "connect all light cells" is switched on.
    if (held.length === 0) continue;
    if (region(config, cells, held[0]!).size !== held.length)
      return "disconnected";
  }
  return "none";
}

/**
 * Every region of `color` holds exactly `area` cells.
 *
 * Region by region, like `symbolCountProblem` and for the same reason: nothing
 * points at a region, so both halves of "exactly" — too big and too small — are
 * only visible from the region's own side. A color with no cells at all has no
 * regions and is legal: the rule says how big a region is, not that one has to
 * exist.
 */
function regionAreaProblem(
  config: LogicGridTest,
  cells: number[],
  color: number,
  area: number,
): LogicGridViolation {
  const seen = new Set<number>();
  for (let index = 0; index < cells.length; index++) {
    if (cells[index] !== color || seen.has(index)) continue;
    const spread = region(config, cells, index);
    for (const cell of spread) seen.add(cell);
    if (spread.size !== area) return "region-size";
  }
  return "none";
}

function regionSizeProblem(
  config: LogicGridTest,
  cells: number[],
): LogicGridViolation {
  for (const rule of config.areas ?? []) {
    const color = rule.color === "dark" ? DARK : LIGHT;
    const problem = regionAreaProblem(config, cells, color, rule.size);
    if (problem !== "none") return problem;
  }
  return "none";
}

function areaProblem(
  config: LogicGridTest,
  cells: number[],
): LogicGridViolation {
  for (const symbol of config.symbols) {
    if (symbol.type !== AREA_SYMBOL) continue;
    const index = symbol.y * config.gridWidth + symbol.x;
    if (!matchesCount(config, region(config, cells, index).size, symbol.value))
      return "area";
  }
  return "none";
}

/**
 * Every region of `color` carries exactly one clue.
 *
 * Region by region rather than clue by clue: both halves of "exactly one" have
 * to be caught, and the empty case is only visible from the region's side —
 * nothing points at a region that has no clue in it.
 */
function symbolCountProblem(
  config: LogicGridTest,
  cells: number[],
  color: number,
): LogicGridViolation {
  const clued = new Set(
    config.symbols.map(symbol => symbol.y * config.gridWidth + symbol.x),
  );
  const seen = new Set<number>();
  for (let index = 0; index < cells.length; index++) {
    if (cells[index] !== color || seen.has(index)) continue;
    const spread = region(config, cells, index);
    let clues = 0;
    for (const cell of spread) {
      seen.add(cell);
      if (clued.has(cell)) clues++;
    }
    if (clues === 0) return "area-without-symbol";
    if (clues > 1) return "area-with-many-symbols";
  }
  return "none";
}

/**
 * No two regions of one color are the same shape.
 *
 * Vacuous at zero regions and at one, like everything else in this file: the
 * rule says what two regions may not be, not that two have to exist. A color
 * whose rule is off is not looked at, so the two colors never interact.
 */
function distinctShapesProblem(
  config: LogicGridTest,
  cells: number[],
): LogicGridViolation {
  for (const [index, color] of [
    [DISTINCT_SHAPES_DARK, DARK],
    [DISTINCT_SHAPES_LIGHT, LIGHT],
  ] as const) {
    if (!has(config, index)) continue;
    const seen = new Set<string>();
    for (const spread of regionsOf(config, cells, color)) {
      const key = shapeKey(config, spread);
      if (seen.has(key)) return "region-shape-repeat";
      seen.add(key);
    }
  }
  return "none";
}

/**
 * Every region of one color is the same shape as every other. Vacuous at zero
 * regions and at one, for the reason above — and legal alongside its opposite,
 * which together simply say the color has at most one region.
 */
function sameShapeProblem(
  config: LogicGridTest,
  cells: number[],
): LogicGridViolation {
  for (const [index, color] of [
    [SAME_SHAPE_DARK, DARK],
    [SAME_SHAPE_LIGHT, LIGHT],
  ] as const) {
    if (!has(config, index)) continue;
    let first: string | null = null;
    for (const spread of regionsOf(config, cells, color)) {
      const key = shapeKey(config, spread);
      first ??= key;
      if (key !== first) return "region-shape-mismatch";
    }
  }
  return "none";
}

function symbolProblem(
  config: LogicGridTest,
  cells: number[],
): LogicGridViolation {
  for (const [index, color] of [
    [ONE_SYMBOL_DARK, DARK],
    [ONE_SYMBOL_LIGHT, LIGHT],
  ] as const) {
    if (!has(config, index)) continue;
    const problem = symbolCountProblem(config, cells, color);
    if (problem !== "none") return problem;
  }
  return "none";
}

function letterProblem(
  config: LogicGridTest,
  cells: number[],
): LogicGridViolation {
  const groups = new Map<string, number[]>();
  for (const symbol of config.symbols) {
    if (symbol.type !== LETTER_SYMBOL) continue;
    const index = symbol.y * config.gridWidth + symbol.x;
    const key = String(symbol.value);
    groups.set(key, [...(groups.get(key) ?? []), index]);
  }
  for (const [letter, members] of groups) {
    const spread = region(config, cells, members[0]!);
    if (members.some(index => !spread.has(index))) return "letter-split";
    for (const [other, cellsOfOther] of groups) {
      if (other === letter) continue;
      if (cellsOfOther.some(index => spread.has(index))) return "letter-shared";
    }
  }
  return "none";
}

/** The region rules, in the order `verifyLogicGrid` asks them. */
export const REGION_CHECKS: readonly RuleCheck[] = [
  connectivityProblem,
  regionSizeProblem,
  // The three rule-driven whole-region checks stay together, ahead of the
  // clue-driven ones. `Verify.cpp`'s `check` calls them at the same point, or
  // a board breaking both region-size and shape would be NAMED differently on
  // each side, which the suites assert.
  distinctShapesProblem,
  sameShapeProblem,
  areaProblem,
  symbolProblem,
  letterProblem,
];
