import type { Tile } from "../../util/types";
import { extractBit, positionToIndex } from "../../util/utilMethods";
import type { Block } from "./block";
import type { Turn } from "./turn";

/**
 * Replays a rolling-blocks solution in TypeScript.
 *
 * This is a second copy of the semantics in `a-star/Replay.cpp`, and the two
 * must stay in sync — the C++ one is the oracle the solver and its tests use,
 * this one is what the page needs to draw the board between two moves. Every
 * rule it implements already lives in `Block`; the module only sequences them.
 */

export interface Puzzle {
  gridWidth: number;
  gridHeight: number;
  /** Column-major, exactly like `Board.cells`. */
  cells: Tile[][];
  blocks: Block[];
}

/** The board as it stands before one particular turn is played. */
export interface ReplayStep {
  blocks: Block[];
  /** Bitmask of must-touch cells already stepped on. */
  satisfied: bigint;
}

export interface ReplayResult {
  /**
   * `steps[i]` is the state turn `i` is played on, so a legal replay of `n`
   * turns yields `n + 1` entries and the last one is the final board.
   */
  steps: ReplayStep[];
  /** How many turns could actually be played; `turns.length` when all could. */
  legalUpTo: number;
}

function cloneAll(blocks: Block[]): Block[] {
  return blocks.map(block => block.clone());
}

/** Seeds the satisfied mask from where the blocks already stand. */
function initialSatisfied(puzzle: Puzzle, blocks: Block[]): bigint {
  let satisfied = 0n;
  for (const block of blocks) {
    satisfied = block.updateMustTouchCells(
      puzzle.gridWidth,
      puzzle.cells,
      satisfied,
    );
  }
  return satisfied;
}

/**
 * A block counts towards goal coverage only if its WHOLE footprint is on goal
 * tiles — a block half on a goal contributes nothing.
 */
function footprintAllGoal(puzzle: Puzzle, block: Block): boolean {
  for (let x = block.x; x < block.x + block.width; x++) {
    for (let y = block.y; y < block.y + block.depth; y++) {
      if (puzzle.cells[x]?.[y] !== "goal") return false;
    }
  }
  return true;
}

/** Whether every must-touch cell on the board has been stepped on. */
function allStarsCollected(puzzle: Puzzle, satisfied: bigint): boolean {
  const { gridWidth, gridHeight, cells } = puzzle;
  for (let x = 0; x < gridWidth; x++) {
    for (let y = 0; y < gridHeight; y++) {
      if (cells[x]?.[y] !== "mustTouch") continue;
      if (extractBit(satisfied, positionToIndex(x, y, gridWidth)) === 0n) {
        return false;
      }
    }
  }
  return true;
}

/** The `"x,y"` key of every goal cell on the board. */
function goalKeys(puzzle: Puzzle): Set<string> {
  const keys = new Set<string>();
  for (let x = 0; x < puzzle.gridWidth; x++) {
    for (let y = 0; y < puzzle.gridHeight; y++) {
      if (puzzle.cells[x]?.[y] === "goal") keys.add(`${x},${y}`);
    }
  }
  return keys;
}

/** Drops every cell under `block` from `keys`. */
function removeFootprint(block: Block, keys: Set<string>) {
  for (let x = block.x; x < block.x + block.width; x++) {
    for (let y = block.y; y < block.y + block.depth; y++) {
      keys.delete(`${x},${y}`);
    }
  }
}

/**
 * Strict solved test: every must-touch cell satisfied, and every goal cell
 * covered by a block that stands entirely on goal tiles. A board with no goal
 * cells passes the second half vacuously.
 */
export function isSolved(
  puzzle: Puzzle,
  blocks: Block[],
  satisfied: bigint,
): boolean {
  if (!allStarsCollected(puzzle, satisfied)) return false;

  const goalCells = goalKeys(puzzle);
  if (goalCells.size === 0) return true;

  for (const block of blocks) {
    if (footprintAllGoal(puzzle, block)) removeFootprint(block, goalCells);
  }
  return goalCells.size === 0;
}

/**
 * Whether the board is already solved where it stands, no turn played.
 *
 * Worth asking because the solver answers such a board with the EMPTY plan,
 * which is exactly what an arm that found nothing returns — so "no moves" has
 * to be told apart from "no solution" somewhere, and the start state is the
 * only thing that can say which it is.
 *
 * Goes through `replayTurns` rather than reading the blocks directly: seeding
 * the satisfied mask from where they already stand is a rule of the replay, and
 * a second copy of it here is a second place for it to go stale.
 */
export function isSolvedAtStart(puzzle: Puzzle): boolean {
  const start = replayTurns(puzzle, []).steps[0]!;
  return isSolved(puzzle, start.blocks, start.satisfied);
}

/**
 * Walks the turns, capturing the board before each one. Stops at the first
 * turn that names a missing block or leaves it in an illegal place — a witness
 * the page cannot play is worth showing up to the point it breaks, not
 * pretending past it.
 */
export function replayTurns(puzzle: Puzzle, turns: Turn[]): ReplayResult {
  let blocks = cloneAll(puzzle.blocks);
  let satisfied = initialSatisfied(puzzle, blocks);
  const steps: ReplayStep[] = [{ blocks: cloneAll(blocks), satisfied }];

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i]!;
    const next = cloneAll(blocks);
    const moving = next.find(block => block.id === turn.blockId);
    if (!moving) return { steps, legalUpTo: i };

    moving.roll(turn.direction);
    const legal = moving.checkValidity(
      puzzle.gridWidth,
      puzzle.gridHeight,
      puzzle.cells,
      next,
      satisfied,
    );
    if (!legal) return { steps, legalUpTo: i };

    satisfied = moving.updateMustTouchCells(
      puzzle.gridWidth,
      puzzle.cells,
      satisfied,
    );
    blocks = next;
    steps.push({ blocks: cloneAll(blocks), satisfied });
  }

  return { steps, legalUpTo: turns.length };
}
