import { describe, expect, test } from "bun:test";
import {
  DARK,
  LIGHT,
  UNKNOWN,
  UNPLAYABLE,
} from "../../src/pages/logic-grid-solver/cell";
import {
  galaxyFootprint,
  galaxyTiles,
  galaxyTiling,
  isTiledKind,
  sameGalaxyTile,
} from "../../src/pages/logic-grid-solver/galaxyTiles";
import { SYMBOL_KINDS } from "../../src/pages/logic-grid-solver/symbols";
import type { LogicGridSymbol } from "../../src/util/types";

/**
 * The seated galaxy's drawing model, with no DOM at all.
 *
 * Every corner case the page showed was decided here and then rendered, so
 * this is where they are cheapest to pin — and it is the one place the claim
 * that the outline, the glyph and the `cell-pair` classes CANNOT disagree is
 * directly assertable, since all three read this and nothing else.
 */
describe("galaxy tiles", () => {
  const kind = (id: string) => SYMBOL_KINDS.findIndex(one => one.id === id);
  const GALAXY = kind("galaxy");
  const LOTUS = kind("lotus");
  const size = { gridWidth: 4, gridHeight: 4 };

  const galaxy = (x: number, y: number, seat = 0): LogicGridSymbol => ({
    x,
    y,
    type: GALAXY,
    ...(seat ? { seat } : {}),
  });

  /** A color lookup from a picture, one character per square, row-major. */
  const colorsOf = (rows: string[]) => (x: number, y: number) => {
    const at = rows[y]?.[x];
    if (at === "#") return DARK;
    if (at === "o") return LIGHT;
    if (at === "X") return UNPLAYABLE;
    return UNKNOWN;
  };

  const tilingOf = (
    clues: LogicGridSymbol[],
    rows: string[],
    merged: (square: number) => boolean = () => false,
  ) => galaxyTiling(galaxyTiles(clues, size), size, colorsOf(rows), merged);

  const blank = ["....", "....", "....", "...."];

  describe("footprints", () => {
    test("a seat of 0 occupies its own square and draws nothing", () => {
      expect(galaxyFootprint(galaxy(1, 1), size)).toEqual([5]);
      expect(galaxyTiles([galaxy(1, 1)], size)).toEqual([]);
    });

    test("a line seat occupies two squares and a corner seat four", () => {
      expect(galaxyFootprint(galaxy(1, 1, 1), size)).toEqual([5, 6]);
      expect(galaxyFootprint(galaxy(1, 1, 2), size)).toEqual([5, 9]);
      expect(galaxyFootprint(galaxy(1, 1, 3), size)).toEqual([5, 6, 9, 10]);
    });

    /** Half a footprint would draw half a pill, which is worse than none. */
    test("a seat whose partner is off the board keeps its own square only", () => {
      expect(galaxyFootprint(galaxy(3, 1, 1), size)).toEqual([7]);
      expect(galaxyTiles([galaxy(3, 1, 1)], size)).toEqual([]);
    });

    /** Keyed on the seating CAPABILITY, so the lotus — whose seat only ever
     * sits inside a merged cell — is not one of these. */
    test("only a board-seated kind has a footprint", () => {
      expect(isTiledKind(GALAXY)).toBeTrue();
      expect(isTiledKind(LOTUS)).toBeFalse();
      expect(
        galaxyFootprint({ x: 1, y: 1, type: LOTUS, seat: 1 }, size),
      ).toEqual([]);
    });
  });

  describe("what is drawn", () => {
    test("a pill needs at least one painted square", () => {
      expect(tilingOf([galaxy(1, 1, 1)], blank).tiles).toEqual([]);
      expect(
        tilingOf([galaxy(1, 1, 1)], ["....", ".#..", "....", "...."]).tiles,
      ).toEqual([[5, 6]]);
    });

    /**
     * A square that is not painted keeps its own absence. It is drawn as a
     * NEUTRAL part of the tile, never borrowed from its partner — borrowing
     * turned three untouched squares of a corner seat solid black and the
     * board stopped saying which squares were really colored.
     */
    test("an unpainted square keeps its own color", () => {
      const tiling = tilingOf([galaxy(1, 1, 1)], ["....", ".#..", "....", "...."]);
      expect(tiling.colorAt(1, 1)).toBe(DARK);
      expect(tiling.colorAt(2, 1)).toBe(UNKNOWN);
      // ...and both are inside the drawn tile, which is what joins them.
      expect(tiling.drawnAt(1, 1)).toBeTrue();
      expect(tiling.drawnAt(2, 1)).toBeTrue();
    });

    test("two painted squares keep their own colors", () => {
      const tiling = tilingOf([galaxy(1, 1, 1)], ["....", ".#o.", "....", "...."]);
      expect(tiling.colorAt(1, 1)).toBe(DARK);
      expect(tiling.colorAt(2, 1)).toBe(LIGHT);
    });

    /** One painted square of four is still a tile, and the other three are
     * still plainly nothing. */
    test("a corner pill leaves its unpainted squares alone", () => {
      const tiling = tilingOf([galaxy(1, 1, 3)], ["....", "..o.", "....", "...."]);
      expect(tiling.tiles).toEqual([[5, 6, 9, 10]]);
      expect(tiling.colorAt(2, 1)).toBe(LIGHT);
      for (const [x, y] of [
        [1, 1],
        [1, 2],
        [2, 2],
      ])
        expect(tiling.colorAt(x!, y!)).toBe(UNKNOWN);
    });

    /**
     * An SVG fill cannot be the gap's hatch, and a square the puzzle does not
     * color is not part of a cell anyway.
     */
    test("a gap under the seat drops the pill", () => {
      expect(
        tilingOf([galaxy(1, 1, 1)], ["....", ".#X.", "....", "...."]).tiles,
      ).toEqual([]);
    });

    /** That cell already draws itself as one outlined shape. */
    test("a merged cell under the seat drops the pill", () => {
      expect(
        tilingOf(
          [galaxy(1, 1, 1)],
          ["....", ".#o.", "....", "...."],
          square => square === 6,
        ).tiles,
      ).toEqual([]);
    });

    test("a square outside every pill is in no tile", () => {
      const tiling = tilingOf([galaxy(1, 1, 1)], ["....", ".#..", "..o.", "...."]);
      expect(tiling.colorAt(2, 2)).toBe(LIGHT);
      expect(tiling.drawnAt(2, 2)).toBeFalse();
    });
  });

  describe("two galaxies", () => {
    /**
     * BOTH are dropped, not the later one: dropping one would make the
     * picture depend on the order the clues happen to be stored in.
     */
    test("overlapping footprints drop both pills", () => {
      const rows = [".....", "####", "....", "...."];
      expect(tilingOf([galaxy(1, 1, 1), galaxy(2, 1, 1)], rows).tiles).toEqual(
        [],
      );
    });

    /** A centered galaxy occupies its square, so a pill may not run through it. */
    test("a centered galaxy blocks a pill over its square", () => {
      const rows = ["....", ".##.", "....", "...."];
      expect(tilingOf([galaxy(2, 1), galaxy(1, 1, 1)], rows).tiles).toEqual([]);
    });

    test("pills that only touch are two pills", () => {
      const rows = ["....", "####", "....", "...."];
      const tiling = tilingOf([galaxy(0, 1, 1), galaxy(2, 1, 1)], rows);
      expect(tiling.tiles).toEqual([
        [4, 5],
        [6, 7],
      ]);
      // ...and nothing bridges them: (1,1) and (2,1) are in different tiles.
      expect(sameGalaxyTile(tiling.tiles, size, 1, 1, 2, 1)).toBeFalse();
      expect(sameGalaxyTile(tiling.tiles, size, 0, 1, 1, 1)).toBeTrue();
    });

    test("the board's edge is not a neighbor", () => {
      const tiling = tilingOf([galaxy(0, 1, 1)], ["....", "##..", "....", "...."]);
      expect(sameGalaxyTile(tiling.tiles, size, 0, 1, -1, 1)).toBeFalse();
      expect(sameGalaxyTile(tiling.tiles, size, 0, 1, 0, 2)).toBeFalse();
    });
  });
});
