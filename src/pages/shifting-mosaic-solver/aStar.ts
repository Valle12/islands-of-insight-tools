import type { Position } from "../../util/types";
import { MinHeap } from "../../util/minHeap";
import { Direction } from "./directions";
import { Node } from "./node";
import type { Turn } from "./turn";
/**
 * What an `AStar` needs to describe a board. An options object rather than a
 * positional list: the two tuning knobs are optional and everything else is a
 * number or a `Position`, so a transposed pair of arguments would have typed
 * fine and searched the wrong board.
 */
export interface AStarOptions {
  gridWidth: number;
  gridHeight: number;
  shapes: Position[][];
  initialAnchors: Position[];
  goalIndex: number;
  goalAnchor: Position;
  /** Greedy weight on the heuristic; 1 (the default) is plain A*. */
  weight?: number;
  deadlockPruning?: boolean;
}

/** The open/closed bookkeeping one `search` run threads through its steps. */
interface SearchState {
  readonly nodeStore: Map<string, Position[]>;
  readonly gScore: Map<string, number>;
  readonly cameFrom: Map<
    string,
    { parentSignature: string | null; turn: Turn | null }
  >;
  readonly closedSet: Set<string>;
  readonly openHeap: MinHeap;
}

/** The node currently being expanded: its anchors, its cost, its signature. */
interface Expansion {
  readonly anchors: Position[];
  readonly g: number;
  readonly signature: string;
}

export class AStar {
  private readonly gridWidth: number;
  private readonly gridHeight: number;
  private readonly shapes: Position[][];
  private readonly initialAnchors: Position[];
  private readonly goalIndex: number;
  private readonly goalAnchor: Position;

  private readonly shapeBoxWidth: number[];
  private readonly shapeBoxHeight: number[];
  private readonly shapeCellSets: Set<number>[];
  private readonly goalBlockFinalCells: Set<number>;

  private static readonly SHAPE_STRIDE = 1024;
  private static readonly DIRECTIONS: Direction[] = [
    Direction.UP,
    Direction.RIGHT,
    Direction.DOWN,
    Direction.LEFT,
  ];
  private static readonly DX = [0, 1, 0, -1];
  private static readonly DY = [-1, 0, 1, 0];

  private readonly weight: number;
  private readonly deadlockPruning: boolean;

  constructor(options: AStarOptions) {
    const { shapes, goalAnchor } = options;
    this.gridWidth = options.gridWidth;
    this.gridHeight = options.gridHeight;
    this.shapes = shapes;
    this.initialAnchors = options.initialAnchors;
    this.goalIndex = options.goalIndex;
    this.goalAnchor = goalAnchor;
    this.weight = options.weight ?? 1;
    this.deadlockPruning = options.deadlockPruning ?? true;

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

  private readonly movableBlockIndices: number[] = [];
  private readonly unsolvableAtStart: boolean = false;
  // BFS distance from every valid goal-block anchor to goalAnchor, treating
  // locked blocks as walls. -1 means unreachable.
  private readonly goalAnchorBfsDist: Int32Array = new Int32Array(0);

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
    if (this.isGoalState(root)) return [];

    const state = this.seedState(root, rootAnchors);
    let nodesExpanded = 0;

    while (state.openHeap.size > 0) {
      if (this.outOfTime(nodesExpanded, deadline)) {
        console.log(
          `A* timed out after ${nodesExpanded} nodes (budget ${maxMs}ms)`,
        );
        return [];
      }

      const { g, signature } = state.openHeap.pop()!;
      const anchors = this.claimNode(state, signature, g);
      if (!anchors) continue;

      if (this.isGoalState(new Node(anchors, g, 0))) {
        console.log(
          `A* found solution in ${g} moves, expanded ${nodesExpanded} nodes`,
        );
        return this.reconstructPath(state.cameFrom, signature);
      }

      nodesExpanded++;

      if (this.deadlockPruning && this.isDeadlocked(anchors)) continue;

      this.expandNode(state, { anchors, g, signature });
    }

    console.log(`A* found no solution, expanded ${nodesExpanded} nodes`);
    return [];
  }

  /** The open/closed bookkeeping for a fresh run, seeded with the root. */
  private seedState(root: Node, rootAnchors: Position[]): SearchState {
    const rootSignature = this.nodeSignature(root);
    const state: SearchState = {
      nodeStore: new Map([[rootSignature, rootAnchors]]),
      gScore: new Map([[rootSignature, 0]]),
      cameFrom: new Map([
        [rootSignature, { parentSignature: null, turn: null }],
      ]),
      closedSet: new Set(),
      openHeap: new MinHeap(),
    };
    state.openHeap.push({
      f: this.weight * this.heuristic(root),
      g: 0,
      signature: rootSignature,
    });
    return state;
  }

  /**
   * Only every 4096th expansion actually reads the clock — `Date.now()` in the
   * inner loop is not free, and the budget is a coarse stop rather than a
   * precise one.
   */
  private outOfTime(nodesExpanded: number, deadline: number): boolean {
    return (nodesExpanded & 0xfff) === 0 && Date.now() > deadline;
  }

