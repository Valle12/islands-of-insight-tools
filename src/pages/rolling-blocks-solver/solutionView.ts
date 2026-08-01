import { markBlockEdges, markZoneEdges } from "../../util/gridOutline";
import { extractBit, positionToIndex } from "../../util/utilMethods";
import type { Block } from "./block";
import { Direction } from "./directions";
import { isSolved, replayTurns, type Puzzle, type ReplayStep } from "./replay";
import type { Turn } from "./turn";

const DIR_LABEL: Record<Direction, string> = {
  [Direction.UP]: "up",
  [Direction.RIGHT]: "right",
  [Direction.DOWN]: "down",
  [Direction.LEFT]: "left",
};

/** Everything one grid cell needs to know about the step being shown. */
interface CellZones {
  /** occupant[x][y] = block id, or 0 where no block stands. */
  occupant: number[][];
  satisfied: bigint;
  /** The turn being previewed, or null on the end card. */
  turn: Turn | null;
  /** Where the rolling block lands. */
  destSet: Set<string>;
}

/**
 * Step-by-step viewer for a rolling-blocks solution.
 *
 * Unlike the shifting-mosaic view it does NOT group consecutive turns of one
 * block: a rolling block tips over its own edge, so every single roll changes
 * the footprint and has to be shown on its own. The board drawn for step `i`
 * is the board the player is looking at *before* they make roll `i`, with the
 * block to tip highlighted and the cells it will land on outlined.
 */
export class SolutionView {
  private readonly puzzle: Puzzle;
  private readonly turns: Turn[];
  private readonly steps: ReplayStep[];
  /** How many turns can actually be played; the rest are shown greyed out. */
  private readonly playable: number;
  private readonly solvedAtEnd: boolean;
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
  private readonly moveList = document.getElementById(
    "solution-moves",
  ) as HTMLOListElement;

  private readonly controller = new AbortController();

  constructor(puzzle: Puzzle, turns: Turn[]) {
    this.puzzle = puzzle;
    this.turns = turns;

    const { steps, legalUpTo } = replayTurns(puzzle, turns);
    this.steps = steps;
    this.playable = legalUpTo;
    const last = steps[steps.length - 1]!;
    this.solvedAtEnd = isSolved(puzzle, last.blocks, last.satisfied);

    const { signal } = this.controller;
    this.prevBtn.addEventListener("click", () => this.step(-1), { signal });
    this.nextBtn.addEventListener("click", () => this.step(1), { signal });
    this.moveList.addEventListener("click", e => this.onListClick(e), {
      signal,
    });
    document.addEventListener("keydown", e => this.onKeyDown(e), { signal });

    this.renderMoveList();
    this.render();
  }

  /** Detaches listeners — call before discarding the view. */
  dispose() {
    this.controller.abort();
  }

  private step(delta: number) {
    this.goTo(this.viewIndex + delta);
  }

  private goTo(index: number) {
    const clamped = Math.min(Math.max(index, 0), this.playable);
    if (clamped === this.viewIndex) return;
    this.viewIndex = clamped;
    this.render();
  }

  private onListClick(event: Event) {
    const item = (event.target as HTMLElement).closest<HTMLElement>("li");
    if (!item?.dataset.step) return;
    this.goTo(Number(item.dataset.step));
  }

  private onKeyDown(event: KeyboardEvent) {
    // Only while nothing is being typed into — the editor is hidden behind
    // this view, but the page still carries its text fields.
    const tag = (event.target as HTMLElement | null)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    if (event.key === "ArrowRight") this.step(1);
    else if (event.key === "ArrowLeft") this.step(-1);
    else return;
    event.preventDefault();
  }

  /** occupant[x][y] = block id, or 0 where no block stands. */
  private buildOccupancy(blocks: Block[]): number[][] {
    const { gridWidth, gridHeight } = this.puzzle;
    const occupant: number[][] = Array.from({ length: gridWidth }, () =>
      Array.from({ length: gridHeight }, () => 0),
    );
    for (const block of blocks) {
      for (let x = block.x; x < block.x + block.width; x++) {
        for (let y = block.y; y < block.y + block.depth; y++) {
          if (x >= 0 && x < gridWidth && y >= 0 && y < gridHeight) {
            occupant[x]![y] = block.id;
          }
        }
      }
    }
    return occupant;
  }

  private static footprintKeys(block: Block): Set<string> {
    const keys = new Set<string>();
    for (let x = block.x; x < block.x + block.width; x++) {
      for (let y = block.y; y < block.y + block.depth; y++) {
        keys.add(`${x},${y}`);
      }
    }
    return keys;
  }

