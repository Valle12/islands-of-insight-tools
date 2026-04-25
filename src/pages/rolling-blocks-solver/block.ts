import type { Tile } from "../../util/types";
import {
  extractBit,
  indexToBitmask,
  positionToIndex,
} from "../../util/utilMethods";
import { Direction } from "./directions";

export class Block {
  id: number;
  x: number;
  y: number;
  width: number;
  depth: number;
  height: number;

  constructor(
    id: number,
    x: number,
    y: number,
    width: number,
    depth: number,
    height: number,
  ) {
    this.id = id;
    this.x = x;
    this.y = y;
    this.width = width;
    this.depth = depth;
    this.height = height;
  }

  roll(direction: Direction) {
    switch (direction) {
      case Direction.UP:
        this.y -= this.height;
        [this.depth, this.height] = [this.height, this.depth];
        break;
      case Direction.RIGHT:
        this.x += this.width;
        [this.width, this.height] = [this.height, this.width];
        break;
      case Direction.DOWN:
        this.y += this.depth;
        [this.depth, this.height] = [this.height, this.depth];
        break;
      case Direction.LEFT:
        this.x -= this.height;
        [this.width, this.height] = [this.height, this.width];
        break;
    }
  }

  clone(): Block {
    return new Block(
      this.id,
      this.x,
      this.y,
      this.width,
      this.depth,
      this.height,
    );
  }

  checkValidity(
    gridWidth: number,
    gridHeight: number,
    cells: Tile[][],
    blocks: Block[],
    mustTouchCellsSatisfied: bigint,
  ) {
    return (
      this.checkOutOfBounds(gridWidth, gridHeight) &&
      this.checkBlockCollisions(blocks) &&
      this.checkBlockingCells(gridWidth, cells, mustTouchCellsSatisfied)
    );
  }

  updateMustTouchCells(
    gridWidth: number,
    cells: Tile[][],
    mustTouchCellsSatisfied: bigint,
  ) {
    for (let x = this.x; x < this.x + this.width; x++) {
      for (let y = this.y; y < this.y + this.depth; y++) {
        if (cells[x]![y] !== "mustTouch") continue;
        const index = positionToIndex(x, y, gridWidth);
        mustTouchCellsSatisfied |= indexToBitmask(index);
      }
    }

    return mustTouchCellsSatisfied;
  }

  private checkOutOfBounds(gridWidth: number, gridHeight: number) {
    return !(
      this.x < 0 ||
      this.x + this.width > gridWidth ||
      this.y < 0 ||
      this.y + this.depth > gridHeight
    );
  }

  private checkBlockCollisions(blocks: Block[]) {
    for (const block of blocks) {
      if (this.id === block.id) continue;
      for (let x = this.x; x < this.x + this.width; x++) {
        for (let y = this.y; y < this.y + this.depth; y++) {
          if (
            x >= block.x &&
            x < block.x + block.width &&
            y >= block.y &&
            y < block.y + block.depth
          ) {
            return false;
          }
        }
      }
    }

    return true;
  }

  private checkBlockingCells(
    gridWidth: number,
    cells: Tile[][],
    mustTouchCellsSatisfied: bigint,
  ) {
    for (let x = this.x; x < this.x + this.width; x++) {
      for (let y = this.y; y < this.y + this.depth; y++) {
        if (cells[x]?.[y] === "unplayable") return false;
        if (cells[x]?.[y] === "mustTouch") {
          const index = positionToIndex(x, y, gridWidth);
          const bit = extractBit(mustTouchCellsSatisfied, index);
          if (bit === 1n) {
            return false;
          }
        }
      }
    }

    return true;
  }
}
