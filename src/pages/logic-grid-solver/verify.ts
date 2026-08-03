import type { LogicGridTest } from "../../util/types";
import { DARK, LIGHT, UNKNOWN, UNPLAYABLE } from "./cell";
import { RULES } from "./rules";

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
  | "disconnected"
  | "area"
  | "region-size"
  | "letter-split"
  | "letter-shared"
  | "area-without-symbol"
  | "area-with-many-symbols"
  | "cell-split";

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
];

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
    if (symbol.type !== 0) continue;
    const index = symbol.y * config.gridWidth + symbol.x;
    if (region(config, cells, index).size !== symbol.value) return "area";
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
    if (symbol.type !== 1) continue;
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
    connectivityProblem,
    regionSizeProblem,
    areaProblem,
    symbolProblem,
    letterProblem,
  ];
  for (const check of checks) {
    const problem = check(config, cells);
    if (problem !== "none") return problem;
  }
  return "none";
}
