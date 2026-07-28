import { cartesianProduct, gcd, lcm, mod } from "../../util/utilMethods";
import type { Button } from "./button";

export class TurnSolver {
  /**
   * Combinations examined between hand-backs to the event loop. The search is
   * a cartesian product over every button's cycle length, so a six-dial puzzle
   * with a handful of buttons runs into the tens of millions of combinations —
   * seconds of straight-line work. Chunking it lets the page paint its spinner
   * and stay clickable; the size is picked so one chunk is roughly one frame.
   */
  private static readonly YIELD_INTERVAL = 50_000;

  private readonly maxValues: number[];
  private readonly initialValues: number[];
  private readonly buttons: Button[];

  constructor(maxValues: number[], initialValues: number[], buttons: Button[]) {
    this.maxValues = maxValues;
    this.initialValues = initialValues;
    this.buttons = buttons;
  }

  /** Runs the whole search without interruption. */
  calculateTurns(): number[] | null {
    const steps = this.searchSteps();
    let step = steps.next();
    while (!step.done) step = steps.next();
    return step.value;
  }

  /**
   * The same search, spread across event-loop turns so the caller's UI keeps
   * responding. Returns exactly what `calculateTurns` would.
   */
  async calculateTurnsAsync(): Promise<number[] | null> {
    const steps = this.searchSteps();
    let step = steps.next();
    while (!step.done) {
      await new Promise(resolve => setTimeout(resolve, 0));
      step = steps.next();
    }
    return step.value;
  }

  /** The search itself, pausing every `YIELD_INTERVAL` combinations. */
  private *searchSteps(): Generator<void, number[] | null> {
    const moduli = this.maxValues.map(v => v + 1);
    const limits = this.buttons.map(button => {
      const cycleLengths = button.getTurns().map((turn, index) => {
        const modulo = moduli[index]!;
        return modulo / gcd(modulo, mod(turn, modulo) || modulo);
      });
      return lcm(cycleLengths);
    });

    let bestCombination: number[] | null = null;
    let bestSteps = Infinity;
    let sinceYield = 0;

    for (const combination of cartesianProduct(limits)) {
      if (++sinceYield >= TurnSolver.YIELD_INTERVAL) {
        sinceYield = 0;
        yield;
      }

      const values = this.initialValues.slice();

      for (let b = 0; b < this.buttons.length; b++) {
        const presses = combination[b]!;
        const turns = this.buttons[b]!.getTurns();
        for (let d = 0; d < values.length; d++) {
          values[d] = mod(values[d]! + turns[d]! * presses, moduli[d]!);
        }
      }

      if (values.every(v => v === 0)) {
        const totalSteps = combination.reduce(
          (sum, presses) => sum + presses,
          0,
        );
        if (totalSteps < bestSteps) {
          bestSteps = totalSteps;
          bestCombination = combination.slice();
        }
      }
    }

    return bestCombination;
  }
}
