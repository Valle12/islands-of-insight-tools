import type { Position } from "../../util/types";
import { MinHeap } from "../../util/minHeap";
import { Direction } from "./directions";
import { Node } from "./node";
import type { Turn } from "./turn";
export class AStar {
  private gridWidth: number;
  private gridHeight: number;
  private shapes: Position[][];
  private initialAnchors: Position[];
  private goalIndex: number;
  private goalAnchor: Position;

  private shapeBoxWidth: number[];
  private shapeBoxHeight: number[];
  private shapeCellSets: Set<number>[];
  private goalBlockFinalCells: Set<number>;

  private static readonly SHAPE_STRIDE = 1024;
  private static readonly DIRECTIONS: Direction[] = [
    Direction.UP,
    Direction.RIGHT,
    Direction.DOWN,
    Direction.LEFT,
  ];
  private static readonly DX = [0, 1, 0, -1];
  private static readonly DY = [-1, 0, 1, 0];

  private weight: number;
  private deadlockPruning: boolean;

  constructor(
    gridWidth: number,
    gridHeight: number,
    shapes: Position[][],
    initialAnchors: Position[],
    goalIndex: number,
    goalAnchor: Position,
    weight = 1,
    deadlockPruning = true,
  ) {
    this.gridWidth = gridWidth;
    this.gridHeight = gridHeight;
    this.shapes = shapes;
    this.initialAnchors = initialAnchors;
    this.goalIndex = goalIndex;
    this.goalAnchor = goalAnchor;
    this.weight = weight;
    this.deadlockPruning = deadlockPruning;

    this.shapeBoxWidth = shapes.map(shape => {
      let max = 0;
      for (const cell of shape) if (cell.x > max) max = cell.x;
      return max + 1;
    });
    this.shapeBoxHeight = shapes.map(shape => {
      let max = 0;
      for (const cell of shape) if (cell.y > max) max = cell.y;
      return max + 1;
    });
    this.shapeCellSets = shapes.map(
      shape =>
        new Set(shape.map(cell => cell.x * AStar.SHAPE_STRIDE + cell.y)),
    );

    this.goalBlockFinalCells = new Set();
    const goalShape = this.shapes[this.goalIndex]!;
    for (const cell of goalShape) {
      const ax = goalAnchor.x + cell.x;
      const ay = goalAnchor.y + cell.y;
      this.goalBlockFinalCells.add(ax * this.gridHeight + ay);
    }

    const movableAtStart = this.computeMovableSet(this.initialAnchors);
    this.movableBlockIndices = [];
    this.unsolvableAtStart = false;
    const lockedCells = new Set<number>();
    for (let i = 0; i < this.shapes.length; i++) {
      if (movableAtStart.has(i) || i === this.goalIndex) {
        this.movableBlockIndices.push(i);
      } else {
        const a = this.initialAnchors[i]!;
        for (const cell of this.shapes[i]!) {
          const enc = (a.x + cell.x) * this.gridHeight + (a.y + cell.y);
          lockedCells.add(enc);
          if (this.goalBlockFinalCells.has(enc)) {
            this.unsolvableAtStart = true;
          }
        }
      }
    }
    this.goalAnchorBfsDist = this.computeGoalAnchorBfs(lockedCells);
    const startBfs =
      this.goalAnchorBfsDist[
        this.initialAnchors[this.goalIndex]!.x * this.gridHeight +
          this.initialAnchors[this.goalIndex]!.y
      ];
    if (startBfs === undefined || startBfs === -1) {
      this.unsolvableAtStart = true;
    }
    console.log(
      `AStar: ${this.movableBlockIndices.length} of ${this.shapes.length} blocks movable from start${this.unsolvableAtStart ? " (UNSOLVABLE — goal anchor unreachable through locked walls)" : ""}`,
    );
  }

  private movableBlockIndices: number[] = [];
  private unsolvableAtStart = false;
  // BFS distance from every valid goal-block anchor to goalAnchor, treating
  // locked blocks as walls. -1 means unreachable.
  private goalAnchorBfsDist: Int32Array = new Int32Array(0);

