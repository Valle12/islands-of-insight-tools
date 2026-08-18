import type { LogicGridTest } from "../../util/types";
import { SolutionView } from "./solutionView";
import {
  solveLogicGrid,
  type LogicGridSolveResult,
  type SolveHandle,
} from "./solver";
import { UNDERCLUED } from "./verify";

/**
 * Solving, and the answer that replaces the editor while it is up.
 *
 * Split out of `logicGridSolver.ts` because it shares NO state with the rest of
 * the editor — the search in flight, the generation counter that drops a stale
 * answer and the mounted `SolutionView` are read nowhere else, and the eight
 * solution elements are touched by nothing else — so exactly one thing crosses
 * in each direction: the board to solve, and the redraw the editor needs when
 * the board comes back.
 *
 * What is deliberately NOT here: `currentConfig`, which reads the board and the
 * rule set and is the editor's own. This asks for it at the moment Solve is
 * pressed rather than holding a copy that could go stale.
 *
 * No `dispose()`, unlike `Board`: its listeners sit on `#grid`, which outlives
 * it, while these sit on elements this controller lives exactly as long as.
 */

export interface SolveControllerOptions {
  /** The board as the solver takes it, read fresh at each press of Solve. */
  configOf: () => LogicGridTest;
  /** Redraws the editor when the answer is dismissed and the board returns. */
  onReturnToEditor: () => void;
}

export class SolveController {
  private readonly configOf: () => LogicGridTest;
  private readonly onReturnToEditor: () => void;

  /** An `<output>`, so only what any element has is used on it. */
  private readonly solutionPanel = document.getElementById(
    "solution-panel",
  ) as HTMLElement;
  private readonly solutionStatus = document.getElementById(
    "solution-status",
  ) as HTMLSpanElement;
  private readonly solutionMessage = document.getElementById(
    "solution-message",
  ) as HTMLDivElement;
  private readonly solutionSpinner = document.getElementById(
    "solution-spinner",
  ) as HTMLDivElement;
  private readonly solutionProgressText = document.getElementById(
    "solution-progress-text",
  ) as HTMLSpanElement;
  private readonly editorSection = document.getElementById(
    "editor-section",
  ) as HTMLDivElement;
  private readonly solutionViewEl = document.getElementById(
    "solution-view",
  ) as HTMLDivElement;
  private readonly solveButton = document.getElementById(
    "solve-puzzle",
  ) as HTMLButtonElement;

  private solutionView: SolutionView | null = null;
  /** The search in flight, or null. */
  private search: SolveHandle | null = null;
  /**
   * Which solve the page is waiting for. A result from an earlier one is
   * dropped rather than drawn: the board it answers no longer exists.
   */
  private solveGeneration = 0;

  constructor(options: SolveControllerOptions) {
    this.configOf = options.configOf;
    this.onReturnToEditor = options.onReturnToEditor;

    this.solveButton.addEventListener("click", () => this.solve());
    document
      .getElementById("solution-cancel")
      ?.addEventListener("click", () => this.cancelSearch());
    document
      .getElementById("solution-exit")
      ?.addEventListener("click", () => this.exitSolutionView());
  }

  /**
   * Drops whatever the solver last said. Called on every board edit, so it has
   * to stay cheap — a drag fires it once per cell — which is why the two
   * branches below are guarded rather than run unconditionally.
   */
  hide() {
    if (this.search) this.cancelSearch();
    this.solutionPanel.classList.add("hidden");
    if (this.solutionView) this.exitSolutionView();
  }