  private buildCell(x: number, y: number, zones: CellZones): HTMLDivElement {
    const { occupant, satisfied, turn, destSet } = zones;
    const cell = document.createElement("div");
    cell.className = "grid-cell";
    cell.dataset.x = String(x);
    cell.dataset.y = String(y);

    const block = occupant[x]![y]!;
    if (block !== 0) {
      cell.dataset.kind = "block";
      cell.dataset.blockId = String(block);
      markBlockEdges(cell, x, y, block, occupant);
      if (turn?.blockId === block) cell.classList.add("rb-moving");
    } else {
      const tile = this.puzzle.cells[x]?.[y] ?? "regular";
      cell.dataset.kind = tile;
      // A star already stepped on is spent — and becomes a wall. Dimming it is
      // what tells the player which ones they still owe.
      if (
        tile === "mustTouch" &&
        extractBit(satisfied, positionToIndex(x, y, this.puzzle.gridWidth)) ===
          1n
      ) {
        cell.dataset.touched = "true";
      }
    }

    markZoneEdges(cell, x, y, destSet, "rb-dest");
    return cell;
  }

  private render() {
    const { gridWidth, gridHeight } = this.puzzle;
    const atEnd = this.viewIndex >= this.playable;
    const state = this.steps[this.viewIndex]!;
    const turn = atEnd ? null : this.turns[this.viewIndex]!;

    const landing =
      turn === null
        ? null
        : this.steps[this.viewIndex + 1]!.blocks.find(
            b => b.id === turn.blockId,
          )!;

    const zones: CellZones = {
      occupant: this.buildOccupancy(state.blocks),
      satisfied: state.satisfied,
      turn,
      destSet: landing ? SolutionView.footprintKeys(landing) : new Set(),
    };

    this.grid.style.gridTemplateColumns = `repeat(${gridWidth}, minmax(0, 1fr))`;
    const fragment = document.createDocumentFragment();
    for (let y = 0; y < gridHeight; y++) {
      for (let x = 0; x < gridWidth; x++) {
        fragment.appendChild(this.buildCell(x, y, zones));
      }
    }
    this.grid.replaceChildren(fragment);

    this.renderControls(turn);
    this.highlightMove();
  }

  private renderControls(turn: Turn | null) {
    if (turn) {
      this.stepCounter.textContent = `Step ${this.viewIndex + 1} of ${this.playable}`;
      this.stepText.innerHTML =
        `Roll <strong class="rb-moving-label">Block ${turn.blockId}</strong> ` +
        `<strong>${DIR_LABEL[turn.direction]}</strong>, onto the ` +
        `<strong class="rb-dest-label">outlined cells</strong>.`;
    } else {
      this.stepCounter.textContent = this.endTitle();
      this.stepText.innerHTML = this.solvedAtEnd
        ? "All rolls done — the board is solved. 🎉"
        : "The remaining rolls could not be played on this board.";
    }

    this.prevBtn.toggleAttribute("disabled", this.viewIndex === 0);
    this.nextBtn.toggleAttribute("disabled", this.viewIndex >= this.playable);
  }

  private endTitle(): string {
    const n = this.playable;
    const plural = n === 1 ? "" : "s";
    return this.solvedAtEnd
      ? `Solved in ${n} move${plural}`
      : `Stopped after ${n} move${plural}`;
  }

  private renderMoveList() {
    this.moveList.innerHTML = this.turns
      .map((turn, index) => {
        const unplayable =
          index >= this.playable ? ' data-unplayable="true"' : "";
        return (
          `<li data-step="${index}"${unplayable}>` +
          `<span class="move-index">${index + 1}</span>` +
          `<span class="move-block">Block ${turn.blockId}</span> ` +
          `<span class="move-direction">${DIR_LABEL[turn.direction]}</span>` +
          `</li>`
        );
      })
      .join("");
  }

  /** Marks the row for the current step and scrolls it into view. */
  private highlightMove() {
    const items = this.moveList.querySelectorAll<HTMLLIElement>("li");
    items.forEach((item, index) => {
      const current = index === this.viewIndex;
      item.classList.toggle("current", current);
      if (current) item.setAttribute("aria-current", "step");
      else item.removeAttribute("aria-current");
      item.classList.toggle("done", index < this.viewIndex);
    });
    items[this.viewIndex]?.scrollIntoView({ block: "nearest" });
  }
}
