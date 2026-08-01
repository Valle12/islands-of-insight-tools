import { describe, expect, test } from "bun:test";
import {
  balancedColumns,
  columnCapacity,
} from "../../src/pages/phasic-dial-solver/layout";

describe("columnCapacity", () => {
  test("counts the items that fit, gaps included", () => {
    // 170px cards (148 of content plus padding and border) with a 12px gap:
    // four need 4*170 + 3*12 = 716px, a fifth pushes that to 898px.
    expect(columnCapacity(716, 170, 12)).toBe(4);
    expect(columnCapacity(897, 170, 12)).toBe(4);
    expect(columnCapacity(898, 170, 12)).toBe(5);
  });

  test("never reports room for less than one item", () => {
    expect(columnCapacity(20, 148, 12)).toBe(1);
  });

  test("an unmeasured container or item claims unlimited room", () => {
    // Zero means "not laid out yet", not "nothing fits" — pretending one card
    // fits would wrap a list that is about to be perfectly fine, and a zero
    // item width would divide the container into an unbounded number of them.
    expect(columnCapacity(0, 148, 12)).toBe(Infinity);
    expect(columnCapacity(932, 0, 12)).toBe(Infinity);
  });
});

describe("balancedColumns", () => {
  test("keeps everything on one row while it fits", () => {
    expect(balancedColumns(5, 5)).toBe(5);
    expect(balancedColumns(3, 5)).toBe(3);
    expect(balancedColumns(1, 5)).toBe(1);
  });

  test("splits an overflowing row evenly instead of filling it", () => {
    // The case that started this: six items in a five-wide row, which
    // `flex-wrap` lays out as 5 + 1.
    expect(balancedColumns(6, 5)).toBe(3);
    expect(balancedColumns(6, 4)).toBe(3);
    // Five in a four-wide row: 3 + 2, so the top row carries the odd one.
    expect(balancedColumns(5, 4)).toBe(3);
  });

  test("never puts more than capacity on a row", () => {
    for (let count = 1; count <= 12; count++) {
      for (let capacity = 1; capacity <= 6; capacity++) {
        const cols = balancedColumns(count, capacity);
        expect(cols).toBeLessThanOrEqual(Math.max(capacity, count));
        if (count > capacity) expect(cols).toBeLessThanOrEqual(capacity);
      }
    }
  });

  test("leaves the last row no fuller than the ones above it", () => {
    for (let count = 1; count <= 12; count++) {
      for (let capacity = 1; capacity <= 6; capacity++) {
        const cols = balancedColumns(count, capacity);
        const last = count % cols === 0 ? cols : count % cols;
        expect(last).toBeLessThanOrEqual(cols);
      }
    }
  });

  test("survives a container that was never measured", () => {
    expect(balancedColumns(6, Infinity)).toBe(6);
    expect(balancedColumns(6, 0)).toBe(6);
  });
});
