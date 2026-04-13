import type { Button } from "./button";

export class Solver {
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
      const cycleLengths = button.getTurns().map((t, d) => {
        const m = moduli[d]!;
        return m / this.gcd(m, ((t % m) + m) % m || m);
      });
      return this.calculateLcm(cycleLengths);
    });

    for (const combination of this.generateCombinations(limits)) {
      const values = this.initialValues.slice();

      for (let b = 0; b < this.buttons.length; b++) {
        const presses = combination[b]!;
        const turns = this.buttons[b]!.getTurns();
        for (let d = 0; d < values.length; d++) {
          values[d] =
            (((values[d]! + turns[d]! * presses) % moduli[d]!) + moduli[d]!) %
            moduli[d]!;
        }
      }

      if (values.every(v => v === 0)) {
        return combination;
      }
    }

    return null;
  }

  private *generateCombinations(limits: number[]): Generator<number[]> {
    const numButtons = this.buttons.length;
    const combination = new Array<number>(numButtons).fill(0);

    while (true) {
      yield combination.slice();

      let carry = true;
      for (let i = numButtons - 1; i >= 0 && carry; i--) {
        combination[i]!++;
        if (combination[i]! >= limits[i]!) {
          combination[i] = 0;
        } else {
          carry = false;
        }
      }

      if (carry) break;
    }
  }

  private gcd(a: number, b: number): number {
    while (b) {
      [a, b] = [b, a % b];
    }
    return a;
  }

  private calculateLcm(values: number[]): number {
    return values.reduce((acc, v) => (acc * v) / this.gcd(acc, v), 1);
  }
}
