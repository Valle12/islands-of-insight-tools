import { describe, expect, test } from "bun:test";
import {
  RULE_COUNT,
  RULE_ROW,
  RULES,
  ruleAt,
  type LogicGridRuleGroup,
  type SizedRuleColor,
  type SizedRuleFamily,
} from "../../src/pages/logic-grid-solver/rules";
import {
  AXES,
  AXIS_COUNT,
  DIRECTION_COUNT,
  DIRECTIONS,
  MIN_AREA_VALUE,
  parseSymbolValue,
  SEAT_COUNT,
  symbolDirectionError,
  SYMBOL_KIND_COUNT,
  SYMBOL_KINDS,
  symbolKindAt,
  symbolSeatError,
  symbolValueError,
  symbolValueMax,
  symbolValueMin,
} from "../../src/pages/logic-grid-solver/symbols";

/** A 5x5 board: 25 cells, and a longest line of 4 squares. */
const SIZE = { gridWidth: 5, gridHeight: 5 };

/**
 * Both catalogues are stored by INDEX, so their order is part of the file
 * format. The two tables below are what makes a reorder fail loudly instead of
 * silently rewriting every puzzle ever saved; appending a row is the only edit
 * either of them should ever need.
 */
const RULE_ORDER: [number, string][] = [
  [0, "no-dark-2x2"],
  [1, "no-light-2x2"],
  [2, "no-dark-1x2"],
  [3, "no-light-1x2"],
  [4, "no-dark-1x3"],
  [5, "no-light-1x3"],
  [6, "no-dark-1x4"],
  [7, "no-light-1x4"],
  [8, "no-dark-1x5"],
  [9, "no-light-1x5"],
  [10, "no-checkerboard"],
  [11, "connect-dark"],
  [12, "connect-light"],
  [13, "one-symbol-dark"],
  [14, "one-symbol-light"],
  [15, "underclued"],
  [16, "area-two-dark"],
  [17, "area-two-light"],
  [18, "area-four-dark"],
  [19, "area-four-light"],
  [20, "area-five-dark"],
  [21, "area-five-light"],
  [22, "no-dark-light-dark"],
  [23, "no-light-dark-light"],
  [24, "no-dark-t"],
  [25, "no-light-t"],
  [26, "no-three-dark-one-light"],
  [27, "no-three-light-one-dark"],
  [28, "no-dark-diagonal"],
  [29, "no-light-diagonal"],
  [30, "area-three-dark"],
  [31, "area-three-light"],
  [32, "off-by-one"],
  [33, "no-dark-elbow"],
  [34, "no-light-elbow"],
  [35, "no-dark-l"],
  [36, "no-light-l"],
  [37, "no-dark-any-dark"],
  [38, "no-light-any-light"],
  [39, "area-six-dark"],
  [40, "area-six-light"],
  [41, "area-seven-dark"],
  [42, "area-seven-light"],
  [43, "no-light-crossed-dark-t"],
  [44, "no-dark-crossed-light-t"],
  [45, "no-dark-long-t"],
  [46, "no-light-long-t"],
  [47, "area-twenty-four-dark"],
  [48, "area-twenty-four-light"],
  [49, "no-dark-knight"],
  [50, "no-light-knight"],
  [51, "no-dark-light-dark-elbow"],
  [52, "no-light-dark-light-elbow"],
  [53, "distinct-shapes-dark"],
  [54, "distinct-shapes-light"],
  [55, "same-shape-dark"],
  [56, "same-shape-light"],
];

/**
 * The v1 -> v2 translation, pinned like the order above: which `areas`/`runs`
 * entry each retired sized index turns into. The migration rewrites saved
 * files through these markers, so changing one silently rewrites every
 * version 1 puzzle ever downloaded — appending a FLAG rule is still the only
 * edit the catalogue should ever need.
 */
const SIZED_MAP: [number, SizedRuleFamily, SizedRuleColor, number][] = [
  [2, "runs", "dark", 2],
  [3, "runs", "light", 2],
  [4, "runs", "dark", 3],
  [5, "runs", "light", 3],
  [6, "runs", "dark", 4],
  [7, "runs", "light", 4],
  [8, "runs", "dark", 5],
  [9, "runs", "light", 5],
  [16, "areas", "dark", 2],
  [17, "areas", "light", 2],
  [18, "areas", "dark", 4],
  [19, "areas", "light", 4],
  [20, "areas", "dark", 5],
  [21, "areas", "light", 5],
  [30, "areas", "dark", 3],
  [31, "areas", "light", 3],
  [39, "areas", "dark", 6],
  [40, "areas", "light", 6],
  [41, "areas", "dark", 7],
  [42, "areas", "light", 7],
  [47, "areas", "dark", 24],
  [48, "areas", "light", 24],
];

