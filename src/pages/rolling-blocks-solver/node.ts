import type { Block } from "./block";

export class Node {
  private blocks: Block[];
  private mustTouchCellsSatisfied = 0n;

  constructor(blocks: Block[]) {
    this.blocks = blocks;
  }
}