  private computeGoalAnchorBfs(lockedCells: Set<number>): Int32Array {
    const total = this.gridWidth * this.gridHeight;
    const dist = new Int32Array(total);
    dist.fill(-1);

    const gw = this.shapeBoxWidth[this.goalIndex]!;
    const gh = this.shapeBoxHeight[this.goalIndex]!;
    const gShape = this.shapes[this.goalIndex]!;

    const anchorValid = (x: number, y: number): boolean => {
      if (x < 0 || y < 0) return false;
      if (x + gw > this.gridWidth || y + gh > this.gridHeight) return false;
      for (const cell of gShape) {
        if (lockedCells.has((x + cell.x) * this.gridHeight + (y + cell.y)))
          return false;
      }
      return true;
    };

    if (!anchorValid(this.goalAnchor.x, this.goalAnchor.y)) return dist;

    dist[this.goalAnchor.x * this.gridHeight + this.goalAnchor.y] = 0;
    const queue: [number, number][] = [[this.goalAnchor.x, this.goalAnchor.y]];
    let head = 0;
    while (head < queue.length) {
      const [x, y] = queue[head++]!;
      const d = dist[x * this.gridHeight + y]!;
      for (let dir = 0; dir < 4; dir++) {
        const nx = x + AStar.DX[dir]!;
        const ny = y + AStar.DY[dir]!;
        if (!anchorValid(nx, ny)) continue;
        const idx = nx * this.gridHeight + ny;
        if (dist[idx] !== -1) continue;
        dist[idx] = d + 1;
        queue.push([nx, ny]);
      }
    }
    return dist;
  }

  search(maxMs?: number): Turn[] {
    if (this.unsolvableAtStart) {
      console.log(
        "A* short-circuit: a permanently-locked block sits on the goal block's final footprint — puzzle is unsolvable",
      );
      return [];
    }

    const deadline = maxMs === undefined ? Infinity : Date.now() + maxMs;
    const rootAnchors = this.initialAnchors.map(a => ({ x: a.x, y: a.y }));
    const root = new Node(rootAnchors);
    const rootSignature = this.nodeSignature(root);

    if (this.isGoalState(root)) return [];

    const nodeStore = new Map<string, Position[]>();
    nodeStore.set(rootSignature, rootAnchors);

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
      if ((nodesExpanded & 0xfff) === 0 && Date.now() > deadline) {
        console.log(
          `A* timed out after ${nodesExpanded} nodes (budget ${maxMs}ms)`,
        );
        return [];
      }

      const { g, signature } = openHeap.pop()!;

      if (closedSet.has(signature)) continue;
      if ((gScore.get(signature) ?? Infinity) < g) continue;

      const anchors = nodeStore.get(signature);
      if (!anchors) continue;

      closedSet.add(signature);
      nodeStore.delete(signature);

      const node = new Node(anchors, g, 0);
      if (this.isGoalState(node)) {
        console.log(
          `A* found solution in ${g} moves, expanded ${nodesExpanded} nodes`,
        );
        return this.reconstructPath(cameFrom, signature);
      }

      nodesExpanded++;

      if (this.deadlockPruning && this.isDeadlocked(anchors)) continue;

      for (const i of this.movableBlockIndices) {
        const currentAnchor = anchors[i]!;
        for (let d = 0; d < 4; d++) {
          const newAnchor: Position = {
            x: currentAnchor.x + AStar.DX[d]!,
            y: currentAnchor.y + AStar.DY[d]!,
          };

          if (!this.inBounds(i, newAnchor)) continue;
          if (this.collidesWithOthers(i, newAnchor, anchors)) continue;

          const newAnchors = anchors.slice();
          newAnchors[i] = newAnchor;

          const newNode = new Node(newAnchors);
          const newSignature = this.nodeSignature(newNode);

          if (closedSet.has(newSignature)) continue;

          const newG = g + 1;
          if (newG >= (gScore.get(newSignature) ?? Infinity)) continue;

          gScore.set(newSignature, newG);
          nodeStore.set(newSignature, newAnchors);
          cameFrom.set(newSignature, {
            parentSignature: signature,
            turn: { blockId: i, direction: AStar.DIRECTIONS[d]! },
          });
          openHeap.push({
            f: newG + this.weight * this.heuristic(newNode),
            g: newG,
            signature: newSignature,
          });
        }
      }
    }