/** One row control, projected to what the layout promises about it. */
type RowPin =
  | ["single", string]
  | ["pair", string, string, string]
  | ["sized", string];

/**
 * And what the ROW looks like, which is a different question with a different
 * answer — `no-dark-2x2` is stored at 0 and drawn as the Dark segment of the
 * first pair. This table may be rewritten whenever the row should read
 * differently; the two above may not. A pair pin is
 * `["pair", label, dark id, light id]`.
 */
const ROW_PINS: {
  band: LogicGridRuleGroup;
  heading: string;
  entries: RowPin[];
}[] = [
  {
    band: "arrangement",
    heading: "Arrangement",
    entries: [
      ["pair", "No 2x2", "no-dark-2x2", "no-light-2x2"],
      ["sized", "run-dark"],
      ["sized", "run-light"],
      ["single", "no-checkerboard"],
      ["pair", "No alternating triple", "no-dark-light-dark", "no-light-dark-light"],
      ["pair", "No elbow", "no-dark-elbow", "no-light-elbow"],
      ["pair", "No L", "no-dark-l", "no-light-l"],
      ["pair", "No T", "no-dark-t", "no-light-t"],
      ["pair", "No long T", "no-dark-long-t", "no-light-long-t"],
      [
        "pair",
        "No mixed elbow",
        "no-dark-light-dark-elbow",
        "no-light-dark-light-elbow",
      ],
      // The Dark segment is `no-light-crossed-dark-t`: the id names the
      // crossing colour, the segment names the T's.
      ["pair", "No crossed T", "no-light-crossed-dark-t", "no-dark-crossed-light-t"],
      ["pair", "No 3 + 1", "no-three-dark-one-light", "no-three-light-one-dark"],
      ["pair", "No diagonal", "no-dark-diagonal", "no-light-diagonal"],
      ["pair", "No knight's move", "no-dark-knight", "no-light-knight"],
      ["pair", "No two apart", "no-dark-any-dark", "no-light-any-light"],
    ],
  },
  {
    band: "region",
    heading: "Region",
    entries: [
      ["pair", "Connect all cells", "connect-dark", "connect-light"],
      ["sized", "area-dark"],
      ["sized", "area-light"],
      [
        "pair",
        "No two regions alike",
        "distinct-shapes-dark",
        "distinct-shapes-light",
      ],
      ["pair", "All regions alike", "same-shape-dark", "same-shape-light"],
    ],
  },
  {
    band: "symbol",
    heading: "Symbol",
    entries: [
      ["pair", "One symbol per area", "one-symbol-dark", "one-symbol-light"],
      ["single", "off-by-one"],
    ],
  },
  {
    band: "answer",
    heading: "Answer",
    entries: [["single", "underclued"]],
  },
];

const SYMBOL_ORDER: [number, string][] = [
  [0, "area"],
  [1, "letter"],
  [2, "dart"],
  [3, "lotus"],
  [4, "viewpoint"],
  [5, "galaxy"],
];

/** The four axes reuse the `direction` key, so their order is frozen too. */
const AXIS_ORDER: [number, string][] = [
  [0, "horizontal"],
  [1, "diagonal-down"],
  [2, "vertical"],
  [3, "diagonal-up"],
];

/** The four directions are stored by index too, so their order is frozen. */
const DIRECTION_ORDER: [number, string][] = [
  [0, "up"],
  [1, "right"],
  [2, "down"],
  [3, "left"],
];

describe("RULES", () => {
  test.each(RULE_ORDER)("index %i is still %s", (index, id) => {
    expect(ruleAt(index)?.id).toBe(id);
  });

  test("the pinned order covers every rule", () => {
    expect(RULE_COUNT).toBe(RULE_ORDER.length);
  });

  test("ids are unique and labels are non-empty", () => {
    expect(new Set(RULES.map(rule => rule.id)).size).toBe(RULE_COUNT);
    expect(RULES.every(rule => rule.label.trim() !== "")).toBeTrue();
  });

  test("an index past the end is undefined rather than a stand-in", () => {
    expect(ruleAt(RULE_COUNT)).toBeUndefined();
  });

  test.each(SIZED_MAP)(
    "index %i is the %s entry for %s %i",
    (index, family, color, value) => {
      expect(ruleAt(index)?.sized).toEqual({ family, color, value });
    },
  );

  test("every entry outside the sized map is a flag", () => {
    const sizedIndices = new Set(SIZED_MAP.map(([index]) => index));
    RULES.forEach((rule, index) => {
      if (!sizedIndices.has(index)) expect(rule.sized).toBeUndefined();
    });
  });
});

