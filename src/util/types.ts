import type { Button } from "../pages/phasic-dial-solver/button";
import type { Block } from "../pages/rolling-blocks-solver/block";
import type { Turn } from "../pages/rolling-blocks-solver/turn";

/**
 * A phasic dial puzzle as downloaded from / uploaded to the solver page.
 * `Button` serialises to `{ "turns": [...] }`, so a downloaded file round-trips
 * through `new Button(raw.turns)`. `result` is present once the puzzle has been
 * solved, which is what makes a downloaded file usable as a test fixture.
 */
export type PhasicDialTest = {
  maxValues: number[];
  initialValues: number[];
  buttons: Button[];
  result?: number[];
};

/** A phasic dial fixture with its expected solution — the test-case shape. */
export type SolverTest = PhasicDialTest & { result: number[] };

export type LcmTest = {
  values: number[];
  result: number;
};

export type BoundsTest = {
  x: number;
  y: number;
  position: string;
};

export type OverlapTest = {
  block1: Block;
  block2: Block;
  blockType: string;
};

export type CartesianProductTest = {
  limits: number[];
  result: number[][];
};

export type PositionToIndexTest = {
  x: number;
  y: number;
  gridWidth: number;
  result: bigint;
};

export type IndexToPositionTest = {
  index: bigint;
  gridWidth: number;
  result: Position;
};

export type RollingBlocksTest = {
  gridWidth: number;
  gridHeight: number;
  cells: Tile[][];
  blocks: Block[];
  turns: Turn[] | undefined;
};

/**
 * A match-three cell, encoded as a single index — see
 * `src/pages/match-three-solver/cell.ts` for the constants. 0 is empty, 1 is a
 * fixed obstacle, and 2+ index the fixed symbol list in `symbols.ts`. That
 * list is append-only, which is what lets a saved board keep its meaning as
 * new symbols are added.
 */
export type MatchThreeCell = number;

export type MatchThreeTest = {
  gridWidth: number;
  gridHeight: number;
  cells: MatchThreeCell[][];
};

/** An area number is a number; a letter is a single `A`-`Z` character. */
export type LogicGridSymbolValue = number | string;

/** A clue as a cell holds it — its position is where it sits. */
export type LogicGridClue = {
  /** Index into `SYMBOL_KINDS`, which is append-only. */
  type: number;
  /**
   * OPTIONAL because the lotus — the first VALUELESS kind — carries none, and
   * writes no key at all rather than a stand-in. Required for every other
   * kind, which the validator enforces per kind.
   */
  value?: LogicGridSymbolValue;
  /**
   * Which way a DIRECTED clue points: 0 up, 1 right, 2 down, 3 left. That is
   * the repo's canonical order — the same one `DIRECTION_MAP` decodes in the
   * rolling-blocks and shifting-mosaic bridges, and the one `nearestVertex`
   * returns for four sides, which is what lets the arrow be dragged round.
   * For the lotus the same key is its AXIS: 0 horizontal, 1 the falling
   * diagonal, 2 vertical, 3 the rising diagonal — 45-degree clockwise steps.
   *
   * OPTIONAL, and omitted entirely rather than written as `0` for a kind that
   * carries none: every captured fixture predates this key and must keep
   * round-tripping byte-identically through `validateConfig`, exactly as
   * `shapes` below does.
   */
  direction?: number;
  /**
   * Where inside a merged cell a lotus's axis point sits, as two half-square
   * offsets from the home square's centre: bit 0 half a square right, bit 1
   * half a square down — so 1 and 2 are the midpoints of the edges to the
   * right and below, and 3 is a corner where squares meet. Lotus-only, and
   * OPTIONAL with 0 (the square's own centre) omitted, the same round-trip
   * discipline as `direction`.
   */
  seat?: number;
};

/** A clue as the config stores it: sparse, so an unclued board carries none. */
export type LogicGridSymbol = LogicGridClue & {
  x: number;
  y: number;
};

/** One regions-have-area-N rule — see `LogicGridTest.areas`. */
export type LogicGridAreaRule = {
  color: "dark" | "light";
  size: number;
};

/** One no-1xN rule — see `LogicGridTest.runs`. */
export type LogicGridRunRule = {
  color: "dark" | "light";
  length: number;
};

