import {
  intInRange,
  readGridSize,
  type ConfigResult,
} from "../../util/configValidation";
import {
  configVersion,
  migrateConfig,
  type ConfigMigration,
} from "../../util/configVersion";
import type {
  LogicGridAreaRule,
  LogicGridRunRule,
  LogicGridSymbol,
  LogicGridTest,
} from "../../util/types";
import { CELL_LIMIT, UNPLAYABLE } from "./cell";
import {
  MAX_AREA_SIZE,
  MAX_RUN_LENGTH,
  MIN_AREA_SIZE,
  MIN_RUN_LENGTH,
  RULE_COUNT,
  RULES,
  type SizedRuleColor,
} from "./rules";
import { OFF_BY_ONE } from "./verify";
import {
  axisIndex,
  SYMBOL_KIND_COUNT,
  symbolDirectionError,
  symbolKindAt,
  symbolSeatError,
  symbolValueError,
} from "./symbols";

/**
 * Hard ceiling on either grid side. Real logic grids in the game are small;
 * this is stress headroom, kept low enough that a full repaint of the grid
 * stays imperceptible.
 */
export const MAX_GRID_SIDE = 32;

/**
 * How long the solver may run before it gives up.
 *
 * A properly clued board is usually finished by deduction alone, in
 * milliseconds — nearly all of the 436 captured boards land well under a
 * second. The budget exists for the two cases that are not like that: the
 * underclued mode, where every cell the deduction could not settle costs a search
 * of its own to prove, and the profile sweep on a wide connectivity board.
 *
 * Two minutes rather than one because of the second. `logicGridTest67` is
 * 15 cells across and measures **45 s in the browser** (38 s natively), so a
 * one-minute budget left almost no headroom and a machine any slower than this
 * one would have watched it time out with the answer nearly in hand. Nothing
 * else in the corpus comes within two orders of magnitude of the limit, so this
 * is invisible in practice — and the panel has a live step counter and a Cancel
 * button for the board where it is not.
 */
export const SOLVE_BUDGET_MS = 120_000;

/** Canonical order for a sized list: dark before light, then value rising. */
function canonicalSized<T extends { color: SizedRuleColor }>(
  entries: readonly T[],
  valueOf: (entry: T) => number,
): T[] {
  const colorRank = (color: SizedRuleColor) => (color === "dark" ? 0 : 1);
  return [...entries].sort(
    (a, b) =>
      colorRank(a.color) - colorRank(b.color) || valueOf(a) - valueOf(b),
  );
}

/**
 * v1 -> v2: the 22 sized rule indices leave `rules` for the `areas`/`runs`
 * lists, the number stored beside the colour instead of spelled by position.
 *
 * Only members the catalogue marks as sized move; a migration runs BEFORE any
 * structural check, so anything else — garbage members, unknown indices, a
 * `rules` that is not an array — stays exactly where it was for the validator
 * to name. One message does shift: a hand-written v1 `[16, 16]` is now two
 * identical areas entries, so the refusal names the dark area 2 rule rather
 * than "Rule 16". A v1 file carrying its own `areas`/`runs` keys was legal —
 * v1 dropped keys it did not know — so they are discarded here the same way
 * rather than merged into real data.
 */
const sizedRulesIntoFamilies: ConfigMigration = data => {
  const rest = Object.fromEntries(
    Object.entries(data).filter(([key]) => key !== "areas" && key !== "runs"),
  );
  const { rules } = rest;
  if (!Array.isArray(rules)) return rest;
  const flags: unknown[] = [];
  const areas: LogicGridAreaRule[] = [];
  const runs: LogicGridRunRule[] = [];
  for (const rule of rules) {
    const sized = typeof rule === "number" ? RULES[rule]?.sized : undefined;
    if (!sized) {
      flags.push(rule);
    } else if (sized.family === "areas") {
      areas.push({ color: sized.color, size: sized.value });
    } else {
      runs.push({ color: sized.color, length: sized.value });
    }
  }
  return {
    ...rest,
    rules: flags,
    ...(areas.length > 0
      ? { areas: canonicalSized(areas, one => one.size) }
      : {}),
    ...(runs.length > 0
      ? { runs: canonicalSized(runs, one => one.length) }
      : {}),
  };
};

