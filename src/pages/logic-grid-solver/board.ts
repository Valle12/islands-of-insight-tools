import type {
  LogicGridClue,
  LogicGridSymbolValue,
  LogicGridTest,
  LogicGridTool,
  Position,
} from "../../util/types";
import { BoardLayers } from "./boardLayers";
import { BoardView } from "./boardView";
import { ClueTyping, handleKey, type KeyEdits } from "./boardKeys";
import { isPlayable, UNKNOWN, UNPLAYABLE } from "./cell";
import { finishMerge, mergeSquare, splitSquare } from "./mergeEdits";
import { NO_SHAPE } from "./shapes";
import { symbolKindAt } from "./symbols";
import {
  seated,
  seatStroke,
  strokeFor,
  toggled,
  type Stroke,
  type ToolSelection,
} from "./strokes";

/**
 * All the board asks of the page around it: that an edit throws the last
 * answer away. Narrower than `LogicGridSolverEditor` on purpose — the wide type
 * made this file import the module that imports it back.
 */
export interface SolutionHolder {
  hideSolution(): void;
}

/**
 * The editor's grid, and only what it takes to work one: a press becomes a
 * stroke, a stroke becomes writes, and a write reaches one button and one
 * outline. Which stroke a press means is `strokes.ts`, what the layers hold is
 * `boardLayers.ts`, what is on screen is `boardView.ts`, restructuring a cell
 * is `mergeEdits.ts` and the keyboard is `boardKeys.ts`.
 */
export class Board {
  private readonly solver: SolutionHolder;
  /**
   * Handed LIVE to everything that decides a stroke, so a tool picked mid-drag
   * is seen rather than snapshotted at pointerdown.
   */
  private readonly selection: ToolSelection;
  private readonly layers: BoardLayers;
  private readonly view: BoardView;
  private readonly typing = new ClueTyping();
  /** What `mergeEdits.ts` and `boardKeys.ts` are given of this board. */
  private readonly edits: KeyEdits;

  /** The stroke in progress, or null when the pointer is up. */
  private stroke: Stroke | null = null;
  /** Aborts every listener this board registered — see `dispose`. */
  private readonly listeners = new AbortController();

  constructor(
    solver: SolutionHolder,
    gridWidth: number,
    gridHeight: number,
    selectedTool: LogicGridTool,
    selectedSymbol: number,
    symbolValue: LogicGridSymbolValue | null,
    symbolDirection: number | null = null,
  ) {
    this.solver = solver;
    this.selection = {
      tool: selectedTool,
      symbol: selectedSymbol,
      value: symbolValue,
      direction: symbolDirection,
    };
    this.layers = new BoardLayers(gridWidth, gridHeight);
    this.view = new BoardView(this.layers);
    this.edits = {
      layers: this.layers,
      selection: this.selection,
      typing: this.typing,
      writeCell: (position, color, clue) =>
        this.writeCell(position, color, clue),
      redress: squares => this.view.redress(squares),
      hideSolution: () => this.solver.hideSolution(),
      applyStroke: (stroke, position) => this.applyStroke(stroke, position),
    };
    this.addListeners();
    // `#grid` outlives the board, so a replaced board inherits whatever the
    // last one left on it — including a seam state that belongs to a tool this
    // one may not have armed.
    this.syncSeamTargets();
  }

  setOffByOne(active: boolean) {
    this.typing.setOffByOne(active);
  }

  /**
   * Drops this board's listeners. The `#grid` element outlives the board it
   * belongs to, so a replaced board that kept listening would keep painting
   * into its own dead layers and make every stroke do the work twice.
   */
  dispose() {
    this.listeners.abort();
    this.view.dispose();
  }

  setSelectedTool(tool: LogicGridTool) {
    this.selection.tool = tool;
    this.syncSeamTargets();
  }

  setSelectedSymbol(index: number) {
    this.selection.symbol = index;
    this.syncSeamTargets();
  }

  /**
   * Opens the seams between the squares to the pointer while a SEATED clue is
   * armed, and closes them again for everything else.
   *
   * A seated clue's whole point is the point BETWEEN squares, so asking the
   * player to hit the square and lean is backwards — the corner where four
   * squares meet is the one place a corner-seated galaxy obviously belongs, and
   * it is exactly the place nothing was listening. The stylesheet grows each
   * square's hit area by half a seam while this is on, so the seams and their
   * crossings are covered with no new elements and no change to what a square
   * IS. Which of the up-to-four overlapping neighbours receives the press does
   * not matter: `leanOf` reads the pointer's position relative to whichever
   * one it was and names the same point either way.
   *
   * Only while a seated clue is armed, so a paint stroke keeps its exact hit
   * area — a colour has no meaning in a seam, and widening those targets would
   * change what a drag across the board paints.
   */
  private syncSeamTargets() {
    const seated =
      this.selection.tool === "symbol" &&
      symbolKindAt(this.selection.symbol)?.seating !== "none";
    this.view.host.toggleAttribute("data-seams", seated);
  }

