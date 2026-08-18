import type { LogicGridClue, Position } from "../../util/types";
import type { BoardLayers } from "./boardLayers";
import { isPlayable } from "./cell";
import {
  clueOf,
  DIGIT_PATTERN,
  directionForKey,
  LETTER_KEY_PATTERN,
  turned,
  turnedBack,
} from "./clueEdits";
import type { BoardEdits } from "./mergeEdits";
import { mergeWithNeighbor, splitSquare } from "./mergeEdits";
import type { Stroke, ToolSelection } from "./strokes";
import { strokeFor, toggled } from "./strokes";
import {
  DEFAULT_DIRECTION,
  symbolKindAt,
  symbolValueMax,
  symbolValueMin,
  type LogicGridSymbolKind,
} from "./symbols";

/**
 * The keyboard's half of every gesture the pointer has: activating the tool on
 * a focused cell under the same re-click rule, splitting and merging without a
 * drag, aiming a clue with the arrows, and the run of digits a number past nine
 * is made of.
 *
 * That run is why this is not more pure functions beside `clueEdits.ts`, whose
 * header promises a clue in and a clue out: which cell is currently taking
 * digits is STATE, and "type 1 then 2 and get 12" cannot be answered without
 * it. Everything else here is a dispatcher over `strokes.ts` and `mergeEdits.ts`
 * — the two paths share the writes at the bottom and nothing above them.
 */

export class ClueTyping {
  /**
   * Whether "Numbers are off by one" is active, which widens the numeric
   * bounds a keystroke is checked against — a displayed 0 is real exactly
   * while it is. The board cannot see the editor's rule set, so the editor
   * pushes the flag in: at construction and on every toggle of the chip.
   */
  private offByOne = false;
  /**
   * The cell the current run of digits is typing into. Area numbers run past
   * nine, so consecutive digits on one cell accumulate; anything else ends the
   * run and the next digit starts a fresh number.
   */
  private digitCell: Position | null = null;

  setOffByOne(active: boolean) {
    this.offByOne = active;
  }

  /** Ends the run of digits. Painting, or moving to another cell, does. */
  reset() {
    this.digitCell = null;
  }

  /**
   * The clue a keystroke produces. A key edits the clue already on the cell
   * when it suits that clue's kind, and otherwise stamps the selected kind — so
   * a digit types into an area number and a letter into a letter, without the
   * chip row having to be touched first. A valueless kind has nothing for a
   * keystroke to edit, so it neither takes one nor loses its clue to one.
   */
  next(
    layers: BoardLayers,
    selection: ToolSelection,
    position: Position,
    key: string,
  ): LogicGridClue | null {
    if (!isPlayable(layers.colorAt(position))) return null;

    const existing = layers.clueAt(position);
    const type = existing ? existing.type : selection.symbol;
    const kind = symbolKindAt(type);
    if (!kind || kind.valueKind === "none") return null;

    // Typing edits the clue that is there, so a dart under the cursor keeps its
    // own aim; only a fresh one takes the tool's.
    const direction =
      kind.aims === "none"
        ? null
        : (existing?.direction ?? selection.direction ?? DEFAULT_DIRECTION);

    if (kind.valueKind === "letter") {
      return LETTER_KEY_PATTERN.test(key)
        ? clueOf(type, key.toUpperCase(), direction)
        : null;
    }

    if (!DIGIT_PATTERN.test(key)) return null;
    const value = this.nextNumberValue(
      layers,
      position,
      existing,
      Number(key),
      kind,
    );
    return value === null ? null : clueOf(type, value, direction);
  }