/**
 * How to read each older shape of this page's download format, newest step
 * last — see `configVersion.ts` for the whole contract.
 *
 * The optional keys — `shapes`, `direction`, `seat` — never needed a step
 * here, since every earlier file satisfies them by not having them. The sized
 * rule families could not be expressed that way: version 1 spelled their
 * numbers as catalogue positions, so reading it takes the rewrite above.
 */
const MIGRATIONS: readonly ConfigMigration[] = [sizedRulesIntoFamilies];

/**
 * The format version this build writes, derived from the list above so the two
 * cannot disagree. Every download carries it as its first key, and a file
 * without one is version 1 — see `configVersion.ts`.
 */
export const CONFIG_VERSION = configVersion(MIGRATIONS);

/**
 * What the page tells a player whose file was written in an older version:
 * the board loaded fine, but the copy on disk is out of date and should be
 * downloaded again. A function here rather than a string at the call site so
 * its wording is pinned like every other string in this file.
 */
export function migrationNotice(from: number): string {
  return (
    `This board was saved in format version ${from} and has been updated to ` +
    `version ${CONFIG_VERSION}. Download it again to save the file in the ` +
    `current format.`
  );
}

export type ConfigParseResult = ConfigResult<LogicGridTest>;

/** Returns the first problem with the colour grid, or null when it is valid. */
function cellsError(
  cells: unknown,
  gridWidth: number,
  gridHeight: number,
): string | null {
  if (!Array.isArray(cells) || cells.length !== gridWidth) {
    return `cells must be an array of ${gridWidth} columns.`;
  }
  const maxCell = CELL_LIMIT - 1;
  for (const column of cells) {
    if (!Array.isArray(column) || column.length !== gridHeight) {
      return `Every cells column must have ${gridHeight} entries.`;
    }
    if (!column.every(cell => intInRange(cell, 0, maxCell))) {
      return `Cells must be integers between 0 and ${maxCell} (0 unknown, 1 dark, 2 light, 3 unplayable).`;
    }
  }
  return null;
}

/**
 * Returns the first problem with the active flag-rule list, or null.
 *
 * An index this build does not know is REJECTED rather than ignored: a config
 * written by a later build carries a rule this one cannot show, and silently
 * dropping it would load a different puzzle under the same name. A sized
 * index is rejected by name too — the migration rewrote every version 1 file,
 * so one here was written by hand, and pointing at the list it belongs in
 * beats a bare refusal.
 */
function rulesError(rules: unknown): string | null {
  if (!Array.isArray(rules)) {
    return "rules must be an array of rule indices.";
  }
  const seen = new Set<number>();
  for (const rule of rules) {
    if (!intInRange(rule, 0, RULE_COUNT - 1)) {
      return `Rules must be integers between 0 and ${RULE_COUNT - 1}.`;
    }
    const sized = RULES[rule as number]?.sized;
    if (sized) {
      return `Rule ${rule} is stored in the ${sized.family} list in this format version.`;
    }
    if (seen.has(rule)) return `Rule ${rule} is listed more than once.`;
    seen.add(rule);
  }
  return null;
}

/** What `sizedListError` needs to know to speak for one sized family. */
interface SizedListSpec {
  /** The config key, exactly as the error messages spell it. */
  readonly key: "areas" | "runs";
  /** What the list holds, for the not-an-array message. */
  readonly noun: string;
  /** The subject of the per-entry messages. */
  readonly subject: string;
  readonly valueKey: "size" | "length";
  /** The value's plural, for the bounds message. */
  readonly valueNoun: string;
  readonly min: number;
  readonly max: number;
  readonly duplicate: (color: string, value: number) => string;
}

