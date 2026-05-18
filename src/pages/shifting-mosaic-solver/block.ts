import type { BlockType, Position } from "../../util/types";

export class Block {
  id: number;
  type: BlockType;
  cells: Position[];
  anchor: Position;

  constructor(id: number, type: BlockType, cells: Position[]) {
    this.id = id;
    this.type = type;
    this.cells = cells;
    const { minX, minY } = this.getBoundingBoxCorners();
    this.anchor = { x: minX, y: minY };
  }

  has(x: number, y: number): boolean {
    for (const cell of this.cells) {
      if (cell.x === x && cell.y === y) return true;
    }

    return false;
  }

  getRelativePositions(): Position[] {
    let minX = this.cells[0]!.x;
    let minY = this.cells[0]!.y;
    for (const cell of this.cells) {
      if (cell.x < minX) minX = cell.x;
      if (cell.y < minY) minY = cell.y;
    }

    return this.cells.map(cell => ({ x: cell.x - minX, y: cell.y - minY }));
  }

  getBoundingBox(): { width: number; height: number } {
    const { minX, minY, maxX, maxY } = this.getBoundingBoxCorners();
    return { width: maxX - minX + 1, height: maxY - minY + 1 };
  }

  private getBoundingBoxCorners() {
    let minX = this.cells[0]!.x;
    let minY = this.cells[0]!.y;
    let maxX = this.cells[0]!.x;
    let maxY = this.cells[0]!.y;
    for (const cell of this.cells) {
      if (cell.x < minX) minX = cell.x;
      if (cell.y < minY) minY = cell.y;
      if (cell.x > maxX) maxX = cell.x;
      if (cell.y > maxY) maxY = cell.y;
    }

    return { minX, minY, maxX, maxY };
  }
}
