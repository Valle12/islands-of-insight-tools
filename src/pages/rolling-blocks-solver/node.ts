import type { Block } from "./block";

export class Node {
  blocks: Block[];
  mustTouchCellsSatisfied: bigint;
  currentCost: number;
  cost: number;

  constructor(
    blocks: Block[],
    mustTouchCellsSatisfied = 0n,
    currentCost = 0,
    cost = 0,
  ) {
    this.blocks = blocks;
    this.mustTouchCellsSatisfied = mustTouchCellsSatisfied;
    this.currentCost = currentCost;
    this.cost = cost;
  }
}