    console.log(`A* found no solution, expanded ${nodesExpanded} nodes`);
    return [];
  }

  private inBounds(blockIndex: number, anchor: Position): boolean {
    return (
      anchor.x >= 0 &&
      anchor.y >= 0 &&
      anchor.x + this.shapeBoxWidth[blockIndex]! <= this.gridWidth &&
      anchor.y + this.shapeBoxHeight[blockIndex]! <= this.gridHeight
    );
  }

  private boundingBoxesOverlap(
    i: number,
    ai: Position,
    j: number,
    aj: Position,
  ): boolean {
    const aw = this.shapeBoxWidth[i]!;
    const ah = this.shapeBoxHeight[i]!;
    const bw = this.shapeBoxWidth[j]!;
    const bh = this.shapeBoxHeight[j]!;
    if (ai.x + aw <= aj.x || aj.x + bw <= ai.x) return false;
    if (ai.y + ah <= aj.y || aj.y + bh <= ai.y) return false;
    return true;
  }

  private blocksCollide(
    i: number,
    ai: Position,
    j: number,
    aj: Position,
  ): boolean {
    if (!this.boundingBoxesOverlap(i, ai, j, aj)) return false;

    const dx = ai.x - aj.x;
    const dy = ai.y - aj.y;
    const bw = this.shapeBoxWidth[j]!;
    const bh = this.shapeBoxHeight[j]!;
    const setJ = this.shapeCellSets[j]!;
    for (const cellA of this.shapes[i]!) {
      const relX = cellA.x + dx;
      const relY = cellA.y + dy;
      if (relX < 0 || relY < 0) continue;
      if (relX >= bw || relY >= bh) continue;
      if (setJ.has(relX * AStar.SHAPE_STRIDE + relY)) return true;
    }
    return false;
  }

  private collidesWithOthers(
    blockIndex: number,
    newAnchor: Position,
    anchors: Position[],
  ): boolean {
    for (let j = 0; j < anchors.length; j++) {
      if (j === blockIndex) continue;
      if (this.blocksCollide(blockIndex, newAnchor, j, anchors[j]!))
        return true;
    }
    return false;
  }

  private heuristic(node: Node): number {
    const goal = node.anchors[this.goalIndex]!;
    if (goal.x === this.goalAnchor.x && goal.y === this.goalAnchor.y) return 0;
    // BFS distance through locked-walls grid dominates Manhattan whenever
    // locked obstacles force a detour. -1 means unreachable; fall back to
    // Manhattan defensively.
    const bfs = this.goalAnchorBfsDist[goal.x * this.gridHeight + goal.y];
    const base =
      bfs === undefined || bfs === -1
        ? Math.abs(goal.x - this.goalAnchor.x) +
          Math.abs(goal.y - this.goalAnchor.y)
        : bfs;
    return base + this.countFinalPositionBlockers(node.anchors);
  }

  private countFinalPositionBlockers(anchors: Position[]): number {
    const gw = this.shapeBoxWidth[this.goalIndex]!;
    const gh = this.shapeBoxHeight[this.goalIndex]!;
    let count = 0;
    for (let i = 0; i < anchors.length; i++) {
      if (i === this.goalIndex) continue;
      const a = anchors[i]!;
      const aw = this.shapeBoxWidth[i]!;
      const ah = this.shapeBoxHeight[i]!;
      // bbox quick reject against goal block's final bbox
      if (a.x + aw <= this.goalAnchor.x || this.goalAnchor.x + gw <= a.x)
        continue;
      if (a.y + ah <= this.goalAnchor.y || this.goalAnchor.y + gh <= a.y)
        continue;

      for (const cell of this.shapes[i]!) {
        const enc = (a.x + cell.x) * this.gridHeight + (a.y + cell.y);
        if (this.goalBlockFinalCells.has(enc)) {
          count++;
          break;
        }
      }
    }
    return count;
  }

  private isGoalState(node: Node): boolean {
    const anchor = node.anchors[this.goalIndex];
    if (!anchor) return false;
    return (
      anchor.x === this.goalAnchor.x && anchor.y === this.goalAnchor.y
    );
  }

  /**
   * Correct fixpoint: start with NOBODY proven movable and only add a block X
   * once some direction's blockers are *already* proven movable. Catches
   * mutual locks (e.g. a hollow ring around a single interior cell) — the
   * optimistic "start full and remove" variant kept both members of such a
   * pair in the set forever, masking the deadlock.
   */
  private computeMovableSet(anchors: Position[]): Set<number> {
    const n = anchors.length;
    const stride = this.gridHeight;
    const occupancy = new Int16Array(this.gridWidth * this.gridHeight);
    occupancy.fill(-1);
    for (let i = 0; i < n; i++) {
      const a = anchors[i]!;
      for (const cell of this.shapes[i]!) {
        occupancy[(a.x + cell.x) * stride + (a.y + cell.y)] = i;
      }
    }

    const movable = new Set<number>();

    let changed = true;
    while (changed) {
      changed = false;
      for (let i = 0; i < n; i++) {
        if (movable.has(i)) continue;
        const a = anchors[i]!;
        const shape = this.shapes[i]!;
        let canMove = false;

        for (let d = 0; d < 4; d++) {
          const nax = a.x + AStar.DX[d]!;
          const nay = a.y + AStar.DY[d]!;
          if (!this.inBounds(i, { x: nax, y: nay })) continue;

          let allFreeable = true;
          for (const cell of shape) {
            const enc = (nax + cell.x) * stride + (nay + cell.y);
            const occ = occupancy[enc]!;
            if (occ === -1 || occ === i) continue;
            if (!movable.has(occ)) {
              allFreeable = false;
              break;
            }
          }
          if (allFreeable) {
            canMove = true;
            break;
          }
        }

        if (canMove) {
          movable.add(i);
          changed = true;
        }
      }
    }

    return movable;
  }

  /**
   * Deadlock iff some block overlapping the goal block's final footprint
   * is permanently stuck. That block must vacate its cells for the goal
   * block to land — if it can never move, the goal is unreachable.
   */
  private isDeadlocked(anchors: Position[]): boolean {
    const stride = this.gridHeight;
    let hasBlocker = false;
    for (let i = 0; i < anchors.length; i++) {
      if (i === this.goalIndex) continue;
      const a = anchors[i]!;
      for (const cell of this.shapes[i]!) {
        const enc = (a.x + cell.x) * stride + (a.y + cell.y);
        if (this.goalBlockFinalCells.has(enc)) {
          hasBlocker = true;
          break;
        }
      }
      if (hasBlocker) break;
    }
    if (!hasBlocker) return false;

    const movable = this.computeMovableSet(anchors);

    for (let i = 0; i < anchors.length; i++) {
      if (i === this.goalIndex) continue;
      if (movable.has(i)) continue;
      const a = anchors[i]!;
      for (const cell of this.shapes[i]!) {
        const enc = (a.x + cell.x) * stride + (a.y + cell.y);
        if (this.goalBlockFinalCells.has(enc)) return true;
      }
    }
    return false;
  }

  private nodeSignature(node: Node): string {
    let out = "";
    for (let i = 0; i < node.anchors.length; i++) {
      const a = node.anchors[i]!;
      if (i > 0) out += "|";
      out += `${a.x},${a.y}`;
    }
    return out;
  }

  private reconstructPath(
    cameFrom: Map<
      string,
      { parentSignature: string | null; turn: Turn | null }
    >,
    goalSignature: string,
  ): Turn[] {
    const turns: Turn[] = [];
    let current: string | null = goalSignature;
    while (current !== null) {
      const entry: { parentSignature: string | null; turn: Turn | null } =
        cameFrom.get(current)!;
      if (entry.turn !== null) turns.unshift(entry.turn);
      current = entry.parentSignature;
    }
    return turns;
  }
}
