// The rules read off a LOCAL WINDOW: a 2x2 block, a straight line of three, a
// tetromino, or a pair of cells at a fixed offset. Every one of them is a
// full-board scan needing nothing but the colouring and a bounds-checked
// reader, which is what makes them a family.
//
// Each `has*` says whether the shape occurs anywhere; each `*Problem` asks it
// only for the colours whose rule is switched on. They share nothing with the
// search on purpose — an oracle built out of the thing it is checking only
// proves the two agree.

import type { LogicGridTest } from "../../util/types";
import { DARK, LIGHT } from "./cell";
import {
  at,
  has,
  holds,
  NO_CHECKERBOARD,
  NO_DARK_2X2,
  NO_DARK_ANY_DARK,
  NO_DARK_CROSSED_LIGHT_T,
  NO_DARK_DIAGONAL,
  NO_DARK_ELBOW,
  NO_DARK_ELL,
  NO_DARK_KNIGHT,
  NO_DARK_LIGHT_DARK,
  NO_DARK_LIGHT_DARK_ELBOW,
  NO_DARK_LONG_T,
  NO_DARK_T,
  NO_LIGHT_2X2,
  NO_LIGHT_ANY_LIGHT,
  NO_LIGHT_CROSSED_DARK_T,
  NO_LIGHT_DARK_LIGHT,
  NO_LIGHT_DARK_LIGHT_ELBOW,
  NO_LIGHT_DIAGONAL,
  NO_LIGHT_ELBOW,
  NO_LIGHT_ELL,
  NO_LIGHT_KNIGHT,
  NO_LIGHT_LONG_T,
  NO_LIGHT_T,
  NO_THREE_DARK_ONE_LIGHT,
  NO_THREE_LIGHT_ONE_DARK,
  type Held,
  type LogicGridViolation,
  type RuleCheck,
} from "./verifyCore";

function hasSquare(config: LogicGridTest, cells: number[], color: number) {
  for (let y = 0; y + 1 < config.gridHeight; y++) {
    for (let x = 0; x + 1 < config.gridWidth; x++) {
      if (
        at(config, cells, x, y) === color &&
        at(config, cells, x + 1, y) === color &&
        at(config, cells, x, y + 1) === color &&
        at(config, cells, x + 1, y + 1) === color
      )
        return true;
    }
  }
  return false;
}

/** The longest straight run of one colour; a gap never equals a colour, so it
 * breaks a run without a special case. */
function longestRun(config: LogicGridTest, cells: number[], color: number) {
  let best = 0;
  for (let y = 0; y < config.gridHeight; y++) {
    let run = 0;
    for (let x = 0; x < config.gridWidth; x++) {
      run = at(config, cells, x, y) === color ? run + 1 : 0;
      best = Math.max(best, run);
    }
  }
  for (let x = 0; x < config.gridWidth; x++) {
    let run = 0;
    for (let y = 0; y < config.gridHeight; y++) {
      run = at(config, cells, x, y) === color ? run + 1 : 0;
      best = Math.max(best, run);
    }
  }
  return best;
}

/**
 * All four corners have to be real colours: two gaps on one diagonal would
 * otherwise read as a matching pair.
 */
function hasCheckerboard(config: LogicGridTest, cells: number[]) {
  for (let y = 0; y + 1 < config.gridHeight; y++) {
    for (let x = 0; x + 1 < config.gridWidth; x++) {
      const topLeft = at(config, cells, x, y);
      const topRight = at(config, cells, x + 1, y);
      const real =
        (topLeft === DARK || topLeft === LIGHT) &&
        (topRight === DARK || topRight === LIGHT);
      if (
        real &&
        topLeft === at(config, cells, x + 1, y + 1) &&
        topRight === at(config, cells, x, y + 1) &&
        topLeft !== topRight
      )
        return true;
    }
  }
  return false;
}

/** The 2x2 rules and the checkerboard: everything read off one small window. */
function squareProblem(
  config: LogicGridTest,
  cells: number[],
): LogicGridViolation {
  if (has(config, NO_DARK_2X2) && hasSquare(config, cells, DARK))
    return "square";
  if (has(config, NO_LIGHT_2X2) && hasSquare(config, cells, LIGHT))
    return "square";
  if (has(config, NO_CHECKERBOARD) && hasCheckerboard(config, cells))
    return "checkerboard";
  return "none";
}

/** Both colours measured once, then every active run rule asked about them. */
function runProblem(
  config: LogicGridTest,
  cells: number[],
): LogicGridViolation {
  const darkRun = longestRun(config, cells, DARK);
  const lightRun = longestRun(config, cells, LIGHT);
  for (const rule of config.runs ?? []) {
    const found = rule.color === "dark" ? darkRun : lightRun;
    if (found >= rule.length) return "run";
  }
  return "none";
}

