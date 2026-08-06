/**
 * The merged-cell layer: which squares are fused into one cell.
 *
 * In the game's harder logic puzzles the board is not a plain grid — several
 * grid squares can be fused into one irregular cell, any connected polyomino.
 * Such a cell is painted once and colours as a whole, while each of its
 * squares may carry its own clue — the game's harder boards put two darts on
 * one domino — and it still contributes every square it is made of to an area
 * number and is adjacent to whatever any of its squares touches.
 *
 * This lives apart from `board.ts` because merging is the one edit that is not
 * "write this value into that square": it moves squares between cells, and
 * whatever a stroke leaves behind has to be split into connected pieces again.
 *
 * Squares are flat `y * width + x` indices — what the config stores and what
 * the wasm boundary takes — while the colour and clue layers next door are
 * column-major. Ids are internal and never saved: only membership survives.
 */

import type { Position } from "../../util/types";

/** The id of a square that is its own cell. */
export const NO_SHAPE = -1;

const STEPS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

export class ShapeLayer {
  private readonly width: number;
  private readonly height: number;
  private readonly ids: number[];
  private nextId = 0;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.ids = Array.from({ length: width * height }, () => NO_SHAPE);
  }

  flat(position: Position): number {
    return position.y * this.width + position.x;
  }

  position(square: number): Position {
    return { x: square % this.width, y: Math.floor(square / this.width) };
  }

  idAt(square: number): number {
    return this.ids[square] ?? NO_SHAPE;
  }

  /** A fresh id, claiming nothing. The first square to join it does that. */
  create(): number {
    return this.nextId++;
  }

  claim(id: number, square: number) {
    this.ids[square] = id;
  }

  release(square: number) {
    this.ids[square] = NO_SHAPE;
  }

  squaresOf(id: number): number[] {
    if (id === NO_SHAPE) return [];
    const squares: number[] = [];
    for (let square = 0; square < this.ids.length; square++) {
      if (this.ids[square] === id) squares.push(square);
    }
    return squares;
  }

  /** Every square of the cell this square belongs to — itself when plain. */
  cellSquares(square: number): number[] {
    const id = this.idAt(square);
    return id === NO_SHAPE ? [square] : this.squaresOf(id);
  }

  /**
   * Splits a cell into its connected pieces, keeping the id on the piece that
   * holds `keep` and dissolving any piece down to one square.
   *
   * Both halves matter. Pulling squares out of a cell can leave the rest in
   * several pieces — right-dragging the middle of a plus leaves four separated
   * arms — and a cell is always one connected polyomino, like the game's. And
   * keeping the id on the piece the pointer started in is what lets a stroke go
   * on growing its own target after momentarily splitting it, which a fast drag
   * that skips a square does.
   */
  normalize(id: number, keep = NO_SHAPE) {
    const squares = this.squaresOf(id);
    if (squares.length === 0) return;

    const pieces = this.componentsOf(squares);
    const inherits = Math.max(
      pieces.findIndex(piece => piece.includes(keep)),
      0,
    );

    for (const [index, piece] of pieces.entries()) {
      // A piece of one square is a PLAIN cell again — a cell of one square and
      // a plain one would otherwise be two spellings of the same thing.
      const pieceId = piece.length < 2 ? NO_SHAPE : this.idFor(index, inherits, id);
      for (const square of piece) this.ids[square] = pieceId;
    }
  }

  private idFor(index: number, inherits: number, id: number): number {
    return index === inherits ? id : this.create();
  }

  /** Drops a whole cell, leaving its squares plain. */
  dissolve(id: number) {
    if (id === NO_SHAPE) return;
    for (const square of this.squaresOf(id)) this.ids[square] = NO_SHAPE;
  }

  /** The on-board orthogonal neighbours of a square. */
  private neighboursOf(square: number): number[] {
    const x = square % this.width;
    const y = Math.floor(square / this.width);
    const found: number[] = [];
    for (const [dx, dy] of STEPS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || nx >= this.width || ny < 0 || ny >= this.height) continue;
      found.push(ny * this.width + nx);
    }
    return found;
  }

  /** One connected piece, flooded out from `start` within `members`. */
  private pieceFrom(
    start: number,
    members: Set<number>,
    seen: Set<number>,
  ): number[] {
    const piece: number[] = [];
    const queue = [start];
    seen.add(start);
    while (queue.length > 0) {
      const square = queue.pop()!;
      piece.push(square);
      for (const next of this.neighboursOf(square)) {
        if (!members.has(next) || seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }
    return piece.toSorted((a, b) => a - b);
  }

  private componentsOf(squares: number[]): number[][] {
    const members = new Set(squares);
    const seen = new Set<number>();
    const pieces: number[][] = [];
    for (const start of squares) {
      if (!seen.has(start)) pieces.push(this.pieceFrom(start, members, seen));
    }
    return pieces;
  }

  /**
   * The cells as the config stores them, or undefined when there are none.
   *
   * Undefined rather than an empty array: every captured fixture predates this
   * key and has to keep round-tripping byte-identically. Both the cells and
   * their squares come out in reading order, so a download is canonical.
   */
  toConfig(): number[][] | undefined {
    const byId = new Map<number, number[]>();
    for (const [square, id] of this.ids.entries()) {
      if (id === NO_SHAPE) continue;
      const members = byId.get(id);
      if (members) members.push(square);
      else byId.set(id, [square]);
    }
    if (byId.size === 0) return undefined;
    return [...byId.values()].sort((a, b) => a[0]! - b[0]!);
  }

  load(shapes: number[][] | undefined) {
    this.ids.fill(NO_SHAPE);
    this.nextId = 0;
    for (const shape of shapes ?? []) {
      const id = this.create();
      for (const square of shape) this.ids[square] = id;
    }
  }
}
