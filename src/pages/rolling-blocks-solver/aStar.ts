import type { BFSTest, Tile } from "../../util/types";
import { extractBit, positionToIndex } from "../../util/utilMethods";
import { Direction } from "./directions";
import { Node } from "./node";
import type { Turn } from "./turn";

interface GoalCluster {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  width: number;
  depth: number;
}

// ---------------------------------------------------------------------------
// Min-heap keyed on f = g + w*h
// ---------------------------------------------------------------------------
class MinHeap {
  private data: { f: number; g: number; signature: string }[] = [];

  push(item: { f: number; g: number; signature: string }) {
    this.data.push(item);
    this.bubbleUp(this.data.length - 1);
  }

  pop(): { f: number; g: number; signature: string } | undefined {
    if (this.data.length === 0) return undefined;
    const top = this.data[0]!;
    const last = this.data.pop()!;
    if (this.data.length > 0) {
      this.data[0] = last;
      this.sinkDown(0);
    }
    return top;
  }

  get size() {
    return this.data.length;
  }

  private bubbleUp(i: number) {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.data[parent]!.f <= this.data[i]!.f) break;
      [this.data[parent], this.data[i]] = [this.data[i]!, this.data[parent]!];
      i = parent;
    }
  }

  private sinkDown(i: number) {
    const n = this.data.length;
    while (true) {
      let s = i;
      const l = 2 * i + 1,
        r = 2 * i + 2;
      if (l < n && this.data[l]!.f < this.data[s]!.f) s = l;
      if (r < n && this.data[r]!.f < this.data[s]!.f) s = r;
      if (s === i) break;
      [this.data[s], this.data[i]] = [this.data[i]!, this.data[s]!];
      i = s;
    }
  }
}

// ---------------------------------------------------------------------------
// A* (weighted)
// ---------------------------------------------------------------------------
export class AStar {
  private gridWidth: number;
  private gridHeight: number;
  private cells: Tile[][];
  private goalClusters: GoalCluster[];

  /**
   * Heuristic weight.  w=1 → optimal A*.  w>1 → suboptimal but much faster.
   * Solutions are guaranteed to be at most w× the optimal length.
   * Recommended: start at 1, increase to 2 or 3 if memory runs out.
   */
  private weight: number;

  /**
   * Pre-computed list of unsatisfied mustTouch cell indices per grid position.
   * Used so heuristic() doesn't re-scan the full grid every call.
   */
  private mustTouchIndices: { x: number; y: number; index: bigint }[] = [];

  private blockGoalAssignment: Map<number, GoalCluster> = new Map();

  onProgress?: (nodesExpanded: number) => void;
  onDownload?: (blob: Blob) => void;

