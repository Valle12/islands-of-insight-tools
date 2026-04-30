import TinyQueue from "tinyqueue";
import type { Tile } from "../../util/types";
import { extractBit, positionToIndex } from "../../util/utilMethods";
import { calculateHeuristicCost } from "./cost";
import { Direction } from "./directions";
import { Node } from "./node";
import type { Turn } from "./turn";

export class AStar {
  private gridWidth: number;
  private gridHeight: number;
  private cells: Tile[][];

  constructor(gridWidth: number, gridHeight: number, cells: Tile[][]) {
    this.gridWidth = gridWidth;
    this.gridHeight = gridHeight;
    this.cells = cells;
  }

  search(root: Node) {
    for (const block of root.blocks) {
      root.mustTouchCellsSatisfied = block.updateMustTouchCells(
        this.gridWidth,
        this.cells,
        root.mustTouchCellsSatisfied,
      );
    }

    const visitedSet: Set<string> = new Set();
    let currentQueue = new TinyQueue([root], (a, b) => a.cost - b.cost);
    while (currentQueue.length > 0) {
      const nextQueue = new TinyQueue<Node>([], (a, b) => a.cost - b.cost);

      for (const current of currentQueue.data) {
        const signature = this.nodeSignature(current);
        if (visitedSet.has(signature)) continue;
        visitedSet.add(signature);
        let goal = this.calculateNextStates(current, visitedSet, nextQueue);
        if (goal) {
          const turns: Turn[] = [];
          while (goal.parent !== null) {
            turns.unshift(goal.turn!);
            goal = goal.parent;
          }

          return turns;
        }
      }

      console.log(visitedSet.size);
      currentQueue = nextQueue;
    }
  }

  private calculateNextStates(
    node: Node,
    visitedSet: Set<string>,
    queue: TinyQueue<Node>,
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
        const blocks = node.blocks.map(b =>
          b.id === newBlock.id ? newBlock : b,
        );
        const cost = calculateHeuristicCost(
          this.gridWidth,
          this.gridHeight,
          this.cells,
          blocks,
          newMustTouchCellsSatisfied,
        );
        const newNode = new Node(
          blocks,
          newMustTouchCellsSatisfied,
          node,
          {
            blockId: newBlock.id,
            direction: direction as Direction,
          },
          node.currentCost + 1,
          node.currentCost + cost + 1,
        );
        const signature = this.nodeSignature(newNode);
        if (visitedSet.has(signature)) continue;
        if (this.isGoalState(newNode)) return newNode;
        queue.push(newNode);
      }
    }
  }

  // Determine whether the node is a goal state.
  // Rules:
  // - All `mustTouch` cells (if any) must be touched (tracked in the node bitmask).
  // - If there are any `goal` cells, all goal cells must be covered by blocks
  //   that are entirely placed on goal tiles (verifies correct orientation).
  // - If there are no `goal` cells, then satisfying all `mustTouch` is sufficient.
  private isGoalState(node: Node) {
    const goalIndices: Set<bigint> = new Set();

    // Collect goals and verify mustTouch cells are satisfied.
    for (let x = 0; x < this.gridWidth; x++) {
      for (let y = 0; y < this.gridHeight; y++) {
        const cell = this.cells[x]![y];
        const index = positionToIndex(x, y, this.gridWidth);

        if (cell === "goal") {
          goalIndices.add(index);
          continue;
        }

        if (cell !== "mustTouch") continue;
        const bit = extractBit(node.mustTouchCellsSatisfied, index);
        if (bit === 0n) return false;
      }
    }

    // If there are no goals, having all mustTouch cells satisfied is enough.
    if (goalIndices.size === 0) return true;

    // For each block that lies entirely on goal tiles, mark those goal cells as satisfied.
    const satisfiedGoalIndices: Set<bigint> = new Set();
    for (const block of node.blocks) {
      let blockFullyOnGoals = true;
      for (let x = block.x; x < block.x + block.width; x++) {
        for (let y = block.y; y < block.y + block.depth; y++) {
          if (this.cells[x]![y] !== "goal") {
            blockFullyOnGoals = false;
            break;
          }
        }
        if (!blockFullyOnGoals) break;
      }

      if (!blockFullyOnGoals) continue;

      for (let x = block.x; x < block.x + block.width; x++) {
        for (let y = block.y; y < block.y + block.depth; y++) {
          const idx = positionToIndex(x, y, this.gridWidth);
          if (goalIndices.has(idx)) satisfiedGoalIndices.add(idx);
        }
      }
    }

    // All goal cells must be covered by blocks that are entirely on goal tiles.
    return satisfiedGoalIndices.size === goalIndices.size;
  }

  private nodeSignature(node: Node) {
    return (
      node.blocks
        .slice()
        .sort(
          (a, b) =>
            a.x - b.x || a.y - b.y || a.width - b.width || a.depth - b.depth,
        )
        .map(block => {
          const packedInt =
            (block.x << 24) |
            (block.y << 16) |
            (block.width << 8) |
            block.depth;
          return (packedInt >>> 0).toString(36);
        })
        .join("-") + `|${node.mustTouchCellsSatisfied.toString(36)}`
    );
  }
}
