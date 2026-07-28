import blueDial from "./../../../images/blue-dial.png";
import cyanDial from "./../../../images/cyan-dial.png";
import greenDial from "./../../../images/green-dial.png";
import purpleDial from "./../../../images/purple-dial.png";
import redDial from "./../../../images/red-dial.png";
import yellowDial from "./../../../images/yellow-dial.png";
import {
  downloadJson,
  readJsonFile,
  setupDragAndDrop,
} from "../../util/configFile";
import type { PhasicDialTest } from "../../util/types";
import { Button } from "./button";
import { validateConfig } from "./config";
import { TurnSolver } from "./turnSolver";

export class PhasicDialSolver {
  private dialCount = 2;
  private buttonCount = 1;

  // The last solution and the inputs it was computed from. A downloaded config
  // only carries a `result` while it still describes the puzzle that produced
  // it — solving on download instead is not an option, because TurnSolver
  // brute-forces a cartesian product and must not run behind a button that
  // looks free.
  private lastResult: number[] | null = null;
  private lastResultKey: string | null = null;
  private warningTimeoutId: number | null = null;
  // Bumped whenever a search starts or the board changes, so an answer that
  // arrives after either is discarded.
  private solveGeneration = 0;

  private dialImages: Record<string, string> = {
    blue: blueDial,
    red: redDial,
    green: greenDial,
    yellow: yellowDial,
    cyan: cyanDial,
    purple: purpleDial,
  };

  // The order the game unlocks dials in; purple is the sixth and last.
  private dialOrder = [
    "blue",
    "red",
    "green",
    "yellow",
    "cyan",
    "purple",
  ] as const;