  /**
   * Digits accumulate while one cell keeps taking them, so 12 is "1" then "2".
   * Painting, or moving to another cell, ends the run and the next digit starts
   * a fresh number. A number the kind cannot use is refused rather than
   * truncated, so a slip leaves the last good value standing.
   *
   * The bounds come from the KIND, and BOTH ends are checked on the first
   * digit as well as on a grown one — on a small board a single keystroke can
   * already overshoot, since a 1x1 board's area tops out at 1 and its dart at
   * 0. Zero is not an area, so a leading zero is ignored there — but zero is a
   * real dart, and refusing it would leave one of the two cases that fill in
   * immediately impossible to type. Under "Numbers are off by one" the floor
   * drops by one, which is exactly when a displayed zero becomes real for
   * every numeric kind.
   */
  private nextNumberValue(
    layers: BoardLayers,
    position: Position,
    existing: LogicGridClue | null,
    digit: number,
    kind: LogicGridSymbolKind,
  ): number | null {
    const previous = this.digitCell;
    const continuing =
      previous?.x === position.x && previous?.y === position.y;
    const current =
      existing && typeof existing.value === "number" ? existing.value : null;
    this.digitCell = { x: position.x, y: position.y };

    const size = {
      gridWidth: layers.gridWidth,
      gridHeight: layers.gridHeight,
      offByOne: this.offByOne,
    };
    const max = symbolValueMax(kind, size);
    if (!continuing || current === null) {
      return digit < symbolValueMin(kind, size) || digit > max ? null : digit;
    }

    const grown = current * 10 + digit;
    return grown <= max ? grown : current;
  }
}

/** What typing on a focused cell needs, on top of what restructuring one does. */
export interface KeyEdits extends BoardEdits {
  readonly selection: ToolSelection;
  readonly typing: ClueTyping;
  applyStroke(stroke: Stroke, position: Position): void;
}

/**
 * Typing on a focused cell. Clicking a cell focuses its button, so this is
 * the quick way to correct a clue without going back to the value field.
 */
export function handleKey(
  host: KeyEdits,
  event: KeyboardEvent,
  position: Position,
) {
  const { layers, selection, typing } = host;

  // Coloring is this page's main task, so it cannot be pointer-only. The
  // activation keys apply the selected tool to the focused cell under the
  // same re-click-erases rule a click gets — as a one-cell stroke, since a
  // keystroke has no drag to carry. Without the preventDefault, Space also
  // scrolls the page and the button's synthesised click follows.
  if (event.key === "Enter" || event.key === " ") {
    if (selection.tool === "merge") {
      event.preventDefault();
      typing.reset();
      mergeWithNeighbor(host, position);
      return;
    }
    const stroke = strokeFor(selection, layers, false, position);
    if (!stroke) return;
    event.preventDefault();
    typing.reset();
    host.applyStroke(toggled(layers, stroke, position), position);
    return;
  }

  if (event.key === "Backspace" || event.key === "Delete") {
    event.preventDefault();
    typing.reset();
    // The merge tool's secondary action, which the pointer gets on the right
    // button. Without it a keyboard user could build a merged cell and never
    // take a square back out of one.
    if (selection.tool === "merge") {
      splitSquare(host, position);
      return;
    }
    // The focused SQUARE's own clue: a merged cell may carry one per
    // square, so lifting reaches exactly the one under focus.
    host.writeCell(position, layers.colorAt(position), null);
    return;
  }

  if (handleArrowKey(host, event, position)) return;

  // The focused SQUARE's own slot: a merged cell may carry a clue per
  // square, so typing edits the clue under focus and an empty square takes
  // a fresh one — the keyboard's version of placing where the press landed.
  const clue = typing.next(layers, selection, position, event.key);
  if (!clue) return;
  event.preventDefault();
  host.writeCell(position, layers.colorAt(position), clue);
}

/**
 * An arrow key aims a directed clue, so the gesture is not pointer-only —
 * ABSOLUTELY for a compass kind, four keys naming four directions. Compass
 * keys do not name axes, so on a symmetry symbol the horizontal pair STEPS
 * instead — left anticlockwise, right clockwise, skipping the diagonals a
 * grid-line seat cannot carry — while the vertical pair, like every arrow
 * over a cell with nothing aimed on it, goes on scrolling the page.
 */
function handleArrowKey(
  host: KeyEdits,
  event: KeyboardEvent,
  position: Position,
): boolean {
  if (directionForKey(event.key) === null) return false;
  // The focused SQUARE's own clue — a merged cell may carry one per square,
  // so the keys aim exactly the one under focus.
  const held = host.layers.clueAt(position);
  if (held?.direction === undefined) return false;
  const color = host.layers.colorAt(position);

  if (symbolKindAt(held.type)?.aims === "axis") {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return false;
    event.preventDefault();
    host.typing.reset();
    const write = event.key === "ArrowRight" ? turned(held) : turnedBack(held);
    host.writeCell(position, color, write);
    return true;
  }

  event.preventDefault();
  host.typing.reset();
  host.writeCell(position, color, {
    ...held,
    direction: directionForKey(event.key)!,
  });
  return true;
}
