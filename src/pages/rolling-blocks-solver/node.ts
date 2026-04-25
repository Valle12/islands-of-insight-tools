import type { Block } from "./block";
import type { Turn } from "./turn";

export class Node {
  blocks: Block[];
  mustTouchCellsSatisfied: bigint;
  parent: Node | null = null;
  turn: Turn | null;

  constructor(
    blocks: Block[],
    mustTouchCellsSatisfied = 0n,
    parent: Node | null = null,
    turn: Turn | null = null,
  ) {
    this.blocks = blocks;
    this.mustTouchCellsSatisfied = mustTouchCellsSatisfied;
    this.parent = parent;
    this.turn = turn;
  }
}
