import { describe, expect, test } from "bun:test";
import type { CartesianProductTest, LcmTest } from "../src/util/types";
import { cartesianProduct, gcd, lcm } from "../src/util/utilMethods";

describe("Gcd", () => {
  const cases = [
    [48, 18, 6],
    [12, 18, 6],
    [4, 9, 1],
    [20, 30, 10],
    [42, 56, 14],
    [24, 36, 12],
    [168, 180, 12],
    [1071, 462, 21],
  ];

  test.each(cases)(
    "gcd of %d and %d",
    (a: number, b: number, result: number) => {
      expect(gcd(a, b)).toBe(result);
    },
  );
});

describe("Lcm", () => {
  const cases: LcmTest[] = [
    { values: [3, 4, 6], result: 12 },
    {
      values: [12, 15],
      result: 60,
    },
    {
      values: [2, 6, 9],
      result: 18,
    },
    {
      values: [2, 3],
      result: 6,
    },
    {
      values: [6, 10],
      result: 30,
    },
    {
      values: [6, 7, 21],
      result: 42,
    },
    {
      values: [24, 300],
      result: 600,
    },
    {
      values: [12, 18, 30],
      result: 180,
    },
    {
      values: [10, 12, 15, 75],
      result: 300,
    },
    {
      values: [10, 18, 25],
      result: 450,
    },
  ];

  test.each(cases)("lcm of $values", ({ values, result }: LcmTest) => {
    expect(lcm(values)).toBe(result);
  });
});

describe("CartesianProduct", () => {
  const cases: CartesianProductTest[] = [
    {
      limits: [0],
      result: [[0]],
    },
    {
      limits: [1],
      result: [[0]],
    },
    {
      limits: [2],
      result: [[0], [1]],
    },
    {
      limits: [0, 2],
      result: [
        [0, 0],
        [0, 1],
      ],
    },
    {
      limits: [1, 2],
      result: [
        [0, 0],
        [0, 1],
      ],
    },
    {
      limits: [2, 3],
      result: [
        [0, 0],
        [0, 1],
        [0, 2],
        [1, 0],
        [1, 1],
        [1, 2],
      ],
    },
    {
      limits: [2, 3, 4],
      result: [
        [0, 0, 0],
        [0, 0, 1],
        [0, 0, 2],
        [0, 0, 3],
        [0, 1, 0],
        [0, 1, 1],
        [0, 1, 2],
        [0, 1, 3],
        [0, 2, 0],
        [0, 2, 1],
        [0, 2, 2],
        [0, 2, 3],
        [1, 0, 0],
        [1, 0, 1],
        [1, 0, 2],
        [1, 0, 3],
        [1, 1, 0],
        [1, 1, 1],
        [1, 1, 2],
        [1, 1, 3],
        [1, 2, 0],
        [1, 2, 1],
        [1, 2, 2],
        [1, 2, 3],
      ],
    },
    {
      limits: [2, 0, 2],
      result: [
        [0, 0, 0],
        [0, 0, 1],
        [1, 0, 0],
        [1, 0, 1],
      ],
    },
  ];

  test.each(cases)(
    "cartesian product of $limits",
    ({ limits, result }: CartesianProductTest) => {
      const generated = Array.from(cartesianProduct(limits));
      expect(generated).toEqual(result);
    },
  );
});