  setSymbolValue(value: LogicGridSymbolValue | null) {
    this.selection.value = value;
  }

  setSymbolDirection(direction: number | null) {
    this.selection.direction = direction;
  }

  /** Clears all three layers, and the run of digits typing into them. */
  resetBoardData() {
    this.layers.reset();
    this.typing.reset();
  }

  getCells() {
    return this.layers.getCells();
  }

  getShapes() {
    return this.layers.getShapes();
  }

  getSymbols() {
    return this.layers.getSymbols();
  }

  renderGrid() {
    this.view.render();
  }

  /**
   * Replaces the board contents with a validated config. The caller must have
   * constructed the board with the config's grid size.
   */
  loadConfig(config: LogicGridTest) {
    this.layers.load(config);
    this.typing.reset();
  }

  private addListeners() {
    const { signal } = this.listeners;
    const grid = this.view.host;

    grid.addEventListener("pointerdown", event => this.beginStroke(event), {
      signal,
    });

    grid.addEventListener(
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
        const position = extractCellPosition(under);
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
        finishMerge(this.edits, stroke.target, stroke.origin);
      }
    };
    document.addEventListener("pointerup", endStroke, { signal });
    document.addEventListener("pointercancel", endStroke, { signal });

    // Right-dragging the light colour across the board would otherwise open the
    // context menu on the first cell and end the stroke there.
    grid.addEventListener("contextmenu", event => event.preventDefault(), {
      signal,
    });

    grid.addEventListener(
      "keydown",
      event => {
        const position = extractCellPosition(event.target);
        if (position) handleKey(this.edits, event, position);
      },
      { signal },
    );
  }

  private beginStroke(event: PointerEvent) {
    // Left and right only. The middle button and the browser-back buttons all
    // arrive here as pointerdowns and must not paint.
    if (event.button !== 0 && event.button !== 2) return;
    const position = extractCellPosition(event.target);
    if (!position) return;

    const secondary = event.button === 2;
    const pressed = strokeFor(this.selection, this.layers, secondary, position);
    if (!pressed) return;
    // A symmetry stroke's seat is fixed here from where the pointer went down
    // — before the re-click rule, which compares seats — and its home square
    // may be the seam's other neighbour.
    const { stroke, home } = seatStroke(
      this.layers,
      pressed,
      event,
      position,
      () => this.view.rectAt(position),
    );

    this.stroke = toggled(this.layers, stroke, home);
    this.typing.reset();
    this.applyStroke(this.stroke, home);
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
      mergeSquare(this.edits, stroke.target, position);
      return;
    }
    if (stroke.kind === "split") {
      splitSquare(this.edits, position);
      return;
    }

    const squares = this.layers.squaresAt(position);

    if (stroke.kind === "erase") {
      for (const square of squares) {
        this.writeCell(this.layers.shapes.position(square), UNKNOWN, null);
      }
      return;
    }

    if (stroke.kind === "color") {
      this.paintCell(stroke.value, squares);
      return;
    }

    // A clue cannot be placed on a gap; lifting one always may.
    if (stroke.clue && !isPlayable(this.layers.colorAt(position))) return;
    this.writeCell(
      position,
      this.layers.colorAt(position),
      seated(this.layers, stroke.clue, position),
    );
  }

  /** One colour across every square of a cell, with every clue left on
   * whichever square of it the player put it on. */
  private paintCell(value: number, squares: number[]) {
    const { shapes } = this.layers;
    // A gap in the board is not a cell the puzzle clues, so painting one drops
    // whatever clues were there — and it is not part of a merged cell either,
    // so painting a merged cell away dissolves it back into loose squares.
    const dissolving = value === UNPLAYABLE && squares.length > 1;
    if (dissolving) shapes.dissolve(shapes.idAt(squares[0]!));

    for (const square of squares) {
      const at = shapes.position(square);
      const keeps = value === UNPLAYABLE ? null : this.layers.clueAt(at);
      this.writeCell(at, value, keeps);
    }
    // Only after the writes: the seams these squares no longer share depend on
    // membership the loop above was still changing.
    if (dissolving) this.view.redress(squares);
  }

  /**
   * Every change to either layer, and everything on screen that has to follow
   * one. A no-op when nothing moves, which is the common case while dragging: a
   * pointermove fires many times per cell.
   */
  private writeCell(
    position: Position,
    color: number,
    clue: LogicGridClue | null,
  ) {
    const moved = this.layers.write(position, color, clue);
    if (moved === "nothing") return;
    this.view.dressCellAt(position.x, position.y);
    // The outline carries a merged cell's fill, so a colour change has to reach
    // it as well as the square.
    if (moved === "color" && this.layers.cellIdAt(position) !== NO_SHAPE) {
      this.view.drawOutlines();
    }
    this.solver.hideSolution();
  }
}

/**
 * Which square an event landed on. A free function rather than a method: it
 * reads nothing of the board, only the `data-x`/`data-y` every `.grid-cell`
 * carries.
 */
function extractCellPosition(target: EventTarget | null): Position | null {
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
