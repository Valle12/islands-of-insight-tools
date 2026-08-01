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

/**
 * The ids `PhasicDialSolver` reaches for, mounted for real rather than handed
 * back one at a time from a `getElementById` spy: the dials and the button
 * cards are built by two view classes that register delegated listeners on
 * their host, so a detached stub would silently swallow every interaction.
 */
const MARKUP = `
  <div id="editor-card">
    <div id="warning-banner" class="hidden"></div>
    <div id="dials-header">
      <md-icon-button id="remove-dial"></md-icon-button>
      <md-icon-button id="add-dial"></md-icon-button>
    </div>
    <div id="dials-list"></div>
    <md-icon-button id="add-button"></md-icon-button>
    <div id="buttons-list"></div>
    <md-filled-button id="calculate">Calculate Turns</md-filled-button>
    <md-icon-button id="reset"></md-icon-button>
    <md-icon-button id="help"></md-icon-button>
    <md-icon-button id="upload-config"></md-icon-button>
    <md-icon-button id="download-config"></md-icon-button>
    <input id="config-file-input" type="file" hidden />
    <div id="solve-spinner" class="hidden"></div>
    <div id="result" hidden></div>
    <md-dialog id="help-dialog">
      <div slot="content">
        <ol>
          <li>one</li>
          <li>two</li>
          <li>three</li>
        </ol>
      </div>
      <div slot="actions">
        <md-text-button id="help-close">Close</md-text-button>
      </div>
    </md-dialog>
  </div>
  <div id="drop-overlay" class="hidden"></div>
`;

const byId = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;

/** Colours, in the order the page hands them out. */
const dialColors = () =>
  Array.from(document.querySelectorAll(".dial-card")).map(card =>
    card.getAttribute("data-color"),
  );

/** The turn counts each button card currently holds. */
const buttonTurns = () =>
  Array.from(document.querySelectorAll(".button-card")).map(card =>
    Array.from(card.querySelectorAll<HTMLInputElement>(".turn-input")).map(
      input => input.value,
    ),
  );

function mount() {
  document.body.innerHTML = MARKUP;
  const dialog = byId("help-dialog") as HTMLElement & {
    open?: boolean;
    show?: () => void;
    close?: () => void;
  };
  // The test DOM does not register `md-dialog`, so provide the two methods the
  // page calls on it.
  dialog.show = () => {
    dialog.open = true;
  };
  dialog.close = () => {
    dialog.open = false;
  };
  return new PhasicDialSolver();
}

