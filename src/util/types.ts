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
  value: LogicGridSymbolValue;
  /**
   * Which way a DIRECTED clue points: 0 up, 1 right, 2 down, 3 left. That is
   * the repo's canonical order — the same one `DIRECTION_MAP` decodes in the
   * rolling-blocks and shifting-mosaic bridges, and the one `nearestVertex`
   * returns for four sides, which is what lets the arrow be dragged round.
   *
   * OPTIONAL, and omitted entirely rather than written as `0` for a kind that
   * carries none: every captured fixture predates this key and must keep
   * round-tripping byte-identically through `validateConfig`, exactly as
   * `shapes` below does.
   */
  direction?: number;
};

/** A clue as the config stores it: sparse, so an unclued board carries none. */
export type LogicGridSymbol = LogicGridClue & {
  x: number;
  y: number;
};

export type LogicGridTest = {
  gridWidth: number;
  gridHeight: number;
  /** Indices into `RULES`, which is append-only. Ascending and unique. */
  rules: number[];
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
   * least two squares, painted as ONE cell and carrying at most one clue, but
   * still counting every square it is made of towards an area number and
   * adjacent to whatever any of its squares touches.
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