describe("RULE_ROW", () => {
  test("draws the bands and controls the pinned way", () => {
    const projected = RULE_ROW.map(band => ({
      band: band.band,
      heading: band.heading,
      entries: band.entries.map((entry): RowPin => {
        if (entry.kind === "single") return ["single", entry.id];
        if (entry.kind === "pair") {
          return ["pair", entry.label, entry.dark, entry.light];
        }
        return ["sized", entry.control.key];
      }),
    }));
    expect(projected).toEqual(ROW_PINS);
  });

  test("shows every flag rule exactly once and no sized rule at all", () => {
    // The invariant that makes the folding safe: a control forgotten here
    // would drop its rules from the page silently, and a sized id here would
    // draw a chip the format can no longer store.
    const drawn = RULE_ROW.flatMap(band =>
      band.entries.flatMap(entry => {
        if (entry.kind === "single") return [entry.id];
        if (entry.kind === "pair") return [entry.dark, entry.light];
        return [];
      }),
    );
    const flags = RULES.filter(rule => !rule.sized).map(rule => rule.id);
    expect([...drawn].sort()).toEqual([...flags].sort());
    expect(new Set(drawn).size).toBe(drawn.length);
  });

  test("every control sits in the band its rules' group names", () => {
    for (const band of RULE_ROW) {
      for (const entry of band.entries) {
        if (entry.kind === "sized") continue;
        const ids = entry.kind === "single" ? [entry.id] : [entry.dark, entry.light];
        for (const id of ids) {
          expect(RULES.find(rule => rule.id === id)?.group).toBe(band.band);
        }
      }
    }
  });

  test("the four sized controls cover both families and colours", () => {
    const controls = RULE_ROW.flatMap(band =>
      band.entries.flatMap(entry =>
        entry.kind === "sized" ? [entry.control] : [],
      ),
    );
    expect(controls.map(control => control.key).sort()).toEqual([
      "area-dark",
      "area-light",
      "run-dark",
      "run-light",
    ]);
    for (const control of controls) {
      // The bounds are pinned as numbers on purpose: the run cap is the
      // engine's `kMaxPatternCells` and must not drift by accident.
      expect([control.min, control.max]).toEqual(
        control.family === "runs" ? [2, 8] : [1, 9999],
      );
      // Whether a second value per colour means anything is a property of the
      // FAMILY: two run bans are conjunctive, two area sizes hold only where
      // the colour is absent. `SizedListSpec.perColor` says the same on the
      // file's side, and these two must never disagree.
      expect(control.onePerColor).toBe(control.family === "areas");
      // A sized control draws in the band its rules always lived in.
      const members = RULES.filter(
        rule =>
          rule.sized?.family === control.family &&
          rule.sized.color === control.color,
      );
      expect(members.length).toBeGreaterThan(0);
      for (const member of members) {
        const band = RULE_ROW.find(one =>
          one.entries.some(
            entry => entry.kind === "sized" && entry.control === control,
          ),
        );
        expect(member.group).toBe(band!.band);
        // Every retired size fits the control that replaced its chips.
        expect(member.sized!.value).toBeGreaterThanOrEqual(control.min);
        expect(member.sized!.value).toBeLessThanOrEqual(control.max);
      }
    }
  });
});

describe("SYMBOL_KINDS", () => {
  test.each(SYMBOL_ORDER)("index %i is still %s", (index, id) => {
    expect(symbolKindAt(index)?.id).toBe(id);
  });

  test("the pinned order covers every kind", () => {
    expect(SYMBOL_KIND_COUNT).toBe(SYMBOL_ORDER.length);
  });

  test("ids are unique, and every kind shows a sample glyph", () => {
    expect(new Set(SYMBOL_KINDS.map(kind => kind.id)).size).toBe(
      SYMBOL_KIND_COUNT,
    );
    expect(SYMBOL_KINDS.every(kind => kind.sample.length > 0)).toBeTrue();
  });
});

