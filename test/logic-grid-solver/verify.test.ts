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
import {
  board,
  painted,
  withArea,
  withAreaRule,
  withDart,
  withGalaxy,
  withLotus,
  withRunRule,
  withShape,
  withPattern,
  withViewpoint,
} from "./boards";

/**
 * The page's own rule checker — the last thing between a bad answer from the
 * solver and the board a player is shown. It mirrors `a-star/Verify.cpp`, and
 * these cases mirror `a-star/test/verify_test.cpp`, so a rule that drifts on
 * one side fails on the other.
 */

/**
 * What a shape retired into `patterns` is NAMED by now.
 *
 * The five controls that left the catalog in format version 3 — diagonal,
 * L, crossed T, knight's move, mixed elbow — arrive as drawings, and the
 * oracle checks a drawing as a drawing: one violation for all of them, since
 * what a board broke is a shape the config carries and no member of the union
 * could spell. The cases below still SAY the rule they were written for, so
 * what they assert is unchanged — only its report has one name. `kDrawn` in
 * `verify_test.cpp` is the same constant on the other side.
 */
const DRAWN = "custom-pattern";

const judge = (picture: string[], answer: string[], ruleIds: string[] = []) =>
  verifyLogicGrid(board(picture, ruleIds), painted(answer));

describe("verifyLogicGrid", () => {
  test("accepts any coloring when nothing is asked", () => {
    expect(judge(["..", ".."], ["DD", "DD"])).toBe("none");
  });

  test("refuses an uncolored cell", () => {
    expect(judge(["..", ".."], ["D.", "DD"])).toBe("incomplete");
  });

  test("refuses a colored gap", () => {
    expect(judge([".#", ".."], ["DD", "DD"])).toBe("shape");
  });

  test("refuses an answer that repaints a given cell", () => {
    expect(judge(["D.", ".."], ["LL", "LL"])).toBe("given");
  });

  test("keeps an answer that agrees with the givens", () => {
    expect(judge(["D.", ".."], ["DD", "DD"])).toBe("none");
  });

  describe("shape rules", () => {
    test("catches a forbidden square, per color", () => {
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
    test("counts the symbols in every area of that color", () => {
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

    test("the two colors are separate switches", () => {
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

    test("a triple names the color at its ends", () => {
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

    test("catches a 3+1 square with the odd cell on any corner", () => {
      const rule = ["no-three-dark-one-light"];
      expect(judge(["..", ".."], ["DD", "DL"], rule)).toBe("three-one");
      expect(judge(["..", ".."], ["DD", "LD"], rule)).toBe("three-one");
      expect(judge(["..", ".."], ["DL", "DD"], rule)).toBe("three-one");
      expect(judge(["..", ".."], ["LD", "DD"], rule)).toBe("three-one");
      // All four of one color is a different arrangement, and an even split.
      expect(judge(["..", ".."], ["DD", "DD"], rule)).toBe("none");
      expect(judge(["..", ".."], ["DD", "LL"], rule)).toBe("none");
    });

    test("the two 3+1 rules are separate switches", () => {
      expect(
        judge(["..", ".."], ["LL", "LD"], ["no-three-dark-one-light"]),
      ).toBe("none");
      expect(
        judge(["..", ".."], ["LL", "LD"], ["no-three-light-one-dark"]),
      ).toBe("three-one");
    });

    /** Three of a color around a gap is legal: the rule wants a FULL 2x2
     * split three and one, and a gap is neither color. */
    test("a gap never completes a 3+1 square", () => {
      expect(
        judge(["..", ".#"], ["DD", "D#"], ["no-three-dark-one-light"]),
      ).toBe("none");
    });

    test("catches a corner touch on either diagonal", () => {
      expect(judge(["..", ".."], ["DL", "LD"], ["no-dark-diagonal"])).toBe(DRAWN);
      expect(judge(["..", ".."], ["LD", "DL"], ["no-dark-diagonal"])).toBe(DRAWN);
      expect(judge(["...", "..."], ["DDD", "LLL"], ["no-dark-diagonal"])).toBe(
        "none",
      );
    });

    /**
     * The literal reading: being joined through an orthogonal neighbor does
     * not excuse the touch, so an L-bend and a filled 2x2 both break the rule
     * and every legal region of the color is a straight bar.
     */
    test("a connected bend still breaks the diagonal rule", () => {
      expect(judge(["..", ".."], ["DD", "DL"], ["no-dark-diagonal"])).toBe(DRAWN);
      expect(judge(["..", ".."], ["DD", "DD"], ["no-dark-diagonal"])).toBe(DRAWN);
    });

    test("the two diagonal rules are separate switches", () => {
      expect(judge(["..", ".."], ["DD", "LD"], ["no-light-diagonal"])).toBe(
        "none",
      );
      expect(judge(["..", ".."], ["DD", "LD"], ["no-dark-diagonal"])).toBe(DRAWN);
    });

    /** The touch is the squares' geometry, not the board's: two cells meeting
     * only across a gap's corner still meet. */
    test("a touch across a gap's corner still counts", () => {
      expect(judge([".#", "#."], ["D#", "#D"], ["no-dark-diagonal"])).toBe(DRAWN);
    });
  });

  /**
   * "Same shape" is CONGRUENCE — the eight dihedral images, rotations and
   * reflections both — so these cases are mostly about which pairs of
   * tetrominoes count as one shape. Mirrors the block in
   * `a-star/test/verify_test.cpp`.
   */
  describe("region shapes", () => {
    test("two identical regions repeat a shape", () => {
      expect(
        judge(["....", "...."], ["DLDL", "DLDL"], ["distinct-shapes-dark"]),
      ).toBe("region-shape-repeat");
    });

    test("regions of different shapes are fine", () => {
      // A vertical domino and a lone square.
      expect(
        judge(["....", "...."], ["DLDL", "DLLL"], ["distinct-shapes-dark"]),
      ).toBe("none");
    });

    test("a rotation is the same shape", () => {
      // A horizontal domino above, a vertical one to the right.
      expect(
        judge(["....", "....", "...."], ["DDLL", "LLLD", "LLLD"], [
          "distinct-shapes-dark",
        ]),
      ).toBe("region-shape-repeat");
    });

    /** The decided semantics, and the one a rotations-only key would miss. */
    test("a reflection is the same shape too", () => {
      // An S-tromino bend and its mirror image.
      expect(
        judge(
          ["......", "......", "......"],
          ["DDLLLL", "LDLLDD", "LLLLDL"],
          ["distinct-shapes-dark"],
        ),
      ).toBe("region-shape-repeat");
    });

    test("zero regions and one region are both vacuous", () => {
      expect(judge(["..", ".."], ["LL", "LL"], ["distinct-shapes-dark"])).toBe(
        "none",
      );
      expect(judge(["..", ".."], ["LL", "LL"], ["same-shape-dark"])).toBe(
        "none",
      );
      expect(judge(["..", ".."], ["DD", "DD"], ["distinct-shapes-dark"])).toBe(
        "none",
      );
      expect(judge(["..", ".."], ["DD", "DD"], ["same-shape-dark"])).toBe(
        "none",
      );
    });

    test("the rule only looks at its own color", () => {
      // Two congruent LIGHT dominoes, while the dark regions — a domino and an
      // L-tromino — are different shapes. Each rule sees only its own.
      const picture = [".....", "....."];
      const answer = ["LDLDD", "LDLDL"];
      expect(judge(picture, answer, ["distinct-shapes-dark"])).toBe("none");
      expect(judge(picture, answer, ["distinct-shapes-light"])).toBe(
        "region-shape-repeat",
      );
    });

    test("all regions alike wants every shape equal", () => {
      expect(
        judge(["....", "...."], ["DLDL", "DLLL"], ["same-shape-dark"]),
      ).toBe("region-shape-mismatch");
      expect(
        judge(["....", "...."], ["DLDL", "DLDL"], ["same-shape-dark"]),
      ).toBe("none");
    });

    /** Both rules of one color say "at most one region", which is a thing a
     * board may legally be — so they are two independent flags. */
    test("both rules together allow exactly one region", () => {
      const rules = ["distinct-shapes-dark", "same-shape-dark"];
      expect(judge(["....", "...."], ["DLLL", "DLLL"], rules)).toBe("none");
      expect(judge(["....", "...."], ["DLDL", "DLDL"], rules)).toBe(
        "region-shape-repeat",
      );
    });

    /**
     * A shape is its SQUARES. Two regions with the same footprint are the same
     * shape however the merges beneath them differ — the case a key counting
     * merged cells would call different while every other test here passed.
     */
    test("a merged cell does not change a region's shape", () => {
      const config = board(["....", "...."], ["distinct-shapes-dark"]);
      // The left domino is one merged cell; the right one is two plain
      // squares. Same footprint, so the same shape.
      withShape(config, [
        [0, 0],
        [0, 1],
      ]);
      expect(verifyLogicGrid(config, painted(["DLDL", "DLDL"]))).toBe(
        "region-shape-repeat",
      );
    });

    /** Region-size is asked first, so a board breaking both is named for it —
     * the order `Verify.cpp`'s `check` has to keep. */
    test("a region-size break is reported ahead of a shape break", () => {
      const config = board(["....", "...."], ["same-shape-dark"]);
      withAreaRule(config, "dark", 3);
      expect(verifyLogicGrid(config, painted(["DLDL", "DLLL"]))).toBe(
        "region-size",
      );
    });
  });

  describe("connectivity", () => {
    test("catches a color in two pieces", () => {
      expect(judge(["...", "..."], ["DLD", "LLL"], ["connect-dark"])).toBe(
        "disconnected",
      );
      expect(judge(["...", "..."], ["DDD", "LLL"], ["connect-dark"])).toBe(
        "none",
      );
    });

    test("an empty color is vacuously connected", () => {
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

  describe("sized instances beyond the old catalog", () => {
    /**
     * Since format version 2 the number is data, so sizes no chip ever named
     * go through the very same walk as the familiar ones — these cases are
     * what say so.
     */
    test("a run of eight is caught at eight cells and not at seven", () => {
      const nine = board(["........."]);
      withRunRule(nine, "dark", 8);
      expect(verifyLogicGrid(nine, painted(["DDDDDDDDL"]))).toBe("run");
      expect(verifyLogicGrid(nine, painted(["DDDDDDDLL"]))).toBe("none");
    });

    test("a run of six verifies the same way", () => {
      const six = board(["......"]);
      withRunRule(six, "light", 6);
      expect(verifyLogicGrid(six, painted(["LLLLLL"]))).toBe("run");
      expect(verifyLogicGrid(six, painted(["LLLLLD"]))).toBe("none");
    });

    test("an area of one keeps singletons and refuses a domino", () => {
      const strip = board(["..."]);
      withAreaRule(strip, "dark", 1);
      expect(verifyLogicGrid(strip, painted(["DLD"]))).toBe("none");
      expect(verifyLogicGrid(strip, painted(["DDL"]))).toBe("region-size");
    });

    test("an area of eight binds exactly", () => {
      const wide = board(["........", "........"]);
      withAreaRule(wide, "dark", 8);
      expect(
        verifyLogicGrid(wide, painted(["DDDDDDDD", "LLLLLLLL"])),
      ).toBe("none");
      expect(
        verifyLogicGrid(wide, painted(["DDDDDDDL", "LLLLLLLL"])),
      ).toBe("region-size");
    });

    test("two sizes on one color both bind", () => {
      const strip = board(["...."]);
      withAreaRule(strip, "dark", 2);
      withAreaRule(strip, "dark", 3);
      // A dark domino satisfies size 2 and breaks size 3.
      expect(verifyLogicGrid(strip, painted(["DDLL"]))).toBe("region-size");
      // No dark at all satisfies both: every one of its zero regions is both
      // sizes at once.
      expect(verifyLogicGrid(strip, painted(["LLLL"]))).toBe("none");
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

    test("an empty color has no regions and is legal", () => {
      // The vacuous case, like "an empty color is vacuously connected": all
      // zero of its regions are the right size.
      expect(judge(["..", ".."], ["DD", "DD"], ["area-two-light"])).toBe("none");
    });

    test("the two colors are separate switches", () => {
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
      // The same coloring judged from the other color's side: light is one
      // region of seven.
      expect(
        judge(["......", "......"], ["DDDDDL", "LLLLLL"], ["area-five-light"]),
      ).toBe("region-size");
    });

    /**
     * The area-THREE pair. `regionAreaProblem` was already generic in the
     * number, so what is pinned is that a legacy id translates into the
     * instance the oracle walks.
     */
    test("catches an area-three region that is too big or too small", () => {
      expect(judge(["...", "..."], ["DDD", "LLL"], ["area-three-dark"])).toBe(
        "none",
      );
      // The bent one, which no run rule reaches.
      expect(judge(["...", "..."], ["DDL", "DLL"], ["area-three-dark"])).toBe(
        "none",
      );
      expect(judge(["...", "..."], ["DDL", "LLL"], ["area-three-dark"])).toBe(
        "region-size",
      );
      expect(judge(["....", "...."], ["DDDD", "LLLL"], ["area-three-dark"])).toBe(
        "region-size",
      );
      // The same first coloring judged from the other side: light is a three.
      expect(judge(["...", "..."], ["DDD", "LLL"], ["area-three-light"])).toBe(
        "none",
      );
    });

    /**
     * Not a contradiction, which is the surprising part: every one of a color's
     * zero regions is both sizes at once, so the pair is satisfied exactly when
     * the color is absent.
     */
    test("both sizes on one color leave only the empty coloring", () => {
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

    test("an area number takes the color of its cell", () => {
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

    test("different letters may share a color in different regions", () => {
      expect(judge(["a.b", "..."], ["DLD", "LLL"])).toBe("none");
    });
  });

  describe("darts", () => {
    /** A dart on `(0, 0)` aimed along the top row, and a coloring to judge. */
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

    test("counts the squares of the OTHER color along its line", () => {
      expect(judgeDart(["....."], ["DLLDD"], 2)).toBe("none");
      expect(judgeDart(["....."], ["DLLDD"], 3)).toBe("dart");
    });

    test("a dart takes the color of its own cell, so it counts the other", () => {
      // The two colorings differ ONLY in the dart's own square, and the same
      // line of `LLLD` reads as three lights from a dark dart and one dark
      // from a light one.
      expect(judgeDart(["....."], ["DLLLD"], 3)).toBe("none");
      expect(judgeDart(["....."], ["LLLLD"], 3)).toBe("dart");
      expect(judgeDart(["....."], ["LLLLD"], 1)).toBe("none");
    });

    test("zero means the whole line is the dart's own color", () => {
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
    /** A lotus on the center of a 3x3, and a coloring to judge. Mirrors the
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

  describe("viewpoints", () => {
    /** A viewpoint on `(0, 0)` holding `value`, and a coloring to judge.
     * Mirrors the viewpoint block in `a-star/test/verify_test.cpp`. */
    const judgeViewpoint = (
      picture: string[],
      answer: string[],
      value: number,
    ) => {
      const config = board(picture);
      withViewpoint(config, 0, 0, value);
      return verifyLogicGrid(config, painted(answer));
    };

    test("counts itself and its leading same-color runs", () => {
      expect(judgeViewpoint(["....."], ["DDLDD"], 2)).toBe("none");
      expect(judgeViewpoint(["....."], ["DDLDD"], 3)).toBe("viewpoint");
    });

    test("sees in all four directions at once", () => {
      const config = board(["...", "...", "..."]);
      withViewpoint(config, 1, 1, 5);
      expect(verifyLogicGrid(config, painted(["LDL", "DDD", "LDL"]))).toBe(
        "none",
      );
      const four = board(["...", "...", "..."]);
      withViewpoint(four, 1, 1, 4);
      expect(verifyLogicGrid(four, painted(["LDL", "DDD", "LDL"]))).toBe(
        "viewpoint",
      );
    });

    test("takes the color of its own cell, so it counts its own", () => {
      // The two colorings differ ONLY in the viewpoint's own square: the
      // same line reads as three from a light one and one from a dark one.
      expect(judgeViewpoint(["....."], ["LLLDD"], 3)).toBe("none");
      expect(judgeViewpoint(["....."], ["DLLDD"], 1)).toBe("none");
      expect(judgeViewpoint(["....."], ["DLLDD"], 3)).toBe("viewpoint");
    });

    /** Sight STOPS at a gap — where a dart's line steps over one — so the
     * pair past the hole is invisible however it is painted. */
    test("sight stops at a gap", () => {
      expect(judgeViewpoint(["..#.."], ["LL#LL"], 2)).toBe("none");
      expect(judgeViewpoint(["..#.."], ["LL#LL"], 4)).toBe("viewpoint");
    });

    /**
     * A merged cell along a ray contributes every square the sight crosses —
     * and the squares of the viewpoint's OWN cell count too, being its own
     * color by definition, which is where it differs from a dart's line.
     */
    test("counts a merged cell once per square the sight crosses", () => {
      const over = board(["....."]);
      withViewpoint(over, 0, 0, 4);
      withShape(over, [
        [1, 0],
        [2, 0],
        [3, 0],
      ]);
      expect(verifyLogicGrid(over, painted(["DDDDL"]))).toBe("none");

      const own = board(["....."]);
      withViewpoint(own, 0, 0, 2);
      withShape(own, [
        [0, 0],
        [1, 0],
      ]);
      expect(verifyLogicGrid(own, painted(["DDLLL"]))).toBe("none");
      const tooFew = board(["....."]);
      withViewpoint(tooFew, 0, 0, 1);
      withShape(tooFew, [
        [0, 0],
        [1, 0],
      ]);
      expect(verifyLogicGrid(tooFew, painted(["DDLLL"]))).toBe("viewpoint");
    });

    /**
     * Pure line geometry: an own-cell square OFF the rays does not count. The
     * L-cell's third square sits diagonally from the clue, on no ray through
     * it, so the count is two — the clue's square and the cell-mate on its
     * left ray.
     */
    test("an off-ray square of its own cell does not count", () => {
      const config = board(["..", ".."]);
      withShape(config, [
        [0, 0],
        [1, 0],
        [0, 1],
      ]);
      withViewpoint(config, 1, 0, 2);
      expect(verifyLogicGrid(config, painted(["DD", "DL"]))).toBe("none");
      const three = board(["..", ".."]);
      withShape(three, [
        [0, 0],
        [1, 0],
        [0, 1],
      ]);
      withViewpoint(three, 1, 0, 3);
      expect(verifyLogicGrid(three, painted(["DD", "DL"]))).toBe("viewpoint");
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

    test("refuses a merged cell in two colors", () => {
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

  describe("drawn patterns", () => {
    /** Judges a coloring against a shape drawn rather than named. */
    const drawn = (picture: string[], answer: string[], shape: string[]) =>
      verifyLogicGrid(withPattern(board(picture), shape), painted(answer));

    test("catches the shape as drawn", () => {
      expect(drawn(["..", ".."], ["DD", "DD"], ["DD", "DD"])).toBe(
        "custom-pattern",
      );
      expect(drawn(["..", ".."], ["DD", "DL"], ["DD", "DD"])).toBe("none");
    });

    /** Every rotation and reflection is forbidden too, always — which is what
     * makes a drawn shape one rule rather than eight. */
    test("catches every rotation of an asymmetric shape", () => {
      const ell = ["D.", "D.", "DD"];
      for (const answer of [
        ["DLL", "DLL", "DDL"],
        ["LLD", "LLD", "LDD"],
        ["DDD", "DLL", "LLL"],
        ["DLL", "DDD", "LLL"],
      ])
        expect(drawn(["...", "...", "..."], answer, ell)).toBe(
          "custom-pattern",
        );
    });

    test("names both colors where a shape does", () => {
      // The mixed elbow: dark ends around a light corner.
      expect(drawn(["..", ".."], ["DL", "LD"], ["LD", "D."])).toBe(
        "custom-pattern",
      );
      // A STRAIGHT dark-light-dark is a different shape and is not it.
      expect(drawn(["..."], ["DLD"], ["LD", "D."])).toBe("none");
    });

    /** Squares the pattern does not name are not read at all, so a gap under
     * one changes nothing — the knight's move's own reading. */
    test("fires across a square it does not name", () => {
      expect(
        drawn([".#.", "...", "..."], ["D#L", "LLL", "LDL"], ["D.", "..", ".D"]),
      ).toBe("custom-pattern");
    });

    /** A gap under a square it DOES name can never match: a pattern only ever
     * wants dark or light, and a gap is neither. */
    test("never matches a gap it names", () => {
      expect(drawn(["..", ".#"], ["DD", "D#"], ["DD", "DD"])).toBe("none");
    });

    test("a board that draws none is unconstrained", () => {
      expect(judge(["..", ".."], ["DD", "DD"])).toBe("none");
    });

    /** Named rules come first, so a board breaking one of those AND a drawing
     * is reported for the rule — the order `Verify.cpp` keeps too. */
    test("a named rule is reported ahead of a drawing", () => {
      const config = withPattern(board(["..", ".."], ["no-dark-2x2"]), [
        "DD",
        "DD",
      ]);
      expect(verifyLogicGrid(config, painted(["DD", "DD"]))).toBe("square");
    });
  });

  describe("elbows", () => {
    test("catches a forbidden elbow in all four orientations", () => {
      expect(judge(["..", ".."], ["DD", "DL"], ["no-dark-elbow"])).toBe(
        "elbow",
      );
      expect(judge(["..", ".."], ["DD", "LD"], ["no-dark-elbow"])).toBe(
        "elbow",
      );
      expect(judge(["..", ".."], ["DL", "DD"], ["no-dark-elbow"])).toBe(
        "elbow",
      );
      expect(judge(["..", ".."], ["LD", "DD"], ["no-dark-elbow"])).toBe(
        "elbow",
      );
    });

    test("a full square contains one; a domino and a corner touch do not", () => {
      expect(judge(["..", ".."], ["DD", "DD"], ["no-dark-elbow"])).toBe(
        "elbow",
      );
      expect(judge(["..", ".."], ["DD", "LL"], ["no-dark-elbow"])).toBe("none");
      expect(judge(["..", ".."], ["DL", "LD"], ["no-dark-elbow"])).toBe("none");
    });

    test("the two elbow rules are separate switches", () => {
      expect(judge(["..", ".."], ["DD", "DL"], ["no-light-elbow"])).toBe(
        "none",
      );
      expect(judge(["..", ".."], ["LL", "LD"], ["no-light-elbow"])).toBe(
        "elbow",
      );
    });

    test("a gap never stands in for an elbow cell", () => {
      expect(judge(["..", ".#"], ["DD", "L#"], ["no-dark-elbow"])).toBe("none");
      expect(judge(["..", ".#"], ["DD", "D#"], ["no-dark-elbow"])).toBe(
        "elbow",
      );
    });
  });

  describe("ells", () => {
    test("catches a forbidden L in either handedness", () => {
      expect(
        judge(["...", "...", "..."], ["DLL", "DLL", "DDL"], ["no-dark-l"]),
      ).toBe(DRAWN);
      expect(
        judge(["...", "...", "..."], ["LLD", "LLD", "LDD"], ["no-dark-l"]),
      ).toBe(DRAWN);
      expect(
        judge(["...", "...", "..."], ["DDD", "DLL", "LLL"], ["no-dark-l"]),
      ).toBe(DRAWN);
      expect(
        judge(["...", "...", "..."], ["DLL", "DDD", "LLL"], ["no-dark-l"]),
      ).toBe(DRAWN);
    });

    test("the two L rules are separate switches", () => {
      // A board whose LIGHT cells hold no L of their own — on a 3x3 the
      // complement of an L contains one.
      expect(judge(["....", "...."], ["DDDL", "LLDL"], ["no-dark-l"])).toBe(DRAWN);
      expect(judge(["....", "...."], ["DDDL", "LLDL"], ["no-light-l"])).toBe(
        "none",
      );
    });

    test("the near shapes are not an L", () => {
      expect(judge(["...", "..."], ["DDD", "LLL"], ["no-dark-l"])).toBe("none");
      expect(
        judge(["...", "...", "..."], ["LDL", "DDD", "LLL"], ["no-dark-l"]),
      ).toBe("none");
      expect(
        judge(["...", "...", "..."], ["LDL", "DDD", "LDL"], ["no-dark-l"]),
      ).toBe("none");
    });
  });

  describe("distance pairs", () => {
    test("catches a pair two apart whatever lies between", () => {
      expect(judge(["..."], ["DLD"], ["no-dark-any-dark"])).toBe(
        "distance-pair",
      );
      // The middle being the SAME color does not excuse the ends: the ban is
      // positional, so a straight three breaks it too.
      expect(judge(["..."], ["DDD"], ["no-dark-any-dark"])).toBe(
        "distance-pair",
      );
      expect(judge([".", ".", "."], ["D", "L", "D"], ["no-dark-any-dark"])).toBe(
        "distance-pair",
      );
    });

    test("adjacent and knight-offset pairs are not two apart", () => {
      expect(judge(["..."], ["DDL"], ["no-dark-any-dark"])).toBe("none");
      expect(judge(["...", "..."], ["DLL", "LLD"], ["no-dark-any-dark"])).toBe(
        "none",
      );
    });

    /** The user-confirmed semantics, pinned in both oracles: the two end
     * squares alone matter, so even a GAP between them does not lift the ban. */
    test("a gap between does not lift the ban", () => {
      expect(judge([".#."], ["D#D"], ["no-dark-any-dark"])).toBe(
        "distance-pair",
      );
      expect(judge([".#."], ["D#L"], ["no-dark-any-dark"])).toBe("none");
    });

    test("the two distance rules are separate switches", () => {
      expect(judge(["..."], ["LDL"], ["no-dark-any-dark"])).toBe("none");
      expect(judge(["..."], ["LDL"], ["no-light-any-light"])).toBe(
        "distance-pair",
      );
    });
  });

  describe("mixed tees", () => {
    test("catches a light-crossed dark T", () => {
      expect(
        judge(["...", "..."], ["DLD", "LDL"], ["no-light-crossed-dark-t"]),
      ).toBe(DRAWN);
      expect(
        judge(["..", "..", ".."], ["DL", "LD", "DL"], [
          "no-light-crossed-dark-t",
        ]),
      ).toBe(DRAWN);
    });

    test("a monochrome T is not a mixed one, and a gap never crosses", () => {
      expect(
        judge(["...", "..."], ["DDD", "LDL"], ["no-light-crossed-dark-t"]),
      ).toBe("none");
      expect(
        judge([".#.", "..."], ["D#D", "LDL"], ["no-light-crossed-dark-t"]),
      ).toBe("none");
    });

    test("the two mixed-T rules are separate switches", () => {
      expect(
        judge(["...", "..."], ["DLD", "DDL"], ["no-light-crossed-dark-t"]),
      ).toBe(DRAWN);
      expect(
        judge(["...", "..."], ["DLD", "DDL"], ["no-dark-crossed-light-t"]),
      ).toBe("none");
      expect(
        judge(["...", "..."], ["LDL", "LLD"], ["no-dark-crossed-light-t"]),
      ).toBe(DRAWN);
    });
  });

  describe("long tees", () => {
    test("catches a long T", () => {
      expect(
        judge(["...", "...", "..."], ["DDD", "LDL", "LDL"], ["no-dark-long-t"]),
      ).toBe("long-tee");
      expect(
        judge(["...", "...", "..."], ["DLL", "DDD", "DLL"], ["no-dark-long-t"]),
      ).toBe("long-tee");
    });

    test("a plain T and a plus are not a long T", () => {
      expect(
        judge(["...", "...", "..."], ["DDD", "LDL", "LLL"], ["no-dark-long-t"]),
      ).toBe("none");
      expect(
        judge(["...", "...", "..."], ["LDL", "DDD", "LDL"], ["no-dark-long-t"]),
      ).toBe("none");
    });

    test("the two long-T rules are separate switches", () => {
      expect(
        judge(["...", "...", "..."], ["DDD", "LDL", "LDL"], [
          "no-light-long-t",
        ]),
      ).toBe("none");
    });
  });

  describe("knights", () => {
    test("catches a knight's-move pair in all four geometries", () => {
      expect(
        judge(["...", "...", "..."], ["DLL", "LLL", "LDL"], ["no-dark-knight"]),
      ).toBe(DRAWN);
      expect(
        judge(["...", "...", "..."], ["LLD", "LLL", "LDL"], ["no-dark-knight"]),
      ).toBe(DRAWN);
      expect(
        judge(["...", "...", "..."], ["DLL", "LLD", "LLL"], ["no-dark-knight"]),
      ).toBe(DRAWN);
      expect(
        judge(["...", "...", "..."], ["LLD", "DLL", "LLL"], ["no-dark-knight"]),
      ).toBe(DRAWN);
    });

    test("a diagonal touch is not a knight's move", () => {
      expect(
        judge(["...", "...", "..."], ["DLL", "LDL", "LLL"], ["no-dark-knight"]),
      ).toBe("none");
    });

    /** Nothing between the two squares is read — the distance pair's
     * positional reading again. */
    test("a knight pair across a gap still counts", () => {
      expect(
        judge([".#.", "...", "..."], ["D#L", "LLL", "LDL"], [
          "no-dark-knight",
        ]),
      ).toBe(DRAWN);
    });

    test("the two knight rules are separate switches", () => {
      // A gap thins the board so the LIGHT cells hold no knight pair of their
      // own, which on a full 3x3 they would.
      expect(
        judge(["..", "..", ".#"], ["LD", "LL", "D#"], ["no-dark-knight"]),
      ).toBe(DRAWN);
      expect(
        judge(["..", "..", ".#"], ["LD", "LL", "D#"], ["no-light-knight"]),
      ).toBe("none");
    });
  });

  describe("mixed elbows", () => {
    test("catches a mixed elbow", () => {
      expect(
        judge(["..", ".."], ["DL", "LD"], ["no-dark-light-dark-elbow"]),
      ).toBe(DRAWN);
      expect(
        judge(["..", ".."], ["LD", "DL"], ["no-dark-light-dark-elbow"]),
      ).toBe(DRAWN);
      // A STRAIGHT dark-light-dark is the triple rule's shape, not this one's.
      expect(judge(["..."], ["DLD"], ["no-dark-light-dark-elbow"])).toBe(
        "none",
      );
      // A 2x2 checkerboard contains BOTH mixed elbows.
      expect(
        judge(["..", ".."], ["DL", "LD"], ["no-light-dark-light-elbow"]),
      ).toBe(DRAWN);
    });

    test("the two mixed-elbow rules are separate switches", () => {
      expect(
        judge(["...", "..."], ["DLD", "DDD"], ["no-dark-light-dark-elbow"]),
      ).toBe(DRAWN);
      expect(
        judge(["...", "..."], ["DLD", "DDD"], ["no-light-dark-light-elbow"]),
      ).toBe("none");
    });

    test("a gap never stands in for the corner", () => {
      expect(
        judge([".#", ".."], ["D#", "DL"], ["no-dark-light-dark-elbow"]),
      ).toBe("none");
    });
  });

  describe("larger areas", () => {
    test("catches an area-six region of the wrong size", () => {
      expect(
        judge([".......", "......."], ["DDDDDDL", "LLLLLLL"], [
          "area-six-dark",
        ]),
      ).toBe("none");
      // The straight seven an area of six implies.
      expect(
        judge([".......", "......."], ["DDDDDDD", "LLLLLLL"], [
          "area-six-dark",
        ]),
      ).toBe("region-size");
      expect(
        judge([".......", "......."], ["DDDDDLL", "LLLLLLL"], [
          "area-six-dark",
        ]),
      ).toBe("region-size");
    });

    test("catches an area-seven region of the wrong size", () => {
      expect(
        judge(["........", "........"], ["DDDDDDDL", "LLLLLLLL"], [
          "area-seven-dark",
        ]),
      ).toBe("none");
      expect(
        judge(["........", "........"], ["DDDDDDDD", "LLLLLLLL"], [
          "area-seven-dark",
        ]),
      ).toBe("region-size");
    });

    /** Far past anything the pattern table lays out — the whole rule rides
     * the region propagator and the family row. */
    test("catches an area-twenty-four region of the wrong size", () => {
      const rows = [".....", ".....", ".....", ".....", "....."];
      expect(
        judge(rows, ["DDDDD", "DDDDD", "DDLDD", "DDDDD", "DDDDD"], [
          "area-twenty-four-dark",
        ]),
      ).toBe("none");
      expect(
        judge(rows, ["DDDDD", "DDDDD", "DDDDD", "DDDDD", "DDDDD"], [
          "area-twenty-four-dark",
        ]),
      ).toBe("region-size");
    });
  });

  describe("off-by-one", () => {
    test("accepts one off and refuses the honest count", () => {
      expect(judge(["3...", "...."], ["DDLL", "LLLL"], ["off-by-one"])).toBe(
        "none",
      );
      expect(judge(["3...", "...."], ["DDDD", "LLLL"], ["off-by-one"])).toBe(
        "none",
      );
      expect(judge(["3...", "...."], ["DDDL", "LLLL"], ["off-by-one"])).toBe(
        "area",
      );
      expect(judge(["3...", "...."], ["DLLL", "LLLL"], ["off-by-one"])).toBe(
        "area",
      );
      // Rule off, the honest three is exactly right.
      expect(judge(["3...", "...."], ["DDDL", "LLLL"])).toBe("none");
    });

    test("bends the dart count", () => {
      const dart = (answer: string[]) =>
        verifyLogicGrid(
          withDart(board(["....."], ["off-by-one"]), 0, 0, 2, 1),
          painted(answer),
        );
      expect(dart(["DLLDD"])).toBe("dart");
      expect(dart(["DLDDD"])).toBe("none");
      expect(dart(["DLLLD"])).toBe("none");
      expect(dart(["DLLLL"])).toBe("dart");
    });

    test("bends the viewpoint count", () => {
      const viewpoint = (answer: string[]) =>
        verifyLogicGrid(
          withViewpoint(board(["....."], ["off-by-one"]), 0, 0, 2),
          painted(answer),
        );
      expect(viewpoint(["DDLLL"])).toBe("viewpoint");
      expect(viewpoint(["DLLLL"])).toBe("none");
      expect(viewpoint(["DDDLL"])).toBe("none");
    });

    /** Zero is displayable under the rule, and its one legal true count is
     * one — minus one being no count at all. */
    test("reads a displayed zero as one", () => {
      const dart = (answer: string[]) =>
        verifyLogicGrid(
          withDart(board(["..."], ["off-by-one"]), 0, 0, 0, 1),
          painted(answer),
        );
      expect(dart(["DLD"])).toBe("none");
      expect(dart(["DDD"])).toBe("dart");
      const area = (answer: string[]) =>
        verifyLogicGrid(
          withArea(board(["..."], ["off-by-one"]), 0, 0, 0),
          painted(answer),
        );
      expect(area(["DLL"])).toBe("none");
      expect(area(["DDL"])).toBe("area");
    });

    test("leaves letters alone", () => {
      expect(judge(["a.a", "..."], ["DDD", "LLL"], ["off-by-one"])).toBe(
        "none",
      );
      expect(judge(["a.a", "..."], ["DLD", "LLL"], ["off-by-one"])).toBe(
        "letter-split",
      );
    });
  });

  describe("galaxy", () => {
    const judgeGalaxy = (answer: string[]) =>
      verifyLogicGrid(
        withGalaxy(board(["...", "...", "..."]), 1, 1),
        painted(answer),
      );

    /** The accepted coloring is 180-degree symmetric but symmetric across NO
     * single axis — the shape that tells a half turn apart from every mirror
     * a lotus could ask for. */
    test("a galaxy region must map to itself turned halfway", () => {
      expect(judgeGalaxy(["DLL", "DDD", "LLD"])).toBe("none");
      expect(judgeGalaxy(["DLL", "DDD", "LLL"])).toBe("galaxy");
    });

    test("only the region holding the galaxy is mirrored", () => {
      expect(
        verifyLogicGrid(withGalaxy(board(["....."]), 1, 0), painted(["LDLDD"])),
      ).toBe("none");
    });

    test("a galaxy region may not reflect off the board", () => {
      const corner = withGalaxy(board(["..."]), 0, 0);
      expect(verifyLogicGrid(corner, painted(["DDL"]))).toBe("galaxy");
      expect(verifyLogicGrid(corner, painted(["DLL"]))).toBe("none");
    });

    test("a galaxy region may not reflect onto a gap", () => {
      const beside = withGalaxy(board(["..#"]), 1, 0);
      expect(verifyLogicGrid(beside, painted(["DD#"]))).toBe("galaxy");
      expect(verifyLogicGrid(beside, painted(["LD#"]))).toBe("none");
    });

    /** Two half turns compose to a translation, which no finite region
     * survives — the oracle needs no code for that: the far galaxy's square
     * turns off the board about the near one's center. */
    test("two galaxies cannot share a region", () => {
      const config = withGalaxy(
        withGalaxy(board(["...", "...", "..."]), 1, 0),
        1,
        2,
      );
      expect(verifyLogicGrid(config, painted(["DDD", "LLL", "DDD"]))).toBe(
        "none",
      );
      expect(verifyLogicGrid(config, painted(["DDD", "LDL", "DDD"]))).toBe(
        "galaxy",
      );
    });

    /**
     * A SEATED galaxy: the center on a grid line or a corner, where the turn
     * carries a sign. Mirrors the seated block in
     * `a-star/test/verify_test.cpp`.
     */
    test("a seated galaxy turns about the grid line", () => {
      // Center on the seam between the two middle columns of a 4x2, so the
      // dark domino on the left turns onto the dark one on the right.
      const config = withGalaxy(board(["....", "...."]), 1, 0, 1);
      expect(verifyLogicGrid(config, painted(["DDDD", "LLLL"]))).toBe("none");
      expect(verifyLogicGrid(config, painted(["DDDL", "LLLL"]))).toBe("galaxy");
    });

    /** The color-INVERTING case, and the user-confirmed semantics: with the
     * colors across the center differing, every square's image holds the
     * opposite color. */
    test("an inverting galaxy turns onto the other color", () => {
      // Center on the seam under (1,1) of a 3x4, so the turn maps the board
      // onto itself: dark above, light below.
      const config = withGalaxy(board(["...", "...", "...", "..."]), 1, 1, 2);
      expect(
        verifyLogicGrid(config, painted(["DDD", "DDD", "LLL", "LLL"])),
      ).toBe("none");
      expect(
        verifyLogicGrid(config, painted(["DDD", "DDD", "LLL", "LLD"])),
      ).toBe("galaxy");
    });

    /** Walking EVERY region touching the center is load-bearing: the turn is
     * an involution, so one region's image lies IN the other — but the other
     * may reach further, and only its own walk says so. */
    test("both regions at an inverting seat are walked", () => {
      const config = withGalaxy(board(["....", "...."]), 1, 0, 3);
      expect(verifyLogicGrid(config, painted(["DDLL", "DDLL"]))).toBe("none");
      // Every DARK square still turns onto a light one; it is the light
      // region, reaching further, that breaks.
      expect(verifyLogicGrid(config, painted(["DDLL", "DLLL"]))).toBe("galaxy");
    });

    /** Seat 0 is the special case rather than the rule: a square is its own
     * image, so the sign can only preserve color. */
    test("a centered galaxy can only preserve color", () => {
      const config = withGalaxy(board(["...", "...", "..."]), 1, 1);
      expect(verifyLogicGrid(config, painted(["DLD", "LDL", "DLD"]))).toBe(
        "none",
      );
    });

    /** At a CORNER both pairs are in scope, so two that disagree about the
     * sign refuse each other with no check of their own. */
    test("an inconsistent corner is refused", () => {
      const config = withGalaxy(board(["..", ".."]), 0, 0, 3);
      expect(verifyLogicGrid(config, painted(["DL", "LD"]))).toBe("none");
      expect(verifyLogicGrid(config, painted(["DD", "LL"]))).toBe("none");
      expect(verifyLogicGrid(config, painted(["DD", "DL"]))).toBe("galaxy");
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
