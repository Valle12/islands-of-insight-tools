import type { Tile } from "../../util/types";
import { extractBit, positionToIndex } from "../../util/utilMethods";
import { Direction } from "./directions";
import { Node } from "./node";
import type { Turn } from "./turn";

export class BFS {
  private gridWidth: number;
  private gridHeight: number;
  private cells: Tile[][];

  constructor(gridWidth: number, gridHeight: number, cells: Tile[][]) {
    this.gridWidth = gridWidth;
    this.gridHeight = gridHeight;
    this.cells = cells;
  }

  search(root: Node) {
    const visitedSet: Set<Node> = new Set();
    const queue: Node[] = [root];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visitedSet.has(current)) continue;
      visitedSet.add(current);
      let goal = this.calculateNextStates(current, visitedSet, queue);
      if (goal) {
        const turns: Turn[] = [];
        while (goal.parent !== null) {
          turns.unshift(goal.turn!);
          goal = goal.parent;
        }

        console.log("Visited nodes:", visitedSet.size);
        return turns;
      }
    }
  }

  private calculateNextStates(
    node: Node,
    visitedSet: Set<Node>,
    queue: Node[],
  ) {
    for (const block of node.blocks) {
      for (const direction of Object.keys(Direction)) {
        const newBlock = block.clone();
        newBlock.roll(direction as Direction);
        const isValid = newBlock.checkValidity(
          this.gridWidth,
          this.gridHeight,
          this.cells,
          node.blocks,
          node.mustTouchCellsSatisfied,
        );
        if (!isValid) continue;
        const newMustTouchCellsSatisfied = newBlock.updateMustTouchCells(
          this.gridWidth,
          this.cells,
          node.mustTouchCellsSatisfied,
        );
        const newNode = new Node(
          node.blocks.map(b => (b.id === newBlock.id ? newBlock : b)),
          newMustTouchCellsSatisfied,
          node,
          { blockId: newBlock.id, direction: direction as Direction },
        );
        if (visitedSet.has(newNode)) continue;
        if (this.isGoalState(newNode)) return newNode;
        queue.push(newNode);
      }
    }
  }

  private isGoalState(node: Node) {
    const goalPositions: Map<bigint, boolean> = new Map();

    for (let x = 0; x < this.gridWidth; x++) {
      for (let y = 0; y < this.gridHeight; y++) {
        if (this.cells[x]![y] === "goal") {
          const index = positionToIndex(x, y, this.gridWidth);
          goalPositions.set(index, false);
          continue;
        }

        if (this.cells[x]![y] !== "mustTouch") continue;
        const index = positionToIndex(x, y, this.gridWidth);
        const bit = extractBit(node.mustTouchCellsSatisfied, index);
        if (bit === 0n) return false;
      }
    }

    for (const block of node.blocks) {
      for (let x = block.x; x < block.x + block.width; x++) {
        for (let y = block.y; y < block.y + block.depth; y++) {
          if (this.cells[x]![y] !== "goal") return false;
          const index = positionToIndex(x, y, this.gridWidth);
          goalPositions.set(index, true);
        }
      }
    }

    if (!goalPositions.values().every(satisfied => satisfied)) return false;
    return true;
  }
}
