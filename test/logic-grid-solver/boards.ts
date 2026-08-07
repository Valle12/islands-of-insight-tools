import {
  DARK,
  LIGHT,
  UNKNOWN,
  UNPLAYABLE,
} from "../../src/pages/logic-grid-solver/cell";
import { CONFIG_VERSION } from "../../src/pages/logic-grid-solver/config";
import { RULES } from "../../src/pages/logic-grid-solver/rules";
import { SYMBOL_KINDS } from "../../src/pages/logic-grid-solver/symbols";
import type { LogicGridTest } from "../../src/util/types";

/**
 * Hand-built boards, written as pictures.
 *
 * `test/resources/logic-grid-solver/` holds boards captured from the game and
 * nothing else, so anything a test invents lives here instead. That split is
 * deliberate: a sweep over the captured corpus should measure the solver
 * against real puzzles, and a made-up board sitting in that directory would
 * quietly dilute the number.
 *
 * The e2e suites import this too — same TypeScript, same parser, so a board
 * cannot drift between the unit tests and the browser ones.
 */

/** Throws on a typo rather than putting `findIndex`'s -1 into a fixture. */
const ruleIndex = (id: string) => {
  const index = RULES.findIndex(rule => rule.id === id);
  if (index < 0) throw new Error(`boards.ts asks for an unknown rule: ${id}`);
  return index;
};

/** Same discipline for the clue catalogue, which is append-only too. */
const symbolIndex = (id: string) => {
  const index = SYMBOL_KINDS.findIndex(kind => kind.id === id);
  if (index < 0) throw new Error(`boards.ts asks for an unknown symbol: ${id}`);
  return index;
};

const AREA_SYMBOL = symbolIndex("area");
const LETTER_SYMBOL = symbolIndex("letter");
const DART_SYMBOL = symbolIndex("dart");
const LOTUS_SYMBOL = symbolIndex("lotus");
const VIEWPOINT_SYMBOL = symbolIndex("viewpoint");
const GALAXY_SYMBOL = symbolIndex("galaxy");

/**
 * A puzzle from a picture, one string per row:
 *
 *   '.'      an uncoloured cell        '#'      a gap in the board
 *   'D'/'L'  a cell already painted    '1'-'9'  an area number
 *   'a'-'z'  a letter clue
 *
 * A clue always lands on an uncoloured cell, which is the colourless clue the
 * game actually shows; `withGiven` paints one afterwards when a test needs a
 * clue whose colour is already known.
 */
export function board(rows: string[], ruleIds: string[] = []): LogicGridTest {
  const gridHeight = rows.length;
  const gridWidth = rows[0]!.length;
  const cells = Array.from({ length: gridWidth }, () =>
    Array.from({ length: gridHeight }, () => UNKNOWN),
  );
  const symbols: LogicGridTest["symbols"] = [];
  for (let y = 0; y < gridHeight; y++) {
    for (let x = 0; x < gridWidth; x++) {
      const glyph = rows[y]![x]!;
      if (glyph === "#") cells[x]![y] = UNPLAYABLE;
      else if (glyph === "D") cells[x]![y] = DARK;
      else if (glyph === "L") cells[x]![y] = LIGHT;
      else if (glyph >= "1" && glyph <= "9")
        symbols.push({ x, y, type: AREA_SYMBOL, value: Number(glyph) });
      else if (glyph >= "a" && glyph <= "z")
        symbols.push({ x, y, type: LETTER_SYMBOL, value: glyph.toUpperCase() });
    }
  }
  return {
    // Current by construction: these boards stand in for files the editor
    // itself could have written, and every one of those carries the tag.
    version: CONFIG_VERSION,
    gridWidth,
    gridHeight,
    rules: ruleIds.map(ruleIndex).sort((a, b) => a - b),
    cells,
    symbols,
  };
}

/** Paints a cell the picture could not, because it already carries a clue. */
export function withGiven(
  config: LogicGridTest,
  x: number,
  y: number,
  color: number,
): LogicGridTest {
  config.cells[x]![y] = color;
  return config;
}

