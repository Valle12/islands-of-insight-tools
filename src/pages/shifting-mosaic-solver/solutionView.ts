import type { Position } from "../../util/types";
import { Direction } from "./directions";
import type { Turn } from "./turn";

const DX: Record<Direction, number> = {
  [Direction.UP]: 0,
  [Direction.RIGHT]: 1,
  [Direction.DOWN]: 0,
  [Direction.LEFT]: -1,
};
const DY: Record<Direction, number> = {
  [Direction.UP]: -1,
  [Direction.RIGHT]: 0,
  [Direction.DOWN]: 1,
  [Direction.LEFT]: 0,
};
const DIR_LABEL: Record<Direction, string> = {
  [Direction.UP]: "up",
  [Direction.RIGHT]: "right",
  [Direction.DOWN]: "down",
  [Direction.LEFT]: "left",
};

interface Step {
  blockId: number;
  direction: Direction;
  distance: number;
}

export interface SolutionViewData {
  gridWidth: number;
  gridHeight: number;
  shapes: Position[][];
  initialAnchors: Position[];
  goalIndex: number;
  goalAnchor: Position;
  turns: Turn[];
}

/**
 * Step-by-step viewer for a shifting-mosaic solution. Consecutive single-cell
 * turns of the same block in the same direction are merged into one "step"
 * (the way a player would do the move in-game: one drag of N cells). Each
 * step highlights the block to move and shows a destination zone.
 */
export class SolutionView {
  private readonly data: SolutionViewData;
  private readonly steps: Step[];
  // snapshots[i] = block anchors *before* step i. snapshots[steps.length] is
  // the final, solved configuration.
  private readonly snapshots: Position[][];
  private viewIndex = 0;

  private readonly grid = document.getElementById(
    "solution-grid",
  ) as HTMLDivElement;
  private readonly stepText = document.getElementById(
    "solution-step-text",
  ) as HTMLDivElement;
  private readonly stepCounter = document.getElementById(
    "solution-step-counter",
  ) as HTMLSpanElement;
  private readonly prevBtn = document.getElementById(
    "solution-prev",
  ) as HTMLButtonElement;
  private readonly nextBtn = document.getElementById(
    "solution-next",
  ) as HTMLButtonElement;

  constructor(data: SolutionViewData) {
    this.data = data;
    this.steps = SolutionView.buildSteps(data.turns);
    this.snapshots = this.buildSnapshots();

    this.prevBtn.onclick = () => {
      if (this.viewIndex > 0) {
        this.viewIndex--;
        this.render();
      }
    };
    this.nextBtn.onclick = () => {
      if (this.viewIndex < this.steps.length) {
        this.viewIndex++;
        this.render();
      }
    };

    this.render();
  }

  /** Merge consecutive same-block, same-direction turns into player moves. */
  private static buildSteps(turns: Turn[]): Step[] {
    const steps: Step[] = [];
    for (const turn of turns) {
      const last = steps[steps.length - 1];
      if (
        last &&
        last.blockId === turn.blockId &&
        last.direction === turn.direction
      ) {
        last.distance++;
      } else {
        steps.push({
          blockId: turn.blockId,
          direction: turn.direction,
          distance: 1,
        });
      }
    }
    return steps;
  }

  /** Anchor configurations before each step, plus the final configuration. */
  private buildSnapshots(): Position[][] {
    const snapshots: Position[][] = [];
    let anchors = this.data.initialAnchors.map(a => ({ x: a.x, y: a.y }));
    snapshots.push(anchors.map(a => ({ x: a.x, y: a.y })));
    for (const step of this.steps) {
      anchors = anchors.map(a => ({ x: a.x, y: a.y }));
      const moving = anchors[step.blockId]!;
      moving.x += DX[step.direction] * step.distance;
      moving.y += DY[step.direction] * step.distance;
      snapshots.push(anchors.map(a => ({ x: a.x, y: a.y })));
    }
    return snapshots;
  }

  /** Absolute cells of a block placed at the given anchor. */
  private cellsOf(blockId: number, anchor: Position): Position[] {
    return this.data.shapes[blockId]!.map(c => ({
      x: anchor.x + c.x,
      y: anchor.y + c.y,
    }));
  }

