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
 * fixed obstacle, and 2+ are palette *slots*. Slots are deliberately not
 * colors: the palette is handed out at random, so the config carries the
 * slot -> color mapping that makes a saved board reload looking identical.
 */
export type MatchThreeCell = number;

export type MatchThreeTest = {
  gridWidth: number;
  gridHeight: number;
  /** Slot index -> CSS color name. */
  colors: string[];
  cells: MatchThreeCell[][];
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

export type MatchThreeTool =
  | "empty"
  | "blocked"
  | "color"
  | "addColor"
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
