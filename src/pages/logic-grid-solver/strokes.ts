import type {
  LogicGridClue,
  LogicGridSymbolValue,
  LogicGridTool,
  Position,
} from "../../util/types";
import type { BoardLayers } from "./boardLayers";
import { DARK, isPlayable, LIGHT, UNKNOWN, UNPLAYABLE } from "./cell";
import {
  clueOf,
  leanOf,
  sameClue,
  turned,
  turnsInstead,
} from "./clueEdits";
import { NO_SHAPE } from "./shapes";
import { isDiagonalAxis, symbolKindAt } from "./symbols";

/**
 * What one button press MEANS, before anything is written: which stroke a tool
 * and a mouse button produce, the re-click-erases rule that commits once for
 * the whole drag, and where inside a merged cell a symmetry press sat down.
 *
 * Nothing here touches the DOM or the solver — a stroke is decided from the
 * tool row and the layers, and that is the whole input to it. (`leanOf` in
 * `clueEdits.ts` is the pure half of the seat story; this is the half that has
 * to know which squares are fused, which is why it lives beside the layers
 * rather than beside the clue arithmetic.) It is not PURE, unlike that file:
 * starting a merge asks the shape layer for a fresh cell id.
 */

/**
 * What one pointer stroke writes into every cell it touches. Decided once, at
 * pointerdown — see `toggled`.
 */
export type Stroke =
  | { kind: "color"; value: number }
  | { kind: "clue"; clue: LogicGridClue | null }
  | { kind: "erase" }
  /**
   * Fuses squares into one merged cell. `target` is fixed at pointerdown —
   * starting inside an existing cell EXTENDS it, starting on a plain square
   * begins a new one — and `origin` is the square the pointer went down on,
   * which is the piece that keeps the id if the cell ever splits mid-drag.
   */
  | { kind: "merge"; target: number; origin: number }
  | { kind: "split" };

/**
 * What the tool row has selected. One object rather than four fields, because
 * the modules that decide a stroke want the selection and nothing else of the
 * board — and because the board hands the LIVE object over, so a tool changed
 * mid-drag is still seen.
 */
export interface ToolSelection {
  tool: LogicGridTool;
  symbol: number;
  /** Null while the value field holds nothing usable, which stamps nothing. */
  value: LogicGridSymbolValue | null;
  /** Which way the selected kind points, or null when it points nowhere. */
  direction: number | null;
}

/**
 * What a button press writes, before the re-click rule.
 *
 * The selected chip drives the left button; the right one paints the other
 * colour where there is one, and erases where there is not. With Dark
 * selected — the default — that is left-dark, right-light with nothing
 * clicked, which is how the boards are drawn.
 */
export function strokeFor(
  selection: ToolSelection,
  layers: BoardLayers,
  secondary: boolean,
  position: Position,
): Stroke | null {
  switch (selection.tool) {
    case "dark":
      return { kind: "color", value: secondary ? LIGHT : DARK };
    case "light":
      return { kind: "color", value: secondary ? DARK : LIGHT };
    case "unplayable":
      return secondary
        ? { kind: "erase" }
        : { kind: "color", value: UNPLAYABLE };
    case "erase":
      return { kind: "erase" };
    case "symbol":
      // The right button lifts the clue and leaves the colour alone.
      return secondary ? { kind: "clue", clue: null } : clueStroke(selection);
    case "merge":
      // The right button takes squares back OUT of whatever cell they are in,
      // one square at a time — right-dragging the middle of a 3x3 cell leaves
      // a donut and a plain square in the hole.
      return secondary ? { kind: "split" } : mergeStroke(layers, position);
    default:
      // Command tools paint nothing.
      return null;
  }
}

/**
 * A merge stroke, with its target cell fixed here at pointerdown: the cell
 * under the first square when there is one, a brand-new cell when that square
 * was plain. Every square the drag then touches joins that cell and leaves
 * whatever cell it was in — so dragging a column out of one cell and into
 * another moves exactly those squares between them.
 */
function mergeStroke(layers: BoardLayers, position: Position): Stroke | null {
  if (!isPlayable(layers.colorAt(position))) return null;
  const origin = layers.shapes.flat(position);
  const held = layers.shapes.idAt(origin);
  return {
    kind: "merge",
    target: held === NO_SHAPE ? layers.shapes.create() : held,
    origin,
  };
}

function clueStroke(selection: ToolSelection): Stroke | null {
  const kind = symbolKindAt(selection.symbol);
  if (!kind) return null;
  // A valueless kind stamps with no value at all; every other kind waits
  // for its field to hold something usable. The direction is gated on the
  // KIND rather than on what the editor last set, so switching from a
  // directed kind cannot leak its aim onto one that carries none.
  if (kind.valueKind !== "none" && selection.value === null) return null;
  return {
    kind: "clue",
    clue: clueOf(
      selection.symbol,
      kind.valueKind === "none" ? undefined : (selection.value ?? undefined),
      kind.aims === "none" ? null : selection.direction,
    ),
  };
}

/**
 * The re-click-erases rule, applied ONCE per stroke: pressing a button on a
 * cell that already holds what that button writes clears it instead.
 *
 * Deciding it per cell would make a drag across a half-painted row alternate
 * between painting and erasing, so the whole stroke commits here and every
 * cell it goes on to touch gets the same effect.
 */
