import type { LogicGridTest } from "../../util/types";
import { DARK, LIGHT, UNKNOWN, UNPLAYABLE } from "./cell";
import { RULES } from "./rules";
import {
  AXIS_COUNT,
  axisIndex,
  directionAt,
  SEAT_COUNT,
  SYMBOL_KINDS,
} from "./symbols";

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
  | "viewpoint";

/**
 * A rule's position in the append-only catalogue, by its stable id.
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

const NO_DARK_2X2 = ruleIndex("no-dark-2x2");
const NO_LIGHT_2X2 = ruleIndex("no-light-2x2");
const CONNECT_DARK = ruleIndex("connect-dark");
const CONNECT_LIGHT = ruleIndex("connect-light");
const NO_CHECKERBOARD = ruleIndex("no-checkerboard");
const NO_DARK_LIGHT_DARK = ruleIndex("no-dark-light-dark");
const NO_LIGHT_DARK_LIGHT = ruleIndex("no-light-dark-light");
const NO_DARK_T = ruleIndex("no-dark-t");
const NO_LIGHT_T = ruleIndex("no-light-t");
const NO_THREE_DARK_ONE_LIGHT = ruleIndex("no-three-dark-one-light");
const NO_THREE_LIGHT_ONE_DARK = ruleIndex("no-three-light-one-dark");
const NO_DARK_DIAGONAL = ruleIndex("no-dark-diagonal");
const NO_LIGHT_DIAGONAL = ruleIndex("no-light-diagonal");
const ONE_SYMBOL_DARK = ruleIndex("one-symbol-dark");
const ONE_SYMBOL_LIGHT = ruleIndex("one-symbol-light");
export const UNDERCLUED = ruleIndex("underclued");

/**
 * Each run rule as the colour it forbids and the length it forbids it at. The
 * lengths are listed here rather than parsed out of the ids, and the pairs are
 * not contiguous in the catalogue — 1x5 was appended after 1x2..1x4, because
 * the catalogue's order is the saved file format.
 */
const RUN_RULES: readonly { index: number; color: number; length: number }[] = [
  { index: ruleIndex("no-dark-1x2"), color: DARK, length: 2 },
  { index: ruleIndex("no-light-1x2"), color: LIGHT, length: 2 },
  { index: ruleIndex("no-dark-1x3"), color: DARK, length: 3 },
  { index: ruleIndex("no-light-1x3"), color: LIGHT, length: 3 },
  { index: ruleIndex("no-dark-1x4"), color: DARK, length: 4 },
  { index: ruleIndex("no-light-1x4"), color: LIGHT, length: 4 },
  { index: ruleIndex("no-dark-1x5"), color: DARK, length: 5 },
  { index: ruleIndex("no-light-1x5"), color: LIGHT, length: 5 },
];

/**
 * Each area rule as the colour it constrains and the area it holds EVERY region
 * of that colour to — the global form of an area number, which names one region
 * only.
 *
 * Listed rather than parsed out of the ids, for the same reason `RUN_RULES` is:
 * a family that computes its members quietly stops covering the next one
 * appended. An "area 3" rule would be another row here rather than a number
 * stored on the board.
 */
const AREA_RULES: readonly { index: number; color: number; area: number }[] = [
  { index: ruleIndex("area-two-dark"), color: DARK, area: 2 },
  { index: ruleIndex("area-two-light"), color: LIGHT, area: 2 },
  { index: ruleIndex("area-four-dark"), color: DARK, area: 4 },
  { index: ruleIndex("area-four-light"), color: LIGHT, area: 4 },
  { index: ruleIndex("area-five-dark"), color: DARK, area: 5 },
  { index: ruleIndex("area-five-light"), color: LIGHT, area: 5 },
  { index: ruleIndex("area-three-dark"), color: DARK, area: 3 },
  { index: ruleIndex("area-three-light"), color: LIGHT, area: 3 },
];