/**
 * Fuses squares into one merged cell. A second call rather than a glyph: the
 * picture's alphabet is entirely spoken for, and a shape has to say which
 * squares go together rather than just that a square is in one. Mirrors
 * `withShape` in the C++ `TestBoards.h`.
 */
export function withShape(
  config: LogicGridTest,
  squares: [number, number][],
): LogicGridTest {
  const shape = squares.map(([x, y]) => y * config.gridWidth + x);
  config.shapes = [...(config.shapes ?? []), shape];
  return config;
}

/**
 * Puts a dart on a cell. A second call rather than a glyph, like `withShape`
 * and for the same reason: the picture's alphabet is spoken for, and a dart
 * carries two things rather than one. Mirrors `withDart` in `TestBoards.h`.
 *
 * `direction` is an index into `DIRECTIONS` — 0 up, 1 right, 2 down, 3 left.
 */
export function withDart(
  config: LogicGridTest,
  x: number,
  y: number,
  value: number,
  direction: number,
): LogicGridTest {
  config.symbols.push({ x, y, type: DART_SYMBOL, value, direction });
  config.symbols.sort((a, b) => a.y - b.y || a.x - b.x);
  return config;
}

/**
 * Puts a symmetry symbol (the game's lotus) on a cell. A second call like
 * `withDart`, and for the same reason — it carries an AXIS in the `direction`
 * key (0 horizontal, 1 falling diagonal, 2 vertical, 3 rising diagonal) and,
 * on a merged cell, an optional SEAT: half a square right for bit 0, down for
 * bit 1, so the axis point can sit on the cell's grid lines. No value at all.
 * Mirrors `withLotus` in the C++ `TestBoards.h`.
 */
export function withLotus(
  config: LogicGridTest,
  x: number,
  y: number,
  axis: number,
  seat = 0,
): LogicGridTest {
  config.symbols.push({
    x,
    y,
    type: LOTUS_SYMBOL,
    direction: axis,
    ...(seat ? { seat } : {}),
  });
  config.symbols.sort((a, b) => a.y - b.y || a.x - b.x);
  return config;
}

/**
 * Puts a viewpoint on a cell. A second call like the others: a counting clue
 * with no direction at all, whose number is its own square plus the leading
 * same-colour run along each of the four rays. Mirrors `withViewpoint` in the
 * C++ `TestBoards.h`.
 */
export function withViewpoint(
  config: LogicGridTest,
  x: number,
  y: number,
  value: number,
): LogicGridTest {
  config.symbols.push({ x, y, type: VIEWPOINT_SYMBOL, value });
  config.symbols.sort((a, b) => a.y - b.y || a.x - b.x);
  return config;
}

/**
 * Puts a galaxy on a cell. A second call like the others: a symmetry symbol
 * with no value, direction or seat at all — its region must map to itself
 * under a half turn about this very square. Mirrors `withGalaxy` in the C++
 * `TestBoards.h`.
 */
export function withGalaxy(
  config: LogicGridTest,
  x: number,
  y: number,
): LogicGridTest {
  config.symbols.push({ x, y, type: GALAXY_SYMBOL });
  config.symbols.sort((a, b) => a.y - b.y || a.x - b.x);
  return config;
}

/**
 * Puts an area number the picture cannot spell on a cell — one past nine, or
 * the displayed ZERO that only the off-by-one rule makes legal. Mirrors
 * `withClue` in the C++ `TestBoards.h`.
 */
export function withArea(
  config: LogicGridTest,
  x: number,
  y: number,
  value: number,
): LogicGridTest {
  config.symbols.push({ x, y, type: AREA_SYMBOL, value });
  config.symbols.sort((a, b) => a.y - b.y || a.x - b.x);
  return config;
}

/** A colouring in the flat row-major layout an answer arrives in. */
export function painted(rows: string[]): number[] {
  const flat: number[] = [];
  for (const row of rows) {
    for (const glyph of row) {
      if (glyph === "#") flat.push(UNPLAYABLE);
      else if (glyph === "D") flat.push(DARK);
      else if (glyph === "L") flat.push(LIGHT);
      else flat.push(UNKNOWN);
    }
  }
  return flat;
}

