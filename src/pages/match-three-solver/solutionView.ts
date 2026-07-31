import { dressCell } from "./cellView";
import {
  applyMove,
  cellAt,
  type MatchThreeBoard,
  type Move,
} from "./rules";

export interface SolutionViewData {
  readonly board: MatchThreeBoard;
  readonly moves: readonly Move[];
}

/** A move, together with the board it is played on and what it takes out. */
interface Step {
  readonly board: MatchThreeBoard;
  readonly move: Move;
  readonly cleared: number;
  readonly cascades: number;
}

function positionText(position: { x: number; y: number }): string {
  return `Column ${position.x + 1}, Row ${position.y + 1}`;
}

/**
 * Walks a solution one swap at a time. Each step draws the board as it stands
 * before the move and marks the two blocks to exchange — and nothing else.
 * Outlining what the move clears as well was tried and dropped: on a move that
 * takes a dozen blocks it left the board unreadable, and the step text gives
 * the count anyway.
 */
export class SolutionView {
  private readonly steps: Step[];
  /** The board once every step has been played — always empty of blocks. */
  private readonly finalBoard: MatchThreeBoard;
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
    this.steps = [];
    let current = data.board;
    for (const move of data.moves) {
      const outcome = applyMove(current, move);
      if (!outcome) break;
      // `board` is the state the move is played *on*, not what it produces.
      this.steps.push({
        board: current,
        move,
        cleared: outcome.cleared,
        cascades: outcome.cascades,
      });
      current = outcome.board;
    }
    this.finalBoard = current;

    this.prevBtn.onclick = () => this.step(-1);
    this.nextBtn.onclick = () => this.step(1);

    this.render();
  }

  /** Detaches listeners — call before discarding the view. */
  dispose() {
    this.prevBtn.onclick = null;
    this.nextBtn.onclick = null;
  }

  private step(delta: number) {
    const next = this.viewIndex + delta;
    if (next < 0 || next > this.steps.length) return;
    this.viewIndex = next;
    this.render();
  }

  private buildCell(
    board: MatchThreeBoard,
    x: number,
    y: number,
    step: Step | null,
  ): HTMLDivElement {
    const cell = document.createElement("div");
    cell.className = "grid-cell";
    cell.dataset.x = String(x);
    cell.dataset.y = String(y);
    dressCell(cell, cellAt(board, x, y), x, y);

    if (!step) return cell;

    const { a, b } = step.move;
    if (a.x === x && a.y === y) cell.dataset.swap = "a";
    else if (b.x === x && b.y === y) cell.dataset.swap = "b";
    if (cell.dataset.swap) {
      cell.dataset.swapAxis = a.y === b.y ? "horizontal" : "vertical";
    }

    return cell;
  }

  render() {
    const step = this.steps[this.viewIndex] ?? null;
    const board = step?.board ?? this.finalBoard;

    this.grid.style.gridTemplateColumns = `repeat(${board.width}, minmax(0, 1fr))`;

    const fragment = document.createDocumentFragment();
    for (let y = 0; y < board.height; y++) {
      for (let x = 0; x < board.width; x++) {
        fragment.appendChild(this.buildCell(board, x, y, step));
      }
    }
    this.grid.replaceChildren(fragment);

    this.renderControls(step);
  }

  /**
   * Positions, not names. The tiles are the game's own artwork and several are
   * near-impossible to name usefully — "Purple 2" and "Nude" told the player
   * nothing the ringed cells were not already saying, and every new tile made
   * the naming worse.
   */
  private describeSwap(step: Step): string {
    return (
      `Swap the block at <strong class="mt-swap-label">${positionText(step.move.a)}</strong> ` +
      `with the one at <strong class="mt-swap-label">${positionText(step.move.b)}</strong>.`
    );
  }

  private renderControls(step: Step | null) {
    if (step) {
      this.stepCounter.textContent = `Step ${this.viewIndex + 1} of ${this.steps.length}`;
      const blocks = `${step.cleared} block${step.cleared === 1 ? "" : "s"}`;
      const outcome =
        step.cascades > 1
          ? `That clears ${blocks} — what falls in keeps matching.`
          : `That clears ${blocks}.`;
      this.stepText.innerHTML = `${this.describeSwap(step)} ${outcome}`;
    } else {
      const total = this.steps.length;
      this.stepCounter.textContent = `Solved in ${total} move${total === 1 ? "" : "s"}`;
      this.stepText.innerHTML = "All moves done — the board is clear. 🎉";
    }

    this.prevBtn.toggleAttribute("disabled", this.viewIndex === 0);
    this.nextBtn.toggleAttribute(
      "disabled",
      this.viewIndex >= this.steps.length,
    );
  }
}
