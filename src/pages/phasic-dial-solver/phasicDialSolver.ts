import blueDial from "./../../../images/blue-dial.png";
import cyanDial from "./../../../images/cyan-dial.png";
import greenDial from "./../../../images/green-dial.png";
import purpleDial from "./../../../images/purple-dial.png";
import redDial from "./../../../images/red-dial.png";
import yellowDial from "./../../../images/yellow-dial.png";
import { downloadJson, readJsonFile } from "../../util/configFile";
import { warningBanner, wireConfigIo } from "../../util/editorShell";
import type { PhasicDialTest } from "../../util/types";
import { Button } from "./button";
import { ButtonsView, type DialDescriptor } from "./buttonsView";
import { MAX_DIALS, MIN_DIALS, validateConfig } from "./config";
import { DialView } from "./dialView";
import { balancedColumns, columnCapacity } from "./layout";
import { TurnSolver } from "./turnSolver";

/** A dial a new puzzle starts with: a square, aimed at the hub. */
const DEFAULT_MAX = 3;

/**
 * The order the game unlocks dials in; purple is the sixth and last. A dial's
 * colour is therefore fixed by its position, which is why the page can only
 * ever drop the LAST one.
 */
const DIALS: readonly DialDescriptor[] = [
  { color: "blue", label: "Blue", image: blueDial },
  { color: "red", label: "Red", image: redDial },
  { color: "green", label: "Green", image: greenDial },
  { color: "yellow", label: "Yellow", image: yellowDial },
  { color: "cyan", label: "Cyan", image: cyanDial },
  { color: "purple", label: "Purple", image: purpleDial },
];

export class PhasicDialSolver {
  // The puzzle itself. `maxValues[i]` is the dial's positions minus one — the
  // config's own encoding — and `buttons[b][i]` is how far button b turns dial
  // i. The page renders from these; nothing is read back out of the DOM.
  private maxValues: number[] = [DEFAULT_MAX, DEFAULT_MAX];
  private values: number[] = [0, 0];
  private buttons: number[][] = [[0, 0]];

  // The last solution and the inputs it was computed from. A downloaded config
  // only carries a `result` while it still describes the puzzle that produced
  // it — solving on download instead is not an option, because TurnSolver
  // brute-forces a cartesian product and must not run behind a button that
  // looks free.
  private lastResult: number[] | null = null;
  private lastResultKey: string | null = null;
  private readonly showWarning = warningBanner(
    document.getElementById("warning-banner")!,
  );
  // Bumped whenever a search starts or the board changes, so an answer that
  // arrives after either is discarded.
  private solveGeneration = 0;

  private dialViews: DialView[] = [];
  private readonly buttonsView: ButtonsView;

  constructor() {
    this.buttonsView = new ButtonsView({
      host: document.getElementById("buttons-list")!,
      onTurnsChange: (button, dial, turns) => {
        this.buttons[button]![dial] = turns;
        this.invalidateResult();
      },
      onRemove: index => this.removeButton(index),
    });

    document.getElementById("add-dial")!.addEventListener("click", () => {
      this.addDial();
    });

    document.getElementById("remove-dial")!.addEventListener("click", () => {
      this.removeDial();
    });

    document.getElementById("add-button")!.addEventListener("click", () => {
      this.addButton();
    });

    document.getElementById("calculate")!.addEventListener("click", () => {
      void this.calculate();
    });

    document.getElementById("reset")!.addEventListener("click", () => {
      this.reset();
    });

    document.getElementById("help")!.addEventListener("click", () => {
      (document.getElementById("help-dialog") as HTMLDialogElement).show();
    });

    document.getElementById("help-close")!.addEventListener("click", () => {
      (document.getElementById("help-dialog") as HTMLDialogElement).close();
    });

    wireConfigIo({
      fileInput: document.getElementById(
        "config-file-input",
      ) as HTMLInputElement,
      dropOverlay: document.getElementById("drop-overlay")!,
      onFile: file => void this.loadConfigFromFile(file),
      onDownload: () => this.downloadCurrentConfig(),
    });

    // How many cards fit on a row is the only thing balancing depends on that
    // the page cannot know until it is measured.
    window.addEventListener("resize", () => this.layoutDials());

    this.render();
  }

