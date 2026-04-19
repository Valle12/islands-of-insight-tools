import { describe, expect, test } from "bun:test";
import { Button } from "../src/pages/phasic-dial-solver/button";
import { TurnSolver } from "../src/pages/phasic-dial-solver/turnSolver";
import type { SolverTest } from "../src/util/types";

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