  constructor() {
    document.getElementById("add-dial")!.addEventListener("click", () => {
      this.addDial();
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

    document
      .getElementById("download-config")
      ?.addEventListener("click", () => this.downloadCurrentConfig());

    const fileInput = document.getElementById(
      "config-file-input",
    ) as HTMLInputElement | null;

    document.getElementById("upload-config")?.addEventListener("click", () => {
      fileInput?.click();
    });

    fileInput?.addEventListener("change", () => {
      const file = fileInput.files?.[0];
      if (file) void this.loadConfigFromFile(file);
      // Clear the value so re-selecting the same file fires "change" again.
      fileInput.value = "";
    });

    const dropOverlay = document.getElementById("drop-overlay");
    if (dropOverlay) {
      setupDragAndDrop(dropOverlay, file => {
        void this.loadConfigFromFile(file);
      });
    }

    this.rebuildDialsList();
    this.rebuildTable();
  }

  private getDialImgSrc(color: string): string {
    return this.dialImages[color]!;
  }

  private rebuildDialsList() {
    const activeDials = this.dialOrder.slice(0, this.dialCount);
    const list = document.getElementById("dials-list")!;
    list.innerHTML = activeDials
      .map(
        c =>
          `<div class="dial-row" data-color="${c}">
            <img src="${this.getDialImgSrc(c)}" width="32" height="32" />
            <md-outlined-text-field label="Max" type="number" value="3" class="dial-max"></md-outlined-text-field>
            <md-outlined-text-field label="Value" type="number" value="0" class="dial-value"></md-outlined-text-field>
          </div>`,
      )
      .join("");

    const addBtn = document.getElementById("add-dial")!;
    addBtn.style.display =
      this.dialCount >= this.dialOrder.length ? "none" : "";
  }

  private rebuildTable() {
    const activeDials = this.dialOrder.slice(0, this.dialCount);

    // Header row: empty cell + dial images
    const header = document.getElementById("table-header")!;
    header.innerHTML =
      "<th></th>" +
      activeDials
        .map(
          c =>
            `<th><img src="${this.getDialImgSrc(c)}" width="32" height="32" /></th>`,
        )
        .join("");

    // Body rows
    const body = document.getElementById("table-body")!;
    body.innerHTML = "";

    // Button rows
    for (let i = 1; i <= this.buttonCount; i++) {
      const row = document.createElement("tr");
      row.innerHTML =
        `<td>Button ${i}</td>` +
        activeDials
          .map(
            () =>
              `<td><md-outlined-text-field type="number" value="0"></md-outlined-text-field></td>`,
          )
          .join("");
      body.appendChild(row);
    }
  }

  private addDial() {
    if (this.dialCount >= this.dialOrder.length) return;
    this.dialCount++;
    this.rebuildDialsList();
    this.rebuildTable();
  }

  private addButton() {
    this.buttonCount++;
    this.rebuildTable();
  }

  private reset() {
    this.dialCount = 2;
    this.buttonCount = 1;
    this.lastResult = null;
    this.lastResultKey = null;
    this.solveGeneration++;
    this.setSolving(false);
    this.rebuildDialsList();
    this.rebuildTable();
    document.getElementById("result")!.hidden = true;
  }

  /** Harvests the puzzle currently entered in the DOM. */
  private readConfig(): PhasicDialTest {
    const dialRows = document.querySelectorAll(".dial-row");
    const maxValues: number[] = [];
    const initialValues: number[] = [];
    dialRows.forEach(row => {
      maxValues.push(
        Number(row.querySelector<HTMLInputElement>(".dial-max")!.value),
      );
      initialValues.push(
        Number(row.querySelector<HTMLInputElement>(".dial-value")!.value),
      );
    });

    const rows = document.querySelectorAll("#table-body tr");
    const buttons: Button[] = [];
    rows.forEach(row => {
      const fields = row.querySelectorAll("md-outlined-text-field");
      const values: number[] = [];
      fields.forEach(f => values.push(Number(f.value)));
      buttons.push(new Button(values));
    });

    return { maxValues, initialValues, buttons };
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

  /** Applies a validated config to the dial rows and the button table. */
  private applyLoadedConfig(config: PhasicDialTest) {
    this.dialCount = config.maxValues.length;
    this.buttonCount = config.buttons.length;
    this.rebuildDialsList();
    this.rebuildTable();

    document.querySelectorAll(".dial-row").forEach((row, index) => {
      row.querySelector<HTMLInputElement>(".dial-max")!.value = String(
        config.maxValues[index],
      );
      row.querySelector<HTMLInputElement>(".dial-value")!.value = String(
        config.initialValues[index],
      );
    });

    document.querySelectorAll("#table-body tr").forEach((row, index) => {
      const turns = config.buttons[index]!.getTurns();
      row.querySelectorAll("md-outlined-text-field").forEach((field, dial) => {
        field.value = String(turns[dial]);
      });
    });

    // A loaded config describes a puzzle that has not been solved on this page
    // yet, so any displayed solution — or one still being searched for —
    // belongs to a different board.
    this.lastResult = null;
    this.lastResultKey = null;
    this.solveGeneration++;
    this.setSolving(false);
    document.getElementById("result")!.hidden = true;
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

  private showWarning(message: string) {
    const banner = document.getElementById("warning-banner")!;
    banner.textContent = message;
    banner.classList.remove("hidden");
    if (this.warningTimeoutId !== null) {
      window.clearTimeout(this.warningTimeoutId);
    }
    this.warningTimeoutId = window.setTimeout(() => {
      banner.classList.add("hidden");
      this.warningTimeoutId = null;
    }, 3500);
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
      if (generation === this.solveGeneration) this.setSolving(false);
    }
    // The board can be reset or replaced by an upload while the search runs;
    // rendering this answer against it would attribute presses to the wrong
    // buttons.
    if (generation !== this.solveGeneration) return;

    this.lastResult = result;
    this.lastResultKey = result === null ? null : this.configKey(config);

    const resultEl = document.getElementById("result")!;
    if (result === null) {
      resultEl.textContent = "No solution found.";
    } else if (result.every(v => v === 0)) {
      resultEl.textContent = "Already solved! No button presses needed.";
    } else {
      const lines = result
        .map((presses, i) => {
          if (presses <= 0) return null;
          const plural = presses === 1 ? "" : "es";
          return `Button ${i + 1}: ${presses} press${plural}`;
        })
        .filter(line => line !== null);
      resultEl.innerHTML = lines.join("<br>");
    }
    resultEl.hidden = false;
  }
}

if (process.env.NODE_ENV !== "test") {
  new PhasicDialSolver();
}
