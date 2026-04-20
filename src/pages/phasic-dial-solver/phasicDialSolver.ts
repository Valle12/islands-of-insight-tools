import blueDial from "./../../../images/blue-dial.png";
import cyanDial from "./../../../images/cyan-dial.png";
import greenDial from "./../../../images/green-dial.png";
import redDial from "./../../../images/red-dial.png";
import yellowDial from "./../../../images/yellow-dial.png";
import { Button } from "./button";
import { TurnSolver } from "./turnSolver";

export class PhasicDialSolver {
  private dialCount = 2;
  private buttonCount = 1;

  private dialImages: Record<string, string> = {
    blue: blueDial,
    red: redDial,
    green: greenDial,
    yellow: yellowDial,
    cyan: cyanDial,
  };

  private dialOrder = ["blue", "red", "green", "yellow", "cyan"] as const;

  constructor() {
    document.getElementById("add-dial")!.addEventListener("click", () => {
      this.addDial();
    });

    document.getElementById("add-button")!.addEventListener("click", () => {
      this.addButton();
    });

    document.getElementById("calculate")!.addEventListener("click", () => {
      this.calculate();
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
    this.rebuildDialsList();
    this.rebuildTable();
    document.getElementById("result")!.hidden = true;
  }

  private calculate() {
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

    const solver = new TurnSolver(maxValues, initialValues, buttons);
    const result = solver.calculateTurns();

    const resultEl = document.getElementById("result")!;
    if (result === null) {
      resultEl.textContent = "No solution found.";
    } else if (result.every(v => v === 0)) {
      resultEl.textContent = "Already solved! No button presses needed.";
    } else {
      const lines = result
        .map((presses, i) =>
          presses > 0
            ? `Button ${i + 1}: ${presses} press${presses !== 1 ? "es" : ""}`
            : null,
        )
        .filter(line => line !== null);
      resultEl.innerHTML = lines.join("<br>");
    }
    resultEl.hidden = false;
  }
}

if (process.env.NODE_ENV !== "test") {
  new PhasicDialSolver();
}