  /**
   * Closes a popped entry and hands back its anchors, or `null` when the entry
   * is STALE: already closed, superseded by a cheaper path found after it was
   * pushed, or with its anchors already released. The heap has no decrease-key,
   * so the same state is pushed more than once and the extra copies are dropped
   * here rather than at push time.
   */
  private claimNode(
    state: SearchState,
    signature: string,
    g: number,
  ): Position[] | null {
    if (state.closedSet.has(signature)) return null;
    if ((state.gScore.get(signature) ?? Infinity) < g) return null;
    const anchors = state.nodeStore.get(signature);
    if (!anchors) return null;
    state.closedSet.add(signature);
    state.nodeStore.delete(signature);
    return anchors;
  }

  /** Every one-square slide of every movable block. */
  private expandNode(state: SearchState, from: Expansion) {
    for (const i of this.movableBlockIndices) {
      for (let d = 0; d < 4; d++) {
        this.relaxMove(state, from, i, d);
      }
    }
  }

  /** One candidate slide: bounds, collision, then the open-set relaxation. */
  private relaxMove(
    state: SearchState,
    from: Expansion,
    i: number,
    d: number,
  ) {
    const { anchors, g, signature } = from;
    const currentAnchor = anchors[i]!;
    const newAnchor: Position = {
      x: currentAnchor.x + AStar.DX[d]!,
      y: currentAnchor.y + AStar.DY[d]!,
    };

    if (!this.inBounds(i, newAnchor)) return;
    if (this.collidesWithOthers(i, newAnchor, anchors)) return;

    const newAnchors = anchors.slice();
    newAnchors[i] = newAnchor;

    const newNode = new Node(newAnchors);
    const newSignature = this.nodeSignature(newNode);
    if (state.closedSet.has(newSignature)) return;

    const newG = g + 1;
    if (newG >= (state.gScore.get(newSignature) ?? Infinity)) return;

    state.gScore.set(newSignature, newG);
    state.nodeStore.set(newSignature, newAnchors);
    state.cameFrom.set(newSignature, {
      parentSignature: signature,
      turn: { blockId: i, direction: AStar.DIRECTIONS[d]! },
    });
    state.openHeap.push({
      f: newG + this.weight * this.heuristic(newNode),
      g: newG,
      signature: newSignature,
    });
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
    const occupancy = this.buildOccupancy(anchors);
    const movable = new Set<number>();

    let changed = true;
    while (changed) {
      changed = false;
      for (let i = 0; i < anchors.length; i++) {
        if (movable.has(i)) continue;
        if (!this.canFreeAnyDirection(i, anchors[i]!, occupancy, movable)) {
          continue;
        }
        movable.add(i);
        changed = true;
      }
    }

    return movable;
  }

  /** Which block owns each cell, `-1` where none does. */
  private buildOccupancy(anchors: Position[]): Int16Array {
    const stride = this.gridHeight;
    const occupancy = new Int16Array(this.gridWidth * this.gridHeight);
    occupancy.fill(-1);
    for (let i = 0; i < anchors.length; i++) {
      const a = anchors[i]!;
      for (const cell of this.shapes[i]!) {
        occupancy[(a.x + cell.x) * stride + (a.y + cell.y)] = i;
      }
    }
    return occupancy;
  }

  /**
   * Can block `i` step one square in SOME direction, counting a cell held by an
   * already-proven-movable block as clearable? One round of the fixpoint above.
   */
  private canFreeAnyDirection(
    i: number,
    a: Position,
    occupancy: Int16Array,
    movable: Set<number>,
  ): boolean {
    for (let d = 0; d < 4; d++) {
      const nax = a.x + AStar.DX[d]!;
      const nay = a.y + AStar.DY[d]!;
      if (!this.inBounds(i, { x: nax, y: nay })) continue;
      if (this.allOccupantsFreeable(i, nax, nay, occupancy, movable)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Every OTHER block sitting on block `i`'s destination footprint is itself
   * already proven movable. A cell held by nobody, or by `i` itself, is free.
   */
  private allOccupantsFreeable(
    i: number,
    nax: number,
    nay: number,
    occupancy: Int16Array,
    movable: Set<number>,
  ): boolean {
    const stride = this.gridHeight;
    for (const cell of this.shapes[i]!) {
      const occ = occupancy[(nax + cell.x) * stride + (nay + cell.y)]!;
      if (occ === -1 || occ === i) continue;
      if (!movable.has(occ)) return false;
    }
    return true;
  }

  /**
   * Deadlock iff some block overlapping the goal block's final footprint
   * is permanently stuck. That block must vacate its cells for the goal
   * block to land — if it can never move, the goal is unreachable.
   */
  private isDeadlocked(anchors: Position[]): boolean {
    // Cheap pre-check: with nothing standing on the goal footprint at all there
    // is no deadlock to look for, and the fixpoint below is not worth running.
    const anyBlocker = anchors.some(
      (_, i) => i !== this.goalIndex && this.overlapsGoalFootprint(i, anchors),
    );
    if (!anyBlocker) return false;

    const movable = this.computeMovableSet(anchors);
    return anchors.some(
      (_, i) =>
        i !== this.goalIndex &&
        !movable.has(i) &&
        this.overlapsGoalFootprint(i, anchors),
    );
  }

  /** Does block `i` stand on any cell the goal block has to end up on? */
  private overlapsGoalFootprint(i: number, anchors: Position[]): boolean {
    const stride = this.gridHeight;
    const a = anchors[i]!;
    for (const cell of this.shapes[i]!) {
      const enc = (a.x + cell.x) * stride + (a.y + cell.y);
      if (this.goalBlockFinalCells.has(enc)) return true;
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
