import { describe, expect, test } from "bun:test";
import { Block } from "../../src/pages/shifting-mosaic-solver/block";

describe("Block (shifting-mosaic)", () => {
  describe("Constructor", () => {
    test("sets id, type, and cells", () => {
      const cells = [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
      ];
      const block = new Block(7, "obstruction", cells);
      expect(block.id).toBe(7);
      expect(block.type).toBe("obstruction");
      expect(block.cells).toBe(cells);
    });

    test("supports goal type", () => {
      const block = new Block(2, "goal", [{ x: 4, y: 5 }]);
      expect(block.type).toBe("goal");
    });
  });

  describe("Has", () => {
    test("returns true for an included cell", () => {
      const block = new Block(1, "obstruction", [
        { x: 2, y: 3 },
        { x: 4, y: 5 },
      ]);
      expect(block.has(2, 3)).toBe(true);
      expect(block.has(4, 5)).toBe(true);
    });

    test("returns false for cells not in the block", () => {
      const block = new Block(1, "obstruction", [{ x: 2, y: 3 }]);
      expect(block.has(2, 4)).toBe(false);
      expect(block.has(0, 0)).toBe(false);
      expect(block.has(-1, -1)).toBe(false);
    });
  });

  describe("GetRelativePositions", () => {
    test("shape already anchored at origin returns identical positions", () => {
      const block = new Block(1, "obstruction", [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 0, y: 1 },
      ]);
      expect(block.getRelativePositions()).toEqual([
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 0, y: 1 },
      ]);
    });

    test("offset shape is normalized to bounding-box top-left", () => {
      const block = new Block(1, "goal", [
        { x: 5, y: 7 },
        { x: 6, y: 7 },
        { x: 5, y: 8 },
      ]);
      expect(block.getRelativePositions()).toEqual([
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 0, y: 1 },
      ]);
    });

    test("single cell normalizes to origin", () => {
      const block = new Block(1, "goal", [{ x: 4, y: 9 }]);
      expect(block.getRelativePositions()).toEqual([{ x: 0, y: 0 }]);
    });

    test("L-shape preserves layout after normalization", () => {
      const block = new Block(1, "obstruction", [
        { x: 3, y: 5 },
        { x: 4, y: 5 },
        { x: 5, y: 5 },
        { x: 3, y: 6 },
      ]);
      expect(block.getRelativePositions()).toEqual([
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 2, y: 0 },
        { x: 0, y: 1 },
      ]);
    });

    test("non-rectangular shape with disjoint columns normalizes via min-x and min-y separately", () => {
      const block = new Block(1, "obstruction", [
        { x: 4, y: 7 },
        { x: 6, y: 7 },
        { x: 4, y: 9 },
      ]);
      expect(block.getRelativePositions()).toEqual([
        { x: 0, y: 0 },
        { x: 2, y: 0 },
        { x: 0, y: 2 },
      ]);
    });
  });

  describe("GetBoundingBox", () => {
    test("1x1 block", () => {
      expect(
        new Block(1, "obstruction", [{ x: 4, y: 9 }]).getBoundingBox(),
      ).toEqual({ width: 1, height: 1 });
    });

    test("3x1 horizontal block", () => {
      expect(
        new Block(1, "obstruction", [
          { x: 1, y: 0 },
          { x: 2, y: 0 },
          { x: 3, y: 0 },
        ]).getBoundingBox(),
      ).toEqual({ width: 3, height: 1 });
    });

    test("1x4 vertical block", () => {
      expect(
        new Block(1, "obstruction", [
          { x: 0, y: 0 },
          { x: 0, y: 1 },
          { x: 0, y: 2 },
          { x: 0, y: 3 },
        ]).getBoundingBox(),
      ).toEqual({ width: 1, height: 4 });
    });

    test("L-shape returns enclosing rectangle", () => {
      expect(
        new Block(1, "obstruction", [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
          { x: 2, y: 0 },
          { x: 0, y: 1 },
        ]).getBoundingBox(),
      ).toEqual({ width: 3, height: 2 });
    });

    test("offset shape uses min/max coordinates", () => {
      expect(
        new Block(1, "goal", [
          { x: 5, y: 7 },
          { x: 7, y: 9 },
        ]).getBoundingBox(),
      ).toEqual({ width: 3, height: 3 });
    });
  });
});
