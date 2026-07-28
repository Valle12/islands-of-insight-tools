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
  describe("UpdateMustTouchCells", () => {
    test("should not update anything if no mustTouch cells are on the grid", () => {
      const block = new Block(1, 1, 1, 1, 1, 1);
      const cells: Tile[][] = Array.from({ length: 5 }, () =>
        Array.from({ length: 5 }, () => "regular"),
      );

      const result = block.updateMustTouchCells(5, cells, 0n);

      expect(result).toBe(0n);
    });

    test("grid contains mustTouch cells, but block does not overlap any of them", () => {
      const block = new Block(1, 1, 1, 1, 1, 1);
      const cells: Tile[][] = Array.from({ length: 5 }, () =>
        Array.from({ length: 5 }, () => "regular"),
      );
      cells[0]![0] = "mustTouch";
      cells[4]![4] = "mustTouch";

      const result = block.updateMustTouchCells(5, cells, 0n);

      expect(result).toBe(0n);
    });

    test("block overlaps some mustTouch cells, but not all", () => {
      const block = new Block(1, 1, 1, 2, 2, 2);
      const cells: Tile[][] = Array.from({ length: 5 }, () =>
        Array.from({ length: 5 }, () => "regular"),
      );
      cells[1]![1] = "mustTouch";
      cells[2]![2] = "mustTouch";
      cells[3]![3] = "mustTouch";

      const result = block.updateMustTouchCells(5, cells, 0n);

      expect(result).toBe(4160n);
    });
  });
});