describe("AXES", () => {
  test.each(AXIS_ORDER)("index %i is still %s", (index, id) => {
    expect(AXES[index]?.id).toBe(id);
  });

  test("the pinned order covers every axis", () => {
    expect(AXIS_COUNT).toBe(AXIS_ORDER.length);
  });

  test("ids are unique and labels are non-empty", () => {
    expect(new Set(AXES.map(axis => axis.id)).size).toBe(AXIS_COUNT);
    expect(AXES.every(axis => axis.label.trim() !== "")).toBeTrue();
  });
});

describe("DIRECTIONS", () => {
  test.each(DIRECTION_ORDER)("index %i is still %s", (index, id) => {
    expect(DIRECTIONS[index]?.id).toBe(id);
  });

  test("the pinned order covers every direction", () => {
    expect(DIRECTION_COUNT).toBe(DIRECTION_ORDER.length);
  });

  /**
   * The order is clockwise from up because that is what `nearestVertex` returns
   * for four sides, which is what lets a dragged arrow land on the right entry
   * with no translation table. Each step is also the offset it names.
   */
  test("reads clockwise from up, and each step is its own offset", () => {
    expect(DIRECTIONS.map(one => [one.dx, one.dy])).toEqual([
      [0, -1],
      [1, 0],
      [0, 1],
      [-1, 0],
    ]);
  });
});

describe("symbolValueMax", () => {
  test("an area is bounded by the board and a dart by its line", () => {
    expect(symbolValueMax(symbolKindAt(0)!, SIZE)).toBe(25);
    // The longest ray on a 5x5 leaves the dart's own square behind.
    expect(symbolValueMax(symbolKindAt(2)!, SIZE)).toBe(4);
    expect(
      symbolValueMax(symbolKindAt(2)!, { gridWidth: 3, gridHeight: 9 }),
    ).toBe(8);
  });

  test("a viewpoint is bounded by its cross, not the longest side", () => {
    expect(symbolValueMax(symbolKindAt(4)!, SIZE)).toBe(9);
    // The asymmetric board is what tells w + h - 1 apart from max(w, h) - 1.
    expect(
      symbolValueMax(symbolKindAt(4)!, { gridWidth: 3, gridHeight: 9 }),
    ).toBe(11);
  });

  test("a valueless kind has no number to bound", () => {
    expect(symbolValueMax(symbolKindAt(3)!, SIZE)).toBe(0);
    expect(symbolValueMax(symbolKindAt(5)!, SIZE)).toBe(0);
  });

  /** Off-by-one widens every numeric bound by one at BOTH ends — the floor
   * never below zero, the game showing no negatives — and leaves the
   * valueless kinds' nothing alone. */
  test("off-by-one widens every numeric bound by one", () => {
    const bent = { ...SIZE, offByOne: true };
    expect(symbolValueMax(symbolKindAt(0)!, bent)).toBe(26);
    expect(symbolValueMax(symbolKindAt(2)!, bent)).toBe(5);
    expect(symbolValueMax(symbolKindAt(4)!, bent)).toBe(10);
    expect(symbolValueMin(symbolKindAt(0)!, bent)).toBe(0);
    expect(symbolValueMin(symbolKindAt(2)!, bent)).toBe(0);
    expect(symbolValueMin(symbolKindAt(4)!, bent)).toBe(0);
    expect(symbolValueMin(symbolKindAt(0)!, SIZE)).toBe(1);
    expect(symbolValueMax(symbolKindAt(3)!, bent)).toBe(0);
  });
});

