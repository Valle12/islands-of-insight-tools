import type { Tile } from "../../util/types";
import { extractBit, positionToIndex } from "../../util/utilMethods";
import { Direction } from "./directions";
import { Node } from "./node";
import type { Turn } from "./turn";

export class IDAStar {
  private gridWidth: number;
  private gridHeight: number;
  private cells: Tile[][];

  constructor(gridWidth: number, gridHeight: number, cells: Tile[][]) {
    this.gridWidth = gridWidth;
    this.gridHeight = gridHeight;
    this.cells = cells;
  }

  search(root: Node): Turn[] | undefined {
    // Initial mustTouch update
    for (const block of root.blocks) {
      root.mustTouchCellsSatisfied = block.updateMustTouchCells(
        this.gridWidth,
        this.cells,
        root.mustTouchCellsSatisfied,
      );
    }

    let threshold = this.heuristic(root);
    const path: Turn[] = [];

    while (true) {
      const result = this.dfs(root, 0, threshold, path, new Set());
      if (result === "FOUND") return path;
      if (result === Infinity) return undefined; // no solution
      threshold = result as number;
    }
  }

  private heuristic(node: Node): number {
    // Count unsatisfied mustTouch cells
    let unsatisfied = 0;

    // Find max footprint any block can have (width * depth, standing or lying)
    let maxFootprint = 1;
    for (const block of node.blocks) {
      maxFootprint = Math.max(maxFootprint, block.width * block.depth);
    }

    for (let x = 0; x < this.gridWidth; x++) {
      for (let y = 0; y < this.gridHeight; y++) {
        if (this.cells[x]![y] !== "mustTouch") continue;
        const index = positionToIndex(x, y, this.gridWidth);
        if (extractBit(node.mustTouchCellsSatisfied, index) === 0n) {
          unsatisfied++;
        }
      }
    }

    // Each move can satisfy at most maxFootprint cells → admissible lower bound
    return Math.ceil(unsatisfied / maxFootprint);
  }

  // Returns: "FOUND", Infinity (dead end), or next threshold (number)
  private dfs(
    node: Node,
    g: number,
    threshold: number,
    path: Turn[],
    visited: Set<string>,
  ): "FOUND" | number {
    console.log(g);
    const f = g + this.heuristic(node);
    if (f > threshold) return f;

    const sig = this.nodeSignature(node);
    if (visited.has(sig)) return Infinity;
    visited.add(sig);

    let min = Infinity;

    for (const block of node.blocks) {
      for (const direction of Object.keys(Direction) as Direction[]) {
        const newBlock = block.clone();
        newBlock.roll(direction);

        const isValid = newBlock.checkValidity(
          this.gridWidth,
          this.gridHeight,
          this.cells,
          node.blocks,
          node.mustTouchCellsSatisfied,
        );
        if (!isValid) continue;

        const newMustTouch = newBlock.updateMustTouchCells(
          this.gridWidth,
          this.cells,
          node.mustTouchCellsSatisfied,
        );
        const newNode = new Node(
          node.blocks.map(b => (b.id === newBlock.id ? newBlock : b)),
          newMustTouch,
        );

        if (this.isGoalState(newNode)) {
          path.push({ blockId: newBlock.id, direction });
          return "FOUND";
        }

        path.push({ blockId: newBlock.id, direction });
        const result = this.dfs(newNode, g + 1, threshold, path, visited);

        if (result === "FOUND") return "FOUND";
        if (typeof result === "number" && result < min) min = result;

        path.pop();
      }
    }

    visited.delete(sig); // allow revisiting via different paths
    return min;
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
