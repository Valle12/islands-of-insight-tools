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

describe("CheckValidity", () => {
  let checkOutOfBoundsSpy: Mock<any>;
  let checkBlockCollisionsSpy: Mock<any>;
  let checkBlockingCellsSpy: Mock<any>;

  beforeEach(() => {
    checkOutOfBoundsSpy = spyOn(Block.prototype as any, "checkOutOfBounds");
    checkBlockCollisionsSpy = spyOn(
      Block.prototype as any,
      "checkBlockCollisions",
    );
    checkBlockingCellsSpy = spyOn(Block.prototype as any, "checkBlockingCells");
  });

  const cells: Tile[][] = Array.from({ length: 5 }, () =>
    Array.from({ length: 5 }, () => "mustTouch"),
  );
  cells[4]![0] = "unplayable";
  cells[0]![4] = "unplayable";
  cells[4]![4] = "unplayable";
  const blocks: Block[] = [];
  let mustTouchCellsSatisfied = 0n;
  mustTouchCellsSatisfied |= indexToBitmask(positionToIndex(0, 0, 5));
  mustTouchCellsSatisfied |= indexToBitmask(positionToIndex(1, 0, 5));
  mustTouchCellsSatisfied |= indexToBitmask(positionToIndex(0, 1, 5));
  mustTouchCellsSatisfied |= indexToBitmask(positionToIndex(1, 1, 5));
  mustTouchCellsSatisfied |= indexToBitmask(positionToIndex(2, 2, 5));
  mustTouchCellsSatisfied |= indexToBitmask(positionToIndex(3, 2, 5));
  mustTouchCellsSatisfied |= indexToBitmask(positionToIndex(2, 3, 5));
  mustTouchCellsSatisfied |= indexToBitmask(positionToIndex(3, 3, 5));

  const completelyOutOfBoundsCases: BoundsTest[] = [
    { x: -3, y: -3, position: "topleft" },
    { x: 1, y: -3, position: "top" },
    { x: 6, y: -3, position: "topright" },
    { x: 6, y: 1, position: "right" },
    { x: 6, y: 6, position: "bottomright" },
    { x: 2, y: 6, position: "bottom" },
    { x: -3, y: 6, position: "bottomleft" },
    { x: -3, y: 2, position: "left" },
  ];

  const partiallyOutOfBoundsCases: BoundsTest[] = [
    { x: 2, y: -1, position: "top" },
    { x: 4, y: -1, position: "topright" },
    { x: 4, y: 2, position: "right" },
    { x: 4, y: 4, position: "bottomright" },
    { x: 1, y: 4, position: "bottom" },
    { x: -1, y: 4, position: "bottomleft" },
    { x: -1, y: 1, position: "left" },
    { x: -1, y: -1, position: "topleft" },
  ];

  const inBoundsCases: BoundsTest[] = [
    { x: 0, y: 0, position: "topleft" },
    { x: 1, y: 0, position: "top" },
    { x: 3, y: 0, position: "topright" },
    { x: 3, y: 1, position: "right" },
    { x: 3, y: 3, position: "bottomright" },
    { x: 2, y: 3, position: "bottom" },
    { x: 0, y: 3, position: "bottomleft" },
    { x: 0, y: 2, position: "left" },
    { x: 1, y: 1, position: "center" },
  ];

  const blockOverlapCases: OverlapTest[] = [
    {
      block1: new Block(1, 1, 1, 3, 2, 1),
      block2: new Block(2, 1, 1, 1, 2, 3),
      blockType: "second block 1x2, 0",
    },
    {
      block1: new Block(1, 1, 1, 3, 2, 1),
      block2: new Block(2, 2, 1, 1, 2, 3),
      blockType: "second block 1x2, 1",
    },
    {
      block1: new Block(1, 1, 1, 3, 2, 1),
      block2: new Block(2, 3, 1, 1, 2, 3),
      blockType: "second block 1x2, 2",
    },
    {
      block1: new Block(1, 1, 1, 3, 2, 1),
      block2: new Block(2, 1, 2, 1, 2, 3),
      blockType: "second block 1x2, 3",
    },
    {
      block1: new Block(1, 1, 1, 3, 2, 1),
      block2: new Block(2, 2, 2, 1, 2, 3),
      blockType: "second block 1x2, 4",
    },
    {
      block1: new Block(1, 1, 1, 3, 2, 1),
      block2: new Block(2, 3, 2, 1, 2, 3),
      blockType: "second block 1x2, 5",
    },
    {
      block1: new Block(1, 1, 1, 3, 2, 1),
      block2: new Block(2, 1, 1, 1, 1, 1),
      blockType: "second block 1x1, 0",
    },
    {
      block1: new Block(1, 1, 1, 3, 2, 1),
      block2: new Block(2, 2, 1, 1, 1, 1),
      blockType: "second block 1x1, 1",
    },
    {
      block1: new Block(1, 1, 1, 3, 2, 1),
      block2: new Block(2, 3, 1, 1, 1, 1),
      blockType: "second block 1x1, 2",
    },
    {
      block1: new Block(1, 1, 1, 3, 2, 1),
      block2: new Block(2, 1, 2, 1, 1, 1),
      blockType: "second block 1x1, 3",
    },
    {
      block1: new Block(1, 1, 1, 3, 2, 1),
      block2: new Block(2, 2, 2, 1, 1, 1),
      blockType: "second block 1x1, 4",
    },
    {
      block1: new Block(1, 1, 1, 3, 2, 1),
      block2: new Block(2, 3, 2, 1, 1, 1),
      blockType: "second block 1x1, 5",
    },
    {
      block1: new Block(1, 0, 0, 1, 1, 1),
      block2: new Block(2, 0, 0, 1, 1, 1),
      blockType: "both blocks 1x1, 0",
    },
    {
      block1: new Block(1, 4, 0, 1, 1, 1),
      block2: new Block(2, 4, 0, 1, 1, 1),
      blockType: "both blocks 1x1, 1",
    },
    {
      block1: new Block(1, 4, 4, 1, 1, 1),
      block2: new Block(2, 4, 4, 1, 1, 1),
      blockType: "both blocks 1x1, 2",
    },
    {
      block1: new Block(1, 0, 4, 1, 1, 1),
      block2: new Block(2, 0, 4, 1, 1, 1),
      blockType: "both blocks 1x1, 3",
    },
    {
      block1: new Block(1, 0, 0, 3, 3, 3),
      block2: new Block(2, 0, 0, 3, 3, 3),
      blockType: "both blocks 3x3, 0",
    },
    {
      block1: new Block(1, 2, 0, 3, 3, 3),
      block2: new Block(2, 2, 0, 3, 3, 3),
      blockType: "both blocks 3x3, 1",
    },
    {
      block1: new Block(1, 2, 2, 3, 3, 3),
      block2: new Block(2, 2, 2, 3, 3, 3),
      blockType: "both blocks 3x3, 2",
    },
    {
      block1: new Block(1, 0, 2, 3, 3, 3),
      block2: new Block(2, 0, 2, 3, 3, 3),
      blockType: "both blocks 3x3, 3",
    },
    {
      block1: new Block(1, 1, 1, 1, 1, 1),
      block2: new Block(2, 0, 0, 3, 3, 3),
      blockType: "second block including first block, 0",
    },
    {
      block1: new Block(1, 3, 1, 1, 1, 1),
      block2: new Block(2, 2, 0, 3, 3, 3),
      blockType: "second block including first block, 1",
    },
    {
      block1: new Block(1, 3, 3, 1, 1, 1),
      block2: new Block(2, 2, 2, 3, 3, 3),
      blockType: "second block including first block, 2",
    },
    {
      block1: new Block(1, 1, 3, 1, 1, 1),
      block2: new Block(2, 0, 2, 3, 3, 3),
      blockType: "second block including first block, 3",
    },
    {
      block1: new Block(1, 0, 0, 3, 3, 3),
      block2: new Block(2, 1, 1, 1, 1, 1),
      blockType: "first block including second block, 0",
    },
    {
      block1: new Block(1, 2, 0, 3, 3, 3),
      block2: new Block(2, 3, 1, 1, 1, 1),
      blockType: "first block including second block, 1",
    },
    {
      block1: new Block(1, 2, 2, 3, 3, 3),
      block2: new Block(2, 3, 3, 1, 1, 1),
      blockType: "first block including second block, 2",
    },
    {
      block1: new Block(1, 0, 2, 3, 3, 3),
      block2: new Block(2, 1, 3, 1, 1, 1),
      blockType: "first block including second block, 3",
    },
  ];

  const nonOverlappingBlocksCase = [
    [
      [
        new Block(1, 0, 0, 4, 1, 1),
        new Block(2, 4, 0, 1, 4, 1),
        new Block(3, 1, 4, 4, 1, 1),
        new Block(4, 0, 1, 1, 4, 1),
      ],
    ],
    [
      [
        new Block(1, 0, 0, 1, 1, 1),
        new Block(2, 1, 0, 1, 1, 1),
        new Block(3, 2, 0, 1, 1, 1),
        new Block(4, 3, 0, 1, 1, 1),
        new Block(5, 4, 0, 1, 1, 1),
        new Block(6, 0, 1, 1, 1, 1),
        new Block(7, 1, 1, 1, 1, 1),
        new Block(8, 2, 1, 1, 1, 1),
        new Block(9, 3, 1, 1, 1, 1),
        new Block(10, 4, 1, 1, 1, 1),
        new Block(11, 0, 2, 1, 1, 1),
        new Block(12, 1, 2, 1, 1, 1),
        new Block(13, 2, 2, 1, 1, 1),
        new Block(14, 3, 2, 1, 1, 1),
        new Block(15, 4, 2, 1, 1, 1),
        new Block(16, 0, 3, 1, 1, 1),
        new Block(17, 1, 3, 1, 1, 1),
        new Block(18, 2, 3, 1, 1, 1),
        new Block(19, 3, 3, 1, 1, 1),
        new Block(20, 4, 3, 1, 1, 1),
        new Block(21, 0, 4, 1, 1, 1),
        new Block(22, 1, 4, 1, 1, 1),
        new Block(23, 2, 4, 1, 1, 1),
        new Block(24, 3, 4, 1, 1, 1),
        new Block(25, 4, 4, 1, 1, 1),
      ],
    ],
  ];

  const overlappingSatisfiedMustTouchCellsCases = [
    [new Block(1, 0, 0, 2, 2, 2)],
    [new Block(1, 2, 1, 2, 2, 2)],
    [new Block(1, 3, 2, 2, 2, 2)],
    [new Block(1, 2, 3, 2, 2, 2)],
    [new Block(1, 1, 2, 2, 2, 2)],
    [new Block(1, 2, 0, 3, 2, 2)],
    [new Block(1, 0, 2, 2, 3, 2)],
    [new Block(1, 4, 4, 1, 1, 1)],
  ];

  const nonOverlappingSatisfiedMustTouchCellsCases = [
    [new Block(1, 0, 2, 2, 2, 2)],
    [new Block(1, 2, 0, 2, 2, 2)],
    [new Block(1, 1, 4, 3, 1, 1)],
    [new Block(1, 4, 1, 1, 3, 1)],
  ];

  test.each(completelyOutOfBoundsCases)(
    "block should be completely out of bounds ($position)",
    ({ x, y, position }) => {
      const block = new Block(1, x, y, 2, 2, 2);
      expect(
        block.checkValidity(5, 5, cells, blocks, mustTouchCellsSatisfied),
      ).toBeFalse();
      expect((block as any).checkOutOfBounds).toHaveBeenCalled();
      expect((block as any).checkBlockCollisions).not.toHaveBeenCalled();
      expect((block as any).checkBlockingCells).not.toHaveBeenCalled();
    },
  );

  test.each(partiallyOutOfBoundsCases)(
    "block should partially be out of bounds ($position)",
    ({ x, y, position }) => {
      const block = new Block(1, x, y, 2, 2, 2);
      expect(
        block.checkValidity(5, 5, cells, blocks, mustTouchCellsSatisfied),
      ).toBeFalse();
      expect((block as any).checkOutOfBounds).toHaveBeenCalled();
      expect((block as any).checkBlockCollisions).not.toHaveBeenCalled();
      expect((block as any).checkBlockingCells).not.toHaveBeenCalled();
    },
  );

  test.each(inBoundsCases)(
    `block should be in bounds ($position)`,
    ({ x, y, position }) => {
      const block = new Block(1, x, y, 2, 2, 2);
      checkBlockCollisionsSpy.mockReturnValue(true);
      checkBlockingCellsSpy.mockReturnValue(true);
      expect(
        block.checkValidity(5, 5, cells, blocks, mustTouchCellsSatisfied),
      ).toBeTrue();
      expect((block as any).checkOutOfBounds).toHaveBeenCalled();
      expect((block as any).checkBlockCollisions).toHaveBeenCalled();
      expect((block as any).checkBlockingCells).toHaveBeenCalled();
    },
  );

  test("there should only be one block on the grid", () => {
    checkOutOfBoundsSpy.mockReturnValue(true);
    checkBlockingCellsSpy.mockReturnValue(true);
    const block = new Block(1, 1, 1, 2, 2, 2);

    const result = block.checkValidity(
      5,
      5,
      cells,
      [block],
      mustTouchCellsSatisfied,
    );

    expect(result).toBeTrue();
  });

  // TODO check non overlapping blocks
  test.each(blockOverlapCases)(
    "blocks should overlap ($blockType)",
    ({ block1, block2, blockType }) => {
      checkOutOfBoundsSpy.mockReturnValue(true);

      const result = block1.checkValidity(
        5,
        5,
        cells,
        [block1, block2],
        mustTouchCellsSatisfied,
      );

      expect(result).toBeFalse();
      expect((block1 as any).checkBlockingCells).not.toHaveBeenCalled();
    },
  );

  let index = 0;

  test.each(nonOverlappingBlocksCase)(
    "there should be no overlaps between blocks (%#)",
    blocks => {
      checkOutOfBoundsSpy.mockReturnValue(true);
      checkBlockingCellsSpy.mockReturnValue(true);

      const result = blocks[index]!.checkValidity(
        5,
        5,
        cells,
        blocks,
        mustTouchCellsSatisfied,
      );

      expect(result).toBeTrue();
      expect((blocks[index]! as any).checkBlockingCells).toHaveBeenCalled();
      index = 13;
    },
  );

  test.each(overlappingSatisfiedMustTouchCellsCases)(
    "blocks should overlap satisfied mustTouch cells (%#)",
    block => {
      checkOutOfBoundsSpy.mockReturnValue(true);
      checkBlockCollisionsSpy.mockReturnValue(true);

      const result = block.checkValidity(
        5,
        5,
        cells,
        [],
        mustTouchCellsSatisfied,
      );

      expect(result).toBeFalse();
    },
  );

  test.each(nonOverlappingSatisfiedMustTouchCellsCases)(
    "blocks should not overlap satisfied mustTouch cells (%#)",
    block => {
      checkOutOfBoundsSpy.mockReturnValue(true);
      checkBlockCollisionsSpy.mockReturnValue(true);

      const result = block.checkValidity(
        5,
        5,
        cells,
        [],
        mustTouchCellsSatisfied,
      );

      expect(result).toBeTrue();
    },
  );
});
