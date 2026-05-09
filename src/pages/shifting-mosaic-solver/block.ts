import type { BlockType, Position } from "../../util/types";

export class Block {
  id: number;
  type: BlockType;
  cells: Position[];

  constructor(id: number, type: BlockType, cells: Position[]) {
    this.id = id;
    this.type = type;
    this.cells = cells;
  }

  has(x: number, y: number): boolean {
    for (const cell of this.cells) {
      if (cell.x === x && cell.y === y) return true;
    }
    return false;
  }

  getRelativeShape(): Position[] {
    if (this.cells.length === 0) return [];
    let minX = this.cells[0]!.x;
    let minY = this.cells[0]!.y;
    for (const cell of this.cells) {
      if (cell.x < minX) minX = cell.x;
      if (cell.y < minY) minY = cell.y;
    }
    return this.cells.map(cell => ({ x: cell.x - minX, y: cell.y - minY }));
  }

  getBoundingBox(): { width: number; height: number } {
    if (this.cells.length === 0) return { width: 0, height: 0 };
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
    return { width: maxX - minX + 1, height: maxY - minY + 1 };
  }
}