  private get dialCount(): number {
    return this.maxValues.length;
  }

  private render() {
    this.renderDials();
    this.buttonsView.render(DIALS.slice(0, this.dialCount), this.buttons);
    this.buttonsView.showPresses(this.lastResult);
  }

  private renderDials() {
    for (const view of this.dialViews) view.dispose();
    this.dialViews = [];

    const list = document.getElementById("dials-list")!;
    list.innerHTML = "";
    for (let i = 0; i < this.dialCount; i++) {
      const view = new DialView({
        ...DIALS[i]!,
        max: this.maxValues[i]!,
        value: this.values[i]!,
        onValueChange: value => {
          this.values[i] = value;
          this.invalidateResult();
        },
        onMaxChange: (max, value) => {
          this.maxValues[i] = max;
          this.values[i] = value;
          this.invalidateResult();
        },
      });
      this.dialViews.push(view);
      list.appendChild(view.root);
    }

    this.layoutDials();

    document
      .getElementById("add-dial")!
      .toggleAttribute("disabled", this.dialCount >= MAX_DIALS);
    document
      .getElementById("remove-dial")!
      .toggleAttribute("disabled", this.dialCount <= MIN_DIALS);
  }

  /**
   * Splits the dial cards over even rows. Six dials in a list five cards wide
   * wrap as 5 + 1 under `flex-wrap`; this makes them 3 + 3.
   *
   * The card width and the gap are MEASURED rather than declared here. A card
   * is 148px of content plus its padding and border, and a constant would go
   * on claiming 148px the moment the stylesheet changed.
   */
  private layoutDials() {
    const list = document.getElementById("dials-list")!;
    const card = list.firstElementChild;
    const cardWidth = card ? card.getBoundingClientRect().width : 0;
    const gap = Number.parseFloat(getComputedStyle(list).columnGap) || 0;
    const capacity = columnCapacity(list.clientWidth, cardWidth, gap);
    list.style.setProperty(
      "--dial-cols",
      String(balancedColumns(this.dialCount, capacity)),
    );
  }

  private addDial() {
    if (this.dialCount >= MAX_DIALS) return;
    this.maxValues.push(DEFAULT_MAX);
    this.values.push(0);
    for (const turns of this.buttons) turns.push(0);
    this.invalidateResult();
    this.render();
  }

  /** Drops the last dial — colours are positional, so no other one can go. */
  private removeDial() {
    if (this.dialCount <= MIN_DIALS) return;
    this.maxValues.pop();
    this.values.pop();
    for (const turns of this.buttons) turns.pop();
    this.invalidateResult();
    this.render();
  }

  private addButton() {
    this.buttons.push(Array.from({ length: this.dialCount }, () => 0));
    this.invalidateResult();
    this.render();
  }

  private removeButton(index: number) {
    if (this.buttons.length <= 1) return;
    this.buttons.splice(index, 1);
    this.invalidateResult();
    this.render();
  }

  private reset() {
    this.maxValues = [DEFAULT_MAX, DEFAULT_MAX];
    this.values = [0, 0];
    this.buttons = [[0, 0]];
    this.invalidateResult();
    this.setSolving(false);
    this.render();
  }

  /** Drops a solution that no longer describes what is on the page. */
  private invalidateResult() {
    this.lastResult = null;
    this.lastResultKey = null;
    this.solveGeneration++;
    this.buttonsView.showPresses(null);
    document.getElementById("result")!.hidden = true;
  }

  /** The puzzle currently entered, in the config/solver shape. */
  private readConfig(): PhasicDialTest {
    return {
      maxValues: [...this.maxValues],
      initialValues: [...this.values],
      buttons: this.buttons.map(turns => new Button([...turns])),
    };
  }

  /** Identity of a puzzle's inputs; tells a stale solution from a live one. */
  private configKey(config: PhasicDialTest): string {
    return JSON.stringify([
      config.maxValues,
      config.initialValues,
      config.buttons.map(button => button.getTurns()),
    ]);
  }

  private downloadCurrentConfig() {
    const config = this.readConfig();
    if (
      this.lastResult !== null &&
      this.configKey(config) === this.lastResultKey
    ) {
      config.result = this.lastResult;
    }
    downloadJson(config, "phasicDialTest.json");
  }