/**
 * A line of three alternating colours with `color` at both ends, in either
 * direction. Both colours are named outright, so a gap can never take part in
 * one: it equals neither.
 */
function hasTriple(config: LogicGridTest, cells: number[], color: number) {
  const other = color === DARK ? LIGHT : DARK;
  for (let y = 0; y < config.gridHeight; y++) {
    for (let x = 0; x < config.gridWidth; x++) {
      if (at(config, cells, x, y) !== color) continue;
      if (
        x + 2 < config.gridWidth &&
        at(config, cells, x + 1, y) === other &&
        at(config, cells, x + 2, y) === color
      )
        return true;
      if (
        y + 2 < config.gridHeight &&
        at(config, cells, x, y + 1) === other &&
        at(config, cells, x, y + 2) === color
      )
        return true;
    }
  }
  return false;
}

function tripleProblem(
  config: LogicGridTest,
  cells: number[],
): LogicGridViolation {
  if (has(config, NO_DARK_LIGHT_DARK) && hasTriple(config, cells, DARK))
    return "triple";
  if (has(config, NO_LIGHT_DARK_LIGHT) && hasTriple(config, cells, LIGHT))
    return "triple";
  return "none";
}

/**
 * A T of one colour: a straight three with a fourth cell on the middle's other
 * side. Scanned from the CENTRE, which sees all four rotations as a bar plus a
 * stem — and sees the T inside a plus, which contains one.
 */
function hasTee(config: LogicGridTest, cells: number[], color: number) {
  const held = holds(config, cells, color);
  for (let y = 0; y < config.gridHeight; y++) {
    for (let x = 0; x < config.gridWidth; x++) {
      if (!held(x, y)) continue;
      if (
        held(x - 1, y) &&
        held(x + 1, y) &&
        (held(x, y - 1) || held(x, y + 1))
      )
        return true;
      if (
        held(x, y - 1) &&
        held(x, y + 1) &&
        (held(x - 1, y) || held(x + 1, y))
      )
        return true;
    }
  }
  return false;
}

function teeProblem(
  config: LogicGridTest,
  cells: number[],
): LogicGridViolation {
  if (has(config, NO_DARK_T) && hasTee(config, cells, DARK)) return "tee";
  if (has(config, NO_LIGHT_T) && hasTee(config, cells, LIGHT)) return "tee";
  return "none";
}

/**
 * A 2x2 holding exactly three of `color` and one of the other. Both colours
 * are counted outright, so a 2x2 touching a gap can never qualify: a gap
 * equals neither.
 */
function hasThreeOne(config: LogicGridTest, cells: number[], color: number) {
  const other = color === DARK ? LIGHT : DARK;
  for (let y = 0; y + 1 < config.gridHeight; y++) {
    for (let x = 0; x + 1 < config.gridWidth; x++) {
      const corners = [
        at(config, cells, x, y),
        at(config, cells, x + 1, y),
        at(config, cells, x, y + 1),
        at(config, cells, x + 1, y + 1),
      ];
      if (
        corners.filter(held => held === color).length === 3 &&
        corners.includes(other)
      )
        return true;
    }
  }
  return false;
}

function threeOneProblem(
  config: LogicGridTest,
  cells: number[],
): LogicGridViolation {
  if (has(config, NO_THREE_DARK_ONE_LIGHT) && hasThreeOne(config, cells, DARK))
    return "three-one";
  if (has(config, NO_THREE_LIGHT_ONE_DARK) && hasThreeOne(config, cells, LIGHT))
    return "three-one";
  return "none";
}

/**
 * Two cells of `color` touching corner to corner, anywhere at all — being
 * joined through an orthogonal neighbour does not excuse the touch, which is
 * what makes every region of the colour a straight bar. Scanned from each
 * cell's two DOWNWARD diagonals, so every pair is seen exactly once.
 */
function hasDiagonal(config: LogicGridTest, cells: number[], color: number) {
  const held = holds(config, cells, color);
  for (let y = 0; y < config.gridHeight; y++) {
    for (let x = 0; x < config.gridWidth; x++) {
      if (!held(x, y)) continue;
      if (held(x + 1, y + 1) || held(x - 1, y + 1)) return true;
    }
  }
  return false;
}

function diagonalProblem(
  config: LogicGridTest,
  cells: number[],
): LogicGridViolation {
  if (has(config, NO_DARK_DIAGONAL) && hasDiagonal(config, cells, DARK))
    return "diagonal";
  if (has(config, NO_LIGHT_DIAGONAL) && hasDiagonal(config, cells, LIGHT))
    return "diagonal";
  return "none";
}

/** A bent tromino of `color`: a 2x2 window holding at least three of it —
 * three is an elbow outright, four is a full square, which contains one. */
