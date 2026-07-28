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
import { PhasicDialSolver } from "../../src/pages/phasic-dial-solver/phasicDialSolver";
import { TurnSolver } from "../../src/pages/phasic-dial-solver/turnSolver";

/**
 * `calculate()` awaits the chunked search, so the result lands a turn or two
 * after the click handler returns.
 */
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

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
  let warningBanner: HTMLDivElement;
  let fileInput: HTMLInputElement;
  let downloadConfig: MdIconButton;

  beforeEach(() => {
    warningBanner = document.createElement("div");
    warningBanner.classList.add("hidden");
    fileInput = document.createElement("input");
    fileInput.type = "file";
    downloadConfig = document.createElement("md-icon-button");
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
    // Several tests attach the dial list / button table to the document so the
    // solver's own `document.querySelectorAll` can find them; leaving them
    // there would let one test read another's rows.
    document.body.innerHTML = "";
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
    expect(rows).toHaveLength(3);
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
    expect(headers).toHaveLength(4);
    const row = tableBody.querySelector("tr");
    const cells = row?.querySelectorAll("td");
    expect(cells).toHaveLength(4);
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
    expect(headers).toHaveLength(3);
    const rows = tableBody.querySelectorAll("tr");
    expect(rows).toHaveLength(2);
    rows.forEach(row => {
      const cells = row.querySelectorAll("td");
      expect(cells).toHaveLength(3);
    });
  });

  test("should start calculation with no solution", async () => {
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
    spyOn(TurnSolver.prototype, "calculateTurnsAsync").mockImplementation(() =>
      Promise.resolve(null),
    );

    new PhasicDialSolver();
    cb(new Event("click"));
    await flush();

    expect(result.textContent).toBe("No solution found.");
  });

  test("should start calculation when already solved", async () => {
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
    spyOn(TurnSolver.prototype, "calculateTurnsAsync").mockImplementation(() =>
      Promise.resolve([0]),
    );

    new PhasicDialSolver();
    cb(new Event("click"));
    await flush();

    expect(result.textContent).toBe(
      "Already solved! No button presses needed.",
    );
  });

  test("should start calculation with one button to press", async () => {
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
    spyOn(TurnSolver.prototype, "calculateTurnsAsync").mockImplementation(() =>
      Promise.resolve([1]),
    );

    new PhasicDialSolver();
    cb(new Event("click"));
    await flush();

    expect(result.textContent).toBe("Button 1: 1 press");
  });

  test("should start calculation with two buttons to press", async () => {
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
    spyOn(TurnSolver.prototype, "calculateTurnsAsync").mockImplementation(() =>
      Promise.resolve([1, 2]),
    );

    new PhasicDialSolver();
    cb(new Event("click"));
    await flush();

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
    expect(rows).toHaveLength(3);

    cb(new Event("click"));

    // rebuildDialsList
    rows = dialsList.querySelectorAll(".dial-row");
    expect(rows).toHaveLength(2);
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
    expect(headers).toHaveLength(3);
    const row = tableBody.querySelector("tr");
    const cells = row?.querySelectorAll("td");
    expect(cells).toHaveLength(3);

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
    expect(helpDialog.querySelectorAll("li")).toHaveLength(3);
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

  test("test real example calculation", async () => {
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
    expect(dialRows).toHaveLength(2);
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
    expect(buttonRows).toHaveLength(2);
    let index = 0;
    buttonRows.forEach(buttonRow => {
      const textFields = buttonRow.querySelectorAll("md-outlined-text-field");
      expect(textFields).toHaveLength(2);
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
    await flush();

    expect(result.textContent).toBe("Button 1: 1 pressButton 2: 3 presses");
  });

  test("should show a spinner while the search runs", async () => {
    let cb: (event: Event) => void = () => {};
    const spinner = document.createElement("div");
    spinner.classList.add("hidden");
    spyOn(document, "getElementById").mockImplementation((id: string) => {
      if (id === "calculate") return calculate;
      if (id === "result") return result;
      if (id === "solve-spinner") return spinner;
      return document.createElement("div");
    });
    spyOn(calculate, "addEventListener").mockImplementation(
      (_type: string, listener: (event: Event) => void) => {
        cb = listener;
      },
    );
    let finish: (turns: number[] | null) => void = () => {};
    spyOn(TurnSolver.prototype, "calculateTurnsAsync").mockImplementation(
      () => new Promise(resolve => (finish = resolve)),
    );

    new PhasicDialSolver();
    result.hidden = false;
    cb(new Event("click"));
    await flush();

    expect(spinner.classList.contains("hidden")).toBeFalse();
    expect(calculate.hasAttribute("disabled")).toBeTrue();
    // The previous answer must not sit next to a running search.
    expect(result.hidden).toBeTrue();

    finish([2]);
    await flush();

    expect(spinner.classList.contains("hidden")).toBeTrue();
    expect(calculate.hasAttribute("disabled")).toBeFalse();
    expect(result.textContent).toBe("Button 1: 2 presses");
  });

  test("should discard a search that a reset outlived", async () => {
    let calculateCb: (event: Event) => void = () => {};
    let resetCb: (event: Event) => void = () => {};
    const spinner = document.createElement("div");
    spinner.classList.add("hidden");
    spyOn(document, "getElementById").mockImplementation((id: string) => {
      if (id === "calculate") return calculate;
      if (id === "reset") return reset;
      if (id === "result") return result;
      if (id === "solve-spinner") return spinner;
      if (id === "dials-list") return dialsList;
      if (id === "table-header") return tableHeader;
      if (id === "table-body") return tableBody;
      return document.createElement("div");
    });
    spyOn(calculate, "addEventListener").mockImplementation(
      (_type: string, listener: (event: Event) => void) => {
        calculateCb = listener;
      },
    );
    spyOn(reset, "addEventListener").mockImplementation(
      (_type: string, listener: (event: Event) => void) => {
        resetCb = listener;
      },
    );
    let finish: (turns: number[] | null) => void = () => {};
    spyOn(TurnSolver.prototype, "calculateTurnsAsync").mockImplementation(
      () => new Promise(resolve => (finish = resolve)),
    );

    new PhasicDialSolver();
    calculateCb(new Event("click"));
    await flush();
    resetCb(new Event("click"));
    finish([7]);
    await flush();

    expect(spinner.classList.contains("hidden")).toBeTrue();
    expect(result.hidden).toBeTrue();
    expect(result.textContent).toBe("");
  });

  test("should stop adding dials after purple", () => {
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
    // Two dials are shown to begin with, so four clicks reach all six colours
    // and a fifth must be a no-op.
    for (let i = 0; i < 5; i++) cb(new Event("click"));

    const rows = dialsList.querySelectorAll(".dial-row");
    expect(rows).toHaveLength(6);
    expect(
      Array.from(rows).map(row => row.getAttribute("data-color")),
    ).toEqual(["blue", "red", "green", "yellow", "cyan", "purple"]);
    expect(addDial.style.display).toBe("none");
    expect(tableHeader.querySelectorAll("th")).toHaveLength(7);
  });

  /** Wires up the page with a real file input and returns its change handler. */
  function mountWithFileInput() {
    let change: (event: Event) => void = () => {};
    spyOn(document, "getElementById").mockImplementation((id: string) => {
      if (id === "config-file-input") return fileInput;
      if (id === "warning-banner") return warningBanner;
      if (id === "dials-list") return dialsList;
      if (id === "table-header") return tableHeader;
      if (id === "table-body") return tableBody;
      if (id === "result") return result;
      return document.createElement("div");
    });
    spyOn(fileInput, "addEventListener").mockImplementation(
      (_type: string, listener: (event: Event) => void) => {
        change = listener;
      },
    );
    dialsList.id = "dials-list";
    tableBody.id = "table-body";
    document.body.appendChild(dialsList);
    document.body.appendChild(tableBody);

    new PhasicDialSolver();
    return (file: File) => {
      Object.defineProperty(fileInput, "files", {
        value: [file],
        configurable: true,
      });
      change(new Event("change"));
    };
  }

  test("should load a config from a file", async () => {
    const pick = mountWithFileInput();
    result.hidden = false;

    pick(
      new File(
        [
          JSON.stringify({
            maxValues: [3, 4, 5],
            initialValues: [1, 2, 0],
            buttons: [{ turns: [1, 0, 2] }, { turns: [0, 3, 1] }],
            result: [2, 1],
          }),
        ],
        "phasicDialTest.json",
        { type: "application/json" },
      ),
    );
    // loadConfigFromFile is async; let its promise chain settle.
    await Promise.resolve();
    await Promise.resolve();

    const rows = dialsList.querySelectorAll(".dial-row");
    expect(rows).toHaveLength(3);
    expect(
      Array.from(rows).map(
        row => (row.querySelector(".dial-max") as MdOutlinedTextField).value,
      ),
    ).toEqual(["3", "4", "5"]);
    expect(
      Array.from(rows).map(
        row => (row.querySelector(".dial-value") as MdOutlinedTextField).value,
      ),
    ).toEqual(["1", "2", "0"]);

    const buttonRows = tableBody.querySelectorAll("tr");
    expect(buttonRows).toHaveLength(2);
    expect(
      Array.from(buttonRows).map(row =>
        Array.from(row.querySelectorAll("md-outlined-text-field")).map(
          field => (field as MdOutlinedTextField).value,
        ),
      ),
    ).toEqual([
      ["1", "0", "2"],
      ["0", "3", "1"],
    ]);

    expect(result.hidden).toBeTrue();
    expect(warningBanner.classList.contains("hidden")).toBeTrue();
  });

  test("should warn about a file that is not valid JSON", async () => {
    const pick = mountWithFileInput();

    pick(new File(["not json"], "phasicDialTest.json"));
    await Promise.resolve();
    await Promise.resolve();

    expect(warningBanner.textContent).toBe("The file is not valid JSON.");
    expect(warningBanner.classList.contains("hidden")).toBeFalse();
    // The page must be left exactly as it was.
    expect(dialsList.querySelectorAll(".dial-row")).toHaveLength(2);
  });

  test("should warn about a config that fails validation", async () => {
    const pick = mountWithFileInput();

    pick(
      new File(
        [JSON.stringify({ maxValues: [3], initialValues: [0], buttons: [] })],
        "phasicDialTest.json",
        { type: "application/json" },
      ),
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(warningBanner.textContent).toBe(
      "Invalid config: maxValues must hold between 2 and 6 dials.",
    );
    expect(dialsList.querySelectorAll(".dial-row")).toHaveLength(2);
  });

  test("should download the entered config, with the result once solved", async () => {
    let downloadCb: (event: Event) => void = () => {};
    let calculateCb: (event: Event) => void = () => {};
    spyOn(document, "getElementById").mockImplementation((id: string) => {
      if (id === "download-config") return downloadConfig;
      if (id === "calculate") return calculate;
      if (id === "dials-list") return dialsList;
      if (id === "table-header") return tableHeader;
      if (id === "table-body") return tableBody;
      if (id === "result") return result;
      return document.createElement("div");
    });
    spyOn(downloadConfig, "addEventListener").mockImplementation(
      (_type: string, listener: (event: Event) => void) => {
        downloadCb = listener;
      },
    );
    spyOn(calculate, "addEventListener").mockImplementation(
      (_type: string, listener: (event: Event) => void) => {
        calculateCb = listener;
      },
    );
    const blobs: Blob[] = [];
    spyOn(URL, "createObjectURL").mockImplementation((blob: Blob) => {
      blobs.push(blob);
      return "blob:mock";
    });
    spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    dialsList.id = "dials-list";
    tableBody.id = "table-body";
    document.body.appendChild(dialsList);
    document.body.appendChild(tableBody);

    new PhasicDialSolver();

    const dialRows = dialsList.querySelectorAll(".dial-row");
    dialRows.forEach(row => {
      (row.querySelector(".dial-max") as MdOutlinedTextField).value = "3";
      (row.querySelector(".dial-value") as MdOutlinedTextField).value = "0";
    });
    (dialRows[0]!.querySelector(".dial-value") as MdOutlinedTextField).value =
      "1";
    (dialRows[1]!.querySelector(".dial-value") as MdOutlinedTextField).value =
      "2";
    const fields = tableBody.querySelectorAll("md-outlined-text-field");
    (fields[0] as MdOutlinedTextField).value = "1";
    (fields[1] as MdOutlinedTextField).value = "2";

    // Before solving, the download carries the inputs only.
    downloadCb(new Event("click"));
    expect(blobs).toHaveLength(1);
    const beforeSolve = JSON.parse(await blobs[0]!.text());
    expect(beforeSolve).toEqual({
      maxValues: [3, 3],
      initialValues: [1, 2],
      buttons: [{ turns: [1, 2] }],
    });

    calculateCb(new Event("click"));
    await flush();
    downloadCb(new Event("click"));
    expect(blobs).toHaveLength(2);
    const afterSolve = JSON.parse(await blobs[1]!.text());
    expect(afterSolve.result).toEqual([3]);

    // Editing an input invalidates the recorded solution.
    (fields[0] as MdOutlinedTextField).value = "3";
    downloadCb(new Event("click"));
    const afterEdit = JSON.parse(await blobs[2]!.text());
    expect(afterEdit.result).toBeUndefined();
  });
});