/**
 * A board with a solution: nine cells of one colour somewhere in a 5x5, with
 * both colours connected and no dark 2x2. Not unique, and nothing should
 * assume it is — what it is for is exercising a full answer end to end.
 */
export const solvableBoard = (): LogicGridTest =>
  board(
    [".....", ".....", "..9..", ".....", "....."],
    ["no-dark-2x2", "connect-dark", "connect-light"],
  );

/**
 * An underclued board with something genuinely forced: the area-one clue sits
 * on a cell that is already dark, so its two neighbours can only be light,
 * while most of the board is free either way.
 */
export const undercluedBoard = (): LogicGridTest => {
  const config = board(
    ["1...", "....", "....", "...3"],
    ["no-dark-2x2", "underclued"],
  );
  withGiven(config, 0, 0, DARK);
  withGiven(config, 3, 3, LIGHT);
  return config;
};

/**
 * Five wide, so the 1x5 run rules have somewhere they can fire, with four of
 * the top row already dark — which forces the fifth light and no other cell.
 *
 * It is the shortest path from the append-only catalogue to the compiled
 * module: the wasm boundary rejects a rule index it does not know, and an
 * engine that silently ignored one would answer `DDDDD` and be thrown out by
 * `verify.ts`. Either kind of drift fails here rather than on a real puzzle.
 */
export const runFiveBoard = (): LogicGridTest =>
  board(["DDDD.", "....."], ["no-dark-1x5", "no-light-1x5"]);

/**
 * Four columns two deep with both area rules on, which the vertical dominoes
 * `DLDL` satisfy: four regions of exactly two, none of them touching another of
 * its own colour.
 *
 * It plays `runFiveBoard`'s role for the newest pair. Half of each rule compiles
 * into forbidden trominoes and half is a propagator, so a board carrying it
 * reaches both — and an engine that quietly ignored either half would answer
 * something `verify.ts` throws out rather than answering nothing.
 */
export const areaTwoBoard = (): LogicGridTest =>
  board(["....", "...."], ["area-two-dark", "area-two-light"]);

/**
 * The same for the area-FOUR pair, which enforce both halves in a propagator
 * rather than half in the pattern table — so a board carrying them exercises a
 * different mechanism from `areaTwoBoard` despite reading the same.
 *
 * Eight cells, satisfied by two 2x2 blocks or by two rows of four.
 */
export const areaFourBoard = (): LogicGridTest =>
  board(["....", "...."], ["area-four-dark", "area-four-light"]);

/**
 * The two dark givens sit a cell apart under "no dark-light-dark", so the
 * middle of the top row cannot be light — the first MIXED-colour clause
 * (checkerboards aside) forcing a cell through the real module.
 */
export const forbiddenTripleBoard = (): LogicGridTest => {
  const config = board(["...", "..."], ["no-dark-light-dark"]);
  withGiven(config, 0, 0, DARK);
  withGiven(config, 2, 0, DARK);
  return config;
};

/**
 * A dark bar across the top under "no dark T": the square under its middle is
 * the T's stem and can only be light. The four-rotation pattern family's trip
 * through the boundary, same as `forbiddenTripleBoard` is the triples'.
 */
export const teeBoard = (): LogicGridTest => {
  const config = board(["...", "..."], ["no-dark-t"]);
  withGiven(config, 0, 0, DARK);
  withGiven(config, 1, 0, DARK);
  withGiven(config, 2, 0, DARK);
  return config;
};

/**
 * The same purpose again for area FIVE — six wide, because an area of five
 * implies a forbidden straight run of SIX, and this is the first board that
 * six-cell clause even fits on. `kMaxPatternCells` was raised for it, so this
 * board is what sends a six-cell clause through the real module. The given
 * dark corner forces a real dark region of exactly five; light is
 * unconstrained, so the board is solvable (five dark across the top, say, and
 * everything else light).
 */