describe("symbolValueError", () => {
  const area = symbolKindAt(0)!;
  const letter = symbolKindAt(1)!;
  const dart = symbolKindAt(2)!;

  test("accepts an area inside the board", () => {
    expect(symbolValueError(area, MIN_AREA_VALUE, SIZE)).toBeNull();
    expect(symbolValueError(area, 25, SIZE)).toBeNull();
  });

  test("an area of zero is not a region", () => {
    expect(symbolValueError(area, 0, SIZE)).toBe(
      "Area number values must be integers between 1 and 25.",
    );
  });

  test("an area cannot name more cells than the board has", () => {
    expect(symbolValueError(area, 26, SIZE)).not.toBeNull();
  });

  test("an area must be a whole number, not a string", () => {
    expect(symbolValueError(area, 2.5, SIZE)).not.toBeNull();
    expect(symbolValueError(area, "3", SIZE)).not.toBeNull();
  });

  /** Zero is one of the two darts that fill in immediately, not a mistake. */
  test("a dart of zero is a real dart", () => {
    expect(symbolValueError(dart, 0, SIZE)).toBeNull();
  });

  test("a dart cannot name more squares than its line holds", () => {
    expect(symbolValueError(dart, 4, SIZE)).toBeNull();
    expect(symbolValueError(dart, 5, SIZE)).toBe(
      "Dart values must be integers between 0 and 4.",
    );
  });

  test("accepts a single upper-case letter", () => {
    expect(symbolValueError(letter, "A", SIZE)).toBeNull();
    expect(symbolValueError(letter, "Z", SIZE)).toBeNull();
  });

  test("rejects lower case, multiple letters and non-letters", () => {
    for (const value of ["a", "AB", "", "1", 1]) {
      expect(symbolValueError(letter, value, SIZE)).toBe(
        "Letter values must be a single letter from A to Z.",
      );
    }
  });

  /** Its own square always counts, so there is no viewpoint of zero — unlike
   * the dart, whose count starts beyond its own cell. */
  test("a viewpoint counts itself, so its floor is one", () => {
    const viewpoint = symbolKindAt(4)!;
    expect(symbolValueError(viewpoint, 1, SIZE)).toBeNull();
    expect(symbolValueError(viewpoint, 9, SIZE)).toBeNull();
    expect(symbolValueError(viewpoint, 0, SIZE)).toBe(
      "Viewpoint values must be integers between 1 and 9.",
    );
    expect(symbolValueError(viewpoint, 10, SIZE)).not.toBeNull();
  });

  /** Not merely ignored: a value on a clue that never reads one would look
   * like part of the puzzle and change nothing about it. */
  test("a symmetry symbol refuses to carry a value at all", () => {
    const lotus = symbolKindAt(3)!;
    expect(symbolValueError(lotus, undefined, SIZE)).toBeNull();
    expect(symbolValueError(lotus, 0, SIZE)).toBe(
      "Symmetry symbols carry no value.",
    );
  });

  /** The widened message names the widened bounds, so a file refused under
   * the rule says the range that really applied. */
  test("off-by-one widens the bounds and the message with them", () => {
    const bent = { ...SIZE, offByOne: true };
    expect(symbolValueError(area, 0, bent)).toBeNull();
    expect(symbolValueError(area, 26, bent)).toBeNull();
    expect(symbolValueError(area, 27, bent)).toBe(
      "Area number values must be integers between 0 and 26.",
    );
    expect(symbolValueError(symbolKindAt(4)!, 0, bent)).toBeNull();
    expect(symbolValueError(dart, 5, bent)).toBeNull();
  });

  /** The galaxy is valueless and aims nowhere, and every refusal derives from
   * its own fields — no validator branch names it. It DOES carry a seat: its
   * centre may sit on a grid line or a corner, so the generic net that refuses
   * one has to be read off `seating` rather than off `aims`. */
  test("a galaxy refuses value and direction but takes a seat", () => {
    const galaxy = symbolKindAt(5)!;
    expect(symbolValueError(galaxy, undefined, SIZE)).toBeNull();
    expect(symbolValueError(galaxy, 0, SIZE)).toBe(
      "Galaxy symbols carry no value.",
    );
    expect(symbolDirectionError(galaxy, undefined)).toBeNull();
    expect(symbolDirectionError(galaxy, 0)).toBe(
      "Only a directed symbol carries a direction, and Galaxy is not one.",
    );
    expect(symbolSeatError(galaxy, undefined)).toBeNull();
    expect(symbolSeatError(galaxy, 1)).toBeNull();
    expect(symbolSeatError(galaxy, 4)).toBe(
      "Galaxy seats must be integers between 0 and 3.",
    );
    expect(parseSymbolValue(galaxy, "3", SIZE)).toBeNull();
  });

  /** The seat net still holds for every kind that has no point of its own,
   * which is what the galaxy's own case used to prove. */
  test("an unseated kind refuses a seat", () => {
    expect(symbolSeatError(symbolKindAt(4)!, 1)).toBe(
      "Only a symmetry symbol carries a seat, and Viewpoint is not one.",
    );
    expect(symbolSeatError(symbolKindAt(0)!, 1)).toBe(
      "Only a symmetry symbol carries a seat, and Area number is not one.",
    );
  });

  /** Exactly one kind seats inside its own merged cell and exactly one seats
   * anywhere on the board — the two halves the capability field exists to keep
   * apart. */
  test("seating names the lotus and the galaxy apart", () => {
    const seatings = SYMBOL_KINDS.map(kind => [kind.id, kind.seating]);
    expect(seatings).toEqual([
      ["area", "none"],
      ["letter", "none"],
      ["dart", "none"],
      ["lotus", "cell"],
      ["viewpoint", "none"],
      ["galaxy", "board"],
    ]);
  });
});

