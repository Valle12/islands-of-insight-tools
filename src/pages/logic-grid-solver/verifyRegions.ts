// The rules about REGIONS — maximal orthogonally-connected runs of one colour —
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
  has,
  LETTER_SYMBOL,
  matchesCount,
  ONE_SYMBOL_DARK,
  ONE_SYMBOL_LIGHT,
  region,
  type LogicGridViolation,
  type RuleCheck,
} from "./verifyCore";

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
    // An empty colour is vacuously one region, which is what lets an all-dark
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
 * only visible from the region's own side. A colour with no cells at all has no
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
  areaProblem,
  symbolProblem,
  letterProblem,
];