export const areaFiveBoard = (): LogicGridTest => {
  const config = board(["......", "......"], ["area-five-dark"]);
  return withGiven(config, 0, 0, DARK);
};

/**
 * A 2x2 with three dark givens under "no 3 dark + 1 light": the fourth corner
 * cannot be light, so the only answer paints it dark. The first family with
 * more instances than orientations — four per rule, one per corner the odd
 * cell can take — making its trip through the boundary. An engine that
 * silently ignored the rule could answer the corner light and be thrown out
 * by `verify.ts`.
 */
export const threeOneBoard = (): LogicGridTest => {
  const config = board(["..", ".."], ["no-three-dark-one-light"]);
  withGiven(config, 0, 0, DARK);
  withGiven(config, 1, 0, DARK);
  withGiven(config, 0, 1, DARK);
  return config;
};

/**
 * A dark given in the middle under "no dark diagonal": all four of its
 * diagonal neighbours are forced light, whatever else happens. The two-cell
 * diagonal patterns' trip through the boundary — the first clauses whose
 * cells are not orthogonally contiguous.
 */
export const diagonalBoard = (): LogicGridTest => {
  const config = board(["...", "...", "..."], ["no-dark-diagonal"]);
  return withGiven(config, 1, 1, DARK);
};

/**
 * `areaTwoBoard`'s role for the area-THREE pair, the size on `regionArea`'s
 * side of the table trade: no shapes beyond the implied run of four. Six
 * cells, satisfied by a dark row of three over a light one.
 */
export const areaThreeBoard = (): LogicGridTest =>
  board(["...", "..."], ["area-three-dark", "area-three-light"]);

/**
 * Two darts, both of which fill in immediately and between them settle the
 * whole board — which is the technique the game calls dart minimax: a dart
 * holding 0, or holding as many squares as its line has, leaves no choice.
 *
 * The top dart also looks straight THROUGH the gap: its line is three squares
 * long, not two, and the gap is neither counted nor a wall. There are no rules
 * at all, so the darts are the only thing deciding anything.
 */
export const dartBoard = (): LogicGridTest => {
  const config = board(["..#..", "....."]);
  withGiven(config, 0, 0, DARK);
  withGiven(config, 0, 1, DARK);
  // Nothing light to the right, past the gap: the rest of the row is dark.
  withDart(config, 0, 0, 0, 1);
  // Every square to the right is light, which is the other extreme.
  withDart(config, 0, 1, 4, 1);
  return config;
};

/**
 * A dart whose line crosses a merged 1x3 bar, with a value only the per-SQUARE
 * reading can satisfy.
 *
 * The line holds four squares, three of which are one cell. Asking for three of
 * the other colour forces that cell light and the last square dark — while a
 * dart that counted CELLS could never reach three at all. So this board is a
 * solution exactly under the rule the engine claims to implement.
 */
export const dartOverMergedBoard = (): LogicGridTest => {
  const config = board(["....."]);
  withGiven(config, 0, 0, DARK);
  withDart(config, 0, 0, 3, 1);
  withShape(config, [
    [1, 0],
    [2, 0],
    [3, 0],
  ]);
  return config;
};

/**
 * A dart INSIDE a merged cell, on a square the cell's middle is not.
 *
 * Which square of a merged cell a clue sits on is the player's choice, and for
 * a dart it is load-bearing: the line starts there. The cell is the two dark
 * squares of the top row and the dart is on the RIGHT one, so its line runs
 * down column 1 and forces both squares under it light. Re-homed to the middle
 * of the cell — which is what the editor used to do, and what the validator
 * used to insist on — the line would run down column 0 instead and the answer
 * would name two different cells. Underclued, so the answer IS the forced set
 * and the column it names is the assertion.
 */
export const dartInMergedBoard = (): LogicGridTest => {
  const config = board(["...", "...", "..."], ["underclued"]);
  withGiven(config, 0, 0, DARK);
  withGiven(config, 1, 0, DARK);
  withDart(config, 1, 0, 2, 2);
  withShape(config, [
    [0, 0],
    [1, 0],
  ]);
  return config;
};

