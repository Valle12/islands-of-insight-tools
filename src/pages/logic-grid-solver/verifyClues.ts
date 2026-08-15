// The clues whose meaning is a GEOMETRY worked out from where the clue sits: a
// dart's ray, a viewpoint's four lines of sight, a lotus's mirror, a galaxy's
// half turn.
//
// Every one of them is walked here from the clue alone rather than read off
// anything the solver built. That is the whole point of this family: it is the
// one place that says out loud where a dart's line runs and what a viewpoint
// sees, so a solver that built those wrongly has something to disagree with.

import type { LogicGridTest } from "../../util/types";
import { DARK, LIGHT } from "./cell";
import { AXIS_COUNT, directionAt, SEAT_COUNT } from "./symbols";
import {
  at,
  DART_SYMBOL,
  DIAGONAL_DOWN,
  DIAGONAL_UP,
  GALAXY_SYMBOL,
  HORIZONTAL_AXIS,
  LOTUS_SYMBOL,
  matchesCount,
  region,
  VERTICAL_AXIS,
  VIEWPOINT_SYMBOL,
  type LogicGridViolation,
  type RuleCheck,
} from "./verifyCore";

/**
 * Every dart counts the squares of the OTHER colour along its own line.
 *
 * The line runs from the dart's square to the edge of the board, and a gap in
 * the board is stepped over rather than stopping it — a dart sees past a hole
 * exactly as the eye does. Squares are counted one by one, so a merged cell
 * lying along the line contributes every square of itself that the line
 * crosses.
 *
 * Walked here rather than read off anything the solver built: this is the one
 * place that says out loud where a dart's line runs, so a solver that built the
 * line wrongly has something to disagree with. The dart's own cell needs no
 * special case for the same reason it needs none in the search — every square
 * of it holds the dart's own colour, so none of them is ever the other one.
 */
function dartProblem(
  config: LogicGridTest,
  cells: number[],
): LogicGridViolation {
  for (const symbol of config.symbols) {
    if (symbol.type !== DART_SYMBOL) continue;
    const step = directionAt(symbol.direction ?? -1);
    if (!step) return "dart";

    const own = at(config, cells, symbol.x, symbol.y);
    const other = own === DARK ? LIGHT : DARK;
    let count = 0;
    for (
      let x = symbol.x + step.dx, y = symbol.y + step.dy;
      x >= 0 && x < config.gridWidth && y >= 0 && y < config.gridHeight;
      x += step.dx, y += step.dy
    ) {
      if (at(config, cells, x, y) === other) count++;
    }
    if (!matchesCount(config, count, symbol.value)) return "dart";
  }
  return "none";
}

/**
 * Every viewpoint counts the squares it can SEE: its own square, plus the
 * leading run of its own colour along each of the four directions. Sight
 * stops at the first square of the other colour, at a gap — unlike a dart's
 * line, which steps over one — and at the edge of the board. Squares are
 * counted one at a time, so a merged cell contributes exactly the squares the
 * sight crosses, wherever the rest of it lies; its own cell's squares count
 * like any others, being the counted colour by definition.
 *
 * Walked from the clue like everything in this file: this is the one place
 * that says out loud what a viewpoint sees, so a solver that built its rays
 * wrongly has something to disagree with.
 */
function viewpointProblem(
  config: LogicGridTest,
  cells: number[],
): LogicGridViolation {
  for (const symbol of config.symbols) {
    if (symbol.type !== VIEWPOINT_SYMBOL) continue;
    const own = at(config, cells, symbol.x, symbol.y);
    let count = 1;
    for (const [dx, dy] of [
      [0, -1],
      [1, 0],
      [0, 1],
      [-1, 0],
    ] as const) {
      for (
        let x = symbol.x + dx, y = symbol.y + dy;
        x >= 0 &&
        x < config.gridWidth &&
        y >= 0 &&
        y < config.gridHeight &&
        at(config, cells, x, y) === own;
        x += dx, y += dy
      )
        count++;
    }
    if (!matchesCount(config, count, symbol.value)) return "viewpoint";
  }
  return "none";
}

/**
 * Every galaxy's region maps to itself under a HALF TURN about the galaxy's
 * own square: the point mirror of each square of the connected same-colour
 * region holding it must be on the board, playable, and the same colour —
 * which by the region's maximality puts the mirror in the region too. The
 * geometry is one point reflection, worked out from the clue alone like
 * everything in this file; a galaxy has no axis or seat that could be
 * unreadable, so unlike the lotus it needs no readability net.
 */
