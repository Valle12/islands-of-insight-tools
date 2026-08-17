// The clues whose meaning is a GEOMETRY worked out from where the clue sits: a
// dart's ray, a viewpoint's four lines of sight, a lotus's mirror, a galaxy's
// half turn.
//
// Every one of them is walked here from the clue alone rather than read off
// anything the solver built. That is the whole point of this family: it is the
// one place that says out loud where a dart's line runs and what a viewpoint
// sees, so a solver that built those wrongly has something to disagree with.

import type { LogicGridTest } from "../../util/types";
import { DARK, LIGHT, UNPLAYABLE } from "./cell";
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

/** The colour a turn hands back where it INVERTS. Only ever asked of a real
 * colour: an unplayable square is dropped before this is reached. */
function otherColor(color: number): number {
  return color === DARK ? LIGHT : DARK;
}

/** Where the square (x, y) lands under a half turn about the DOUBLED point
 * (cx2, cy2) — doubled so a centre on a grid line stays an integer, exactly
 * as `mirrorOf` needs it for an axis. */
function halfTurnOf(
  cx2: number,
  cy2: number,
  x: number,
  y: number,
): [number, number] {
  return [cx2 - x, cy2 - y];
}

/**
 * The playable squares touching a galaxy's centre: one at a square's own
 * centre, two on a grid line, four at a corner. This IS the scope of the rule
 * — every region holding one of them is turned — and each of them is its own
 * partner's mirror, which is what pins the sign.
 */
function seatSquares(
  config: LogicGridTest,
  cells: number[],
  x: number,
  y: number,
  seat: number,
): number[] {
  const squares: number[] = [];
  for (let dy = 0; dy <= seat >> 1; dy++) {
    for (let dx = 0; dx <= (seat & 1); dx++) {
      const [sx, sy] = [x + dx, y + dy];
      if (sx >= config.gridWidth || sy >= config.gridHeight) continue;
      // An unplayable square is in no region and holds no colour, so it takes
      // no part. Its PARTNER, if playable, still demands a mirror it cannot
      // have — which that partner's own walk reports.
      if (at(config, cells, sx, sy) === UNPLAYABLE) continue;
      squares.push(sy * config.gridWidth + sx);
    }
  }
  return squares;
}

/**
 * Which way the turn takes colour, read off the clue's own square and its
 * image: `false` where it preserves, `true` where it inverts, and null where
 * the clue's square cannot turn at all — off the board or onto a gap, either
 * of which no colouring survives.
 *
 * The pair always exists: the clue's square is playable, and its image is a
 * square touching the centre too. At seat 0 the square IS its own image, so
 * the answer can only be `false` — which is why the seatless galaxy is the
 * special case rather than the rule.
 */
function turnSign(
  config: LogicGridTest,
  cells: number[],
  x: number,
  y: number,
  cx2: number,
  cy2: number,
): boolean | null {
  const [px, py] = halfTurnOf(cx2, cy2, x, y);
  if (px < 0 || px >= config.gridWidth) return null;
  if (py < 0 || py >= config.gridHeight) return null;
  const partner = at(config, cells, px, py);
  if (partner === UNPLAYABLE) return null;
  return cells[y * config.gridWidth + x] !== partner;
}

/**
 * Whether the region holding `start` turns onto a region of the right colour:
 * every square's image on the board, playable, and holding `start`'s colour —
 * or the OTHER colour where the turn inverts. The lotus's `regionMirrors` for
 * the half turn, and split out for its reason.
 */
function regionTurns(
  config: LogicGridTest,
  cells: number[],
  start: number,
  cx2: number,
  cy2: number,
  invert: boolean,
): boolean {
  const color = cells[start]!;
  const target = invert ? otherColor(color) : color;
  for (const cell of region(config, cells, start)) {
    const [mx, my] = halfTurnOf(
      cx2,
      cy2,
      cell % config.gridWidth,
      Math.floor(cell / config.gridWidth),
    );
    if (mx < 0 || mx >= config.gridWidth) return false;
    if (my < 0 || my >= config.gridHeight) return false;
    if (at(config, cells, mx, my) !== target) return false;
  }
  return true;
}

/**
 * Every galaxy's regions map onto one another under a HALF TURN about its
 * centre, which may be a square's own centre, a grid line or a corner.
 *
 * The turn carries a SIGN. With the centre on a square, that square is its own
 * mirror, so the sign can only preserve colour and the rule is what it always
 * was. With the centre between squares of DIFFERENT colours, the turn inverts:
 * every cell's mirror holds the opposite colour, so the dark region and the
 * light region touching the centre are each other's image. The sign is read
 * off the home square and its partner, which always exist — the home square is
 * playable, and its partner is a seat square too.
 *
 * Scope is every region touching the centre, and walking all of them is
 * load-bearing rather than thorough: the turn is an involution, so one
 * region's image LIES IN the other, but the other may reach further, and only
 * its own walk says so.
 *
 * A corner whose two pairs disagree about the sign needs no check of its own —
 * the second pair's squares are in scope, so their walk demands exactly what
 * the first pair's sign refuses.
 */
function galaxyProblem(
  config: LogicGridTest,
  cells: number[],
): LogicGridViolation {
  for (const symbol of config.symbols) {
    if (symbol.type !== GALAXY_SYMBOL) continue;
    const seat = symbol.seat ?? 0;
    // Unreadable geometry satisfies nothing, the lotus's rule: the validator
    // names these faults properly, so only a board that skipped it gets here.
    if (seat < 0 || seat >= SEAT_COUNT) return "galaxy";
    const cx2 = 2 * symbol.x + (seat & 1);
    const cy2 = 2 * symbol.y + (seat >> 1);

    const invert = turnSign(config, cells, symbol.x, symbol.y, cx2, cy2);
    if (invert === null) return "galaxy";

    for (const start of seatSquares(config, cells, symbol.x, symbol.y, seat)) {
      if (!regionTurns(config, cells, start, cx2, cy2, invert)) return "galaxy";
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