/**
 * TWO darts on one merged cell — the game's harder boards do exactly this,
 * and it used to be refused on every layer.
 *
 * Each dart acts from its own square with its own value: the left one says
 * the two squares below it are light, the right one says its own two are
 * dark, so the forced set names the two columns DIFFERENTLY. Any re-homing or
 * one-clue collapse would make that impossible. Underclued, so the answer IS
 * the forced set.
 */
export const twoDartsOneCellBoard = (): LogicGridTest => {
  const config = board(["...", "...", "..."], ["underclued"]);
  withGiven(config, 0, 0, DARK);
  withGiven(config, 1, 0, DARK);
  withDart(config, 0, 0, 2, 2);
  withDart(config, 1, 0, 0, 2);
  withShape(config, [
    [0, 0],
    [1, 0],
  ]);
  return config;
};

/**
 * A board with merged cells: a 1x3 bar across the top row and an L below it,
 * with "no dark 1x3" on.
 *
 * It reaches everything a merged cell is for in one board. The bar is one cell
 * three squares wide, so the run rule compiles to a clause in a SINGLE variable
 * and the whole bar is forced light before anything is guessed — the rules
 * count squares, and fusing them does not hide the run they make. The L spans a
 * 2x2 diagonal, which is the pattern instance the compiler drops rather than
 * collapses. It carries no clues: what it is for is the two halves of clause
 * construction through the real wasm, and an area number counting a merged
 * cell's squares is pinned by `verify.test.ts` and by the C++ brute-force sweep.
 */
export const mergedCellBoard = (): LogicGridTest => {
  const config = board(["...", "...", "..."], ["no-dark-1x3"]);
  withShape(config, [
    [0, 0],
    [1, 0],
    [2, 0],
  ]);
  withShape(config, [
    [0, 1],
    [0, 2],
    [1, 2],
  ]);
  return config;
};

/**
 * A symmetry symbol whose own colour is given, with one dark neighbour above:
 * the region must mirror across the horizontal axis, so the square below is
 * forced dark while the rest of the board stays free. The lotus's
 * `direction`-as-axis crosses the boundary nowhere else — every captured
 * board predates the kind — which is the same argument the dart boards make.
 */
export const lotusBoard = (): LogicGridTest => {
  const config = board(["...", "...", "..."]);
  withGiven(config, 1, 0, DARK);
  withGiven(config, 1, 1, DARK);
  withLotus(config, 1, 1, 0);
  return config;
};

/**
 * A symmetry symbol SEATED on the seam of its own 1x2 merged cell — the axis
 * is the grid line between its two squares — with the top-right square
 * already dark. Mirroring forces the square below it dark, and the bottom row
 * reflects off the board, so it can only be light: the whole answer is
 * forced, which makes any arm's wrong seat arithmetic loud. The `seat` key
 * crosses the boundary nowhere else.
 */
export const lotusOverMergedBoard = (): LogicGridTest => {
  const config = board(["..", "..", ".."]);
  withShape(config, [
    [0, 0],
    [0, 1],
  ]);
  withGiven(config, 0, 0, DARK);
  withGiven(config, 0, 1, DARK);
  withGiven(config, 1, 0, DARK);
  withLotus(config, 0, 0, 0, 2);
  return config;
};

/**
 * Two viewpoints on a board with a gap, and no rules at all, so the counting
 * is the only thing deciding anything. The dark three at the closed end of
 * the top corridor must see two more squares — the game's viewpoint
 * expansion, and the corridor example the technique is usually told with —
 * and its sight STOPS at the gap where a dart's line would step over. The
 * light five below is everything it could still see with the dark square
 * above it, so its whole row fills in. The kind and its `value` cross the
 * boundary nowhere else: every captured board predates kind 4, the same
 * argument the dart and lotus boards make.
 */
export const viewpointBoard = (): LogicGridTest => {
  const config = board(["...#.", "....."]);
  withGiven(config, 0, 0, DARK);
  withGiven(config, 0, 1, LIGHT);
  withViewpoint(config, 0, 0, 3);
  withViewpoint(config, 0, 1, 5);
  return config;
};

