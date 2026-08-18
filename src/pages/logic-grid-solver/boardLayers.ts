import type {
  LogicGridClue,
  LogicGridSymbol,
  LogicGridTest,
  Position,
} from "../../util/types";
import { UNKNOWN } from "./cell";
import { clueOf, sameClue, symbolOf } from "./clueEdits";
import { NO_SHAPE, ShapeLayer } from "./shapes";

/**
 * The three layers a board is made of — color, clues and merged cells — and
 * what the config file makes of them.
 *
 * A class rather than free functions because it OWNS the arrays: this is the
 * only part of the board that survives a re-render, and keeping it apart from
 * `board.ts` is what lets a stroke be reasoned about as arithmetic on a grid,
 * with no DOM handle and no drag state in the same file. Nothing here draws
 * anything or knows a solution exists.
 */

/**
 * What a write moved, which is what decides how much of the page has to be
 * redrawn: a clue reaches its own square, a color reaches the outline around
 * a merged cell as well, and nothing reaches nothing.
 *
 * BOTH flags, not one answer of three. A single write moves both layers more
 * often than it looks — the eraser writes `(UNKNOWN, null)`, and painting a
 * square unplayable drops the clue with it — and reporting only the color
 * left the clue's own redraw undone. That is invisible for a number or a
 * letter, which is drawn on the square it sits on, and very visible for a
 * seated galaxy, whose tile is drawn on the outline layer and stayed there
 * after the clue had gone.
 */
export interface WriteResult {
  readonly color: boolean;
  readonly clue: boolean;
}

export class BoardLayers {
  readonly gridWidth: number;
  readonly gridHeight: number;

  /** The color layer, column-major. */
  private cells: number[][] = [];
  /** The clue layer, indexed like `cells`. Independent of the color. */
  private clues: (LogicGridClue | null)[][] = [];
  /**
   * The merged-cell layer: which squares are fused into one cell. A third layer
   * beside the two above rather than a value inside either, because it says how
   * the other two are GROUPED rather than what any one square holds.
   */
  private shapeLayer: ShapeLayer;

  constructor(gridWidth: number, gridHeight: number) {
    this.gridWidth = gridWidth;
    this.gridHeight = gridHeight;
    this.shapeLayer = new ShapeLayer(gridWidth, gridHeight);
    this.reset();
  }

  /**
   * The merged-cell layer itself. Exposed rather than wrapped, because
   * restructuring a cell is the one edit that is not "write this value into
   * that square" — see `mergeEdits.ts`.
   */
  get shapes(): ShapeLayer {
    return this.shapeLayer;
  }

  /** Clears all three layers. */
  reset() {
    this.cells = Array.from({ length: this.gridWidth }, () =>
      Array.from({ length: this.gridHeight }, () => UNKNOWN),
    );
    this.clues = Array.from({ length: this.gridWidth }, () =>
      Array.from({ length: this.gridHeight }, () => null),
    );
    this.shapeLayer = new ShapeLayer(this.gridWidth, this.gridHeight);
  }

  getCells() {
    return this.cells;
  }

  /** The merged cells as the config stores them, undefined when there are none. */
  getShapes() {
    return this.shapeLayer.toConfig();
  }

  /** The clue layer, sparse and in reading order, as the config stores it. */
  getSymbols(): LogicGridSymbol[] {
    const symbols: LogicGridSymbol[] = [];
    for (let y = 0; y < this.gridHeight; y++) {
      for (let x = 0; x < this.gridWidth; x++) {
        const clue = this.clues[x]?.[y];
        if (clue) symbols.push(symbolOf(clue, x, y));
      }
    }
    return symbols;
  }

  /**
   * Replaces the layers with a validated config. The caller must have
   * constructed them with the config's grid size.
   */
  load(config: LogicGridTest) {
    this.reset();
    // Before the clues: which squares are fused decides where a clue is stored.
    this.shapeLayer.load(config.shapes);
    for (let x = 0; x < this.gridWidth; x++) {
      for (let y = 0; y < this.gridHeight; y++) {
        this.cells[x]![y] = config.cells[x]![y]!;
      }
    }
    for (const symbol of config.symbols) {
      // Kept on the square the file names, for every kind. Where a clue sits
      // inside a merged cell is the player's choice — a dart's square is where
      // its ray starts, and even an area number reads as a different board when
      // it moves — so nothing is re-homed on the way in and what comes back out
      // is what went in.
      const column = this.clues[symbol.x];
      if (column) {
        column[symbol.y] = clueOf(
          symbol.type,
          symbol.value,
          symbol.direction ?? null,
          symbol.seat ?? 0,
        );
      }
    }
  }

  colorAt(position: Position): number {
    return this.cells[position.x]?.[position.y] ?? UNKNOWN;
  }

  clueAt(position: Position): LogicGridClue | null {
    return this.clues[position.x]?.[position.y] ?? null;
  }

  /** The merged cell this square belongs to, or `NO_SHAPE` when it is plain. */
  cellIdAt(position: Position): number {
    return this.shapeLayer.idAt(this.shapeLayer.flat(position));
  }

  /** Every square of the cell this position belongs to — itself when plain. */
  squaresAt(position: Position): number[] {
    return this.shapeLayer.cellSquares(this.shapeLayer.flat(position));
  }

  /** Whether two squares belong to the same merged cell. */
  sharesCell(x: number, y: number, nx: number, ny: number): boolean {
    if (nx < 0 || nx >= this.gridWidth || ny < 0 || ny >= this.gridHeight) {
      return false;
    }
    const id = this.cellIdAt({ x, y });
    return id !== NO_SHAPE && this.cellIdAt({ x: nx, y: ny }) === id;
  }

  /**
   * The one place either layer changes. Returns "nothing" when nothing moves,
   * which is the common case while dragging: a pointermove fires many times per
   * cell. The caller redraws from what came back — see `Board.writeCell`.
   */
  write(
    position: Position,
    color: number,
    clue: LogicGridClue | null,
  ): WriteResult {
    const still = { color: false, clue: false };
    const column = this.cells[position.x];
    const clueColumn = this.clues[position.x];
    if (!column || !clueColumn) return still;
    if (position.y < 0 || position.y >= this.gridHeight) return still;
    const existing = clueColumn[position.y] ?? null;
    const moved = {
      color: column[position.y] !== color,
      clue: !sameClue(existing, clue),
    };
    if (!moved.color && !moved.clue) return still;

    column[position.y] = color;
    clueColumn[position.y] = clue;
    return moved;
  }
}
