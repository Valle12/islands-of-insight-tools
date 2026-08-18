// Editing a CLUE, as arithmetic on the clue itself: which way a key or a
// re-press turns one, whether two are the same, and how one becomes the
// `LogicGridSymbol` the config stores.
//
// Every function here is pure — a clue in, a clue out — which is what makes
// them worth having apart from `board.ts`. That file is all DOM handles, stroke
// state and mutation; none of it is needed to answer "what does pressing this
// arrow do to a dart", and mixing the two is what made the file long enough to
// have to search rather than read.

import type {
  LogicGridClue,
  LogicGridSymbol,
  LogicGridSymbolValue,
  Position,
} from "../../util/types";
import {
  AXIS_COUNT,
  DEFAULT_AXIS,
  DEFAULT_DIRECTION,
  DIRECTION_COUNT,
  directionIndex,
  isDiagonalAxis,
  symbolKindAt,
} from "./symbols";

export const DIGIT_PATTERN = /^\d$/;
export const LETTER_KEY_PATTERN = /^[a-zA-Z]$/;

/**
 * The arrow keys, aiming a directed clue ABSOLUTELY rather than stepping it
 * round. Four keys and four directions, so a step would only be worse.
 *
 * Resolved through the catalog rather than written as indices, so the keys go
 * on meaning what they say whatever position a direction ends up at.
 */
export const ARROW_KEYS: Readonly<Record<string, string>> = {
  ArrowUp: "up",
  ArrowRight: "right",
  ArrowDown: "down",
  ArrowLeft: "left",
};

export function directionForKey(key: string): number | null {
  const id = ARROW_KEYS[key];
  if (id === undefined) return null;
  const index = directionIndex(id);
  return index < 0 ? null : index;
}

/**
 * Whether two clues are the same clue — which is what decides whether writing
 * one changes anything at all.
 *
 * The direction and the seat count, so re-aiming a dart or re-seating a
 * symmetry symbol really is a change.
 */
export function sameClue(a: LogicGridClue | null, b: LogicGridClue | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.type === b.type &&
    a.value === b.value &&
    a.direction === b.direction &&
    (a.seat ?? 0) === (b.seat ?? 0)
  );
}

/**
 * Whether a stroke stamping `next` onto a cell holding `held` should TURN what
 * is there instead of writing over it.
 *
 * This is the directed kinds' replacement for the re-click-erases rule: the
 * same clue apart from where it points is a request to point it somewhere
 * else. Four clicks take a dart all the way round, and lifting one is the
 * right button's job alone — which is what makes placing a row of darts and
 * then aiming them a sequence of plain clicks. A symmetry symbol turns only
 * on its OWN seat: a click at a different seat of the same cell re-seats it.
 */
export function turnsInstead(
  held: LogicGridClue | null,
  next: LogicGridClue | null,
): boolean {
  if (!held || next?.direction === undefined) return false;
  return (
    held.type === next.type &&
    held.value === next.value &&
    (held.seat ?? 0) === (next.seat ?? 0)
  );
}

/**
 * The same clue aimed one step CLOCKWISE — a quarter turn along `DIRECTIONS`,
 * or 45 degrees along `AXES` for a symmetry symbol, skipping the diagonals
 * where its seat sits on a grid line and they have no reflection to offer.
 */
export function turned(clue: LogicGridClue): LogicGridClue {
  if (symbolKindAt(clue.type)?.aims === "axis") {
    const from = clue.direction ?? DEFAULT_AXIS;
    const seam = clue.seat === 1 || clue.seat === 2;
    let next = (from + 1) % AXIS_COUNT;
    if (seam && isDiagonalAxis(next)) next = (next + 1) % AXIS_COUNT;
    return { ...clue, direction: next };
  }
  const from = clue.direction ?? DEFAULT_DIRECTION;
  return { ...clue, direction: (from + 1) % DIRECTION_COUNT };
}

/** The same clue one step ANTICLOCKWISE: three clockwise turns, which is also
 * right where a grid-line seat leaves only the two straight axes. */
export function turnedBack(clue: LogicGridClue): LogicGridClue {
  return turned(turned(turned(clue)));
}

/**
 * Which half-square offsets a press leans to, and the home square the lean
 * names — the pressed square, or the seat's top-left neighbor when the lean
 * crosses a grid line to the left or above. Bit 0 leans right, bit 1 down;
 * fractions past roughly three quarters count, which also catches a press on
 * the invisible bridge between two squares, whose coordinates lie beyond the
 * square's own edge.
 */
export function leanOf(
  event: PointerEvent,
  position: Position,
  rect: DOMRect,
): { home: Position; lean: number } {
  const fx = (event.clientX - rect.left) / rect.width;
  const fy = (event.clientY - rect.top) / rect.height;
  const home = { ...position };
  let lean = 0;
  if (fx > 0.75) lean |= 1;
  else if (fx < 0.25 && position.x > 0) {
    home.x -= 1;
    lean |= 1;
  }
  if (fy > 0.75) lean |= 2;
  else if (fy < 0.25 && position.y > 0) {
    home.y -= 1;
    lean |= 2;
  }
  return { home, lean };
}

/**
 * One clue as the config stores it, with `value`, `direction` and `seat` only
 * where there is one: they are the format's optional keys, and every fixture
 * predating them has to round-trip byte-identically. A seat of 0 means the
 * square's own center, which is what absent means.
 */
export function symbolOf(clue: LogicGridClue, x: number, y: number): LogicGridSymbol {
  return {
    x,
    y,
    type: clue.type,
    ...(clue.value === undefined ? {} : { value: clue.value }),
    ...(clue.direction === undefined ? {} : { direction: clue.direction }),
    ...(clue.seat ? { seat: clue.seat } : {}),
  };
}

/** A clue with its value, direction and seat attached only when its kind
 * carries one — a valueless lotus holds no `value` key at all, and a seat of
 * 0 means the square's own center, which is what absent means. */
export function clueOf(
  type: number,
  value: LogicGridSymbolValue | undefined,
  direction: number | null,
  seat = 0,
): LogicGridClue {
  return {
    type,
    ...(value === undefined ? {} : { value }),
    ...(direction === null ? {} : { direction }),
    ...(seat ? { seat } : {}),
  };
}
