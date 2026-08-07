import type {
  LogicGridClue,
  LogicGridSymbol,
  LogicGridSymbolValue,
  LogicGridTest,
  LogicGridTool,
  Position,
} from "../../util/types";
import { markGroupJoins } from "../../util/gridOutline";
import { DARK, isPlayable, LIGHT, UNKNOWN, UNPLAYABLE } from "./cell";
import { dressCell } from "./cellView";
import type { LogicGridSolverEditor } from "./logicGridSolver";
import { createOutlineLayer, drawShapeOutlines } from "./outlineLayer";
import { NO_SHAPE, ShapeLayer } from "./shapes";
import {
  AXIS_COUNT,
  DEFAULT_AXIS,
  DEFAULT_DIRECTION,
  DIRECTION_COUNT,
  directionIndex,
  isDiagonalAxis,
  symbolKindAt,
  symbolValueMax,
  symbolValueMin,
  type LogicGridSymbolKind,
} from "./symbols";

/**
 * What one pointer stroke writes into every cell it touches. Decided once, at
 * pointerdown — see `toggled`.
 */
type Stroke =
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

const DIGIT_PATTERN = /^\d$/;
const LETTER_KEY_PATTERN = /^[a-zA-Z]$/;

/**
 * The arrow keys, aiming a directed clue ABSOLUTELY rather than stepping it
 * round. Four keys and four directions, so a step would only be worse.
 *
 * Resolved through the catalogue rather than written as indices, so the keys go
 * on meaning what they say whatever position a direction ends up at.
 */
const ARROW_KEYS: Readonly<Record<string, string>> = {
  ArrowUp: "up",
  ArrowRight: "right",
  ArrowDown: "down",
  ArrowLeft: "left",
};

