import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
  type Mock,
} from "bun:test";
import { Block } from "../../src/pages/rolling-blocks-solver/block";
import { Direction } from "../../src/pages/rolling-blocks-solver/directions";
import type { BoundsTest, OverlapTest, Tile } from "../../src/util/types";
import { indexToBitmask, positionToIndex } from "../../src/util/utilMethods";

afterEach(() => {
  mock.restore();
});

describe("Block", () => {
  describe("Roll", () => {
    const upCases = [
      [new Block(1, 3, 3, 1, 2, 3), new Block(1, 3, 0, 1, 3, 2)],
      [new Block(1, 3, 3, 1, 3, 2), new Block(1, 3, 1, 1, 2, 3)],
      [new Block(1, 3, 3, 2, 1, 3), new Block(1, 3, 0, 2, 3, 1)],
      [new Block(1, 3, 3, 2, 3, 1), new Block(1, 3, 2, 2, 1, 3)],
      [new Block(1, 3, 3, 3, 1, 2), new Block(1, 3, 1, 3, 2, 1)],
      [new Block(1, 3, 3, 3, 2, 1), new Block(1, 3, 2, 3, 1, 2)],
    ];

    const rightCases = [
      [new Block(1, 3, 3, 1, 2, 3), new Block(1, 4, 3, 3, 2, 1)],
      [new Block(1, 3, 3, 1, 3, 2), new Block(1, 4, 3, 2, 3, 1)],
      [new Block(1, 3, 3, 2, 1, 3), new Block(1, 5, 3, 3, 1, 2)],
      [new Block(1, 3, 3, 2, 3, 1), new Block(1, 5, 3, 1, 3, 2)],
      [new Block(1, 3, 3, 3, 1, 2), new Block(1, 6, 3, 2, 1, 3)],
      [new Block(1, 3, 3, 3, 2, 1), new Block(1, 6, 3, 1, 2, 3)],
    ];

    const downCases = [
      [new Block(1, 3, 3, 1, 2, 3), new Block(1, 3, 5, 1, 3, 2)],
      [new Block(1, 3, 3, 1, 3, 2), new Block(1, 3, 6, 1, 2, 3)],
      [new Block(1, 3, 3, 2, 1, 3), new Block(1, 3, 4, 2, 3, 1)],
      [new Block(1, 3, 3, 2, 3, 1), new Block(1, 3, 6, 2, 1, 3)],
      [new Block(1, 3, 3, 3, 1, 2), new Block(1, 3, 4, 3, 2, 1)],
      [new Block(1, 3, 3, 3, 2, 1), new Block(1, 3, 5, 3, 1, 2)],
    ];

    const leftCases = [
      [new Block(1, 3, 3, 1, 2, 3), new Block(1, 0, 3, 3, 2, 1)],
      [new Block(1, 3, 3, 1, 3, 2), new Block(1, 1, 3, 2, 3, 1)],
      [new Block(1, 3, 3, 2, 1, 3), new Block(1, 0, 3, 3, 1, 2)],
      [new Block(1, 3, 3, 2, 3, 1), new Block(1, 2, 3, 1, 3, 2)],
      [new Block(1, 3, 3, 3, 1, 2), new Block(1, 1, 3, 2, 1, 3)],
      [new Block(1, 3, 3, 3, 2, 1), new Block(1, 2, 3, 1, 2, 3)],
    ];

    test.each(upCases)("should roll up %#", (initial, expected) => {
      initial.roll(Direction.UP);
      expect(initial).toEqual(expected);
    });

    test.each(rightCases)("should roll right %#", (initial, expected) => {
      initial.roll(Direction.RIGHT);
      expect(initial).toEqual(expected);
    });

    test.each(downCases)("should roll down %#", (initial, expected) => {
      initial.roll(Direction.DOWN);
      expect(initial).toEqual(expected);
    });

    test.each(leftCases)("should roll left %#", (initial, expected) => {
      initial.roll(Direction.LEFT);
      expect(initial).toEqual(expected);
    });
  });

  describe("Clone", () => {
    test("changes to clone should not affect original", () => {
      const original = new Block(1, 3, 3, 1, 2, 3);
      const clone = original.clone();
      original.x = 0;
      expect(original).not.toEqual(clone);
      clone.x = 0;
      expect(original).toEqual(clone);
    });
  });

});