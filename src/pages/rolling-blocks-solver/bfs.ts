import type { BFSTest, Tile } from "../../util/types";
import { extractBit, positionToIndex } from "../../util/utilMethods";
import { Direction } from "./directions";
import { Node } from "./node";
import type { Turn } from "./turn";

export class BFS {
  private gridWidth: number;
  private gridHeight: number;
  private cells: Tile[][];

  private readonly dx = [0, 1, 0, -1];
  private readonly dy = [-1, 0, 1, 0];

  constructor(gridWidth: number, gridHeight: number, cells: Tile[][]) {
    this.gridWidth = gridWidth;
    this.gridHeight = gridHeight;
    this.cells = cells;
  }

  search(root: Node) {
    const bfsTest: BFSTest = {
      gridWidth: this.gridWidth,
      gridHeight: this.gridHeight,
      cells: this.cells,
      blocks: root.blocks,
      turns: undefined,
    };

    // Serialize and download bfsTest as a pretty-printed JSON file in the browser.
    try {
      const json = JSON.stringify(bfsTest, null, 2);
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "bfsTest.json";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      // If serialization or download fails, log the error but continue the search.
      // e may be e.g. circular structure or unsupported types.
      // eslint-disable-next-line no-console
      console.error("Failed to download bfsTest:", e);
    }

    for (const block of root.blocks) {
      root.mustTouchCellsSatisfied = block.updateMustTouchCells(
        this.gridWidth,
        this.cells,
        root.mustTouchCellsSatisfied,
      );
    }

    const rootSignature = this.nodeSignature(root);
    const cameFrom = new Map<
      string,
      { parentSignature: string | null; turn: Turn | null }
    >();
    cameFrom.set(rootSignature, { parentSignature: null, turn: null });

    let currentQueue: Node[] = [root];
    while (currentQueue.length > 0) {
      const nextQueue: Node[] = [];

      for (const current of currentQueue) {
        const result = this.calculateNextStates(current, cameFrom, nextQueue);
        if (result) {
          return this.reconstructPath(
            this.nodeSignature(result.node),
            cameFrom,
          );
        }
      }

      console.log(cameFrom.size);
      currentQueue = nextQueue;
    }
  }

  private calculateNextStates(
    node: Node,
    cameFrom: Map<
      string,
      { parentSignature: string | null; turn: Turn | null }
    >,
    queue: Node[],
  ) {
    const currentSignature = this.nodeSignature(node);

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

        const newMustTouchCellsSatisfied = newBlock.updateMustTouchCells(
          this.gridWidth,
          this.cells,
          node.mustTouchCellsSatisfied,
        );
        const newNode = new Node(
          node.blocks.map(b => (b.id === newBlock.id ? newBlock : b)),
          newMustTouchCellsSatisfied,
        );

        if (this.isDeadlock(newNode) || this.isComponentDeadlock(newNode))
          continue;

        const newSignature = this.nodeSignature(newNode);
        if (cameFrom.has(newSignature)) continue;
        const turn: Turn = { blockId: newBlock.id, direction };
        cameFrom.set(newSignature, {
          parentSignature: currentSignature,
          turn: turn,
        });

        if (this.isGoalState(newNode)) return { node: newNode, turn };
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

    if (goalIndices.size === 0) return true;

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

    return satisfiedGoalIndices.size === goalIndices.size;
  }

  // Flood-fill from all block footprint cells. Satisfied mustTouch cells act
  // as walls. Returns true if any unsatisfied mustTouch cell is unreachable.
  private isDeadlock(node: Node): boolean {
    const reachable = new Set<number>();
    const queue: number[] = [];

    // Seed flood-fill from the entire footprint of every block
    for (const block of node.blocks) {
      for (let bx = block.x; bx < block.x + block.width; bx++) {
        for (let by = block.y; by < block.y + block.depth; by++) {
          const key = bx * this.gridHeight + by;
          if (!reachable.has(key)) {
            reachable.add(key);
            queue.push(key);
          }
        }
      }
    }

    let head = 0;
    while (head < queue.length) {
      const key = queue[head++]!;
      const cx = Math.floor(key / this.gridHeight);
      const cy = key % this.gridHeight;

      for (let d = 0; d < 4; d++) {
        const nx = cx + this.dx[d]!;
        const ny = cy + this.dy[d]!;
        if (nx < 0 || nx >= this.gridWidth || ny < 0 || ny >= this.gridHeight)
          continue;

        const nkey = nx * this.gridHeight + ny;
        if (reachable.has(nkey)) continue;

        const cell = this.cells[nx]?.[ny];
        if (cell === "unplayable") continue;
        if (cell === "mustTouch") {
          const index = positionToIndex(nx, ny, this.gridWidth);
          if (extractBit(node.mustTouchCellsSatisfied, index) === 1n) continue;
        }

        reachable.add(nkey);
        queue.push(nkey);
      }
    }

    for (let x = 0; x < this.gridWidth; x++) {
      for (let y = 0; y < this.gridHeight; y++) {
        if (this.cells[x]![y] !== "mustTouch") continue;
        const index = positionToIndex(x, y, this.gridWidth);
        if (extractBit(node.mustTouchCellsSatisfied, index) === 1n) continue;
        if (!reachable.has(x * this.gridHeight + y)) return true;
      }
    }

    return false;
  }

