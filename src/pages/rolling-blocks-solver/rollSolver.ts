import type { Tile } from "../../util/types";
import type { Block } from "./block";

export class RollSolver {
  private gridWidth: number;
  private gridHeight: number;
  private cells: Tile[][];
  private blocks: Map<number, Block>;

  constructor(
    gridWidth: number,
    gridHeight: number,
    cells: Tile[][],
    blocks: Map<number, Block>,
  ) {
    this.gridWidth = gridWidth;
    this.gridHeight = gridHeight;
    this.cells = cells;
    this.blocks = blocks;
  }
}