function hasElbow(config: LogicGridTest, cells: number[], color: number) {
  for (let y = 0; y + 1 < config.gridHeight; y++) {
    for (let x = 0; x + 1 < config.gridWidth; x++) {
      const corners = [
        at(config, cells, x, y),
        at(config, cells, x + 1, y),
        at(config, cells, x, y + 1),
        at(config, cells, x + 1, y + 1),
      ];
      if (corners.filter(held => held === color).length >= 3) return true;
    }
  }
  return false;
}

function elbowProblem(
  config: LogicGridTest,
  cells: number[],
): LogicGridViolation {
  if (has(config, NO_DARK_ELBOW) && hasElbow(config, cells, DARK))
    return "elbow";
  if (has(config, NO_LIGHT_ELBOW) && hasElbow(config, cells, LIGHT))
    return "elbow";
  return "none";
}

/**
 * An L-tetromino of `color`, either handedness: a straight three with a
 * fourth cell perpendicular at one END. Scanned from the bar's middle like
 * the T. Every diagonal neighbour of the middle is orthogonally adjacent to
 * exactly one end of either bar, so "a bar plus any diagonal of its middle"
 * is precisely an L — all eight orientations — while a foot at the middle
 * itself would be a T, which this never matches.
 */
function hasEll(config: LogicGridTest, cells: number[], color: number) {
  const held = holds(config, cells, color);
  for (let y = 0; y < config.gridHeight; y++) {
    for (let x = 0; x < config.gridWidth; x++) {
      if (held(x, y) && isEllAt(held, x, y)) return true;
    }
  }
  return false;
}

/** The shape test of `hasEll`, for the bar's middle at `(x, y)`. */
function isEllAt(held: Held, x: number, y: number) {
  const corner =
    held(x - 1, y - 1) ||
    held(x - 1, y + 1) ||
    held(x + 1, y - 1) ||
    held(x + 1, y + 1);
  if (!corner) return false;
  return (
    (held(x - 1, y) && held(x + 1, y)) || (held(x, y - 1) && held(x, y + 1))
  );
}

function ellProblem(
  config: LogicGridTest,
  cells: number[],
): LogicGridViolation {
  if (has(config, NO_DARK_ELL) && hasEll(config, cells, DARK)) return "ell";
  if (has(config, NO_LIGHT_ELL) && hasEll(config, cells, LIGHT)) return "ell";
  return "none";
}

/**
 * Two cells of `color` exactly two apart in a straight line. Only the two END
 * squares are read — whatever lies between them, the other colour or even a
 * gap, does not lift the ban, which is what "purely positional" means.
 * Scanned rightward and downward only, so every pair is seen exactly once.
 */
function hasDistancePair(
  config: LogicGridTest,
  cells: number[],
  color: number,
) {
  for (let y = 0; y < config.gridHeight; y++) {
    for (let x = 0; x < config.gridWidth; x++) {
      if (at(config, cells, x, y) !== color) continue;
      if (x + 2 < config.gridWidth && at(config, cells, x + 2, y) === color)
        return true;
      if (y + 2 < config.gridHeight && at(config, cells, x, y + 2) === color)
        return true;
    }
  }
  return false;
}

function distancePairProblem(
  config: LogicGridTest,
  cells: number[],
): LogicGridViolation {
  if (has(config, NO_DARK_ANY_DARK) && hasDistancePair(config, cells, DARK))
    return "distance-pair";
  if (has(config, NO_LIGHT_ANY_LIGHT) && hasDistancePair(config, cells, LIGHT))
    return "distance-pair";
  return "none";
}

/**
 * A T whose CROSSING — the bar's middle, where the stem attaches — holds the
 * other colour while the bar's ends and the stem hold `color`. Scanned from
 * the crossing, which sees all four rotations; every cell is named outright,
 * so a gap can never stand in for the crossing.
 */
function hasMixedTee(config: LogicGridTest, cells: number[], color: number) {
  const other = color === DARK ? LIGHT : DARK;
  const held = holds(config, cells, color);
  for (let y = 0; y < config.gridHeight; y++) {
    for (let x = 0; x < config.gridWidth; x++) {
      if (at(config, cells, x, y) !== other) continue;
      if (held(x - 1, y) && held(x + 1, y) && (held(x, y - 1) || held(x, y + 1)))
        return true;
      if (held(x, y - 1) && held(x, y + 1) && (held(x - 1, y) || held(x + 1, y)))
        return true;
    }
  }
  return false;
}

function mixedTeeProblem(
  config: LogicGridTest,
  cells: number[],
): LogicGridViolation {
  // The rule's id names the ARMS' colour last: a "light-crossed dark T" is
  // three dark cells around a light crossing.
  if (has(config, NO_LIGHT_CROSSED_DARK_T) && hasMixedTee(config, cells, DARK))
    return "mixed-tee";
  if (has(config, NO_DARK_CROSSED_LIGHT_T) && hasMixedTee(config, cells, LIGHT))
    return "mixed-tee";
  return "none";
}