export function toggled(
  layers: BoardLayers,
  stroke: Stroke,
  position: Position,
): Stroke {
  if (stroke.kind === "color") {
    return layers.colorAt(position) === stroke.value
      ? { kind: "color", value: UNKNOWN }
      : stroke;
  }
  if (stroke.kind === "clue" && stroke.clue) {
    // This SQUARE's own clue, not the cell's. A press on a different square
    // of a clued cell ADDS a clue there — the game's harder boards carry
    // several on one merged cell — so it must not read as "the same clue
    // again" and lift it.
    const held = layers.clueAt(position);
    // A DIRECTED clue turns rather than lifting — see `turnsInstead`. The
    // turned clue is what the whole stroke then writes, so a drag over a row
    // of matching darts aims them all the same way rather than each one a
    // different way.
    if (turnsInstead(held, stroke.clue)) {
      return { kind: "clue", clue: turned(held!) };
    }
    return sameClue(held, stroke.clue) ? { kind: "clue", clue: null } : stroke;
  }
  return stroke;
}

/**
 * Fixes a symmetry stroke's seat from where the pointer went down, and
 * names the HOME square the stroke should start on — the seat's top-left
 * neighbour when the press leaned onto a grid line, the pressed square
 * itself everywhere else and for every other stroke.
 *
 * `rectOf` is a thunk rather than a rect: only an axis-aiming clue is measured
 * at all, and measuring eagerly would force a layout on every pointerdown,
 * including a plain paint stroke on a 32x32 board.
 */
export function seatStroke(
  layers: BoardLayers,
  stroke: Stroke,
  event: PointerEvent,
  position: Position,
  rectOf: () => DOMRect | null,
): { stroke: Stroke; home: Position } {
  if (stroke.kind !== "clue" || !stroke.clue) {
    return { stroke, home: position };
  }
  if (symbolKindAt(stroke.clue.type)?.aims !== "axis") {
    return { stroke, home: position };
  }
  const axis = stroke.clue.direction ?? null;
  const snapped = snapSeat(layers, event, position, axis, rectOf);
  return {
    stroke: {
      kind: "clue",
      clue: clueOf(stroke.clue.type, undefined, axis, snapped.seat),
    },
    home: snapped.home,
  };
}

/**
 * Where inside its cell a symmetry press lands: the nearest of the cell's
 * LEGAL seat points to where the pointer went down. The press's fractions
 * within the square lean the seat right or down past roughly three quarters
 * — which also catches a press on the invisible bridge between two squares,
 * whose coordinates lie beyond the square's own edge — and a lean towards
 * the left or top is the neighbouring square's own rightward or downward
 * seat, since a home square is always its seat's top-left neighbour. A lean
 * that leaves the cell, or a seat the shape cannot carry, falls back to the
 * pressed square's centre.
 */
function snapSeat(
  layers: BoardLayers,
  event: PointerEvent,
  position: Position,
  axis: number | null,
  rectOf: () => DOMRect | null,
): { home: Position; seat: number } {
  const centre = { home: position, seat: 0 };
  const rect = rectOf();
  if (!rect) return centre;

  const { home, lean } = leanOf(event, position, rect);
  if (lean === 0) return centre;

  // A home that moved must still be a square of the SAME cell, or the lean
  // walked out of it.
  const id = layers.cellIdAt(position);
  if (id === NO_SHAPE) return centre;
  const moved = home.x !== position.x || home.y !== position.y;
  if (moved && layers.cellIdAt(home) !== id) {
    return centre;
  }
  return seatLegalAt(layers, home, lean, axis) ? { home, seat: lean } : centre;
}

/**
 * Whether `seat` really sits inside `home`'s merged cell — the same rule
 * the validator enforces, asked before a stroke stamps it: a seam seat
 * needs the square beyond it as a shape-mate, a corner at least three of
 * its four squares, and the two diagonal axes refuse the seam seats their
 * reflection cannot exist on.
 *
 * Exported although only this file calls it, so the suites can ask it directly
 * rather than reaching through a `Board`.
 */
export function seatLegalAt(
  layers: BoardLayers,
  home: Position,
  seat: number,
  axis: number | null,
): boolean {
  if (seat === 0) return true;
  if (axis !== null && isDiagonalAxis(axis) && (seat === 1 || seat === 2)) {
    return false;
  }
  const id = layers.cellIdAt(home);
  if (id === NO_SHAPE) return false;
  const owns = (x: number, y: number) =>
    x < layers.gridWidth &&
    y < layers.gridHeight &&
    layers.cellIdAt({ x, y }) === id;
  if (seat === 1) return owns(home.x + 1, home.y);
  if (seat === 2) return owns(home.x, home.y + 1);
  return (
    1 +
      Number(owns(home.x + 1, home.y)) +
      Number(owns(home.x, home.y + 1)) +
      Number(owns(home.x + 1, home.y + 1)) >=
    3
  );
}

/**
 * A clue as this square can really carry it. A dragged symmetry stroke keeps
 * the seat its press fixed only where the cell under the pointer surrounds
 * that point too — a drag crosses cells with different shapes around them,
 * and the pressed one's own snap legalised only the first. Every other kind
 * sits at its square's centre and passes straight through.
 */
export function seated(
  layers: BoardLayers,
  clue: LogicGridClue | null,
  position: Position,
): LogicGridClue | null {
  if (!clue || symbolKindAt(clue.type)?.aims !== "axis") return clue;
  const seat = clue.seat ?? 0;
  const axis = clue.direction ?? null;
  return clueOf(
    clue.type,
    undefined,
    axis,
    seatLegalAt(layers, position, seat, axis) ? seat : 0,
  );
}