const AREAS_SPEC: SizedListSpec = {
  key: "areas",
  noun: "area rules",
  subject: "Area rule",
  valueKey: "size",
  valueNoun: "sizes",
  min: MIN_AREA_SIZE,
  max: MAX_AREA_SIZE,
  duplicate: (color, size) =>
    `The ${color} area ${size} rule is listed more than once.`,
};

const RUNS_SPEC: SizedListSpec = {
  key: "runs",
  noun: "run rules",
  subject: "Run rule",
  valueKey: "length",
  valueNoun: "lengths",
  min: MIN_RUN_LENGTH,
  max: MAX_RUN_LENGTH,
  duplicate: (color, length) =>
    `The ${color} 1x${length} rule is listed more than once.`,
};

/**
 * Returns the first problem with one sized-rule list, or null. Both families
 * are validated by this one walk so their messages cannot drift apart; the
 * bounds are the format's — the run cap is the engine's `kMaxPatternCells`,
 * see `rules.ts`. An ABSENT key is fine (it means no rules of that family)
 * but is checked when present even if empty, like `shapes`.
 */
function sizedListError(value: unknown, spec: SizedListSpec): string | null {
  if (value === undefined) return null;
  if (!Array.isArray(value)) {
    return `${spec.key} must be an array of ${spec.noun}.`;
  }
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return `Every ${spec.key} entry must be a JSON object.`;
    }
    const { color } = entry as Record<string, unknown>;
    if (color !== "dark" && color !== "light") {
      return `${spec.subject} colors must be "dark" or "light".`;
    }
    const carried = (entry as Record<string, unknown>)[spec.valueKey];
    if (!intInRange(carried, spec.min, spec.max)) {
      return `${spec.subject} ${spec.valueNoun} must be integers between ${spec.min} and ${spec.max}.`;
    }
    const stamp = `${color} ${carried}`;
    if (seen.has(stamp)) return spec.duplicate(color, carried as number);
    seen.add(stamp);
  }
  return null;
}

/**
 * The validated sized lists, rebuilt for the outgoing config: canonically
 * ordered, stripped to their own keys, and OMITTED rather than written empty —
 * a board without a family has no key at all, the `shapes` discipline, so the
 * corpus keeps round-tripping byte-identically.
 */
function rebuiltSized(raw: Record<string, unknown>): Partial<LogicGridTest> {
  const areas = canonicalSized(
    ((raw.areas as LogicGridAreaRule[] | undefined) ?? []).map(entry => ({
      color: entry.color,
      size: entry.size,
    })),
    one => one.size,
  );
  const runs = canonicalSized(
    ((raw.runs as LogicGridRunRule[] | undefined) ?? []).map(entry => ({
      color: entry.color,
      length: entry.length,
    })),
    one => one.length,
  );
  const rebuilt: Partial<LogicGridTest> = {};
  if (areas.length > 0) rebuilt.areas = areas;
  if (runs.length > 0) rebuilt.runs = runs;
  return rebuilt;
}

/** Returns the first problem with one clue, or null when it is valid. */
function symbolError(
  symbol: unknown,
  gridWidth: number,
  gridHeight: number,
  cells: number[][],
  offByOne: boolean,
): string | null {
  if (typeof symbol !== "object" || symbol === null) {
    return "Every symbol must be a JSON object.";
  }
  const raw = symbol as Record<string, unknown>;

  if (
    !intInRange(raw.x, 0, gridWidth - 1) ||
    !intInRange(raw.y, 0, gridHeight - 1)
  ) {
    return `Symbol coordinates must lie on the ${gridWidth}x${gridHeight} board.`;
  }
  const x = raw.x as number;
  const y = raw.y as number;

  if (!intInRange(raw.type, 0, SYMBOL_KIND_COUNT - 1)) {
    return `Symbol types must be integers between 0 and ${SYMBOL_KIND_COUNT - 1}.`;
  }
  const kind = symbolKindAt(raw.type as number)!;

  // A gap in the board is not a cell the puzzle clues, and the editor cannot
  // produce one, so a file claiming otherwise is describing a different board.
  if (cells[x]![y] === UNPLAYABLE) {
    return `Column ${x + 1}, row ${y + 1} is unplayable and cannot carry a symbol.`;
  }

  const valueProblem = symbolValueError(kind, raw.value, {
    gridWidth,
    gridHeight,
    offByOne,
  });
  if (valueProblem !== null) return valueProblem;
  const directionProblem = symbolDirectionError(kind, raw.direction);
  if (directionProblem !== null) return directionProblem;
  const seatProblem = symbolSeatError(kind, raw.seat);
  if (seatProblem !== null) return seatProblem;

  // A diagonal axis on an edge-midpoint seat has no reflection on the square
  // grid — mirrors would land on square corners — so the combination is
  // refused here exactly as the solver names it. Whether the seat's squares
  // really belong to the clue's merged cell is `seatShapeError`'s question.
  if (kind.aims === "axis") {
    const diagonal =
      raw.direction === axisIndex("diagonal-down") ||
      raw.direction === axisIndex("diagonal-up");
    if (diagonal && (raw.seat === 1 || raw.seat === 2)) {
      return `A diagonal ${kind.label.toLowerCase()} symbol cannot sit on a grid-line seat.`;
    }
  }
  return null;
}