/**
 * A viewpoint whose right ray crosses a merged 1x3 bar, with a value only the
 * per-SQUARE reading can satisfy: four means three more squares seen, which is
 * exactly the bar — so it joins the viewpoint's colour whole, and the square
 * past it is the stop. A count that took the bar as ONE thing could never
 * reach four on this board.
 */
export const viewpointOverMergedBoard = (): LogicGridTest => {
  const config = board(["....."]);
  withGiven(config, 0, 0, DARK);
  withViewpoint(config, 0, 0, 4);
  withShape(config, [
    [1, 0],
    [2, 0],
    [3, 0],
  ]);
  return config;
};

/**
 * A viewpoint ON a merged cell, on the end of an L whose third square lies on
 * no ray through it. Underclued, so the answer IS the forced set: the clue's
 * own square and its two ray neighbours are decided — the cell-mate on the
 * left ray counts and the one diagonal to it counts only through the cell's
 * one-colour rule, while the far corner the count never reaches stays
 * undecided. Pure line geometry, read off the answer.
 */
export const viewpointOnMergedBoard = (): LogicGridTest => {
  const config = board(["...", "...", "..."], ["underclued"]);
  withGiven(config, 0, 0, DARK);
  withGiven(config, 1, 0, DARK);
  withGiven(config, 0, 1, DARK);
  withShape(config, [
    [0, 0],
    [1, 0],
    [0, 1],
  ]);
  withViewpoint(config, 1, 0, 2);
  return config;
};

/**
 * Four letter pairs on a 10x7 board with no rules at all, which means the only
 * thing the propagators can bite on is connectivity — so the search has to
 * guess most of the seventy cells.
 *
 * That is the whole point of it. `Dfs::descend` used to recurse once per
 * guessed cell, and the frame is big enough (the compiler inlines `pickCell`'s
 * `Bits` temporaries into it) that seventy of them overflowed emscripten's
 * 64 KB stack. The module trapped with "Out of bounds memory access" while the
 * native build, with a megabyte of stack, solved the same board in 32 ms. Sent
 * through the real wasm this board fails loudly if that recursion ever returns.
 *
 * A real capture, but a mis-entered one — the game's board had gaps in the
 * corners — so it lives here rather than in the captured corpus.
 */
/**
 * A galaxy on the centre with its column's top already dark: the half turn
 * forces the square below it dark. Kind 5 crosses the wasm boundary nowhere
 * else — every captured board predates it.
 */
export const galaxyBoard = (): LogicGridTest => {
  const config = board(["...", "...", "..."]);
  withGiven(config, 1, 0, DARK);
  withGiven(config, 1, 1, DARK);
  withGalaxy(config, 1, 1);
  return config;
};

/**
 * A galaxy on the RIGHT square of a dark 1x2 merged cell, underclued. The
 * mirror is taken about the SQUARE, never the cell's middle: the cell-mate
 * turns onto the top-right corner, and the whole row below turns off the
 * board — so the forced set is the top row dark and the middle row light,
 * which an arm mirroring about the cell's centre could not produce.
 */
export const galaxyOverMergedBoard = (): LogicGridTest => {
  const config = board(["...", "...", "..."], ["underclued"]);
  withShape(config, [
    [0, 0],
    [1, 0],
  ]);
  withGiven(config, 0, 0, DARK);
  withGiven(config, 1, 0, DARK);
  withGalaxy(config, 1, 0);
  return config;
};

/**
 * All three numeric kinds under "Numbers are off by one", each DISPLAYING a
 * zero or a value one off its true count — the displayed 0 is the value this
 * board exists to push across the boundary, since no captured fixture can
 * carry one and the valueless kinds' default is the same number.
 */
export const offByOneBoard = (): LogicGridTest => {
  const config = board(["...", "...", "..2"], ["off-by-one"]);
  withArea(config, 0, 0, 0);
  withDart(config, 2, 0, 0, 3);
  withViewpoint(config, 1, 1, 0);
  return config;
};

/** Two dark givens in a 2x2 under the elbow rule: any third dark square would
 * bend, so both remaining squares are forced light. */
