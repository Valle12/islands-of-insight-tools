import type { Position } from "../../util/types";
import { Direction } from "./directions";
import { gridMaxWidthPx } from "./layout";
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

const SVG_NS = "http://www.w3.org/2000/svg";

/** One leg of a step — a straight slide of `distance` cells. */
interface PathSegment {
  direction: Direction;
  distance: number;
}

/**
 * One player step: a maximal run of consecutive turns of a single block. The
 * block may change direction mid-step, so the step carries the whole route as
 * an ordered list of segments — the player performs it as one path drag.
 */
interface Step {
  blockId: number;
  segments: PathSegment[];
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
 * Step-by-step viewer for a shifting-mosaic solution. All consecutive turns of
 * the same block — across any number of direction changes — are grouped into a
 * single step. Each step highlights the block to move, draws the full drag
 * path it travels along, and shows the destination zone, so the player makes
 * one trip per step instead of one per direction.
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

  // The path overlay is measured in pixels, so it must be redrawn on resize.
  private readonly onResize = () => this.drawPath();

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

    window.addEventListener("resize", this.onResize);
    this.render();
  }

  /** Detaches listeners — call before discarding the view. */
  dispose() {
    window.removeEventListener("resize", this.onResize);
    this.prevBtn.onclick = null;
    this.nextBtn.onclick = null;
  }

  /**
   * Groups consecutive turns of the same block into one step, and within each
   * step folds consecutive same-direction turns into one path segment.
   */
  private static buildSteps(turns: Turn[]): Step[] {
    const steps: Step[] = [];
    for (const turn of turns) {
      let step = steps[steps.length - 1];
      if (!step || step.blockId !== turn.blockId) {
        step = { blockId: turn.blockId, segments: [] };
        steps.push(step);
      }
      const seg = step.segments[step.segments.length - 1];
      if (seg && seg.direction === turn.direction) {
        seg.distance++;
      } else {
        step.segments.push({ direction: turn.direction, distance: 1 });
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
      for (const seg of step.segments) {
        moving.x += DX[seg.direction] * seg.distance;
        moving.y += DY[seg.direction] * seg.distance;
      }
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

  /** Anchor positions at each corner of a step's path: start → … → end. */
  private stepAnchorWaypoints(step: Step, start: Position): Position[] {
    const points: Position[] = [{ x: start.x, y: start.y }];
    let cur = { x: start.x, y: start.y };
    for (const seg of step.segments) {
      cur = {
        x: cur.x + DX[seg.direction] * seg.distance,
        y: cur.y + DY[seg.direction] * seg.distance,
      };
      points.push({ x: cur.x, y: cur.y });
    }
    return points;
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
    this.grid.style.maxWidth = `${gridMaxWidthPx(gridWidth)}px`;
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

    this.drawPath();
    this.renderControls(step);
  }

  /** Draws the current step's drag path as an SVG overlay on the grid. */
  private drawPath() {
    this.grid.querySelector(".sm-path-overlay")?.remove();
    if (this.viewIndex >= this.steps.length) return;

    const step = this.steps[this.viewIndex]!;
    const startAnchor = this.snapshots[this.viewIndex]![step.blockId]!;
    const anchorPoints = this.stepAnchorWaypoints(step, startAnchor);

    const { gridWidth, gridHeight } = this.data;
    const cells = this.grid.querySelectorAll<HTMLElement>(".grid-cell");
    if (cells.length < gridWidth * gridHeight) return;

    // Route the line through the block's footprint centroid. The grid pitch
    // is NOT uniform — goal and destination cells carry thicker borders, so
    // their rows are taller — so map each (fractional) cell coordinate to
    // pixels by interpolating measured cell centres, never a constant pitch.
    const shape = this.data.shapes[step.blockId]!;
    let cox = 0;
    let coy = 0;
    for (const c of shape) {
      cox += c.x;
      coy += c.y;
    }
    cox /= shape.length;
    coy /= shape.length;

    const colCenterX = (ix: number) => {
      const el = cells[ix]!; // row 0, column ix
      return el.offsetLeft + el.offsetWidth / 2;
    };
    const rowCenterY = (iy: number) => {
      const el = cells[iy * gridWidth]!; // column 0, row iy
      return el.offsetTop + el.offsetHeight / 2;
    };
    const toPixel = (fx: number, fy: number) => {
      const ix0 = Math.floor(fx);
      const ix1 = Math.min(ix0 + 1, gridWidth - 1);
      const iy0 = Math.floor(fy);
      const iy1 = Math.min(iy0 + 1, gridHeight - 1);
      const x0 = colCenterX(ix0);
      const y0 = rowCenterY(iy0);
      return {
        x: x0 + (colCenterX(ix1) - x0) * (fx - ix0),
        y: y0 + (rowCenterY(iy1) - y0) * (fy - iy0),
      };
    };

    const pts = anchorPoints.map(p => toPixel(p.x + cox, p.y + coy));
    const pointsAttr = pts
      .map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`)
      .join(" ");

    const w = this.grid.offsetWidth;
    const h = this.grid.offsetHeight;
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "sm-path-overlay");
    svg.setAttribute("width", String(w));
    svg.setAttribute("height", String(h));
    svg.setAttribute("viewBox", `0 0 ${w} ${h}`);

    const defs = document.createElementNS(SVG_NS, "defs");
    const marker = document.createElementNS(SVG_NS, "marker");
    marker.setAttribute("id", "sm-path-arrow");
    marker.setAttribute("viewBox", "0 0 10 10");
    marker.setAttribute("refX", "8");
    marker.setAttribute("refY", "5");
    marker.setAttribute("markerWidth", "9");
    marker.setAttribute("markerHeight", "9");
    marker.setAttribute("markerUnits", "userSpaceOnUse");
    marker.setAttribute("orient", "auto");
    const head = document.createElementNS(SVG_NS, "path");
    head.setAttribute("d", "M1,1 L9,5 L1,9 Z");
    head.setAttribute("class", "sm-path-arrowhead");
    marker.appendChild(head);
    defs.appendChild(marker);
    svg.appendChild(defs);

    const casing = document.createElementNS(SVG_NS, "polyline");
    casing.setAttribute("points", pointsAttr);
    casing.setAttribute("class", "sm-path-casing");
    svg.appendChild(casing);

    const line = document.createElementNS(SVG_NS, "polyline");
    line.setAttribute("points", pointsAttr);
    line.setAttribute("class", "sm-path-line");
    line.setAttribute("marker-end", "url(#sm-path-arrow)");
    svg.appendChild(line);

    const start = document.createElementNS(SVG_NS, "circle");
    start.setAttribute("cx", pts[0]!.x.toFixed(1));
    start.setAttribute("cy", pts[0]!.y.toFixed(1));
    start.setAttribute("r", "5.5");
    start.setAttribute("class", "sm-path-start");
    svg.appendChild(start);

    this.grid.appendChild(svg);
  }

  private renderControls(step: Step | null) {
    if (step) {
      this.stepCounter.textContent = `Step ${this.viewIndex + 1} of ${this.steps.length}`;
      if (step.segments.length === 1) {
        const seg = step.segments[0]!;
        this.stepText.innerHTML =
          `Move the <strong class="sm-moving-label">highlighted block</strong> ` +
          `<strong>${DIR_LABEL[seg.direction]} ${seg.distance}</strong> into the ` +
          `<strong class="sm-dest-label">green zone</strong>.`;
      } else {
        const path = step.segments
          .map(seg => `${DIR_LABEL[seg.direction]} ${seg.distance}`)
          .join(" → ");
        this.stepText.innerHTML =
          `Drag the <strong class="sm-moving-label">highlighted block</strong> ` +
          `along the path — <strong>${path}</strong> — into the ` +
          `<strong class="sm-dest-label">green zone</strong>.`;
      }
    } else {
      const n = this.steps.length;
      this.stepCounter.textContent = `Solved in ${n} step${n === 1 ? "" : "s"}`;
      this.stepText.innerHTML =
        "All steps done — the goal block is in the goal zone. 🎉";
    }

    this.prevBtn.toggleAttribute("disabled", this.viewIndex === 0);
    this.nextBtn.toggleAttribute(
      "disabled",
      this.viewIndex >= this.steps.length,
    );
  }
}