  constructor(
    gridWidth: number,
    gridHeight: number,
    cells: Tile[][],
    weight = 2,
  ) {
    this.gridWidth = gridWidth;
    this.gridHeight = gridHeight;
    this.cells = cells;
    this.weight = weight;
    this.goalClusters = this.precomputeGoalClusters();

    for (let x = 0; x < gridWidth; x++) {
      for (let y = 0; y < gridHeight; y++) {
        if (cells[x]![y] !== "mustTouch") continue;
        this.mustTouchIndices.push({
          x,
          y,
          index: BigInt(positionToIndex(x, y, gridWidth)),
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Public entry point
  // -------------------------------------------------------------------------
  search(root: Node): Turn[] {
    for (const block of root.blocks) {
      root.mustTouchCellsSatisfied = block.updateMustTouchCells(
        this.gridWidth,
        this.cells,
        root.mustTouchCellsSatisfied,
      );
    }

    this.blockGoalAssignment = this.assignBlocksToGoals(root.blocks);

    const rootSignature = this.nodeSignature(root);

    // nodeStore holds Node objects only while in the open set.
    // Deleted on expansion so closed nodes do not hold memory.
    const nodeStore = new Map<string, Node>();
    nodeStore.set(rootSignature, root);

    const gScore = new Map<string, number>();
    gScore.set(rootSignature, 0);

    const cameFrom = new Map<
      string,
      { parentSignature: string | null; turn: Turn | null }
    >();
    cameFrom.set(rootSignature, { parentSignature: null, turn: null });

    const closedSet = new Set<string>();
    const openHeap = new MinHeap();
    openHeap.push({
      f: this.weight * this.heuristic(root),
      g: 0,
      signature: rootSignature,
    });

    let nodesExpanded = 0;

    while (openHeap.size > 0) {
      const { g, signature } = openHeap.pop()!;

      if (closedSet.has(signature)) continue;
      if ((gScore.get(signature) ?? Infinity) < g) continue;

      closedSet.add(signature);
      const node = nodeStore.get(signature)!;
      nodeStore.delete(signature); // free memory once expanded

      if (this.isGoalState(node)) {
        console.log(
          `A* (w=${this.weight}) found solution in ${g} moves, expanded ${nodesExpanded} nodes`,
        );
        const turns = this.reconstructPath(cameFrom, signature);
        const bfsTest: BFSTest = {
          gridWidth: this.gridWidth,
          gridHeight: this.gridHeight,
          cells: this.cells,
          blocks: root.blocks,
          turns: turns,
        };

        // Serialize and download bfsTest as a pretty-printed JSON file in the browser.
        try {
          const json = JSON.stringify(bfsTest, null, 2);
          const blob = new Blob([json], { type: "application/json" });
          this.onDownload?.(blob);
        } catch (e) {
          // If serialization or download fails, log the error but continue the search.
          // e may be e.g. circular structure or unsupported types.
          // eslint-disable-next-line no-console
          console.error("Failed to download bfsTest:", e);
        }
        return turns;
      }

      nodesExpanded++;
      if (nodesExpanded % 10_000 === 0) {
        this.onProgress?.(nodesExpanded);
      }

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

          const newSignature = this.nodeSignature(newNode);
          if (closedSet.has(newSignature)) continue;

          const newG = g + 1;
          if (newG >= (gScore.get(newSignature) ?? Infinity)) continue;

          gScore.set(newSignature, newG);
          nodeStore.set(newSignature, newNode);
          cameFrom.set(newSignature, {
            parentSignature: signature,
            turn: { blockId: block.id, direction },
          });
          openHeap.push({
            f: newG + this.weight * this.heuristic(newNode),
            g: newG,
            signature: newSignature,
          });
        }
      }
    }

    console.log("No solution found");
    return [];
  }

  // -------------------------------------------------------------------------
  // Heuristic  (max of three admissible components, scaled by weight outside)
  // -------------------------------------------------------------------------
  private heuristic(node: Node): number {
    return Math.max(
      this.mustTouchHeuristic(node),
      this.groupedMustTouchHeuristic(node),
      this.goalDistanceHeuristic(node),
    );
  }

  /**
   * Global lower bound: ceil(totalUnsatisfied / maxFootprint).
   * Admissible because one move covers at most maxFootprint cells.
   */
  private mustTouchHeuristic(node: Node): number {
    let unsatisfied = 0;
    let maxFootprint = 1;
    for (const block of node.blocks) {
      maxFootprint = Math.max(maxFootprint, block.width * block.depth);
    }
    for (const { index } of this.mustTouchIndices) {
      if (extractBit(node.mustTouchCellsSatisfied, index) === 0n) {
        unsatisfied++;
      }
    }
    return Math.ceil(unsatisfied / maxFootprint);
  }

  /**
   * Per-block lower bound: for each block, count mustTouch cells that ONLY
   * that block can reach (i.e. no other block is assigned to cover them via
   * proximity), then take ceil(count / blockFootprint).
   *
   * This is strictly stronger than the global heuristic when cells are
   * spatially separated across blocks, which is common in multi-block puzzles.
   *
   * Still admissible: a block can cover at most footprint cells per move, so
   * it needs at least ceil(exclusiveCells / footprint) moves for those cells
   * alone — regardless of what the other blocks are doing.
   */
  private groupedMustTouchHeuristic(node: Node): number {
    // Build a quick lookup: for each unsatisfied mustTouch cell, which blocks
    // are "close enough" to plausibly cover it?  We use a simple proximity
    // assignment: the cell belongs to whichever block is Manhattan-closest.
    const blockUnsatisfied = new Map<number, number>();
    for (const block of node.blocks) {
      blockUnsatisfied.set(block.id, 0);
    }

    for (const { x, y, index } of this.mustTouchIndices) {
      if (extractBit(node.mustTouchCellsSatisfied, index) !== 0n) continue;

      let bestId = node.blocks[0]!.id;
      let bestDist = Infinity;
      for (const block of node.blocks) {
        const d = Math.abs(block.x - x) + Math.abs(block.y - y);
        if (d < bestDist) {
          bestDist = d;
          bestId = block.id;
        }
      }
      blockUnsatisfied.set(bestId, (blockUnsatisfied.get(bestId) ?? 0) + 1);
    }

    let maxLowerBound = 0;
    for (const block of node.blocks) {
      const count = blockUnsatisfied.get(block.id) ?? 0;
      if (count === 0) continue;
      const footprint = block.width * block.depth;
      maxLowerBound = Math.max(maxLowerBound, Math.ceil(count / footprint));
    }
    return maxLowerBound;
  }

  /**
   * Lower bound from goal distances:
   * sum of Manhattan distances from each block to its assigned goal cluster.
   * Admissible because blocks move independently one step at a time.
   */
  private goalDistanceHeuristic(node: Node): number {
    if (this.goalClusters.length === 0) return 0;
    let total = 0;
    for (const block of node.blocks) {
      const goal = this.blockGoalAssignment.get(block.id);
      if (!goal) continue;
      if (this.blockCoversGoal(block, goal)) continue;
      total += Math.abs(block.x - goal.minX) + Math.abs(block.y - goal.minY);
    }
    return total;
  }

  private blockCoversGoal(
    block: { x: number; y: number; width: number; depth: number },
    goal: GoalCluster,
  ): boolean {
    for (let x = block.x; x < block.x + block.width; x++) {
      for (let y = block.y; y < block.y + block.depth; y++) {
        if (this.cells[x]?.[y] !== "goal") return false;
      }
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // Goal cluster pre-computation
  // -------------------------------------------------------------------------
  private precomputeGoalClusters(): GoalCluster[] {
    const visited = new Set<string>();
    const clusters: GoalCluster[] = [];

    for (let x = 0; x < this.gridWidth; x++) {
      for (let y = 0; y < this.gridHeight; y++) {
        if (this.cells[x]![y] !== "goal") continue;
        const key = `${x},${y}`;
        if (visited.has(key)) continue;

        const component: { x: number; y: number }[] = [];
        const queue: { x: number; y: number }[] = [{ x, y }];
        visited.add(key);

        while (queue.length > 0) {
          const cur = queue.shift()!;
          component.push(cur);
          for (const [dx, dy] of [
            [0, 1],
            [0, -1],
            [1, 0],
            [-1, 0],
          ] as [number, number][]) {
            const nx = cur.x + dx,
              ny = cur.y + dy;
            if (
              nx < 0 ||
              nx >= this.gridWidth ||
              ny < 0 ||
              ny >= this.gridHeight
            )
              continue;
            if (this.cells[nx]![ny] !== "goal") continue;
            const nk = `${nx},${ny}`;
            if (visited.has(nk)) continue;
            visited.add(nk);
            queue.push({ x: nx, y: ny });
          }
        }

        const minX = Math.min(...component.map(c => c.x));
        const maxX = Math.max(...component.map(c => c.x));
        const minY = Math.min(...component.map(c => c.y));
        const maxY = Math.max(...component.map(c => c.y));
        clusters.push({
          minX,
          maxX,
          minY,
          maxY,
          width: maxX - minX + 1,
          depth: maxY - minY + 1,
        });
      }
    }

    return clusters;
  }

  // -------------------------------------------------------------------------
  // Block ↔ goal assignment
  // -------------------------------------------------------------------------
  private blockPossibleFootprints(block: {
    width: number;
    depth: number;
    height: number;
  }): { width: number; depth: number }[] {
    const seen = new Set<string>();
    const result: { width: number; depth: number }[] = [];
    for (const [w, d] of [
      [block.width, block.depth],
      [block.height, block.depth],
      [block.width, block.height],
      [block.depth, block.width],
      [block.depth, block.height],
      [block.height, block.width],
    ] as [number, number][]) {
      const k = `${w}x${d}`;
      if (!seen.has(k)) {
        seen.add(k);
        result.push({ width: w, depth: d });
      }
    }
    return result;
  }

  private blockCompatibleWithCluster(
    block: { width: number; depth: number; height: number },
    cluster: GoalCluster,
  ): boolean {
    return this.blockPossibleFootprints(block).some(
      fp => fp.width === cluster.width && fp.depth === cluster.depth,
    );
  }

  private assignBlocksToGoals(
    blocks: {
      id: number;
      x: number;
      y: number;
      width: number;
      depth: number;
      height: number;
    }[],
  ): Map<number, GoalCluster> {
    if (this.goalClusters.length === 0) return new Map();

    const assignment = new Map<number, GoalCluster>();
    const taken = new Set<GoalCluster>();

    // Pass 1: forced (uniquely compatible) assignments, iterated until stable.
    let changed = true;
    while (changed) {
      changed = false;
      for (const block of blocks) {
        if (assignment.has(block.id)) continue;
        const compatible = this.goalClusters.filter(
          c => !taken.has(c) && this.blockCompatibleWithCluster(block, c),
        );
        if (compatible.length === 1) {
          assignment.set(block.id, compatible[0]!);
          taken.add(compatible[0]!);
          changed = true;
        }
      }
    }

    // Pass 2: nearest compatible cluster for remaining blocks.
    for (const block of blocks) {
      if (assignment.has(block.id)) continue;
      const compatible = this.goalClusters.filter(
        c => !taken.has(c) && this.blockCompatibleWithCluster(block, c),
      );
      if (compatible.length === 0) continue;
      const nearest = compatible.reduce((best, c) => {
        const d = Math.abs(block.x - c.minX) + Math.abs(block.y - c.minY);
        return d < Math.abs(block.x - best.minX) + Math.abs(block.y - best.minY)
          ? c
          : best;
      });
      assignment.set(block.id, nearest);
      taken.add(nearest);
    }

    return assignment;
  }

  // -------------------------------------------------------------------------
  // Goal state check
  // -------------------------------------------------------------------------
  private isGoalState(node: Node): boolean {
    const goalIndices: Set<bigint> = new Set();

    for (let x = 0; x < this.gridWidth; x++) {
      for (let y = 0; y < this.gridHeight; y++) {
        const cell = this.cells[x]![y];
        const index = positionToIndex(x, y, this.gridWidth);
        if (cell === "goal") {
          goalIndices.add(BigInt(index));
          continue;
        }
        if (cell !== "mustTouch") continue;
        if (extractBit(node.mustTouchCellsSatisfied, index) === 0n)
          return false;
      }
    }

    if (goalIndices.size === 0) return true;

    const satisfiedGoalIndices: Set<bigint> = new Set();
    for (const block of node.blocks) {
      let fullyOnGoal = true;
      outer: for (let x = block.x; x < block.x + block.width; x++) {
        for (let y = block.y; y < block.y + block.depth; y++) {
          if (this.cells[x]![y] !== "goal") {
            fullyOnGoal = false;
            break outer;
          }
        }
      }
      if (!fullyOnGoal) continue;
      for (let x = block.x; x < block.x + block.width; x++) {
        for (let y = block.y; y < block.y + block.depth; y++) {
          const idx = BigInt(positionToIndex(x, y, this.gridWidth));
          if (goalIndices.has(idx)) satisfiedGoalIndices.add(idx);
        }
      }
    }

    return satisfiedGoalIndices.size === goalIndices.size;
  }

  // -------------------------------------------------------------------------
  // Path reconstruction & signature
  // -------------------------------------------------------------------------
  private reconstructPath(
    cameFrom: Map<
      string,
      { parentSignature: string | null; turn: Turn | null }
    >,
    goalSignature: string,
  ): Turn[] {
    const turns: Turn[] = [];
    let current = goalSignature;
    while (true) {
      const entry = cameFrom.get(current)!;
      if (entry.turn === null) break;
      turns.unshift(entry.turn);
      current = entry.parentSignature!;
    }
    return turns;
  }

  private nodeSignature(node: Node): string {
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