/** A T-pentomino of `color`: a bar of three with a stem of TWO from its
 * middle. Scanned from the crossing like the T, with the stem asked to reach
 * two deep on either side of the bar. */
function hasLongTee(config: LogicGridTest, cells: number[], color: number) {
  const held = holds(config, cells, color);
  for (let y = 0; y < config.gridHeight; y++) {
    for (let x = 0; x < config.gridWidth; x++) {
      if (held(x, y) && isLongTeeAt(held, x, y)) return true;
    }
  }
  return false;
}

/** The shape test of `hasLongTee`, for the crossing at `(x, y)`. */
function isLongTeeAt(held: Held, x: number, y: number) {
  const acrossBar = held(x - 1, y) && held(x + 1, y);
  const downStem =
    (held(x, y - 1) && held(x, y - 2)) || (held(x, y + 1) && held(x, y + 2));
  if (acrossBar && downStem) return true;

  const downBar = held(x, y - 1) && held(x, y + 1);
  const acrossStem =
    (held(x - 1, y) && held(x - 2, y)) || (held(x + 1, y) && held(x + 2, y));
  return downBar && acrossStem;
}

function longTeeProblem(
  config: LogicGridTest,
  cells: number[],
): LogicGridViolation {
  if (has(config, NO_DARK_LONG_T) && hasLongTee(config, cells, DARK))
    return "long-tee";
  if (has(config, NO_LIGHT_LONG_T) && hasLongTee(config, cells, LIGHT))
    return "long-tee";
  return "none";
}

/** Two cells of `color` a chess knight's move apart — two in one direction
 * and one in the other; nothing between them is read. Scanned from each
 * cell's four DOWNWARD offsets, so every pair is seen exactly once. */
function hasKnight(config: LogicGridTest, cells: number[], color: number) {
  const held = holds(config, cells, color);
  for (let y = 0; y < config.gridHeight; y++) {
    for (let x = 0; x < config.gridWidth; x++) {
      if (!held(x, y)) continue;
      if (
        held(x + 1, y + 2) ||
        held(x - 1, y + 2) ||
        held(x + 2, y + 1) ||
        held(x - 2, y + 1)
      )
        return true;
    }
  }
  return false;
}

function knightProblem(
  config: LogicGridTest,
  cells: number[],
): LogicGridViolation {
  if (has(config, NO_DARK_KNIGHT) && hasKnight(config, cells, DARK))
    return "knight";
  if (has(config, NO_LIGHT_KNIGHT) && hasKnight(config, cells, LIGHT))
    return "knight";
  return "none";
}

/**
 * A bent tromino whose CORNER — the square touching both others — holds the
 * other colour while both ends hold `color`. Scanned from the corner: any
 * vertical neighbour of it paired with any horizontal one is a right angle,
 * which covers the four orientations — while a straight line through the
 * corner has no such pair, so a mixed TRIPLE never matches.
 */
function hasMixedElbow(config: LogicGridTest, cells: number[], color: number) {
  const other = color === DARK ? LIGHT : DARK;
  const held = holds(config, cells, color);
  for (let y = 0; y < config.gridHeight; y++) {
    for (let x = 0; x < config.gridWidth; x++) {
      if (at(config, cells, x, y) !== other) continue;
      if (
        (held(x, y - 1) || held(x, y + 1)) &&
        (held(x - 1, y) || held(x + 1, y))
      )
        return true;
    }
  }
  return false;
}

function mixedElbowProblem(
  config: LogicGridTest,
  cells: number[],
): LogicGridViolation {
  // The id reads the shape end-corner-end: `no-dark-light-dark-elbow` is two
  // dark ends around a light corner.
  if (
    has(config, NO_DARK_LIGHT_DARK_ELBOW) &&
    hasMixedElbow(config, cells, DARK)
  )
    return "mixed-elbow";
  if (
    has(config, NO_LIGHT_DARK_LIGHT_ELBOW) &&
    hasMixedElbow(config, cells, LIGHT)
  )
    return "mixed-elbow";
  return "none";
}

/**
 * The window rules, in the order `verifyLogicGrid` asks them. Order is not
 * load-bearing WITHIN a family — every one of these is independent of the
 * others — but it decides which violation a board breaking several is named
 * for, and the suites assert those names.
 */
export const PATTERN_CHECKS: readonly RuleCheck[] = [
  squareProblem,
  runProblem,
  tripleProblem,
  teeProblem,
  threeOneProblem,
  diagonalProblem,
  elbowProblem,
  ellProblem,
  distancePairProblem,
  mixedTeeProblem,
  longTeeProblem,
  knightProblem,
  mixedElbowProblem,
];
