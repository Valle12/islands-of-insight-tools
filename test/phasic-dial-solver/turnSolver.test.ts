import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { Button } from "../../src/pages/phasic-dial-solver/button";
import { validateConfig } from "../../src/pages/phasic-dial-solver/config";
import { TurnSolver } from "../../src/pages/phasic-dial-solver/turnSolver";
import type { SolverTest } from "../../src/util/types";

describe("TurnSolver", () => {
  const cases: SolverTest[] = [
    {
      maxValues: [3, 4, 5],
      initialValues: [1, 1, 2],
      buttons: [
        new Button([1, 0, 0]),
        new Button([0, 1, 0]),
        new Button([0, 0, 1]),
      ],
      result: [3, 4, 4],
    },
    {
      maxValues: [3, 4, 5],
      initialValues: [1, 2, 3],
      buttons: [
        new Button([1, 0, 0]),
        new Button([0, 3, 0]),
        new Button([0, 0, 5]),
      ],
      result: [3, 1, 3],
    },
    {
      maxValues: [4, 3, 5],
      initialValues: [1, 1, 1],
      buttons: [new Button([1, 0, 0]), new Button([0, 1, 1])],
      result: [4, 11],
    },
    {
      maxValues: [4, 3, 4, 5],
      initialValues: [2, 2, 2, 3],
      buttons: [
        new Button([4, 0, 0, 0]),
        new Button([3, 3, 0, 0]),
        new Button([2, 0, 2, 0]),
        new Button([1, 0, 0, 1]),
      ],
      result: [4, 2, 4, 3],
    },
    {
      maxValues: [5, 4, 5, 4, 4],
      initialValues: [4, 1, 2, 1, 4],
      buttons: [
        new Button([1, 2, 3, 1, 2]),
        new Button([1, 0, 0, 0, 0]),
        new Button([0, 3, 0, 0, 0]),
        new Button([0, 0, 1, 0, 0]),
        new Button([0, 0, 0, 0, 1]),
      ],
      result: [4, 4, 2, 4, 3],
    },
    {
      maxValues: [4, 3, 4, 5],
      initialValues: [0, 3, 2, 3],
      buttons: [
        new Button([2, 3, 2, 2]),
        new Button([1, 0, 3, 3]),
        new Button([3, 0, 0, 1]),
        new Button([1, 0, 0, 0]),
      ],
      result: [3, 4, 3, 1],
    },
    {
      maxValues: [4, 4, 4, 3],
      initialValues: [1, 4, 1, 0],
      buttons: [
        new Button([1, 1, 0, 0]),
        new Button([0, 3, 2, 0]),
        new Button([0, 0, 1, 1]),
      ],
      result: [4, 4, 16],
    },
    {
      maxValues: [4, 5, 4],
      initialValues: [3, 5, 1],
      buttons: [new Button([1, 2, 0]), new Button([0, 3, 1])],
      result: [2, 9],
    },
    {
      maxValues: [3, 3],
      initialValues: [1, 2],
      buttons: [new Button([1, 1]), new Button([2, 2]), new Button([1, 2])],
      result: [0, 0, 3],
    },
    {
      maxValues: [3, 5],
      initialValues: [3, 0],
      buttons: [new Button([2, 0]), new Button([1, 2]), new Button([1, 3])],
      result: [1, 3, 0],
    },
    {
      maxValues: [3, 3],
      initialValues: [0, 1],
      buttons: [new Button([1, 2]), new Button([1, 3])],
      result: [1, 3],
    },
    {
      maxValues: [5, 5, 5],
      initialValues: [5, 0, 1],
      buttons: [
        new Button([1, 1, 0]),
        new Button([0, 1, 1]),
        new Button([1, 0, 1]),
      ],
      result: [1, 5, 0],
    },
    {
      maxValues: [3, 5, 4],
      initialValues: [2, 4, 2],
      buttons: [new Button([1, 1, 0]), new Button([0, 1, 1])],
      result: [6, 8],
    },
    {
      maxValues: [5, 5, 3, 4],
      initialValues: [2, 4, 1, 1],
      buttons: [
        new Button([2, 2, 0, 0]),
        new Button([0, 2, 2, 0]),
        new Button([2, 0, 2, 0]),
        new Button([0, 0, 1, 2]),
      ],
      result: [2, 2, 0, 7],
    },
    {
      maxValues: [3, 5, 3, 4],
      initialValues: [3, 5, 3, 4],
      buttons: [
        new Button([2, 2, 0, 0]),
        new Button([0, 3, 2, 0]),
        new Button([0, 0, 1, 2]),
        new Button([1, 0, 0, 1]),
      ],
      result: [2, 1, 3, 5],
    },
    {
      maxValues: [4, 5, 4, 3],
      initialValues: [1, 4, 2, 3],
      buttons: [new Button([0, 1, 1, 1]), new Button([3, 3, 2, 2])],
      result: [47, 3],
    },
    {
      maxValues: [4, 4, 4],
      initialValues: [1, 1, 1],
      buttons: [
        new Button([1, 3, 2]),
        new Button([0, 3, 2]),
        new Button([1, 3, 0]),
      ],
      result: [3, 4, 1],
    },
    {
      maxValues: [3, 5, 4, 5],
      initialValues: [3, 1, 2, 1],
      buttons: [
        new Button([1, 1, 0, 0]),
        new Button([0, 1, 1, 0]),
        new Button([1, 1, 0, 3]),
        new Button([0, 2, 0, 1]),
      ],
      result: [0, 8, 5, 2],
    },
  ];

  test.each(cases)("calculateTurns %#", (input: SolverTest) => {
    const maxValues = input.maxValues;
    const initialValues = input.initialValues;
    const buttons = input.buttons;
    const result = input.result;
    const solver = new TurnSolver(maxValues, initialValues, buttons);
    const turns = solver.calculateTurns();
    expect(turns).toEqual(result);
  });
});

// Real puzzles captured from the game with the page's download button. Every
// `phasicDialTest*.json` in test/resources/phasic-dial-solver is picked up
// automatically, so adding a fixture needs no change here — the file already
// carries its own expected `result`. Discovery is by directory listing rather
// than a hard-coded list so a captured puzzle cannot be dropped in and
// silently never run.
const fixtureDir = join(import.meta.dir, "../resources/phasic-dial-solver");
const fixtures = readdirSync(fixtureDir)
  .filter(name => /^phasicDialTest\d*\.json$/.test(name))
  .sort(
    (a, b) =>
      Number(/(\d*)\.json$/.exec(a)![1] || 0) -
      Number(/(\d*)\.json$/.exec(b)![1] || 0),
  );

describe.if(fixtures.length > 0)("TurnSolver fixtures", () => {
  test.each(fixtures)("%s", async filename => {
    const data = await Bun.file(join(fixtureDir, filename)).json();
    const parsed = validateConfig(data);
    expect(parsed.ok).toBeTrue();
    if (!parsed.ok) return;
    // A fixture without a result records no expectation, so it would pass
    // whatever the solver returned.
    expect(parsed.config.result).toBeDefined();

    const solver = new TurnSolver(
      parsed.config.maxValues,
      parsed.config.initialValues,
      parsed.config.buttons,
    );
    expect(solver.calculateTurns()).toEqual(parsed.config.result!);
  });
});
