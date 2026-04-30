import type { MdFilledButton } from "@material/web/button/filled-button";
import type { MdTextButton } from "@material/web/button/text-button";
import type { MdDialog } from "@material/web/dialog/dialog";
import type { MdIconButton } from "@material/web/iconbutton/icon-button";
import type { MdOutlinedTextField } from "@material/web/textfield/outlined-text-field";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { PhasicDialSolver } from "../src/pages/phasic-dial-solver/phasicDialSolver";
import { TurnSolver } from "../src/pages/phasic-dial-solver/turnSolver";

describe("PhasicDialSolver", () => {
  let addDial: MdIconButton;
  let addButton: MdIconButton;
  let reset: MdIconButton;
  let help: MdIconButton;
  let calculate: MdFilledButton;
  let helpClose: MdTextButton;
  let dialsList: HTMLDivElement;
  let result: HTMLDivElement;
  let tableHeader: HTMLTableRowElement;
  let tableBody: HTMLTableSectionElement;
  let helpDialog: MdDialog;

  beforeEach(() => {
    addDial = document.createElement("md-icon-button");
    addButton = document.createElement("md-icon-button");
    reset = document.createElement("md-icon-button");
    help = document.createElement("md-icon-button");
    calculate = document.createElement("md-filled-button");
    helpClose = document.createElement("md-text-button");
    dialsList = document.createElement("div");
    result = document.createElement("div");
    tableHeader = document.createElement("tr");
    tableBody = document.createElement("tbody");
    helpDialog = document.createElement("md-dialog");
    helpDialog.innerHTML = `
    <div slot="headline">How to use</div>
        <div slot="content">
          <ol>
            <li>
              Add dials first so the table has the right number of columns.
            </li>
            <li>
              Set <strong>Max</strong> to the number of sides of the dial minus
              1 (e.g. a square dial has 4 sides, so Max = 3). The
              <strong>Value</strong> is 0 when pointing at the center, then
              count clockwise by the number of lit-up dots.
            </li>
            <li>
              For each button, enter how many turns it applies to each dial. For
              example, if you see two blue icons on a button, enter
              <strong>2</strong> in that button's blue column.
            </li>
          </ol>
        </div>
        <div slot="actions">
          <md-text-button id="help-close">Close</md-text-button>
        </div>
    `;
    // The test DOM doesn't register the custom `md-dialog` element,
    // so provide simple `show`/`close` implementations used by the code.
    (helpDialog as any).show = () => {
      (helpDialog as any).open = true;
    };
    (helpDialog as any).close = () => {
      (helpDialog as any).open = false;
    };
  });

  afterEach(() => {
    mock.restore();
  });

  test("should add dial and update ui", () => {
    let cb: (event: Event) => void = () => {};
    spyOn(document, "getElementById").mockImplementation((id: string) => {
      if (id === "add-dial") return addDial;
      if (id === "dials-list") return dialsList;
      if (id === "table-header") return tableHeader;
      if (id === "table-body") return tableBody;
      return document.createElement("div");
    });
    spyOn(addDial, "addEventListener").mockImplementation(
      (_type: string, listener: (event: Event) => void) => {
        cb = listener;
      },
    );

    new PhasicDialSolver();
    cb(new Event("click"));

    // rebuildDialsList
    const rows = dialsList.querySelectorAll(".dial-row");
    expect(rows.length).toBe(3);
    let index = 0;
    rows.forEach(row => {
      const color = row.getAttribute("data-color");
      if (index === 0) {
        expect(color).toBe("blue");
      } else if (index === 1) {
        expect(color).toBe("red");
      } else if (index === 2) {
        expect(color).toBe("green");
      }

      index++;
    });
    expect(addDial.style.display).toBe("");

    // rebuildTable
    const headers = tableHeader.querySelectorAll("th");
    expect(headers.length).toBe(4);
    const row = tableBody.querySelector("tr");
    const cells = row?.querySelectorAll("td");
    expect(cells?.length).toBe(4);
  });

  test("should add button and update ui", () => {
    let cb: (event: Event) => void = () => {};
    spyOn(document, "getElementById").mockImplementation((id: string) => {
      if (id === "add-button") return addButton;
      if (id === "table-header") return tableHeader;
      if (id === "table-body") return tableBody;
      return document.createElement("div");
    });
    spyOn(addButton, "addEventListener").mockImplementation(
      (_type: string, listener: (event: Event) => void) => {
        cb = listener;
      },
    );

    new PhasicDialSolver();
    cb(new Event("click"));

    // rebuildTable
    const headers = tableHeader.querySelectorAll("th");
    expect(headers.length).toBe(3);
    const rows = tableBody.querySelectorAll("tr");
    expect(rows.length).toBe(2);
    rows.forEach(row => {
      const cells = row.querySelectorAll("td");
      expect(cells?.length).toBe(3);
    });
  });

  test("should start calculation with no solution", () => {
    let cb: (event: Event) => void = () => {};
    spyOn(document, "getElementById").mockImplementation((id: string) => {
      if (id === "calculate") return calculate;
      if (id === "result") return result;
      return document.createElement("div");
    });
    spyOn(calculate, "addEventListener").mockImplementation(
      (_type: string, listener: (event: Event) => void) => {
        cb = listener;
      },
    );
    spyOn(TurnSolver.prototype, "calculateTurns").mockImplementation(
      () => null,
    );

    new PhasicDialSolver();
    cb(new Event("click"));

    expect(result.textContent).toBe("No solution found.");
  });

  test("should start calculation when already solved", () => {
    let cb: (event: Event) => void = () => {};
    spyOn(document, "getElementById").mockImplementation((id: string) => {
      if (id === "calculate") return calculate;
      if (id === "result") return result;
      return document.createElement("div");
    });
    spyOn(calculate, "addEventListener").mockImplementation(
      (_type: string, listener: (event: Event) => void) => {
        cb = listener;
      },
    );
    spyOn(TurnSolver.prototype, "calculateTurns").mockImplementation(() => [0]);

    new PhasicDialSolver();
    cb(new Event("click"));

    expect(result.textContent).toBe(
      "Already solved! No button presses needed.",
    );
  });

  test("should start calculation with one button to press", () => {
    let cb: (event: Event) => void = () => {};
    spyOn(document, "getElementById").mockImplementation((id: string) => {
      if (id === "calculate") return calculate;
      if (id === "result") return result;
      return document.createElement("div");
    });
    spyOn(calculate, "addEventListener").mockImplementation(
      (_type: string, listener: (event: Event) => void) => {
        cb = listener;
      },
    );
    spyOn(TurnSolver.prototype, "calculateTurns").mockImplementation(() => [1]);

    new PhasicDialSolver();
    cb(new Event("click"));

    expect(result.textContent).toBe("Button 1: 1 press");
  });

  test("should start calculation with two buttons to press", () => {
    let cb: (event: Event) => void = () => {};
    spyOn(document, "getElementById").mockImplementation((id: string) => {
      if (id === "calculate") return calculate;
      if (id === "result") return result;
      return document.createElement("div");
    });
    spyOn(calculate, "addEventListener").mockImplementation(
      (_type: string, listener: (event: Event) => void) => {
        cb = listener;
      },
    );
    spyOn(TurnSolver.prototype, "calculateTurns").mockImplementation(() => [
      1, 2,
    ]);

    new PhasicDialSolver();
    cb(new Event("click"));

    expect(result.textContent).toBe("Button 1: 1 pressButton 2: 2 presses");
  });

  test("test reset", async () => {
    let cb: (event: Event) => void = () => {};
    let cb2: (event: Event) => void = () => {};
    spyOn(document, "getElementById").mockImplementation((id: string) => {
      if (id === "result") return result;
      if (id === "dials-list") return dialsList;
      if (id === "table-header") return tableHeader;
      if (id === "table-body") return tableBody;
      if (id === "reset") return reset;
      if (id === "add-dial") return addDial;
      return document.createElement("div");
    });
    spyOn(reset, "addEventListener").mockImplementation(
      (_type: string, listener: (event: Event) => void) => {
        cb = listener;
      },
    );
    spyOn(addDial, "addEventListener").mockImplementation(
      (_type: string, listener: (event: Event) => void) => {
        cb2 = listener;
      },
    );

    new PhasicDialSolver();
    cb2(new Event("click"));

    let rows = dialsList.querySelectorAll(".dial-row");
    expect(rows.length).toBe(3);

    cb(new Event("click"));

    // rebuildDialsList
    rows = dialsList.querySelectorAll(".dial-row");
    expect(rows.length).toBe(2);
    let index = 0;
    rows.forEach(row => {
      const color = row.getAttribute("data-color");
      if (index === 0) {
        expect(color).toBe("blue");
      } else if (index === 1) {
        expect(color).toBe("red");
      }

      index++;
    });
    expect(addDial.style.display).toBe("");

    // rebuildTable
    const headers = tableHeader.querySelectorAll("th");
    expect(headers.length).toBe(3);
    const row = tableBody.querySelector("tr");
    const cells = row?.querySelectorAll("td");
    expect(cells?.length).toBe(3);

    expect(result.hidden).toBeTrue();
  });

  test("test help dialog", async () => {
    let cb: (event: Event) => void = () => {};
    spyOn(document, "getElementById").mockImplementation((id: string) => {
      if (id === "help") return help;
      if (id === "help-dialog") return helpDialog;
      return document.createElement("div");
    });
    spyOn(help, "addEventListener").mockImplementation(
      (_type: string, listener: (event: Event) => void) => {
        cb = listener;
      },
    );

    new PhasicDialSolver();
    cb(new Event("click"));

    expect(helpDialog.open).toBeTrue();
    expect(helpDialog.querySelectorAll("li").length).toBe(3);
    expect(helpDialog.querySelector("#help-close")).not.toBeNull();
  });

  test("test closing help dialog", async () => {
    let cb: (event: Event) => void = () => {};
    let cb2: (event: Event) => void = () => {};
    spyOn(document, "getElementById").mockImplementation((id: string) => {
      if (id === "help-dialog") return helpDialog;
      if (id === "help-close") return helpClose;
      if (id === "help") return help;
      return document.createElement("div");
    });
    spyOn(help, "addEventListener").mockImplementation(
      (_type: string, listener: (event: Event) => void) => {
        cb = listener;
      },
    );
    spyOn(helpClose, "addEventListener").mockImplementation(
      (_type: string, listener: (event: Event) => void) => {
        cb2 = listener;
      },
    );

    new PhasicDialSolver();
    cb(new Event("click"));

    expect(helpDialog.open).toBeTrue();

    cb2(new Event("click"));

    expect(helpDialog.open).toBeFalse();
  });

  test("test real example calculation", () => {
    let cb: (event: Event) => void = () => {};
    spyOn(document, "getElementById").mockImplementation((id: string) => {
      if (id === "calculate") return calculate;
      if (id === "result") return result;
      if (id === "dials-list") return dialsList;
      if (id === "table-header") return tableHeader;
      if (id === "table-body") return tableBody;
      if (id === "add-button") return addButton;
      return document.createElement("div");
    });
    spyOn(calculate, "addEventListener").mockImplementation(
      (_type: string, listener: (event: Event) => void) => {
        cb = listener;
      },
    );
    dialsList.id = "dials-list";
    tableBody.id = "table-body";
    document.body.appendChild(dialsList);
    document.body.appendChild(tableBody);

    new PhasicDialSolver();

    const dialRows = dialsList.querySelectorAll(".dial-row");
    expect(dialRows.length).toBe(2);
    // md-outlined-text-field doesn't map the `value` attribute to a property
    // in the test DOM, so set the `.value` property explicitly for max values.
    dialRows.forEach(row => {
      const dialMax = row.querySelector(
        ".dial-max",
      ) as MdOutlinedTextField | null;
      if (dialMax) dialMax.value = "3";
      const dv = row.querySelector(".dial-value") as MdOutlinedTextField | null;
      if (dv && !dv.value) dv.value = "0";
    });
    const dialValue = dialRows[1]!.querySelector(
      ".dial-value",
    ) as MdOutlinedTextField | null;
    expect(dialValue).not.toBeNull();
    dialValue!.value = "1";

    addButton.click();
    const buttonRows = tableBody.querySelectorAll("tr");
    expect(buttonRows.length).toBe(2);
    let index = 0;
    buttonRows.forEach(buttonRow => {
      const textFields = buttonRow.querySelectorAll("md-outlined-text-field");
      expect(textFields.length).toBe(2);
      const f1 = textFields[0] as MdOutlinedTextField;
      const f2 = textFields[1] as MdOutlinedTextField;
      expect(f1).not.toBeUndefined();
      expect(f2).not.toBeUndefined();
      if (index === 0) {
        f1.value = "1";
        f2.value = "2";
      } else if (index === 1) {
        f1.value = "1";
        f2.value = "3";
      }

      index++;
    });

    cb(new Event("click"));

    expect(result.textContent).toBe("Button 1: 1 pressButton 2: 3 presses");
  });
});