function directionForKey(key: string): number | null {
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
function sameClue(a: LogicGridClue | null, b: LogicGridClue | null): boolean {
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
function turnsInstead(
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
function turned(clue: LogicGridClue): LogicGridClue {
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
function turnedBack(clue: LogicGridClue): LogicGridClue {
  return turned(turned(turned(clue)));
}

/**
 * Which half-square offsets a press leans to, and the home square the lean
 * names — the pressed square, or the seat's top-left neighbour when the lean
 * crosses a grid line to the left or above. Bit 0 leans right, bit 1 down;
 * fractions past roughly three quarters count, which also catches a press on
 * the invisible bridge between two squares, whose coordinates lie beyond the
 * square's own edge.
 */
function leanOf(
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
 * square's own centre, which is what absent means.
 */
function symbolOf(clue: LogicGridClue, x: number, y: number): LogicGridSymbol {
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
 * 0 means the square's own centre, which is what absent means. */
function clueOf(
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

export class Board {
  private readonly gridWidth: number;
  private readonly gridHeight: number;
  private selectedTool: LogicGridTool;
  private selectedSymbol: number;
  /** Null while the value field holds nothing usable, which stamps nothing. */
  private symbolValue: LogicGridSymbolValue | null;
  /** Which way the selected kind points, or null when it points nowhere. */
  private symbolDirection: number | null;
  private readonly solver: LogicGridSolverEditor;

  /** The colour layer, column-major. */
  private cells: number[][] = [];
  /** The clue layer, indexed like `cells`. Independent of the colour. */
  private clues: (LogicGridClue | null)[][] = [];
  /**
   * The merged-cell layer: which squares are fused into one cell. A third layer
   * beside the two above rather than a value inside either, because it says how
   * the other two are GROUPED rather than what any one square holds.
   */
  private shapes: ShapeLayer;
  /**
   * The rendered cell buttons, indexed like `cells`. Painting rewrites the one
   * button it touched rather than re-running `renderGrid`; on a 32x32 board
   * that is the difference between one attribute write and rebuilding 1024
   * elements per pointermove.
   */
  private cellElements: HTMLButtonElement[][] = [];
  /** The stroke in progress, or null when the pointer is up. */
  private stroke: Stroke | null = null;
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
  /** Aborts every listener this board registered — see `dispose`. */
  private readonly listeners = new AbortController();
  private readonly grid = document.getElementById("grid") as HTMLDivElement;
  /** Where every merged cell is drawn — see `outlineLayer.ts`. */
  private outlines: SVGSVGElement | null = null;
  /**
   * Retraces the outlines when the squares change size. They are traced in
   * PIXELS, at the size actually rendered, so the mobile breakpoint moving a
   * square from 42px to 34px would otherwise leave every tile behind.
   */
  private readonly resize = new ResizeObserver(() => this.drawOutlines());

  constructor(
    solver: LogicGridSolverEditor,
    gridWidth: number,
    gridHeight: number,
    selectedTool: LogicGridTool,
    selectedSymbol: number,
    symbolValue: LogicGridSymbolValue | null,
    symbolDirection: number | null = null,
  ) {
    this.solver = solver;
    this.gridWidth = gridWidth;
    this.gridHeight = gridHeight;
    this.selectedTool = selectedTool;
    this.selectedSymbol = selectedSymbol;
    this.symbolValue = symbolValue;
    this.symbolDirection = symbolDirection;
    this.shapes = new ShapeLayer(gridWidth, gridHeight);
    this.resetBoardData();
    this.addListeners();
  }

  setOffByOne(active: boolean) {
    this.offByOne = active;
  }

  /**
   * Drops this board's listeners. The `#grid` element outlives the board it
   * belongs to, so a replaced board that kept listening would keep painting
   * into its own dead `cells` and make every stroke do the work twice.
   */
  dispose() {
    this.listeners.abort();
    this.resize.disconnect();
  }

  setSelectedTool(tool: LogicGridTool) {
    this.selectedTool = tool;
  }

  setSelectedSymbol(index: number) {
    this.selectedSymbol = index;
  }

  setSymbolValue(value: LogicGridSymbolValue | null) {
    this.symbolValue = value;
  }

  setSymbolDirection(direction: number | null) {
    this.symbolDirection = direction;
  }

  /** Clears all three layers. */
  resetBoardData() {
    this.cells = Array.from({ length: this.gridWidth }, () =>
      Array.from({ length: this.gridHeight }, () => UNKNOWN),
    );
    this.clues = Array.from({ length: this.gridWidth }, () =>
      Array.from({ length: this.gridHeight }, () => null),
    );
    this.shapes = new ShapeLayer(this.gridWidth, this.gridHeight);
    this.digitCell = null;
  }

  getCells() {
    return this.cells;
  }

  /** The merged cells as the config stores them, undefined when there are none. */
  getShapes() {
    return this.shapes.toConfig();
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

  renderGrid() {
    // Fixed-size tracks, never minmax(0, 1fr): the squares have a hard
    // width, so a track allowed to shrink below it makes the cells OVERLAP
    // while the absolutely-positioned outline SVG keeps its natural size —
    // a squeezed grid under a full-width overlay, i.e. a scrollbar into
    // blank space. Fixed tracks keep grid, cells and SVG the same width and
    // let #grid-shell do the scrolling.
    this.grid.style.gridTemplateColumns = `repeat(${this.gridWidth}, var(--logic-cell))`;

    // One fragment, one insertion: appending cell by cell to a live #grid
    // makes the browser lay out the whole grid on every one of them.
    const fragment = document.createDocumentFragment();
    // First, so every square paints over it.
    this.outlines = createOutlineLayer();
    fragment.appendChild(this.outlines);
    this.cellElements = Array.from(
      { length: this.gridWidth },
      (): HTMLButtonElement[] => [],
    );

    for (let y = 0; y < this.gridHeight; y++) {
      for (let x = 0; x < this.gridWidth; x++) {
        const cell = document.createElement("button");
        cell.type = "button";
        cell.className = "grid-cell";
        cell.dataset.x = String(x);
        cell.dataset.y = String(y);
        this.cellElements[x]![y] = cell;
        this.dressCellAt(x, y);
        fragment.appendChild(cell);
      }
    }

    this.grid.replaceChildren(fragment);
    this.drawOutlines();
    this.resize.observe(this.grid);
  }

  /**
   * Redraws every merged cell's outline. Called whenever membership changes,
   * whenever one is painted, and when the squares change size — the outline is
   * traced in pixels, so it has to be retraced at the size actually rendered.
   */
  private drawOutlines() {
    if (!this.outlines) return;
    drawShapeOutlines(this.outlines, {
      shapes: this.shapes.toConfig() ?? [],
      gridWidth: this.gridWidth,
      gridHeight: this.gridHeight,
      colorOf: square => this.cells[square % this.gridWidth]?.[
        Math.floor(square / this.gridWidth)
      ] ?? UNKNOWN,
      host: this.grid,
    });
  }

  /**
   * Replaces the board contents with a validated config. The caller must have
   * constructed the board with the config's grid size.
   */
  loadConfig(config: LogicGridTest) {
    this.resetBoardData();
    // Before the clues: which squares are fused decides where a clue is stored.
    this.shapes.load(config.shapes);
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

  /** Writes the current state of (x, y) onto its button. */
  private dressCellAt(x: number, y: number) {
    const element = this.cellElements[x]?.[y];
    if (!element) return;
    const color = this.cells[x]?.[y] ?? UNKNOWN;
    dressCell(element, color, this.clues[x]?.[y] ?? null, x, y);
    markGroupJoins(element, x, y, (nx, ny) => this.sharesCell(x, y, nx, ny));
  }

  /** Whether two squares belong to the same merged cell. */
  private sharesCell(x: number, y: number, nx: number, ny: number): boolean {
    if (nx < 0 || nx >= this.gridWidth || ny < 0 || ny >= this.gridHeight) {
      return false;
    }
    const id = this.shapes.idAt(this.shapes.flat({ x, y }));
    return id !== NO_SHAPE && this.shapes.idAt(this.shapes.flat({ x: nx, y: ny })) === id;
  }

  private addListeners() {
    const { signal } = this.listeners;

    this.grid.addEventListener(
      "pointerdown",
      event => this.beginStroke(event),
      { signal },
    );

    this.grid.addEventListener(
      "pointermove",
      event => {
        const stroke = this.stroke;
        if (!stroke) return;
        // Hit-tested by coordinate, NOT taken from `event.target`. A touch or
        // pen pointer is implicitly captured by the cell the stroke began on,
        // so every later move reports that same cell and a drag would paint
        // exactly one square. `touch-action: none` does not prevent that —
        // implicit capture is what the spec does on pointerdown for direct
        // manipulation devices, whatever the touch action is.
        const under = document.elementFromPoint(event.clientX, event.clientY);
        const position = this.extractCellPosition(under);
        if (position) this.applyStroke(stroke, position);
      },
      { signal },
    );

    // A stroke does not always end in a pointerup: a touch that turns into a
    // system gesture arrives as pointercancel instead, and a board that kept
    // the stroke would carry on painting on the next move.
    const endStroke = () => {
      const stroke = this.stroke;
      this.stroke = null;
      // A merge stroke settles its cell here rather than per square — see
      // `mergeSquare`. A cancelled stroke settles too: the squares it already
      // moved are moved, and leaving them in a half-built cell would be worse.
      if (stroke?.kind === "merge") {
        this.finishMerge(stroke.target, stroke.origin);
      }
    };
    document.addEventListener("pointerup", endStroke, { signal });
    document.addEventListener("pointercancel", endStroke, { signal });

    // Right-dragging the light colour across the board would otherwise open the
    // context menu on the first cell and end the stroke there.
    this.grid.addEventListener("contextmenu", event => event.preventDefault(), {
      signal,
    });

    this.grid.addEventListener("keydown", event => this.handleKey(event), {
      signal,
    });
  }

  private extractCellPosition(target: EventTarget | null): Position | null {
    if (!(target instanceof HTMLElement)) {
      return null;
    }

    const cell = target.closest(".grid-cell") as HTMLElement;
    if (!cell) return null;

    const x = Number(cell.dataset.x);
    const y = Number(cell.dataset.y);

    if (!Number.isInteger(x) || !Number.isInteger(y)) {
      return null;
    }

    return { x, y };
  }

  private beginStroke(event: PointerEvent) {
    // Left and right only. The middle button and the browser-back buttons all
    // arrive here as pointerdowns and must not paint.
    if (event.button !== 0 && event.button !== 2) return;
    const position = this.extractCellPosition(event.target);
    if (!position) return;

    const pressed = this.strokeFor(event.button === 2, position);
    if (!pressed) return;
    // A symmetry stroke's seat is fixed here from where the pointer went down
    // — before the re-click rule, which compares seats — and its home square
    // may be the seam's other neighbour.
    const { stroke, home } = this.seatStroke(pressed, event, position);

    this.stroke = this.toggled(stroke, home);
    this.digitCell = null;
    this.applyStroke(this.stroke, home);
  }

  /**
   * Fixes a symmetry stroke's seat from where the pointer went down, and
   * names the HOME square the stroke should start on — the seat's top-left
   * neighbour when the press leaned onto a grid line, the pressed square
   * itself everywhere else and for every other stroke.
   */
  private seatStroke(
    stroke: Stroke,
    event: PointerEvent,
    position: Position,
  ): { stroke: Stroke; home: Position } {
    if (stroke.kind !== "clue" || !stroke.clue) {
      return { stroke, home: position };
    }
    if (symbolKindAt(stroke.clue.type)?.aims !== "axis") {
      return { stroke, home: position };
    }
    const axis = stroke.clue.direction ?? null;
    const snapped = this.snapSeat(event, position, axis);
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
  private snapSeat(
    event: PointerEvent,
    position: Position,
    axis: number | null,
  ): { home: Position; seat: number } {
    const centre = { home: position, seat: 0 };
    const element = this.cellElements[position.x]?.[position.y];
    if (!element) return centre;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return centre;

    const { home, lean } = leanOf(event, position, rect);
    if (lean === 0) return centre;

    // A home that moved must still be a square of the SAME cell, or the lean
    // walked out of it.
    const id = this.shapes.idAt(this.shapes.flat(position));
    if (id === NO_SHAPE) return centre;
    const moved = home.x !== position.x || home.y !== position.y;
    if (moved && this.shapes.idAt(this.shapes.flat(home)) !== id) {
      return centre;
    }
    return this.seatLegalAt(home, lean, axis) ? { home, seat: lean } : centre;
  }

  /**
   * Whether `seat` really sits inside `home`'s merged cell — the same rule
   * the validator enforces, asked before a stroke stamps it: a seam seat
   * needs the square beyond it as a shape-mate, a corner at least three of
   * its four squares, and the two diagonal axes refuse the seam seats their
   * reflection cannot exist on.
   */
  private seatLegalAt(
    home: Position,
    seat: number,
    axis: number | null,
  ): boolean {
    if (seat === 0) return true;
    if (axis !== null && isDiagonalAxis(axis) && (seat === 1 || seat === 2)) {
      return false;
    }
    const id = this.shapes.idAt(this.shapes.flat(home));
    if (id === NO_SHAPE) return false;
    const owns = (x: number, y: number) =>
      x < this.gridWidth &&
      y < this.gridHeight &&
      this.shapes.idAt(this.shapes.flat({ x, y })) === id;
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
   * What a button press writes, before the re-click rule.
   *
   * The selected chip drives the left button; the right one paints the other
   * colour where there is one, and erases where there is not. With Dark
   * selected — the default — that is left-dark, right-light with nothing
   * clicked, which is how the boards are drawn.
   */
  private strokeFor(secondary: boolean, position: Position): Stroke | null {
    switch (this.selectedTool) {
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
        return secondary ? { kind: "clue", clue: null } : this.clueStroke();
      case "merge":
        // The right button takes squares back OUT of whatever cell they are in,
        // one square at a time — right-dragging the middle of a 3x3 cell leaves
        // a donut and a plain square in the hole.
        return secondary ? { kind: "split" } : this.mergeStroke(position);
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
  private mergeStroke(position: Position): Stroke | null {
    if (!isPlayable(this.colorAt(position))) return null;
    const origin = this.shapes.flat(position);
    const held = this.shapes.idAt(origin);
    return {
      kind: "merge",
      target: held === NO_SHAPE ? this.shapes.create() : held,
      origin,
    };
  }

  private clueStroke(): Stroke | null {
    const kind = symbolKindAt(this.selectedSymbol);
    if (!kind) return null;
    // A valueless kind stamps with no value at all; every other kind waits
    // for its field to hold something usable. The direction is gated on the
    // KIND rather than on what the editor last set, so switching from a
    // directed kind cannot leak its aim onto one that carries none.
    if (kind.valueKind !== "none" && this.symbolValue === null) return null;
    return {
      kind: "clue",
      clue: clueOf(
        this.selectedSymbol,
        kind.valueKind === "none" ? undefined : (this.symbolValue ?? undefined),
        kind.aims === "none" ? null : this.symbolDirection,
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
  private toggled(stroke: Stroke, position: Position): Stroke {
    if (stroke.kind === "color") {
      return this.colorAt(position) === stroke.value
        ? { kind: "color", value: UNKNOWN }
        : stroke;
    }
    if (stroke.kind === "clue" && stroke.clue) {
      // This SQUARE's own clue, not the cell's. A press on a different square
      // of a clued cell ADDS a clue there — the game's harder boards carry
      // several on one merged cell — so it must not read as "the same clue
      // again" and lift it.
      const held = this.clueAt(position);
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
   * Writes one stroke onto one CELL. Takes the stroke rather than reading the
   * one in progress, so the keyboard path can apply a single-cell stroke
   * without touching the drag state.
   *
   * A merged cell takes one colour for all of its squares, so the colour
   * branches below work on the whole cell rather than on the square the pointer
   * happens to be over. Clues are the other way round: every SQUARE carries its
   * own — a merged cell may hold several, one per square — so a clue lands, and
   * lifts, exactly where the press did.
   */
  private applyStroke(stroke: Stroke, position: Position) {
    if (stroke.kind === "merge") {
      this.mergeSquare(stroke.target, position);
      return;
    }
    if (stroke.kind === "split") {
      this.splitSquare(position);
      return;
    }

    const squares = this.shapes.cellSquares(this.shapes.flat(position));

    if (stroke.kind === "erase") {
      for (const square of squares) {
        this.writeCell(this.shapes.position(square), UNKNOWN, null);
      }
      return;
    }

    if (stroke.kind === "color") {
      this.paintCell(stroke.value, squares);
      return;
    }

    // A clue cannot be placed on a gap; lifting one always may.
    if (stroke.clue && !isPlayable(this.colorAt(position))) return;
    this.writeCell(
      position,
      this.colorAt(position),
      this.seated(stroke.clue, position),
    );
  }

  /**
   * A clue as this square can really carry it. A dragged symmetry stroke keeps
   * the seat its press fixed only where the cell under the pointer surrounds
   * that point too — a drag crosses cells with different shapes around them,
   * and the pressed one's own snap legalised only the first. Every other kind
   * sits at its square's centre and passes straight through.
   */
  private seated(
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
      this.seatLegalAt(position, seat, axis) ? seat : 0,
    );
  }

  /** One colour across every square of a cell, with every clue left on
   * whichever square of it the player put it on. */
  private paintCell(value: number, squares: number[]) {
    // A gap in the board is not a cell the puzzle clues, so painting one drops
    // whatever clues were there — and it is not part of a merged cell either,
    // so painting a merged cell away dissolves it back into loose squares.
    const dissolving = value === UNPLAYABLE && squares.length > 1;
    if (dissolving) this.shapes.dissolve(this.shapes.idAt(squares[0]!));

    for (const square of squares) {
      const at = this.shapes.position(square);
      const keeps = value === UNPLAYABLE ? null : this.clueAt(at);
      this.writeCell(at, value, keeps);
    }
    // Only after the writes: the seams these squares no longer share depend on
    // membership the loop above was still changing.
    if (dissolving) this.redress(squares);
  }

  /**
   * Moves one square into the stroke's target cell, out of whatever cell it was
   * in. Whatever the donor is left holding splits into its connected pieces.
   */
  private mergeSquare(target: number, position: Position) {
    // A gap is not a cell, so it cannot be part of one.
    if (!isPlayable(this.colorAt(position))) return;
    const square = this.shapes.flat(position);
    const from = this.shapes.idAt(square);
    if (from === target) return;

    const touched = new Set(this.shapes.cellSquares(square));
    for (const one of this.shapes.squaresOf(target)) touched.add(one);

    this.shapes.claim(target, square);
    // The donor settles at once — that is the donut: right- or left-dragging
    // through the middle of a cell really does leave the rest in pieces. The
    // TARGET is left alone until the pointer is up, because mid-drag it is
    // allowed to be a single square (the one the stroke began on) or briefly in
    // two pieces (a fast drag skips squares between two pointermoves), and
    // settling it then would dissolve the cell out from under its own stroke.
    this.shapes.normalize(from);
    // Only once the target really holds two squares. A single click claims one
    // square into a cell that `finishMerge` then dissolves again, so clearing
    // here would cost that square its colour and its clue and merge nothing.
    // The first real growth step still clears both, because `touched` already
    // carries the target's existing members.
    if (this.shapes.squaresOf(target).length > 1) this.clearSquares(touched);
  }

  /** Settles the cell a merge stroke was growing, once the pointer is up. */
  private finishMerge(target: number, origin: number) {
    const grown = this.shapes.squaresOf(target);
    if (grown.length === 0) return;
    this.shapes.normalize(target, origin);
    this.redress(grown);
    this.solver.hideSolution();
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
  private mergeWithNeighbour(position: Position) {
    if (!isPlayable(this.colorAt(position))) return;
    const candidates = [
      { x: position.x - 1, y: position.y },
      { x: position.x, y: position.y - 1 },
    ];
    const before = candidates.find(
      one => one.x >= 0 && one.y >= 0 && isPlayable(this.colorAt(one)),
    );
    if (!before) return;

    const origin = this.shapes.flat(before);
    const held = this.shapes.idAt(origin);
    const target = held === NO_SHAPE ? this.shapes.create() : held;
    if (held === NO_SHAPE) this.mergeSquare(target, before);
    this.mergeSquare(target, position);
    this.finishMerge(target, origin);
  }

  /** Takes one square back out of its cell, leaving it plain. */
  private splitSquare(position: Position) {
    const square = this.shapes.flat(position);
    const from = this.shapes.idAt(square);
    if (from === NO_SHAPE) return;

    const touched = new Set(this.shapes.squaresOf(from));
    this.shapes.release(square);
    this.shapes.normalize(from);
    this.clearSquares(touched);
  }

  /**
   * Everything a merge or a split touched goes back to uncoloured and unclued.
   *
   * A merged cell holds ONE colour and at most one clue, and the squares coming
   * together may disagree about both — picking a winner would be a rule nobody
   * could predict from looking at the board. So restructuring clears, and the
   * cell is painted again afterwards.
   */
  private clearSquares(squares: Iterable<number>) {
    const affected = [...squares];
    for (const square of affected) {
      this.writeCell(this.shapes.position(square), UNKNOWN, null);
    }
    this.redress(affected);
    // Explicitly: `writeCell` only drops the answer when a VALUE changed, and a
    // restructuring that cleared nothing still changed what the board is.
    this.solver.hideSolution();
  }

  /**
   * Redraws squares after their membership changed. A second pass rather than
   * part of the loop above: which sides a square joins depends on its
   * neighbours' membership, which that loop was still moving around.
   */
  private redress(squares: Iterable<number>) {
    for (const square of squares) {
      const { x, y } = this.shapes.position(square);
      this.dressCellAt(x, y);
    }
    // Membership moved, so every outline is retraced rather than patched.
    this.drawOutlines();
  }

  private colorAt(position: Position): number {
    return this.cells[position.x]?.[position.y] ?? UNKNOWN;
  }

  private clueAt(position: Position): LogicGridClue | null {
    return this.clues[position.x]?.[position.y] ?? null;
  }

  /**
   * The one place either layer changes. A no-op when nothing moves, which is
   * the common case while dragging: a pointermove fires many times per cell.
   */
  private writeCell(
    position: Position,
    color: number,
    clue: LogicGridClue | null,
  ) {
    const column = this.cells[position.x];
    const clueColumn = this.clues[position.x];
    if (!column || !clueColumn) return;
    if (position.y < 0 || position.y >= this.gridHeight) return;
    const existing = clueColumn[position.y] ?? null;
    if (column[position.y] === color && sameClue(existing, clue)) return;

    const wasColor = column[position.y];
    column[position.y] = color;
    clueColumn[position.y] = clue;
    this.dressCellAt(position.x, position.y);
    // The outline carries a merged cell's fill, so a colour change has to reach
    // it as well as the square.
    if (wasColor !== color && this.shapes.idAt(this.shapes.flat(position)) !== NO_SHAPE) {
      this.drawOutlines();
    }
    this.solver.hideSolution();
  }

  /**
   * Typing on a focused cell. Clicking a cell focuses its button, so this is
   * the quick way to correct a clue without going back to the value field.
   */
  private handleKey(event: KeyboardEvent) {
    const position = this.extractCellPosition(event.target);
    if (!position) return;

    // Colouring is this page's main task, so it cannot be pointer-only. The
    // activation keys apply the selected tool to the focused cell under the
    // same re-click-erases rule a click gets — as a one-cell stroke, since a
    // keystroke has no drag to carry. Without the preventDefault, Space also
    // scrolls the page and the button's synthesised click follows.
    if (event.key === "Enter" || event.key === " ") {
      if (this.selectedTool === "merge") {
        event.preventDefault();
        this.digitCell = null;
        this.mergeWithNeighbour(position);
        return;
      }
      const stroke = this.strokeFor(false, position);
      if (!stroke) return;
      event.preventDefault();
      this.digitCell = null;
      this.applyStroke(this.toggled(stroke, position), position);
      return;
    }

    if (event.key === "Backspace" || event.key === "Delete") {
      event.preventDefault();
      this.digitCell = null;
      // The merge tool's secondary action, which the pointer gets on the right
      // button. Without it a keyboard user could build a merged cell and never
      // take a square back out of one.
      if (this.selectedTool === "merge") {
        this.splitSquare(position);
        return;
      }
      // The focused SQUARE's own clue: a merged cell may carry one per
      // square, so lifting reaches exactly the one under focus.
      this.writeCell(position, this.colorAt(position), null);
      return;
    }

    if (this.handleArrowKey(event, position)) return;

    // The focused SQUARE's own slot: a merged cell may carry a clue per
    // square, so typing edits the clue under focus and an empty square takes
    // a fresh one — the keyboard's version of placing where the press landed.
    const clue = this.nextClue(position, this.clueAt(position), event.key);
    if (!clue) return;
    event.preventDefault();
    this.writeCell(position, this.colorAt(position), clue);
  }

  /**
   * An arrow key aims a directed clue, so the gesture is not pointer-only —
   * ABSOLUTELY for a compass kind, four keys naming four directions. Compass
   * keys do not name axes, so on a symmetry symbol the horizontal pair STEPS
   * instead — left anticlockwise, right clockwise, skipping the diagonals a
   * grid-line seat cannot carry — while the vertical pair, like every arrow
   * over a cell with nothing aimed on it, goes on scrolling the page.
   */
  private handleArrowKey(event: KeyboardEvent, position: Position): boolean {
    if (directionForKey(event.key) === null) return false;
    // The focused SQUARE's own clue — a merged cell may carry one per square,
    // so the keys aim exactly the one under focus.
    const held = this.clueAt(position);
    if (held?.direction === undefined) return false;

    if (symbolKindAt(held.type)?.aims === "axis") {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return false;
      event.preventDefault();
      this.digitCell = null;
      const write =
        event.key === "ArrowRight" ? turned(held) : turnedBack(held);
      this.writeCell(position, this.colorAt(position), write);
      return true;
    }

    event.preventDefault();
    this.digitCell = null;
    this.writeCell(position, this.colorAt(position), {
      ...held,
      direction: directionForKey(event.key)!,
    });
    return true;
  }

  /**
   * The clue a keystroke produces. A key edits the clue already on the cell
   * when it suits that clue's kind, and otherwise stamps the selected kind — so
   * a digit types into an area number and a letter into a letter, without the
   * chip row having to be touched first. A valueless kind has nothing for a
   * keystroke to edit, so it neither takes one nor loses its clue to one.
   */
  private nextClue(
    position: Position,
    existing: LogicGridClue | null,
    key: string,
  ): LogicGridClue | null {
    if (!isPlayable(this.colorAt(position))) return null;

    const type = existing ? existing.type : this.selectedSymbol;
    const kind = symbolKindAt(type);
    if (!kind || kind.valueKind === "none") return null;

    // Typing edits the clue that is there, so a dart under the cursor keeps its
    // own aim; only a fresh one takes the tool's.
    const direction =
      kind.aims === "none"
        ? null
        : (existing?.direction ?? this.symbolDirection ?? DEFAULT_DIRECTION);

    if (kind.valueKind === "letter") {
      return LETTER_KEY_PATTERN.test(key)
        ? clueOf(type, key.toUpperCase(), direction)
        : null;
    }

    if (!DIGIT_PATTERN.test(key)) return null;
    const value = this.nextNumberValue(position, existing, Number(key), kind);
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
      gridWidth: this.gridWidth,
      gridHeight: this.gridHeight,
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