  render() {
    const { gridWidth, gridHeight, goalIndex } = this.data;
    const atEnd = this.viewIndex >= this.steps.length;
    const anchors = this.snapshots[this.viewIndex]!;
    const step = atEnd ? null : this.steps[this.viewIndex]!;

    // occupant[x][y] = block index, or -1 for empty.
    const occupant: number[][] = Array.from({ length: gridWidth }, () =>
      Array.from({ length: gridHeight }, () => -1),
    );
    for (let i = 0; i < anchors.length; i++) {
      for (const cell of this.cellsOf(i, anchors[i]!)) {
        if (
          cell.x >= 0 &&
          cell.x < gridWidth &&
          cell.y >= 0 &&
          cell.y < gridHeight
        ) {
          occupant[cell.x]![cell.y] = i;
        }
      }
    }

    // Destination zone — the moving block's footprint after this step.
    const destSet = new Set<string>();
    if (step) {
      const after = this.snapshots[this.viewIndex + 1]![step.blockId]!;
      for (const cell of this.cellsOf(step.blockId, after)) {
        destSet.add(`${cell.x},${cell.y}`);
      }
    }

    // Goal zone — where the goal block must finish.
    const goalSet = new Set<string>();
    for (const cell of this.cellsOf(goalIndex, this.data.goalAnchor)) {
      goalSet.add(`${cell.x},${cell.y}`);
    }

    this.grid.style.gridTemplateColumns = `repeat(${gridWidth}, minmax(0, 1fr))`;
    this.grid.innerHTML = "";

    for (let y = 0; y < gridHeight; y++) {
      for (let x = 0; x < gridWidth; x++) {
        const cell = document.createElement("div");
        cell.className = "grid-cell";
        cell.dataset.x = String(x);
        cell.dataset.y = String(y);

        const block = occupant[x]![y]!;
        if (block !== -1) {
          cell.dataset.blockType =
            block === goalIndex ? "goal" : "obstruction";
          const sameBlock = (nx: number, ny: number) =>
            occupant[nx]?.[ny] === block;
          if (!sameBlock(x, y - 1)) cell.classList.add("block-edge-top");
          if (!sameBlock(x + 1, y)) cell.classList.add("block-edge-right");
          if (!sameBlock(x, y + 1)) cell.classList.add("block-edge-bottom");
          if (!sameBlock(x - 1, y)) cell.classList.add("block-edge-left");
          if (step && block === step.blockId) {
            cell.classList.add("sm-moving");
          }
        }

        if (destSet.has(`${x},${y}`)) {
          cell.classList.add("sm-dest");
          if (!destSet.has(`${x},${y - 1}`))
            cell.classList.add("sm-dest-edge-top");
          if (!destSet.has(`${x + 1},${y}`))
            cell.classList.add("sm-dest-edge-right");
          if (!destSet.has(`${x},${y + 1}`))
            cell.classList.add("sm-dest-edge-bottom");
          if (!destSet.has(`${x - 1},${y}`))
            cell.classList.add("sm-dest-edge-left");
        }

        if (goalSet.has(`${x},${y}`)) {
          cell.classList.add("sm-goal");
          if (!goalSet.has(`${x},${y - 1}`))
            cell.classList.add("sm-goal-edge-top");
          if (!goalSet.has(`${x + 1},${y}`))
            cell.classList.add("sm-goal-edge-right");
          if (!goalSet.has(`${x},${y + 1}`))
            cell.classList.add("sm-goal-edge-bottom");
          if (!goalSet.has(`${x - 1},${y}`))
            cell.classList.add("sm-goal-edge-left");
        }

        this.grid.appendChild(cell);
      }
    }

    this.renderControls(step);
  }

  private renderControls(step: Step | null) {
    if (step) {
      this.stepCounter.textContent = `Step ${this.viewIndex + 1} of ${this.steps.length}`;
      const cells = step.distance === 1 ? "1 cell" : `${step.distance} cells`;
      this.stepText.innerHTML =
        `Move the <strong class="sm-moving-label">highlighted block</strong> ` +
        `<strong>${DIR_LABEL[step.direction]}</strong> by ${cells}, ` +
        `into the <strong class="sm-dest-label">green zone</strong>.`;
    } else {
      this.stepCounter.textContent = `Solved in ${this.steps.length} move${this.steps.length === 1 ? "" : "s"}`;
      this.stepText.innerHTML =
        "All moves done — the goal block is in the goal zone. 🎉";
    }

    this.prevBtn.toggleAttribute("disabled", this.viewIndex === 0);
    this.nextBtn.toggleAttribute(
      "disabled",
      this.viewIndex >= this.steps.length,
    );
  }
}