describe("symbolDirectionError", () => {
  const area = symbolKindAt(0)!;
  const dart = symbolKindAt(2)!;

  test("a directed kind takes one of the four", () => {
    for (let index = 0; index < DIRECTION_COUNT; index++) {
      expect(symbolDirectionError(dart, index)).toBeNull();
    }
  });

  test("a directed kind refuses a missing or unknown direction", () => {
    for (const value of [undefined, -1, DIRECTION_COUNT, 1.5, "up"]) {
      expect(symbolDirectionError(dart, value)).toBe(
        `Dart directions must be integers between 0 and ${DIRECTION_COUNT - 1}.`,
      );
    }
  });

  /**
   * Not merely ignored: a direction stored on a clue that never reads one
   * would look like part of the puzzle and change nothing about it.
   */
  test("an undirected kind refuses to carry one at all", () => {
    expect(symbolDirectionError(area, undefined)).toBeNull();
    expect(symbolDirectionError(area, 0)).toBe(
      "Only a directed symbol carries a direction, and Area number is not one.",
    );
  });

  /** The lotus reuses the key as its AXIS, with the same bounds. */
  test("an axis-aimed kind takes one of the four in the same key", () => {
    const lotus = symbolKindAt(3)!;
    for (let index = 0; index < AXIS_COUNT; index++) {
      expect(symbolDirectionError(lotus, index)).toBeNull();
    }
    expect(symbolDirectionError(lotus, undefined)).toBe(
      `Symmetry directions must be integers between 0 and ${AXIS_COUNT - 1}.`,
    );
  });
});

describe("symbolSeatError", () => {
  const area = symbolKindAt(0)!;
  const lotus = symbolKindAt(3)!;

  test("a symmetry symbol takes one of the four seats, or none", () => {
    expect(symbolSeatError(lotus, undefined)).toBeNull();
    for (let seat = 0; seat < SEAT_COUNT; seat++) {
      expect(symbolSeatError(lotus, seat)).toBeNull();
    }
  });

  test("refuses a seat outside the four", () => {
    for (const value of [-1, SEAT_COUNT, 1.5, "1"]) {
      expect(symbolSeatError(lotus, value)).toBe(
        `Symmetry seats must be integers between 0 and ${SEAT_COUNT - 1}.`,
      );
    }
  });

  test("any other kind refuses to carry one at all", () => {
    expect(symbolSeatError(area, undefined)).toBeNull();
    expect(symbolSeatError(area, 1)).toBe(
      "Only a symmetry symbol carries a seat, and Area number is not one.",
    );
  });
});

describe("parseSymbolValue", () => {
  const area = symbolKindAt(0)!;
  const letter = symbolKindAt(1)!;
  const dart = symbolKindAt(2)!;

  test("reads a number for an area and upper-cases a letter", () => {
    expect(parseSymbolValue(area, " 12 ", SIZE)).toBe(12);
    expect(parseSymbolValue(letter, "b", SIZE)).toBe("B");
  });

  test("reads a dart of zero, which an area could not be", () => {
    expect(parseSymbolValue(dart, "0", SIZE)).toBe(0);
    expect(parseSymbolValue(area, "0", SIZE)).toBeNull();
  });

  /** A half-typed field must stamp nothing rather than stamping a guess. */
  test("returns null for anything the kind cannot use", () => {
    expect(parseSymbolValue(area, "", SIZE)).toBeNull();
    expect(parseSymbolValue(area, "-", SIZE)).toBeNull();
    expect(parseSymbolValue(area, "99", SIZE)).toBeNull();
    expect(parseSymbolValue(letter, "", SIZE)).toBeNull();
    expect(parseSymbolValue(letter, "AB", SIZE)).toBeNull();
  });

  /** A valueless kind has no field, so nothing typed is ever its value. */
  test("returns null for a valueless kind whatever was typed", () => {
    expect(parseSymbolValue(symbolKindAt(3)!, "3", SIZE)).toBeNull();
  });
});