export const elbowBoard = (): LogicGridTest =>
  board(["DD", ".."], ["no-dark-elbow"]);

/** A dark bar of three under the L rule: a foot at either END would make an
 * L, while one at the middle would only make a T, which stays legal. */
export const ellBoard = (): LogicGridTest =>
  board(["D.", "D.", "D."], ["no-dark-l"]);

/**
 * The distance rule ACROSS a gap, underclued: the two ends of the row are two
 * apart whatever sits between them, so the far cell is forced light straight
 * through the hole — the user-confirmed positional semantics, pinned where
 * only the wasm lane can see it.
 */
export const distancePairBoard = (): LogicGridTest =>
  board(["D#."], ["no-dark-any-dark", "underclued"]);

/** A dark T with its stem's first square given: growing the stem one deeper
 * would make the long T, so that square is forced light. */
export const longTeeBoard = (): LogicGridTest =>
  board(["DDD", ".D.", "..."], ["no-dark-long-t"]);

/** One dark given mid-board under the knight rule: both on-board knight
 * targets are forced light, nothing between them read. */
export const knightBoard = (): LogicGridTest =>
  board(["....", ".D..", "...."], ["no-dark-knight"]);

/** Dark bar ends and stem given: a light crossing would be the forbidden
 * mixed T, so the crossing is forced dark. */
export const mixedTeeBoard = (): LogicGridTest =>
  board(["D.D", ".D."], ["no-light-crossed-dark-t"]);

/** Two dark givens corner to corner: either square between them would be the
 * corner of a dark-light-dark elbow if it went light, so both go dark. */
export const mixedElbowBoard = (): LogicGridTest =>
  board(["D.", ".D"], ["no-dark-light-dark-elbow"]);

/** Six dark in a row on the first board wide enough for the implied run of
 * SEVEN to instantiate — the clause the widened pattern table exists for. */
export const areaSixBoard = (): LogicGridTest =>
  board(["DDDDDD.", "......."], ["area-six-dark"]);

/** And seven on an eight-wide board: the run of EIGHT, the table's new
 * ceiling, firing across the boundary — no reference board has this room. */
export const areaSevenBoard = (): LogicGridTest =>
  board(["DDDDDDD.", "........"], ["area-seven-dark"]);

/** One dark given under area twenty-four: far past the table, the whole rule
 * rides the region walk, and the answer must grow the region to 24 of the 25
 * squares. */
export const areaTwentyFourBoard = (): LogicGridTest =>
  board(
    ["D....", ".....", ".....", ".....", "....."],
    ["area-twenty-four-dark"],
  );

export const deepSearchBoard = (): LogicGridTest => {
  const config = board([
    "......a...",
    "..........",
    "...b...c..",
    "....d.....",
    "..b.D.c...",
    "....d.....",
    ".....a....",
  ]);
  // Every clue sits on a cell the player had already painted light.
  const lit = [
    [6, 0],
    [3, 2],
    [7, 2],
    [4, 3],
    [2, 4],
    [6, 4],
    [4, 5],
    [5, 6],
  ] as const;
  for (const [x, y] of lit) withGiven(config, x, y, LIGHT);
  return config;
};

/**
 * A board with no solution at all: dark has to be one region, and its two
 * cells each claim a different size for it.
 */
export const impossibleBoard = (): LogicGridTest => {
  const config = board(["2...", "....", "....", "...5"], ["connect-dark"]);
  withGiven(config, 0, 0, DARK);
  withGiven(config, 3, 3, DARK);
  return config;
};

/**
 * Every part of the download format in one board — painted cells of both
 * colours, a gap, an area number and a letter — for the tests that care about
 * loading rather than solving.
 */
export const formatSample = (): LogicGridTest => {
  const config = board(
    ["3..L.", "DL.L.", "D.a..", ".L.2.", "....#"],
    ["no-dark-2x2", "connect-dark", "underclued"],
  );
  withGiven(config, 0, 0, DARK);
  withGiven(config, 3, 3, DARK);
  return config;
};
