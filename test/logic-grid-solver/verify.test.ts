import { describe, expect, test } from "bun:test";
import {
  DARK,
  LIGHT,
  UNKNOWN,
  UNPLAYABLE,
} from "../../src/pages/logic-grid-solver/cell";
import {
  toFlat,
  toGrid,
  verifyLogicGrid,
} from "../../src/pages/logic-grid-solver/verify";
import { board, painted, withDart, withLotus, withShape } from "./boards";

/**
 * The page's own rule checker — the last thing between a bad answer from the
 * solver and the board a player is shown. It mirrors `a-star/Verify.cpp`, and
 * these cases mirror `a-star/test/verify_test.cpp`, so a rule that drifts on
 * one side fails on the other.
 */

const judge = (picture: string[], answer: string[], ruleIds: string[] = []) =>
  verifyLogicGrid(board(picture, ruleIds), painted(answer));

describe("verifyLogicGrid", () => {
  test("accepts any colouring when nothing is asked", () => {
    expect(judge(["..", ".."], ["DD", "DD"])).toBe("none");
  });

  test("refuses an uncoloured cell", () => {
    expect(judge(["..", ".."], ["D.", "DD"])).toBe("incomplete");
  });

  test("refuses a coloured gap", () => {
    expect(judge([".#", ".."], ["DD", "DD"])).toBe("shape");
  });

  test("refuses an answer that repaints a given cell", () => {
    expect(judge(["D.", ".."], ["LL", "LL"])).toBe("given");
  });

  test("keeps an answer that agrees with the givens", () => {
    expect(judge(["D.", ".."], ["DD", "DD"])).toBe("none");
  });

  describe("shape rules", () => {
    test("catches a forbidden square, per colour", () => {
      expect(judge(["..", ".."], ["DD", "DD"], ["no-dark-2x2"])).toBe("square");
      expect(judge(["..", ".."], ["LL", "LL"], ["no-dark-2x2"])).toBe("none");
      expect(judge(["..", ".."], ["LL", "LL"], ["no-light-2x2"])).toBe(
        "square",
      );
    });

    test("catches a forbidden run in either direction", () => {
      expect(judge(["...", "..."], ["DDD", "LLL"], ["no-dark-1x3"])).toBe(
        "run",
      );
      expect(
        judge(["..", "..", ".."], ["DL", "DL", "DL"], ["no-dark-1x3"]),
      ).toBe("run");
      expect(judge(["...", "..."], ["DDL", "LLD"], ["no-dark-1x3"])).toBe(
        "none",
      );
    });

    /**
     * Four in a row is fine under a 1x5 rule and five is not — the off-by-one
     * this would get wrong if it read "1x5" as a cap of five rather than four.
     */
    test("a five-run needs five cells", () => {
      expect(judge(["....."], ["DDDDD"], ["no-dark-1x5"])).toBe("run");
      expect(judge(["....."], ["DDDDL"], ["no-dark-1x5"])).toBe("none");
      expect(judge(["....."], ["LLLLL"], ["no-dark-1x5"])).toBe("none");
      expect(judge(["....."], ["LLLLL"], ["no-light-1x5"])).toBe("run");
    });

    /**
     * "Exactly one" is two failures, not one, and the empty half is the easy
     * one to leave out — nothing points at a region that has no symbol in it.
     */
    test("counts the symbols in every area of that colour", () => {
      expect(judge(["a.", ".."], ["DL", "LL"], ["one-symbol-dark"])).toBe(
        "none",
      );
      expect(judge(["a.", ".."], ["LD", "DD"], ["one-symbol-dark"])).toBe(
        "area-without-symbol",
      );
      // Both area clues say 4 and the region really is 4 cells, so the size is
      // fine; what is wrong is that one region carries two symbols.
      expect(judge(["44", ".."], ["DD", "DD"], ["one-symbol-dark"])).toBe(
        "area-with-many-symbols",
      );
    });

    test("the two colours are separate switches", () => {
      // The same answer: legal for dark, and the light region has no symbol.
      expect(judge(["a.", ".."], ["DL", "LL"], ["one-symbol-light"])).toBe(
        "area-without-symbol",
      );
      expect(judge(["a.", ".."], ["DL", "LL"], [])).toBe("none");
    });

    test("a gap breaks a run", () => {
      expect(judge([".#.", "..."], ["D#D", "LLL"], ["no-dark-1x2"])).toBe(
        "none",
      );
    });

    test("catches a checkerboard", () => {
      expect(judge(["..", ".."], ["DL", "LD"], ["no-checkerboard"])).toBe(
        "checkerboard",
      );
      expect(judge(["..", ".."], ["DD", "LL"], ["no-checkerboard"])).toBe(
        "none",
      );
    });

    test("catches a forbidden triple in either direction", () => {
      expect(
        judge(["...", "..."], ["DLD", "LLL"], ["no-dark-light-dark"]),
      ).toBe("triple");
      // Down the first column: D over L over D.
      expect(
        judge(["..", "..", ".."], ["DL", "LL", "DL"], ["no-dark-light-dark"]),
      ).toBe("triple");
      expect(
        judge(["...", "..."], ["DDL", "LLD"], ["no-dark-light-dark"]),
      ).toBe("none");
    });

    test("a triple names the colour at its ends", () => {
      // The same line, judged under each rule: L-D-L is the OTHER rule's shape.
      expect(
        judge(["...", "..."], ["LDL", "DDD"], ["no-dark-light-dark"]),
      ).toBe("none");
      expect(
        judge(["...", "..."], ["LDL", "DDD"], ["no-light-dark-light"]),
      ).toBe("triple");
    });

    /** Two darks a gap apart are not a triple: the middle must really be light. */
    test("a gap never completes a triple", () => {
      expect(
        judge([".#.", "..."], ["D#D", "LLL"], ["no-dark-light-dark"]),
      ).toBe("none");
    });

    test("catches a T in every rotation", () => {
      expect(judge(["...", "..."], ["DDD", "LDL"], ["no-dark-t"])).toBe("tee");
      expect(judge(["...", "..."], ["LDL", "DDD"], ["no-dark-t"])).toBe("tee");
      expect(judge(["..", "..", ".."], ["DL", "DD", "DL"], ["no-dark-t"])).toBe(
        "tee",
      );
      expect(judge(["..", "..", ".."], ["LD", "DD", "LD"], ["no-dark-t"])).toBe(
        "tee",
      );
    });

    test("a bare line is not a T, and a plus contains one", () => {
      expect(judge(["...", "..."], ["DDD", "LLL"], ["no-dark-t"])).toBe("none");
      expect(
        judge(["...", "...", "..."], ["LDL", "DDD", "LDL"], ["no-dark-t"]),
      ).toBe("tee");
    });

    test("the two T rules are separate switches", () => {
      expect(judge(["...", "..."], ["DDD", "LDL"], ["no-light-t"])).toBe(
        "none",
      );
      expect(judge(["...", "..."], ["LLL", "DLD"], ["no-light-t"])).toBe("tee");
    });
  });

  describe("connectivity", () => {
    test("catches a colour in two pieces", () => {
      expect(judge(["...", "..."], ["DLD", "LLL"], ["connect-dark"])).toBe(
        "disconnected",
      );
      expect(judge(["...", "..."], ["DDD", "LLL"], ["connect-dark"])).toBe(
        "none",
      );
    });

    test("an empty colour is vacuously connected", () => {
      expect(judge(["..", ".."], ["DD", "DD"], ["connect-light"])).toBe("none");
    });

    test("a checkerboard breaks connectivity on its own", () => {
      // Which is why the implied rule is left out of this file entirely: the
      // connectivity test already catches what it would have caught.
      expect(
        judge(["..", ".."], ["DL", "LD"], ["connect-dark", "connect-light"]),
      ).toBe("disconnected");
    });
  });

  describe("region areas", () => {
    /**
     * The two halves of "exactly two" fail differently and are caught by
     * different machinery — too big compiles into forbidden trominoes, too
     * small is a propagator — so both are pinned here, where neither exists.
     */
    test("catches a region that is too big, straight or bent", () => {
      expect(judge(["...", "..."], ["DDL", "LLL"], ["area-two-dark"])).toBe(
        "none",
      );
      expect(judge(["...", "..."], ["DDD", "LLL"], ["area-two-dark"])).toBe(
        "region-size",
      );
      // The bent one, which no run rule would have caught.
      expect(judge(["...", "..."], ["DDL", "DLL"], ["area-two-dark"])).toBe(
        "region-size",
      );
    });

    test("catches a region that is too small", () => {
      expect(judge(["...", "..."], ["DLD", "LLL"], ["area-two-dark"])).toBe(
        "region-size",
      );
    });

    test("an empty colour has no regions and is legal", () => {
      // The vacuous case, like "an empty colour is vacuously connected": all
      // zero of its regions are the right size.
      expect(judge(["..", ".."], ["DD", "DD"], ["area-two-light"])).toBe("none");
    });

    test("the two colours are separate switches", () => {
      // Dark is two dominoes and light is one region of four.
      expect(judge(["..", "..", ".."], ["DD", "LL", "DD"], [])).toBe("none");
      expect(
        judge(["..", "..", ".."], ["DD", "LL", "DD"], ["area-two-dark"]),
      ).toBe("none");
      expect(
        judge(["..", "..", ".."], ["DD", "LL", "DD"], ["area-two-light"]),
      ).toBe("none");
      expect(judge(["...", "..."], ["DDL", "LLL"], ["area-two-light"])).toBe(
        "region-size",
      );
    });

    test("a gap separates two regions rather than joining them", () => {
      expect(
        judge(["..#..", "....."], ["DD#DD", "LLLLL"], ["area-two-dark"]),
      ).toBe("none");
    });

    /**
     * The area-FOUR pair, which say the same thing at a different size — and
     * whose "too big" half is a propagator rather than forbidden shapes, so
     * this oracle is the only place both halves are stated outright.
     */
    test("catches an area-four region that is too big or too small", () => {
      expect(judge(["....", "...."], ["DDDD", "LLLL"], ["area-four-dark"])).toBe(
        "none",
      );
      // The square one, which no run rule reaches.
      expect(judge(["....", "...."], ["DDLL", "DDLL"], ["area-four-dark"])).toBe(
        "none",
      );
      expect(judge(["....", "...."], ["DDDD", "DLLL"], ["area-four-dark"])).toBe(
        "region-size",
      );
      expect(judge(["....", "...."], ["DDDL", "LLLL"], ["area-four-dark"])).toBe(
        "region-size",
      );
    });

    /**
     * The area-FIVE pair, appended after four and checked the same way. Six
     * wide on purpose: five is the first size whose implied forbidden run —
     * SIX cells — did not fit in the pattern table as it stood.
     */
    test("catches an area-five region that is too big or too small", () => {
      expect(
        judge(["......", "......"], ["DDDDDL", "LLLLLL"], ["area-five-dark"]),
      ).toBe("none");
      // The straight six an area of five implies.
      expect(
        judge(["......", "......"], ["DDDDDD", "LLLLLL"], ["area-five-dark"]),
      ).toBe("region-size");
      expect(
        judge(["......", "......"], ["DDDDLL", "LLLLLL"], ["area-five-dark"]),
      ).toBe("region-size");
      // The same colouring judged from the other colour's side: light is one
      // region of seven.
      expect(
        judge(["......", "......"], ["DDDDDL", "LLLLLL"], ["area-five-light"]),
      ).toBe("region-size");
    });

    /**
     * Not a contradiction, which is the surprising part: every one of a colour's
     * zero regions is both sizes at once, so the pair is satisfied exactly when
     * the colour is absent.
     */
    test("both sizes on one colour leave only the empty colouring", () => {
      const both = ["area-two-dark", "area-four-dark"];
      expect(judge(["....", "...."], ["LLLL", "LLLL"], both)).toBe("none");
      expect(judge(["....", "...."], ["DDLL", "DDLL"], both)).toBe(
        "region-size",
      );
      expect(judge(["....", "...."], ["DDLL", "LLLL"], both)).toBe(
        "region-size",
      );
    });
  });

  describe("clues", () => {
    test("checks an area number against its region", () => {
      expect(judge(["2..", "...", "..."], ["DDL", "LLL", "LLL"])).toBe("none");
      expect(judge(["2..", "...", "..."], ["DDD", "LLL", "LLL"])).toBe("area");
    });

    test("an area number takes the colour of its cell", () => {
      expect(judge(["2..", "..."], ["LLD", "DDD"])).toBe("none");
    });

    test("two area numbers may share a region when they agree", () => {
      expect(judge(["3.3", "..."], ["DDD", "LLL"])).toBe("none");
      expect(judge(["3.2", "..."], ["DDD", "LLL"])).toBe("area");
    });

    test("one letter has to be one region", () => {
      expect(judge(["a.a", "..."], ["DDD", "LLL"])).toBe("none");
      expect(judge(["a.a", "..."], ["DLD", "LLL"])).toBe("letter-split");
    });

    test("two letters may not share a region", () => {
      expect(judge(["a.b", "..."], ["DDD", "LLL"])).toBe("letter-shared");
    });

    test("different letters may share a colour in different regions", () => {
      expect(judge(["a.b", "..."], ["DLD", "LLL"])).toBe("none");
    });
  });

  describe("darts", () => {
    /** A dart on `(0, 0)` aimed along the top row, and a colouring to judge. */
    const judgeDart = (
      picture: string[],
      answer: string[],
      value: number,
      direction = 1,
    ) => {
      const config = board(picture);
      withDart(config, 0, 0, value, direction);
      return verifyLogicGrid(config, painted(answer));
    };

    test("counts the squares of the OTHER colour along its line", () => {
      expect(judgeDart(["....."], ["DLLDD"], 2)).toBe("none");
      expect(judgeDart(["....."], ["DLLDD"], 3)).toBe("dart");
    });

    test("a dart takes the colour of its own cell, so it counts the other", () => {
      // The two colourings differ ONLY in the dart's own square, and the same
      // line of `LLLD` reads as three lights from a dark dart and one dark
      // from a light one.
      expect(judgeDart(["....."], ["DLLLD"], 3)).toBe("none");
      expect(judgeDart(["....."], ["LLLLD"], 3)).toBe("dart");
      expect(judgeDart(["....."], ["LLLLD"], 1)).toBe("none");
    });

    test("zero means the whole line is the dart's own colour", () => {
      expect(judgeDart(["....."], ["DDDDD"], 0)).toBe("none");
      expect(judgeDart(["....."], ["DDDDL"], 0)).toBe("dart");
    });

    /** A gap is stepped over: neither counted, nor a wall the dart stops at. */
    test("looks straight through a gap", () => {
      expect(judgeDart(["..#.."], ["DL#LD"], 2)).toBe("none");
      expect(judgeDart(["..#.."], ["DL#LD"], 1)).toBe("dart");
    });

    test("counts to the edge and no further", () => {
      expect(judgeDart([".....", "LLLLL"], ["DDDDD", "LLLLL"], 0)).toBe("none");
    });

    test("aims where it says it does", () => {
      // Down the first column rather than along the first row.
      expect(judgeDart([".....", "....."], ["DLLLL", "LLLLL"], 1, 2)).toBe(
        "none",
      );
      expect(judgeDart([".....", "....."], ["DLLLL", "DLLLL"], 1, 2)).toBe(
        "dart",
      );
    });

    /**
     * A merged cell lying along the line contributes every square of itself
     * that the line crosses. Three, here — a count a dart reading CELLS could
     * never reach on a line only four squares long with one of them apart.
     */
    test("counts a merged cell once per square the line crosses", () => {
      const config = board(["....."]);
      withDart(config, 0, 0, 3, 1);
      withShape(config, [
        [1, 0],
        [2, 0],
        [3, 0],
      ]);
      expect(verifyLogicGrid(config, painted(["DLLLD"]))).toBe("none");
      expect(verifyLogicGrid(config, painted(["DDDDL"]))).toBe("dart");
    });
  });

  describe("symmetry", () => {
    /** A lotus on the centre of a 3x3, and a colouring to judge. Mirrors the
     * lotus block in `a-star/test/verify_test.cpp`. */
    const judgeLotus = (answer: string[], axis: number) => {
      const config = board(["...", "...", "..."]);
      withLotus(config, 1, 1, axis);
      return verifyLogicGrid(config, painted(answer));
    };

    test("the region must mirror across the axis", () => {
      expect(judgeLotus(["LDL", "DDD", "LDL"], 0)).toBe("none");
      // One extra dark corner joins the region and reflects onto a light cell.
      expect(judgeLotus(["LDL", "DDD", "LDD"], 0)).toBe("symmetry");
    });

    test("a diagonal axis transposes the region", () => {
      expect(judgeLotus(["LDL", "DDL", "LLD"], 1)).toBe("none");
      expect(judgeLotus(["LDL", "DDD", "LLL"], 1)).toBe("symmetry");
    });

    test("only the region holding the symbol is mirrored", () => {
      // The far dark pair reflects clean off the board and is nobody's
      // business: it is not the symbol's region.
      const config = board(["....."]);
      withLotus(config, 1, 0, 2);
      expect(verifyLogicGrid(config, painted(["LDLDD"]))).toBe("none");
    });

    test("the region may not reflect off the board or onto a gap", () => {
      const edge = board(["..."]);
      withLotus(edge, 0, 0, 2);
      expect(verifyLogicGrid(edge, painted(["DDL"]))).toBe("symmetry");
      expect(verifyLogicGrid(edge, painted(["DLL"]))).toBe("none");

      const gapped = board(["..#"]);
      withLotus(gapped, 1, 0, 2);
      expect(verifyLogicGrid(gapped, painted(["DD#"]))).toBe("symmetry");
    });

    /** A seat on the seam of a 1x2 cell: rows swap in pairs across the grid
     * line, and the third row reflects above the board. */
    test("a seam seat mirrors across the grid line", () => {
      const config = board(["..", "..", ".."]);
      withShape(config, [
        [0, 0],
        [0, 1],
      ]);
      withLotus(config, 0, 0, 0, 2);
      expect(verifyLogicGrid(config, painted(["DD", "DD", "LL"]))).toBe(
        "none",
      );
      expect(verifyLogicGrid(config, painted(["DD", "DD", "DL"]))).toBe(
        "symmetry",
      );
    });

    test("two lotuses each hold the region to their own axis", () => {
      const config = board(["...", "...", "..."]);
      withLotus(config, 1, 1, 0);
      withLotus(config, 1, 0, 2);
      expect(verifyLogicGrid(config, painted(["LDL", "DDD", "LDL"]))).toBe(
        "none",
      );
      // Still symmetric for the horizontal one; the vertical one is broken.
      expect(verifyLogicGrid(config, painted(["LDL", "DDL", "LDL"]))).toBe(
        "symmetry",
      );
    });
  });

  describe("merged cells", () => {
    const judgeMerged = (
      picture: string[],
      squares: [number, number][],
      answer: string[],
      ruleIds: string[] = [],
    ) =>
      verifyLogicGrid(
        withShape(board(picture, ruleIds), squares),
        painted(answer),
      );

    test("refuses a merged cell in two colours", () => {
      expect(
        judgeMerged(
          ["..", ".."],
          [
            [0, 0],
            [1, 0],
          ],
          ["DL", "LL"],
        ),
      ).toBe("cell-split");
      expect(
        judgeMerged(
          ["..", ".."],
          [
            [0, 0],
            [1, 0],
          ],
          ["DD", "LL"],
        ),
      ).toBe("none");
    });

    /**
     * The arrangement rules count SQUARES, not cells: a merged dark 1x2 IS a
     * dark 1x2, because they scan the square grid and fusing two squares does
     * not hide the run they make.
     */
    test("arrangement rules count squares rather than cells", () => {
      expect(
        judgeMerged(
          ["..", ".."],
          [
            [0, 0],
            [1, 0],
          ],
          ["DD", "LL"],
          ["no-dark-1x2"],
        ),
      ).toBe("run");
      expect(
        judgeMerged(
          ["..", ".."],
          [
            [0, 0],
            [1, 0],
          ],
          ["DD", "DD"],
          ["no-dark-2x2"],
        ),
      ).toBe("square");
    });

    test("an area rule counts a merged cell as its squares", () => {
      const domino: [number, number][] = [
        [0, 0],
        [1, 0],
      ];
      // A merged domino is a legal region of two on its own...
      expect(
        judgeMerged(["..", ".."], domino, ["DD", "LL"], ["area-two-dark"]),
      ).toBe("none");
      // ...while a merged 1x3 is a region of three, which that rule forbids.
      expect(
        judgeMerged(
          ["...", "..."],
          [
            [0, 0],
            [1, 0],
            [2, 0],
          ],
          ["DDD", "LLL"],
          ["area-two-dark"],
        ),
      ).toBe("region-size");
    });

    test("an area clue counts every square of the cells in its region", () => {
      const bar: [number, number][] = [
        [0, 0],
        [1, 0],
        [2, 0],
      ];
      expect(judgeMerged(["3..", "..."], bar, ["DDD", "LLL"])).toBe("none");
      expect(judgeMerged(["2..", "..."], bar, ["DDD", "LLL"])).toBe("area");
    });

    test("a merged cell is adjacent to whatever any of its squares touches", () => {
      // The bent cell's foot at (0,1) welds the dark cells into one region, so
      // "connect all dark" holds: fusing changes the VARIABLES, not the
      // geometry the rules read.
      expect(
        judgeMerged(
          ["..", ".."],
          [
            [0, 0],
            [0, 1],
          ],
          ["DL", "DD"],
          ["connect-dark"],
        ),
      ).toBe("none");
    });
  });

  describe("layout helpers", () => {
    test("toFlat reads the editor's column-major grid row by row", () => {
      const config = board(["DL", "#."]);
      expect(toFlat(config)).toEqual([DARK, LIGHT, UNPLAYABLE, UNKNOWN]);
    });

    test("toGrid is its inverse", () => {
      const config = board(["DL", "#."]);
      expect(toGrid(config, toFlat(config))).toEqual(config.cells);
    });
  });
});
