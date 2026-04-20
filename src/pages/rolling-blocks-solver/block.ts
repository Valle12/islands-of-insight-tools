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
        // TODO need to check out of bounds, unplayable cells, must-touuch cells, potential other blocks
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

  checkValidity(): boolean {
    return false;
  }
}
