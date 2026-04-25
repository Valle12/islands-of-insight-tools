import { describe, expect, test } from "bun:test";
import type {
  CartesianProductTest,
  LcmTest,
  PositionToIndexTest,
} from "../src/util/types";
import {
  cartesianProduct,
  extractBit,
  gcd,
  indexToBitmask,
  lcm,
  positionToIndex,
} from "../src/util/utilMethods";

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

describe("PositionToIndex", () => {
  const cases: PositionToIndexTest[] = [
    { x: 0, y: 0, gridWidth: 5, result: 0n },
    { x: 1, y: 0, gridWidth: 5, result: 1n },
    { x: 0, y: 1, gridWidth: 5, result: 5n },
    { x: 2, y: 3, gridWidth: 5, result: 17n },
    { x: 4, y: 4, gridWidth: 5, result: 24n },
  ];

  test.each(cases)(
    "index for position (%d, %d) with grid width %d",
    ({ x, y, gridWidth, result }) => {
      expect(positionToIndex(x, y, gridWidth)).toBe(result);
    },
  );
});

describe("IndexToBitmask", () => {
  const cases = [
    [0n, 1n],
    [1n, 2n],
    [2n, 4n],
    [5n, 32n],
    [10n, 1024n],
  ];

  test.each(cases)("bitmask for index %d", (index: bigint, result: bigint) => {
    expect(indexToBitmask(index)).toBe(result);
  });

  test("calculating complex bitmask", () => {
    let bitmask = 0n;
    let oldSingleBit = 1n;
    let singleBit = 1n;

    for (let i = 0n; i < 40n; i++) {
      singleBit = indexToBitmask(i);
      if (i > 0n) expect(singleBit).toBe(oldSingleBit * 2n);
      oldSingleBit = singleBit;
      bitmask |= singleBit;
    }

    expect(bitmask).toBe((1n << 40n) - 1n);
  });
});

describe("ExtractBit", () => {
  test("extracting bits from alterating bitmask", () => {
    let bitmask = 2730n;

    for (let i = 0n; i < 12n; i++) {
      expect(extractBit(bitmask, i)).toBe(0n);
      i++;
      expect(extractBit(bitmask, i)).toBe(1n);
    }
  });

  test("extracting bits from bitmask with all bits set", () => {
    const bitmask = (1n << 20n) - 1n;

    for (let i = 0n; i < 20n; i++) {
      expect(extractBit(bitmask, i)).toBe(1n);
    }
  });

  test("extracting specific bits from bitmask", () => {
    let bitmask = 32n;
    expect(extractBit(bitmask, 5n)).toBe(1n);
    expect(extractBit(bitmask, 6n)).toBe(0n);

    bitmask = 1025n;
    expect(extractBit(bitmask, 0n)).toBe(1n);
    expect(extractBit(bitmask, 10n)).toBe(1n);
    expect(extractBit(bitmask, 5n)).toBe(0n);
  });
});