  // Finds connected components of unsatisfied mustTouch cells (traversing
  // through regular cells too). Each component needs at least one block
  // inside it or directly adjacent to it.
  private isComponentDeadlock(node: Node): boolean {
    const globalVisited = new Set<number>();
    const components: Array<{
      mustTouchSet: Set<number>;
      expandedRegion: Set<number>;
    }> = [];

    for (let x = 0; x < this.gridWidth; x++) {
      for (let y = 0; y < this.gridHeight; y++) {
        if (this.cells[x]![y] !== "mustTouch") continue;
        const index = positionToIndex(x, y, this.gridWidth);
        if (extractBit(node.mustTouchCellsSatisfied, index) === 1n) continue;

        const startKey = x * this.gridHeight + y;
        if (globalVisited.has(startKey)) continue;

        const mustTouchSet = new Set<number>();
        const expandedRegion = new Set<number>([startKey]);
        const queue = [startKey];
        let head = 0;

        while (head < queue.length) {
          const key = queue[head++]!;
          const cx = Math.floor(key / this.gridHeight);
          const cy = key % this.gridHeight;
          const cell = this.cells[cx]?.[cy];

          if (cell === "mustTouch") {
            mustTouchSet.add(key);
            globalVisited.add(key);
          }

          for (let d = 0; d < 4; d++) {
            const nx = cx + this.dx[d]!;
            const ny = cy + this.dy[d]!;
            if (
              nx < 0 ||
              nx >= this.gridWidth ||
              ny < 0 ||
              ny >= this.gridHeight
            )
              continue;

            const nkey = nx * this.gridHeight + ny;
            if (expandedRegion.has(nkey)) continue;

            const ncell = this.cells[nx]?.[ny];
            if (ncell === "unplayable") continue;
            if (ncell === "mustTouch") {
              const nindex = positionToIndex(nx, ny, this.gridWidth);
              // Satisfied mustTouch cells are walls
              if (extractBit(node.mustTouchCellsSatisfied, nindex) === 1n)
                continue;
            }
            // regular cells and unsatisfied mustTouch cells are passable

            expandedRegion.add(nkey);
            queue.push(nkey);
          }
        }

        if (mustTouchSet.size > 0) {
          components.push({ mustTouchSet, expandedRegion });
        }
      }
    }

    for (const { expandedRegion } of components) {
      const hasBlock = node.blocks.some(b => {
        // Check the entire footprint of the block, not just b.x/b.y
        for (let bx = b.x; bx < b.x + b.width; bx++) {
          for (let by = b.y; by < b.y + b.depth; by++) {
            // Block cell directly inside the reachable region
            if (expandedRegion.has(bx * this.gridHeight + by)) return true;
            // Block cell on a satisfied cell but adjacent to the region
            for (let d = 0; d < 4; d++) {
              const nx = bx + this.dx[d]!;
              const ny = by + this.dy[d]!;
              if (expandedRegion.has(nx * this.gridHeight + ny)) return true;
            }
          }
        }
        return false;
      });
      if (!hasBlock) return true;
    }

    return false;
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

  private reconstructPath(
    goalSig: string,
    cameFrom: Map<
      string,
      { parentSignature: string | null; turn: Turn | null }
    >,
  ): Turn[] {
    const result: Turn[] = [];
    let sig: string | null = goalSig;

    while (sig !== null) {
      const entry: { parentSignature: string | null; turn: Turn | null } =
        cameFrom.get(sig)!;
      if (entry.turn !== null) {
        result.unshift(entry.turn);
      }
      sig = entry.parentSignature;
    }

    return result;
  }
}