/**
 * A clue kind's position in its own append-only catalogue, by its stable id —
 * the same trick `ruleIndex` plays, and for the same reason. A clue family
 * matched by a bare `type !== 0` silently checks the wrong kind the moment the
 * catalogue grows, and this file is the last thing between a bad answer and the
 * board.
 */
function symbolIndex(id: string): number {
  const index = SYMBOL_KINDS.findIndex(kind => kind.id === id);
  if (index < 0) throw new Error(`verify.ts refers to an unknown symbol: ${id}`);
  return index;
}

const AREA_SYMBOL = symbolIndex("area");
const LETTER_SYMBOL = symbolIndex("letter");
const DART_SYMBOL = symbolIndex("dart");
const LOTUS_SYMBOL = symbolIndex("lotus");
const VIEWPOINT_SYMBOL = symbolIndex("viewpoint");

/** The two axes with no reflection on a grid-line seat. Resolved by id like
 * every other index here, so a reorder fails loudly at import. */
const DIAGONAL_DOWN = axisIndex("diagonal-down");
const DIAGONAL_UP = axisIndex("diagonal-up");
const HORIZONTAL_AXIS = axisIndex("horizontal");
const VERTICAL_AXIS = axisIndex("vertical");

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

function has(config: LogicGridTest, index: number): boolean {
  return config.rules.includes(index);
}

function at(config: LogicGridTest, cells: number[], x: number, y: number) {
  return cells[y * config.gridWidth + x] ?? UNPLAYABLE;
}

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

/** A bounds-checked "is (x, y) on the board and holding `color`" reader — the
 * probe the centre-anchored scans share, since their steps walk off the board. */
function holds(config: LogicGridTest, cells: number[], color: number) {
  return (x: number, y: number) =>
    x >= 0 &&
    x < config.gridWidth &&
    y >= 0 &&
    y < config.gridHeight &&
    at(config, cells, x, y) === color;
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

/** The cells of one colour orthogonally reachable from a starting index. */
function region(config: LogicGridTest, cells: number[], start: number) {
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

function areaProblem(
  config: LogicGridTest,
  cells: number[],
): LogicGridViolation {
  for (const symbol of config.symbols) {
    if (symbol.type !== AREA_SYMBOL) continue;
    const index = symbol.y * config.gridWidth + symbol.x;
    if (region(config, cells, index).size !== symbol.value) return "area";
  }
  return "none";
}

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
    if (count !== symbol.value) return "dart";
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
    if (count !== symbol.value) return "viewpoint";
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
  for (const rule of AREA_RULES) {
    if (!has(config, rule.index)) continue;
    const problem = regionAreaProblem(config, cells, rule.color, rule.area);
    if (problem !== "none") return problem;
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

/**
 * Whether `cells` is a complete, legal solution of `config`.
 *
 * The implied checkerboard rule is deliberately absent: when both colours are
 * connected a checkerboard already breaks one of them, so the connectivity
 * test catches it — and leaving it out keeps this file free of anything the
 * solver derived rather than was told.
 */
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
  for (const rule of RUN_RULES) {
    const found = rule.color === DARK ? darkRun : lightRun;
    if (has(config, rule.index) && found >= rule.length) return "run";
  }
  return "none";
}

export function verifyLogicGrid(
  config: LogicGridTest,
  cells: number[],
): LogicGridViolation {
  // One family per entry, each returning "none" when it has nothing to say, so
  // adding a rule family is one line here rather than another branch inside an
  // already-long function.
  // `shapeProblem` is about the board's GAPS and givens and stays first, so
  // those are still named as such; `fusedProblem` then settles what a merged
  // cell is before anything below reads the colouring square by square.
  const checks = [
    shapeProblem,
    fusedProblem,
    squareProblem,
    runProblem,
    tripleProblem,
    teeProblem,
    threeOneProblem,
    diagonalProblem,
    connectivityProblem,
    regionSizeProblem,
    areaProblem,
    symbolProblem,
    letterProblem,
    dartProblem,
    lotusProblem,
    viewpointProblem,
  ];
  for (const check of checks) {
    const problem = check(config, cells);
    if (problem !== "none") return problem;
  }
  return "none";
}