/** Returns the first problem with the clue layer, or null when it is valid. */
function symbolsError(
  symbols: unknown,
  gridWidth: number,
  gridHeight: number,
  cells: number[][],
  offByOne: boolean,
): string | null {
  if (!Array.isArray(symbols)) {
    return "symbols must be an array.";
  }
  const seen = new Set<number>();
  for (const symbol of symbols) {
    const problem = symbolError(symbol, gridWidth, gridHeight, cells, offByOne);
    if (problem !== null) return problem;

    const entry = symbol as LogicGridSymbol;
    const slot = entry.y * gridWidth + entry.x;
    if (seen.has(slot)) {
      return `Column ${entry.x + 1}, row ${entry.y + 1} carries more than one symbol.`;
    }
    seen.add(slot);
  }
  return null;
}

/**
 * Returns the first problem with one merged cell, or null.
 *
 * `claimed` accumulates across the whole list, so it also catches the same
 * square appearing twice inside a single shape.
 */
function shapeError(
  shape: unknown,
  size: { gridWidth: number; gridHeight: number },
  cells: number[][],
  claimed: Set<number>,
): string | null {
  const { gridWidth, gridHeight } = size;
  const limit = gridWidth * gridHeight;
  if (!Array.isArray(shape) || shape.length < 2) {
    // A cell of one square IS a plain cell, so the other spelling is refused
    // rather than accepted and normalised away.
    return "Every merged cell must be an array of at least two squares.";
  }
  for (const square of shape) {
    if (!intInRange(square, 0, limit - 1)) {
      return `Merged cell squares must be integers between 0 and ${limit - 1}.`;
    }
    const x = (square as number) % gridWidth;
    const y = Math.floor((square as number) / gridWidth);
    if (cells[x]![y] === UNPLAYABLE) {
      return `Column ${x + 1}, row ${y + 1} is unplayable and cannot be part of a merged cell.`;
    }
    if (claimed.has(square as number)) {
      return `Column ${x + 1}, row ${y + 1} belongs to more than one merged cell.`;
    }
    claimed.add(square as number);
  }

  // Connectivity first, then agreement — the same order the solver's own
  // `structureProblem` uses, so the two name the same fault on the same file.
  const squares = shape as number[];
  const broken = connectedError(squares, gridWidth);
  if (broken !== null) return broken;

  // Every square of a merged cell holds ONE colour, so a file that paints them
  // differently describes a cell that cannot exist. The editor cannot produce
  // one — restructuring clears — but an imported file can, and the solver
  // refuses it, so accepting it here would only turn a clear message into a
  // failure inside wasm.
  const given = colorAt(cells, squares[0]!, gridWidth);
  const split = squares.find(
    square => colorAt(cells, square, gridWidth) !== given,
  );
  if (split === undefined) return null;
  const x = split % gridWidth;
  const y = Math.floor(split / gridWidth);
  return `Column ${x + 1}, row ${y + 1} is a different colour from the rest of its merged cell.`;
}

