import type { Position, Tile } from "../../util/types";
import { extractBit, positionToIndex } from "../../util/utilMethods";
import type { Block } from "./block";

export function calculateHeuristicCost(
  gridWidth: number,
  gridHeight: number,
  cells: Tile[][],
  blocks: Block[],
  mustTouchCellsSatisfied: bigint,
) {
  const goalCells: Position[] = [];
  const mustTouchCells: Position[] = [];

  for (let x = 0; x < gridWidth; x++) {
    for (let y = 0; y < gridHeight; y++) {
      const cell = cells[x]![y];
      if (cell === "goal") goalCells.push({ x, y });
      if (cell === "mustTouch") mustTouchCells.push({ x, y });
    }
  }

  let heuristicCost = 0;
  for (const block of blocks) {
    const blockTopLeft: Position = { x: block.x, y: block.y };
    const blockTopRight: Position = {
      x: block.x + block.width,
      y: block.y,
    };
    const blockBottomRight: Position = {
      x: block.x + block.width,
      y: block.y + block.depth,
    };
    const blockBottomLeft: Position = {
      x: block.x,
      y: block.y + block.depth,
    };

    let distToClosestGoal = Infinity;
    for (const goal of goalCells) {
      const distToBlock = Math.min(
        Math.abs(goal.x - blockTopLeft.x) + Math.abs(goal.y - blockTopLeft.y),
        Math.abs(goal.x - blockTopRight.x) + Math.abs(goal.y - blockTopRight.y),
        Math.abs(goal.x - blockBottomRight.x) +
          Math.abs(goal.y - blockBottomRight.y),
        Math.abs(goal.x - blockBottomLeft.x) +
          Math.abs(goal.y - blockBottomLeft.y),
      );
      distToClosestGoal = Math.min(distToClosestGoal, distToBlock);
    }

    heuristicCost += distToClosestGoal;
  }

  for (const mustTouch of mustTouchCells) {
    const index = positionToIndex(mustTouch.x, mustTouch.y, gridWidth);
    const bit = extractBit(mustTouchCellsSatisfied, index);
    if (bit === 0n) heuristicCost += 1;
  }

  return heuristicCost;
}