  /** Reads a dropped/picked file, validates it, and populates the page. */
  private async loadConfigFromFile(file: File) {
    const read = await readJsonFile(file);
    if (!read.ok) {
      this.showWarning(read.error);
      return;
    }

    const result = validateConfig(read.data);
    if (!result.ok) {
      this.showWarning(`Invalid config: ${result.error}`);
      return;
    }

    this.applyLoadedConfig(result.config);
  }

  /** Applies a validated config to the dials and the button cards. */
  private applyLoadedConfig(config: PhasicDialTest) {
    this.maxValues = [...config.maxValues];
    this.values = [...config.initialValues];
    this.buttons = config.buttons.map(button => [...button.getTurns()]);

    // A loaded config describes a puzzle that has not been solved on this page
    // yet, so any displayed solution — or one still being searched for —
    // belongs to a different board.
    this.invalidateResult();
    this.setSolving(false);
    this.render();
  }

  /** Swaps the Calculate button for a spinner while the search runs. */
  private setSolving(solving: boolean) {
    document
      .getElementById("solve-spinner")!
      .classList.toggle("hidden", !solving);
    const calculateBtn = document.getElementById("calculate")!;
    calculateBtn.toggleAttribute("disabled", solving);
    if (solving) document.getElementById("result")!.hidden = true;
  }

  private async calculate() {
    const config = this.readConfig();
    const solver = new TurnSolver(
      config.maxValues,
      config.initialValues,
      config.buttons,
    );

    const generation = ++this.solveGeneration;
    this.setSolving(true);
    let result: number[] | null;
    try {
      result = await solver.calculateTurnsAsync();
    } finally {
      // Unconditionally, NOT `if (generation === this.solveGeneration)`. A
      // newer generation means the board was edited while the search ran —
      // `invalidateResult` bumps the counter and touches nothing else — and
      // the guarded form then skipped the only call that hides the spinner and
      // re-enables Calculate, leaving the page stuck until a reset or an
      // upload. Nothing else can be solving: the button is disabled for the
      // whole of `calculate`, so this is always THIS search's chrome.
      this.setSolving(false);
    }
    // The board can be reset or replaced by an upload while the search runs;
    // rendering this answer against it would attribute presses to the wrong
    // buttons.
    if (generation !== this.solveGeneration) return;

    this.lastResult = result;
    this.lastResultKey = result === null ? null : this.configKey(config);
    this.buttonsView.showPresses(result);
    this.renderResult(result);
  }

  private renderResult(result: number[] | null) {
    const resultEl = document.getElementById("result")!;
    if (result === null) {
      resultEl.textContent = "No solution found.";
    } else if (result.every(v => v === 0)) {
      resultEl.textContent = "Already solved! No button presses needed.";
    } else {
      resultEl.innerHTML = this.solutionMarkup(result);
    }
    resultEl.hidden = false;
  }

  /** The solved press counts, one row per button that has to be pressed. */
  private solutionMarkup(result: number[]): string {
    const total = result.reduce((sum, presses) => sum + presses, 0);
    const rows = result
      .map((presses, index) =>
        presses > 0 ? this.resultRowMarkup(index, presses) : null,
      )
      .filter(row => row !== null)
      .join("");
    return (
      `<div class="result-summary">` +
      `${total} press${total === 1 ? "" : "es"} in total</div>` +
      `<ol class="result-list">${rows}</ol>`
    );
  }

  private resultRowMarkup(index: number, presses: number): string {
    const turns = this.buttons[index] ?? [];
    const icons = turns
      .map((count, dial) =>
        count > 0
          ? `<img class="result-dial" src="${DIALS[dial]!.image}" alt="" />`
          : null,
      )
      .filter(icon => icon !== null)
      .join("");
    const plural = presses === 1 ? "" : "es";
    return (
      `<li class="result-row">` +
      `<span class="result-button">Button ${index + 1}</span>` +
      `<span class="result-count">${presses} press${plural}</span>` +
      `<span class="result-dials">${icons}</span></li>`
    );
  }
}

if (process.env.NODE_ENV !== "test") {
  new PhasicDialSolver();
}
