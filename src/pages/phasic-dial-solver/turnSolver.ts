import { cartesianProduct, gcd, lcm, mod } from "../../util/utilMethods";
import type { Button } from "./button";

export class TurnSolver {
  private maxValues: number[];
  private initialValues: number[];
  private buttons: Button[];

  constructor(maxValues: number[], initialValues: number[], buttons: Button[]) {
    this.maxValues = maxValues;
    this.initialValues = initialValues;
    this.buttons = buttons;
  }

  calculateTurns(): number[] | null {
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

    for (const combination of cartesianProduct(limits)) {
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