describe("PhasicDialSolver", () => {
  beforeEach(() => {
    mount();
  });

  afterEach(() => {
    mock.restore();
    document.body.innerHTML = "";
  });

  test("should render two dials and one button to begin with", () => {
    expect(dialColors()).toEqual(["blue", "red"]);
    expect(document.querySelectorAll(".button-card")).toHaveLength(1);
    expect(buttonTurns()).toEqual([["0", "0"]]);
    expect(byId("remove-dial").hasAttribute("disabled")).toBeTrue();
    expect(byId("add-dial").hasAttribute("disabled")).toBeFalse();
  });

  test("should add a dial and give every button a slot for it", () => {
    byId("add-dial").click();

    expect(dialColors()).toEqual(["blue", "red", "green"]);
    expect(buttonTurns()).toEqual([["0", "0", "0"]]);
    expect(byId("remove-dial").hasAttribute("disabled")).toBeFalse();
  });

  test("should stop adding dials after purple", () => {
    // Two dials are shown to begin with, so four clicks reach all six colours
    // and a fifth must be a no-op.
    for (let i = 0; i < 5; i++) byId("add-dial").click();

    expect(dialColors()).toEqual([
      "blue",
      "red",
      "green",
      "yellow",
      "cyan",
      "purple",
    ]);
    expect(byId("add-dial").hasAttribute("disabled")).toBeTrue();
    expect(buttonTurns()[0]).toHaveLength(6);
  });

  test("should remove the last dial, and only the last", () => {
    byId("add-dial").click();
    byId("add-dial").click();
    expect(dialColors()).toEqual(["blue", "red", "green", "yellow"]);

    byId("remove-dial").click();

    expect(dialColors()).toEqual(["blue", "red", "green"]);
    expect(buttonTurns()).toEqual([["0", "0", "0"]]);
  });

  test("should never remove a dial below the minimum", () => {
    byId("remove-dial").click();

    expect(dialColors()).toEqual(["blue", "red"]);
  });

  test("should add a button", () => {
    byId("add-button").click();

    expect(buttonTurns()).toEqual([
      ["0", "0"],
      ["0", "0"],
    ]);
    const names = Array.from(document.querySelectorAll(".button-name")).map(
      el => el.textContent,
    );
    expect(names).toEqual(["Button 1", "Button 2"]);
  });

  test("should delete any button and renumber the rest", () => {
    byId("add-button").click();
    byId("add-button").click();
    setTurns(0, 0, 1);
    setTurns(2, 0, 3);

    // Delete the middle card; the third one keeps its turns and becomes #2.
    const cards = document.querySelectorAll(".button-card");
    cards[1]!.querySelector<HTMLElement>(".button-delete")!.click();

    expect(buttonTurns()).toEqual([
      ["1", "0"],
      ["3", "0"],
    ]);
    const names = Array.from(document.querySelectorAll(".button-name")).map(
      el => el.textContent,
    );
    expect(names).toEqual(["Button 1", "Button 2"]);
  });

  test("should refuse to delete the only button", () => {
    const card = document.querySelector(".button-card")!;
    const del = card.querySelector<HTMLElement>(".button-delete")!;
    expect(del.hasAttribute("disabled")).toBeTrue();

    del.click();

    expect(document.querySelectorAll(".button-card")).toHaveLength(1);
  });

  test("should step a turn count and stack one icon per turn", () => {
    const slot = document.querySelector<HTMLElement>(".turn-slot")!;
    expect(slot.dataset.empty).toBe("true");

    slot.querySelector<HTMLElement>(".turn-more")!.click();
    slot.querySelector<HTMLElement>(".turn-more")!.click();

    expect(slot.querySelector<HTMLInputElement>(".turn-input")!.value).toBe("2");
    expect(slot.querySelectorAll(".turn-icon")).toHaveLength(2);
    expect(slot.dataset.empty).toBe("false");

    slot.querySelector<HTMLElement>(".turn-less")!.click();
    slot.querySelector<HTMLElement>(".turn-less")!.click();
    slot.querySelector<HTMLElement>(".turn-less")!.click();

    // A button cannot turn a dial a negative number of times.
    expect(slot.querySelector<HTMLInputElement>(".turn-input")!.value).toBe("0");
    expect(slot.dataset.empty).toBe("true");
  });

  test("should lay the icon stack out over even rows", () => {
    const slot = document.querySelector<HTMLElement>(".turn-slot")!;
    const icons = slot.querySelector<HTMLElement>(".turn-icons")!;
    const cols = () => icons.style.getPropertyValue("--icon-cols").trim();

    // Five is what a slot holds, so nothing wraps yet.
    setTurns(0, 0, 5);
    expect(icons.querySelectorAll(".turn-icon")).toHaveLength(5);
    expect(cols()).toBe("5");

    // Six would wrap as 5 + 1; three columns makes it 3 + 3.
    setTurns(0, 0, 6);
    expect(cols()).toBe("3");
  });

  test("should collapse a stack too tall to count into one icon", () => {
    const slot = document.querySelector<HTMLElement>(".turn-slot")!;

    setTurns(0, 0, 6);
    expect(slot.querySelectorAll(".turn-icon")).toHaveLength(6);
    expect(slot.querySelector(".turn-overflow")).toBeNull();

    setTurns(0, 0, 7);

    // Seven tiles is not readable; one tile and the number is.
    expect(slot.querySelectorAll(".turn-icon")).toHaveLength(1);
    expect(slot.querySelector(".turn-overflow")!.textContent).toBe("×7");
  });

  test("should aim a dial with the arrow keys and wrap around", () => {
    const face = document.querySelector<SVGSVGElement>(".dial-face")!;
    const card = document.querySelector<HTMLElement>(".dial-card")!;
    expect(card.dataset.solved).toBe("true");

    press(face, "ArrowRight");
    expect(face.getAttribute("aria-valuenow")).toBe("1");
    expect(card.dataset.solved).toBe("false");

    // A square dial has four positions, so a fourth step is back at the hub.
    press(face, "ArrowRight");
    press(face, "ArrowRight");
    press(face, "ArrowRight");
    expect(face.getAttribute("aria-valuenow")).toBe("0");
    expect(card.dataset.solved).toBe("true");

    press(face, "ArrowLeft");
    expect(face.getAttribute("aria-valuenow")).toBe("3");
  });

  test("should clamp a dial's position when it loses positions", () => {
    const card = document.querySelector<HTMLElement>(".dial-card")!;
    const face = card.querySelector<SVGSVGElement>(".dial-face")!;
    press(face, "End");
    expect(face.getAttribute("aria-valuenow")).toBe("3");

    card.querySelector<HTMLElement>(".dial-sides-fewer")!.click();
    card.querySelector<HTMLElement>(".dial-sides-fewer")!.click();

    expect(card.querySelector(".dial-sides-count")!.textContent).toBe(
      "2 positions",
    );
    expect(face.getAttribute("aria-valuenow")).toBe("1");
  });

  test("should never take a dial below two positions", () => {
    const card = document.querySelector<HTMLElement>(".dial-card")!;
    const fewer = card.querySelector<HTMLElement>(".dial-sides-fewer")!;
    fewer.click();
    fewer.click();
    fewer.click();

    expect(card.querySelector(".dial-sides-count")!.textContent).toBe(
      "2 positions",
    );
    expect(fewer.hasAttribute("disabled")).toBeTrue();
  });

  test("should report that no solution exists", async () => {
    spyOn(TurnSolver.prototype, "calculateTurnsAsync").mockImplementation(() =>
      Promise.resolve(null),
    );

    byId("calculate").click();
    await flush();

    expect(byId("result").textContent).toBe("No solution found.");
  });

  test("should report a puzzle that is already solved", async () => {
    spyOn(TurnSolver.prototype, "calculateTurnsAsync").mockImplementation(() =>
      Promise.resolve([0]),
    );

    byId("calculate").click();
    await flush();

    expect(byId("result").textContent).toBe(
      "Already solved! No button presses needed.",
    );
  });

  test("should list the presses and badge each button card", async () => {
    byId("add-button").click();
    spyOn(TurnSolver.prototype, "calculateTurnsAsync").mockImplementation(() =>
      Promise.resolve([1, 2]),
    );

    byId("calculate").click();
    await flush();

    const rows = document.querySelectorAll("#result .result-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.querySelector(".result-button")!.textContent).toBe(
      "Button 1",
    );
    expect(rows[0]!.querySelector(".result-count")!.textContent).toBe("1 press");
    expect(rows[1]!.querySelector(".result-count")!.textContent).toBe(
      "2 presses",
    );
    expect(document.querySelector(".result-summary")!.textContent).toBe(
      "3 presses in total",
    );

    expect(
      Array.from(document.querySelectorAll(".button-presses")).map(
        el => el.textContent,
      ),
    ).toEqual(["press ×1", "press ×2"]);
  });

  test("should mark a button the solution never presses", async () => {
    byId("add-button").click();
    spyOn(TurnSolver.prototype, "calculateTurnsAsync").mockImplementation(() =>
      Promise.resolve([2, 0]),
    );

    byId("calculate").click();
    await flush();

    const cards = document.querySelectorAll<HTMLElement>(".button-card");
    expect(cards[1]!.dataset.unused).toBe("true");
    expect(cards[1]!.querySelector(".button-presses")!.textContent).toBe(
      "not needed",
    );
    // Only the pressed button gets a row.
    expect(document.querySelectorAll("#result .result-row")).toHaveLength(1);
  });

  test("should drop a stale answer as soon as an input changes", async () => {
    spyOn(TurnSolver.prototype, "calculateTurnsAsync").mockImplementation(() =>
      Promise.resolve([2]),
    );

    byId("calculate").click();
    await flush();
    expect(byId("result").hidden).toBeFalse();

    document.querySelector<HTMLElement>(".turn-more")!.click();

    expect(byId("result").hidden).toBeTrue();
    expect(document.querySelector(".button-presses")!.classList).toContain(
      "hidden",
    );
  });

  test("should show a spinner while the search runs", async () => {
    let finish: (turns: number[] | null) => void = () => {};
    spyOn(TurnSolver.prototype, "calculateTurnsAsync").mockImplementation(
      () => new Promise(resolve => (finish = resolve)),
    );

    byId("result").hidden = false;
    byId("calculate").click();
    await flush();

    expect(byId("solve-spinner").classList.contains("hidden")).toBeFalse();
    expect(byId("calculate").hasAttribute("disabled")).toBeTrue();
    // The previous answer must not sit next to a running search.
    expect(byId("result").hidden).toBeTrue();

    finish([2]);
    await flush();

    expect(byId("solve-spinner").classList.contains("hidden")).toBeTrue();
    expect(byId("calculate").hasAttribute("disabled")).toBeFalse();
    expect(document.querySelector(".result-count")!.textContent).toBe(
      "2 presses",
    );
  });

  test("should discard a search that a reset outlived", async () => {
    let finish: (turns: number[] | null) => void = () => {};
    spyOn(TurnSolver.prototype, "calculateTurnsAsync").mockImplementation(
      () => new Promise(resolve => (finish = resolve)),
    );

    byId("calculate").click();
    await flush();
    byId("reset").click();
    finish([7]);
    await flush();

    expect(byId("solve-spinner").classList.contains("hidden")).toBeTrue();
    expect(byId("result").hidden).toBeTrue();
    expect(byId("result").textContent).toBe("");
  });

  test("should reset the puzzle to two dials and one button", () => {
    byId("add-dial").click();
    byId("add-button").click();
    setTurns(0, 0, 4);

    byId("reset").click();

    expect(dialColors()).toEqual(["blue", "red"]);
    expect(buttonTurns()).toEqual([["0", "0"]]);
  });

  test("test help dialog", () => {
    const dialog = byId("help-dialog") as HTMLElement & { open?: boolean };

    byId("help").click();

    expect(dialog.open).toBeTrue();
    expect(dialog.querySelectorAll("li")).toHaveLength(3);
    expect(dialog.querySelector("#help-close")).not.toBeNull();

    byId("help-close").click();

    expect(dialog.open).toBeFalse();
  });

  test("should load a config from a file", async () => {
    byId("result").hidden = false;

    await pick(
      JSON.stringify({
        maxValues: [3, 4, 5],
        initialValues: [1, 2, 0],
        buttons: [{ turns: [1, 0, 2] }, { turns: [0, 3, 1] }],
        result: [2, 1],
      }),
    );

    expect(dialColors()).toEqual(["blue", "red", "green"]);
    expect(
      Array.from(document.querySelectorAll(".dial-face")).map(face => [
        face.getAttribute("aria-valuemax"),
        face.getAttribute("aria-valuenow"),
      ]),
    ).toEqual([
      ["3", "1"],
      ["4", "2"],
      ["5", "0"],
    ]);
    expect(buttonTurns()).toEqual([
      ["1", "0", "2"],
      ["0", "3", "1"],
    ]);

    // A loaded config has not been solved on this page, so `result` in the file
    // says nothing about what is on screen.
    expect(byId("result").hidden).toBeTrue();
    expect(byId("warning-banner").classList.contains("hidden")).toBeTrue();
  });

  test("should warn about a file that is not valid JSON", async () => {
    await pick("not json");

    expect(byId("warning-banner").textContent).toBe(
      "The file is not valid JSON.",
    );
    expect(byId("warning-banner").classList.contains("hidden")).toBeFalse();
    // The page must be left exactly as it was.
    expect(dialColors()).toEqual(["blue", "red"]);
  });

  test("should warn about a config that fails validation", async () => {
    await pick(
      JSON.stringify({ maxValues: [3], initialValues: [0], buttons: [] }),
    );

    expect(byId("warning-banner").textContent).toBe(
      "Invalid config: maxValues must hold between 2 and 6 dials.",
    );
    expect(dialColors()).toEqual(["blue", "red"]);
  });

  test("should download the entered config, with the result once solved", async () => {
    const blobs: Blob[] = [];
    spyOn(URL, "createObjectURL").mockImplementation((blob: Blob) => {
      blobs.push(blob);
      return "blob:mock";
    });
    spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    const faces = document.querySelectorAll<SVGSVGElement>(".dial-face");
    press(faces[0]!, "ArrowRight");
    press(faces[1]!, "ArrowRight");
    press(faces[1]!, "ArrowRight");
    setTurns(0, 0, 1);
    setTurns(0, 1, 2);

    // Before solving, the download carries the inputs only.
    byId("download-config").click();
    expect(blobs).toHaveLength(1);
    expect(JSON.parse(await blobs[0]!.text())).toEqual({
      maxValues: [3, 3],
      initialValues: [1, 2],
      buttons: [{ turns: [1, 2] }],
    });

    byId("calculate").click();
    await flush();
    byId("download-config").click();
    expect(JSON.parse(await blobs[1]!.text()).result).toEqual([3]);

    // Editing an input invalidates the recorded solution.
    setTurns(0, 0, 3);
    byId("download-config").click();
    expect(JSON.parse(await blobs[2]!.text()).result).toBeUndefined();
  });
});

/** Types `turns` into one button card's slot for one dial. */
function setTurns(button: number, dial: number, turns: number) {
  const card = document.querySelectorAll(".button-card")[button]!;
  const input = card.querySelectorAll<HTMLInputElement>(".turn-input")[dial]!;
  input.value = String(turns);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function press(face: SVGSVGElement, key: string) {
  face.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
}

/** Hands a file to the page's own change handler and lets it settle. */
async function pick(contents: string) {
  const input = document.getElementById(
    "config-file-input",
  ) as HTMLInputElement;
  const file = new File([contents], "phasicDialTest.json", {
    type: "application/json",
  });
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  input.dispatchEvent(new Event("change"));
  // loadConfigFromFile is async; let its promise chain settle.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