/** The colour on a square, by its flat index. */
function colorAt(cells: number[][], square: number, gridWidth: number): number {
  return cells[square % gridWidth]![Math.floor(square / gridWidth)]!;
}

/**
 * A merged cell has to be one connected polyomino, which the editor guarantees
 * by splitting whatever a stroke leaves behind into its components. A file
 * saying otherwise describes a cell that cannot be drawn.
 */
function connectedError(shape: number[], gridWidth: number): string | null {
  const members = new Set(shape);
  const seen = new Set<number>([shape[0]!]);
  const queue = [shape[0]!];
  while (queue.length > 0) {
    const square = queue.pop()!;
    const x = square % gridWidth;
    const y = Math.floor(square / gridWidth);
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nx = x + dx;
      if (nx < 0 || nx >= gridWidth) continue;
      const next = (y + dy) * gridWidth + nx;
      if (!members.has(next) || seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen.size === members.size
    ? null
    : "Every merged cell must be one connected shape.";
}

/**
 * Returns the first problem with the merged-cell layer, or null.
 *
 * A merged cell may carry SEVERAL clues, one per square — the game's harder
 * boards do exactly that (two darts on one domino). WHICH square each clue
 * sits on is the player's own choice and is data: a dart's square is where
 * its ray starts and a symmetry symbol's is half of its seat, so every kind
 * keeps the square the file names. Combinations no colouring can satisfy
 * (two different letters, disagreeing area numbers) are the solver's to
 * refuse — the board loads, and Solve answers unsolvable by name.
 */
function shapesError(
  shapes: unknown,
  size: { gridWidth: number; gridHeight: number },
  cells: number[][],
): string | null {
  if (!Array.isArray(shapes)) {
    return "shapes must be an array.";
  }
  const claimed = new Set<number>();
  for (const shape of shapes) {
    const problem = shapeError(shape, size, cells, claimed);
    if (problem !== null) return problem;
  }
  return null;
}

/**
 * The half of a seat only the merged-cell layer can judge: its squares must
 * really surround a point of the clue's own cell. A seam seat needs the
 * square beyond it as a shape-mate; a corner seat needs at least THREE of its
 * four surrounding squares in the cell — a 2x2 block's centre has four, and
 * an L-tromino's natural middle is the corner it wraps, which has three.
 */
function seatShapeError(
  symbols: LogicGridSymbol[],
  shapes: number[][],
  gridWidth: number,
  gridHeight: number,
): string | null {
  for (const symbol of symbols) {
    const seat = symbol.seat ?? 0;
    if (symbolKindAt(symbol.type)?.aims !== "axis" || seat === 0) continue;
    const cell = shapes.find(shape =>
      shape.includes(symbol.y * gridWidth + symbol.x),
    );
    if (!cell) {
      return `Column ${symbol.x + 1}, row ${symbol.y + 1} carries a seat but no merged cell to sit in.`;
    }
    // Bounds first: past the right edge the flat index would wrap to the next
    // row and could falsely match a member there.
    const owns = (x: number, y: number) =>
      x < gridWidth && y < gridHeight && cell.includes(y * gridWidth + x);
    const right = owns(symbol.x + 1, symbol.y);
    const down = owns(symbol.x, symbol.y + 1);
    const corner = owns(symbol.x + 1, symbol.y + 1);
    const fits =
      (seat === 1 && right) ||
      (seat === 2 && down) ||
      (seat === 3 && 1 + Number(right) + Number(down) + Number(corner) >= 3);
    if (!fits) {
      return `Column ${symbol.x + 1}, row ${symbol.y + 1} carries a seat its merged cell does not surround.`;
    }
  }
  return null;
}

/**
 * Validates an unknown parsed JSON value against the logic grid config
 * (download/fixture) format. Returns the typed config on success, or a
 * human-readable error explaining the first problem found.
 *
 * The result is rebuilt from the validated fields, so unknown keys are dropped
 * and the rule list comes back sorted whatever order the file listed it in.
 *
 * `shapes` is the one OPTIONAL key, and an empty one normalises back to absent:
 * every captured fixture predates it, and `config.test.ts` asserts they all
 * round-trip byte-identically.
 */
export function validateConfig(data: unknown): ConfigParseResult {
  // First of all, and before a single structural check: a migration is exactly
  // what makes an older file's shape make sense to the rules below.
  const migrated = migrateConfig(data, MIGRATIONS);
  if (!migrated.ok) return { ok: false, error: migrated.error };

  const size = readGridSize(migrated.data, MAX_GRID_SIDE);
  if (!size.ok) return size;
  const { gridWidth, gridHeight } = size.config;
  const raw = migrated.data as Record<string, unknown>;

  const cellsProblem = cellsError(raw.cells, gridWidth, gridHeight);
  if (cellsProblem !== null) return { ok: false, error: cellsProblem };
  const cells = raw.cells as number[][];

  const rulesProblem = rulesError(raw.rules);
  if (rulesProblem !== null) return { ok: false, error: rulesProblem };
  const areasProblem = sizedListError(raw.areas, AREAS_SPEC);
  if (areasProblem !== null) return { ok: false, error: areasProblem };
  const runsProblem = sizedListError(raw.runs, RUNS_SPEC);
  if (runsProblem !== null) return { ok: false, error: runsProblem };
  // Read AFTER `rulesError`, so the list is known to be well formed: a file
  // with rule 32 on may carry a displayed 0 — and one without it may not,
  // whatever build wrote it.
  const offByOne = (raw.rules as number[]).includes(OFF_BY_ONE);

  const symbolsProblem = symbolsError(
    raw.symbols,
    gridWidth,
    gridHeight,
    cells,
    offByOne,
  );
  if (symbolsProblem !== null) return { ok: false, error: symbolsProblem };

  const rules = [...(raw.rules as number[])].sort((a, b) => a - b);
  // `value`, `direction` and `seat` are each spread only when the clue has
  // one, for the same reason `shapes` is omitted below: every captured
  // fixture predates the optional keys and has to keep round-tripping
  // byte-identically. A seat of 0 normalises back to absent, like an empty
  // `shapes` — it means the square's own centre, which is what absent means.
  const symbols = (raw.symbols as LogicGridSymbol[]).map(symbol => ({
    x: symbol.x,
    y: symbol.y,
    type: symbol.type,
    ...(symbol.value === undefined ? {} : { value: symbol.value }),
    ...(symbol.direction === undefined ? {} : { direction: symbol.direction }),
    ...(symbol.seat ? { seat: symbol.seat } : {}),
  }));

  // `version` FIRST, and always the current one — whatever the file said, what
  // comes out of here is the shape this build stores. The sized lists sit
  // between `rules` and `cells`, rule-layer data beside the flag list.
  const config: LogicGridTest = {
    version: CONFIG_VERSION,
    gridWidth,
    gridHeight,
    rules,
    ...rebuiltSized(raw),
    cells,
    symbols,
  };

  if (raw.shapes !== undefined) {
    const shapesProblem = shapesError(raw.shapes, { gridWidth, gridHeight }, cells);
    if (shapesProblem !== null) return { ok: false, error: shapesProblem };
    const shapes = (raw.shapes as number[][]).map(shape => [...shape]);
    if (shapes.length > 0) config.shapes = shapes;
  }

  // After the shapes: a seat is judged against the merged cell it sits in,
  // and a board with no shapes at all has nowhere for one.
  const seatProblem = seatShapeError(
    symbols,
    config.shapes ?? [],
    gridWidth,
    gridHeight,
  );
  if (seatProblem !== null) return { ok: false, error: seatProblem };

  // The number is reported only when the file really was older, so the page
  // can say the copy on disk is out of date without claiming it of every load.
  return migrated.from < CONFIG_VERSION
    ? { ok: true, config, migratedFrom: migrated.from }
    : { ok: true, config };
}