function galaxyProblem(
  config: LogicGridTest,
  cells: number[],
): LogicGridViolation {
  for (const symbol of config.symbols) {
    if (symbol.type !== GALAXY_SYMBOL) continue;
    const start = symbol.y * config.gridWidth + symbol.x;
    const color = cells[start];
    for (const cell of region(config, cells, start)) {
      const mx = 2 * symbol.x - (cell % config.gridWidth);
      const my = 2 * symbol.y - Math.floor(cell / config.gridWidth);
      if (mx < 0 || mx >= config.gridWidth) return "galaxy";
      if (my < 0 || my >= config.gridHeight) return "galaxy";
      if (at(config, cells, mx, my) !== color) return "galaxy";
    }
  }
  return "none";
}

/** Where the square (x, y) reflects to across `axis` through the DOUBLED
 * point (cx2, cy2) — doubled so a seat on a grid line stays an integer. */
function mirrorOf(
  axis: number,
  cx2: number,
  cy2: number,
  x: number,
  y: number,
): [number, number] {
  if (axis === HORIZONTAL_AXIS) return [x, cy2 - y];
  if (axis === VERTICAL_AXIS) return [cx2 - x, y];
  if (axis === DIAGONAL_DOWN)
    return [y + (cx2 - cy2) / 2, x - (cx2 - cy2) / 2];
  return [(cx2 + cy2) / 2 - y, (cx2 + cy2) / 2 - x];
}

/** Whether a lotus's geometry can be read at all: axis and seat in range, and
 * no diagonal on a grid-line seat, whose reflection would land on corners. */
function lotusReadable(axis: number, seat: number): boolean {
  if (axis < 0 || axis >= AXIS_COUNT || seat < 0 || seat >= SEAT_COUNT)
    return false;
  const diagonal = axis === DIAGONAL_DOWN || axis === DIAGONAL_UP;
  return !(diagonal && (seat === 1 || seat === 2));
}

/** Whether the region holding `start` maps to itself across the axis through
 * the doubled point: every square's mirror on the board and the same colour. */
function regionMirrors(
  config: LogicGridTest,
  cells: number[],
  start: number,
  axis: number,
  cx2: number,
  cy2: number,
): boolean {
  const color = cells[start];
  for (const cell of region(config, cells, start)) {
    const [mx, my] = mirrorOf(
      axis,
      cx2,
      cy2,
      cell % config.gridWidth,
      Math.floor(cell / config.gridWidth),
    );
    if (mx < 0 || mx >= config.gridWidth) return false;
    if (my < 0 || my >= config.gridHeight) return false;
    if (at(config, cells, mx, my) !== color) return false;
  }
  return true;
}

/**
 * Every symmetry symbol's region maps to itself across the symbol's axis: the
 * mirror of each square of the connected same-colour region holding it must
 * be on the board, playable, and the same colour — which by the region's
 * maximality puts the mirror in the region too. The geometry is worked out
 * from the clue alone, mirroring `lotusProblem` in `a-star/Verify.cpp`; this
 * file shares nothing with the solver on purpose.
 */
function lotusProblem(
  config: LogicGridTest,
  cells: number[],
): LogicGridViolation {
  for (const symbol of config.symbols) {
    if (symbol.type !== LOTUS_SYMBOL) continue;
    const axis = symbol.direction ?? -1;
    const seat = symbol.seat ?? 0;
    // Unreadable geometry satisfies nothing. The validator names these
    // faults properly, so only a board that skipped it can reach them.
    if (!lotusReadable(axis, seat)) return "symmetry";

    const start = symbol.y * config.gridWidth + symbol.x;
    const cx2 = 2 * symbol.x + (seat & 1);
    const cy2 = 2 * symbol.y + (seat >> 1);
    if (!regionMirrors(config, cells, start, axis, cx2, cy2))
      return "symmetry";
  }
  return "none";
}

/** The clue geometries, in the order `verifyLogicGrid` asks them. */
export const CLUE_CHECKS: readonly RuleCheck[] = [
  dartProblem,
  lotusProblem,
  galaxyProblem,
  viewpointProblem,
];