  private solve() {
    if (this.search) return;
    const config = this.configOf();
    const generation = ++this.solveGeneration;

    this.solutionPanel.classList.remove("hidden");
    this.solutionSpinner.classList.remove("hidden");
    this.solutionStatus.textContent = "Working";
    this.solutionMessage.textContent = "";
    this.solutionProgressText.textContent = "Deducing…";
    this.solveButton.disabled = true;

    // `solveLogicGrid` can answer before it returns — it defers a synchronous
    // failure only as far as its own last statement, which still runs `onDone`
    // inside the call. `finishSolve` then nulls `this.search`, and assigning
    // the returned handle straight to the field would put a dead one back,
    // after which `if (this.search) return;` above kills the button for good.
    let settled = false;
    const handle = solveLogicGrid(config, {
      onProgress: (nodes, decided) => {
        if (generation !== this.solveGeneration) return;
        // The step count is the part that keeps moving. `decided` comes from
        // the deduction pass, which finishes in milliseconds and then never
        // changes again — on a board that needs the long search it would sit
        // frozen at its number for the whole minute, which reads as a hang.
        const steps = `${nodes.toLocaleString()} steps`;
        this.solutionProgressText.textContent =
          decided > 0
            ? `Deducing… ${decided} cells settled, ${steps}`
            : `Deducing… ${steps}`;
      },
      onDone: result => {
        if (generation !== this.solveGeneration) return;
        settled = true;
        this.finishSolve(config, result);
      },
    });
    this.search = settled ? null : handle;
  }

  private cancelSearch() {
    this.search?.cancel();
    this.search = null;
    this.solveGeneration++;
    this.solutionSpinner.classList.add("hidden");
    this.solveButton.disabled = false;
  }

  private finishSolve(config: LogicGridTest, result: LogicGridSolveResult) {
    this.search = null;
    this.solutionSpinner.classList.add("hidden");
    this.solveButton.disabled = false;

    if (result.status === "failed") {
      // Every arm died. The raw text is whatever the module threw — useful in a
      // bug report and meaningless to a player — so it goes after a sentence
      // that says what actually happened and what to do about it.
      this.solutionStatus.textContent = "Failed";
      this.solutionMessage.textContent =
        "The solver stopped before it could answer. Reloading the page and " +
        `trying again usually clears it. (${result.error})`;
      return;
    }
    if (result.status === "unsolvable") {
      this.solutionStatus.textContent = "No solution";
      this.solutionMessage.textContent = result.reason
        ? `This board cannot be completed: ${result.reason.toLowerCase()}.`
        : "No coloring of this board satisfies every rule and clue. Every " +
          "puzzle in the game is solvable, so something on the board is not " +
          "what the game showed.";
      return;
    }
    if (result.status === "budget") {
      // Not the same claim as "no solution": the search stopped looking, it did
      // not rule anything out. The nudge about the board is still worth making
      // — every puzzle the game ships can be finished, so a board that runs the
      // clock out is far more often mis-entered than genuinely hard.
      this.solutionStatus.textContent = "Gave up";
      this.solutionMessage.textContent =
        (result.decided > 0
          ? `The time limit ran out. ${result.decided} cells were settled ` +
            "before it did, but the rest are still open. "
          : "The time limit ran out before anything could be settled. ") +
        "Every puzzle in the game can be finished, so it is worth checking " +
        "the board against the one on screen — a missing gap or clue is the " +
        "usual reason.";
      return;
    }
    this.enterSolutionView(config, result);
  }

  private enterSolutionView(
    config: LogicGridTest,
    result: Extract<LogicGridSolveResult, { status: "solved" | "deduced" }>,
  ) {
    this.solutionPanel.classList.add("hidden");
    this.editorSection.classList.add("hidden");
    this.solutionViewEl.classList.remove("hidden");
    this.solutionView?.dispose();
    this.solutionView = new SolutionView({
      config,
      cells: result.cells,
      decided: result.decided,
      playable: result.playable,
      proven: result.status === "deduced" ? result.proven : true,
      underclued: config.rules.includes(UNDERCLUED),
    });
  }

  private exitSolutionView() {
    this.solutionView?.dispose();
    this.solutionView = null;
    this.solutionViewEl.classList.add("hidden");
    this.editorSection.classList.remove("hidden");
    this.solutionPanel.classList.add("hidden");
    this.onReturnToEditor();
  }
}