export type LogicGridTest = {
  /**
   * Which shape of this format the file is in — see `src/util/configVersion.ts`
   * for how an older one is read. Written FIRST, and required here rather than
   * optional so a writer cannot forget it: a file with no tag is version 1 on
   * the way IN, but everything this build produces says which version it is.
   */
  version: number;
  gridWidth: number;
  gridHeight: number;
  /**
   * Indices into `RULES`, which is append-only. Ascending and unique, and
   * since format version 2 FLAG rules only: the sized families — regions-
   * have-area-N and no-1xN — live in `areas` and `runs` below, and their 22
   * retired indices are rejected by name rather than read.
   */
  rules: number[];
  /**
   * The regions-have-area-N rules, one entry per active size and colour:
   * every region of `color` has exactly `size` cells. Several entries per
   * colour are legal and conjunctive — satisfiable exactly where the colour
   * is absent. Canonical order (what `validateConfig` returns and every
   * writer emits): dark before light, then size ascending; duplicates are
   * rejected. `size` is 1..9999 — a format cap, deliberately NOT the board
   * area, since an oversized area is still enforceable (the colour cannot
   * appear) and belongs to Solve, not the validator.
   *
   * OPTIONAL, and omitted rather than written `[]` when a board has none —
   * the same byte-identical round-trip discipline as `shapes`. This is also
   * exactly the shape the solver's wasm boundary takes.
   */
  areas?: LogicGridAreaRule[];
  /**
   * The no-1xN rules, one entry per active length and colour: no straight
   * run of `length` cells of `color`, in either orientation. Same canonical
   * order, duplicate rule and omit-when-empty discipline as `areas`. `length`
   * is 2..8 — the cap is the engine's `kMaxPatternCells`, because a run rule
   * is enforced only by its compiled pattern, so a longer one is refused by
   * name rather than accepted and silently not enforced.
   */
  runs?: LogicGridRunRule[];
  /**
   * The colour layer alone, column-major, one index per cell — see
   * `src/pages/logic-grid-solver/cell.ts` for the constants. 0 is uncoloured,
   * 1 dark, 2 light, 3 an unplayable gap in the board.
   *
   * Clues are the SEPARATE layer below: a cell carries a colour and,
   * independently, at most one clue, so a clue on an uncoloured cell is one
   * whose colour the player still has to deduce.
   */
  cells: number[][];
  symbols: LogicGridSymbol[];
  /**
   * The merged cells: each one the squares it fuses, as flat
   * `y * gridWidth + x` indices — row-major, unlike `cells` above, and the same
   * layout the solver's wasm boundary takes.
   *
   * A merged cell is the game's irregular tile: any connected polyomino of at
   * least two squares, painted as ONE cell but still counting every square it
   * is made of towards an area number and adjacent to whatever any of its
   * squares touches.
   *
   * Every SQUARE keeps its own clue slot, so a merged cell may carry SEVERAL
   * clues — the game puts two darts on one domino, and each acts from the
   * square the file names it on. It is one clue per square that is capped, not
   * one per cell.
   *
   * OPTIONAL, and omitted entirely rather than written as `[]` when a board has
   * none — every captured fixture predates this key and must keep round-tripping
   * byte-identically through `validateConfig`.
   */
  shapes?: number[][];
};

export type ShiftingMosaicTest = {
  gridWidth: number;
  gridHeight: number;
  shapes: Position[][];
  initialAnchors: Position[];
  goalIndex: number;
  goalAnchor: Position;
};

export type Tile = "regular" | "mustTouch" | "goal" | "unplayable";

export type PaintTool =
  | "regular"
  | "mustTouch"
  | "goal"
  | "unplayable"
  | "block"
  | "fillRegular"
  | "fillMustTouch"
  | "reset";

export type MatchThreeTool = "empty" | "blocked" | "symbol" | "reset";

export type LogicGridTool =
  | "dark"
  | "light"
  | "unplayable"
  | "erase"
  | "symbol"
  | "merge"
  | "reset";

export type BlockType = "obstruction" | "goal";

export type ShiftingMosaicTool = "obstruction" | "goal" | "reset";

export type Position = {
  x: number;
  y: number;
};

export type DfsReturn = {
  found: boolean;
  threshold: number;
};

declare module "bun" {
  interface Env {
    ROLLING_BLOCKS_TEST: string;
  }
}
