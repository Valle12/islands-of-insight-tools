import type { LogicGridClue, Position } from "../../util/types";
import type { BoardLayers } from "./boardLayers";
import { isPlayable, UNKNOWN } from "./cell";
import { NO_SHAPE } from "./shapes";

/**
 * Moving squares between merged cells — the one edit that is not "write this
 * value into that square", and the one that has to clear what it touched and
 * settle whatever it left behind.
 *
 * Free functions over a named slice of the board rather than methods on it, so
 * the rules about donors and leftovers can be read without the DOM handles and
 * the drag state in the same file. An object literal rather than the board
 * itself, because the three things this needs from it are private.
 */

/** What restructuring a cell needs from the board around it. */
export interface BoardEdits {
  readonly layers: BoardLayers;
  writeCell(
    position: Position,
    color: number,
    clue: LogicGridClue | null,
  ): void;
  redress(squares: Iterable<number>): void;
  hideSolution(): void;
}

/**
 * Moves one square into the stroke's target cell, out of whatever cell it was
 * in. Whatever the donor is left holding splits into its connected pieces.
 */
export function mergeSquare(
  host: BoardEdits,
  target: number,
  position: Position,
) {
  const { layers } = host;
  // A gap is not a cell, so it cannot be part of one.
  if (!isPlayable(layers.colorAt(position))) return;
  const square = layers.shapes.flat(position);
  const from = layers.shapes.idAt(square);
  if (from === target) return;

  const touched = new Set(layers.shapes.cellSquares(square));
  for (const one of layers.shapes.squaresOf(target)) touched.add(one);

  layers.shapes.claim(target, square);
  // The donor settles at once — that is the donut: right- or left-dragging
  // through the middle of a cell really does leave the rest in pieces. The
  // TARGET is left alone until the pointer is up, because mid-drag it is
  // allowed to be a single square (the one the stroke began on) or briefly in
  // two pieces (a fast drag skips squares between two pointermoves), and
  // settling it then would dissolve the cell out from under its own stroke.
  layers.shapes.normalize(from);
  // Only once the target really holds two squares. A single click claims one
  // square into a cell that `finishMerge` then dissolves again, so clearing
  // here would cost that square its colour and its clue and merge nothing.
  // The first real growth step still clears both, because `touched` already
  // carries the target's existing members.
  if (layers.shapes.squaresOf(target).length > 1) clearSquares(host, touched);
}

/** Settles the cell a merge stroke was growing, once the pointer is up. */
export function finishMerge(host: BoardEdits, target: number, origin: number) {
  const grown = host.layers.shapes.squaresOf(target);
  if (grown.length === 0) return;
  host.layers.shapes.normalize(target, origin);
  host.redress(grown);
  host.hideSolution();
}

/**
 * The keyboard's merge gesture: joins this square to the cell beside it — the
 * one to its left, or the one above when there is nothing to the left.
 *
 * A keystroke carries no drag, so it takes a fixed neighbour rather than
 * asking for a direction: the square to the LEFT, or the one ABOVE when there
 * is nothing to the left. Walking a shape and pressing Enter on each square
 * builds any polyomino a pointer could, which is what keeps this tool from
 * being pointer-only — and Backspace takes one back out again.
 */
export function mergeWithNeighbour(host: BoardEdits, position: Position) {
  const { layers } = host;
  if (!isPlayable(layers.colorAt(position))) return;
  const candidates = [
    { x: position.x - 1, y: position.y },
    { x: position.x, y: position.y - 1 },
  ];
  const before = candidates.find(
    one => one.x >= 0 && one.y >= 0 && isPlayable(layers.colorAt(one)),
  );
  if (!before) return;

  const origin = layers.shapes.flat(before);
  const held = layers.shapes.idAt(origin);
  const target = held === NO_SHAPE ? layers.shapes.create() : held;
  if (held === NO_SHAPE) mergeSquare(host, target, before);
  mergeSquare(host, target, position);
  finishMerge(host, target, origin);
}

/** Takes one square back out of its cell, leaving it plain. */
export function splitSquare(host: BoardEdits, position: Position) {
  const { layers } = host;
  const square = layers.shapes.flat(position);
  const from = layers.shapes.idAt(square);
  if (from === NO_SHAPE) return;

  const touched = new Set(layers.shapes.squaresOf(from));
  layers.shapes.release(square);
  layers.shapes.normalize(from);
  clearSquares(host, touched);
}

/**
 * Everything a merge or a split touched goes back to uncoloured and unclued.
 *
 * A merged cell holds ONE colour and at most one clue, and the squares coming
 * together may disagree about both — picking a winner would be a rule nobody
 * could predict from looking at the board. So restructuring clears, and the
 * cell is painted again afterwards.
 */
function clearSquares(host: BoardEdits, squares: Iterable<number>) {
  const affected = [...squares];
  for (const square of affected) {
    host.writeCell(host.layers.shapes.position(square), UNKNOWN, null);
  }
  host.redress(affected);
  // Explicitly: `writeCell` only drops the answer when a VALUE changed, and a
  // restructuring that cleared nothing still changed what the board is.
  host.hideSolution();
}
