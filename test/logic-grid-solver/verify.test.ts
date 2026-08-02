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
import { board, painted } from "./boards";

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
