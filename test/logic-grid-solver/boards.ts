import {
  DARK,
  LIGHT,
  UNKNOWN,
  UNPLAYABLE,
} from "../../src/pages/logic-grid-solver/cell";
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
