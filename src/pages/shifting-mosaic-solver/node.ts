import type { Position } from "../../util/types";

export class Node {
  anchors: Position[];
  currentCost: number;
  cost: number;

  constructor(anchors: Position[], currentCost = 0, cost = 0) {
    this.anchors = anchors;
    this.currentCost = currentCost;
    this.cost = cost;
  }
}
