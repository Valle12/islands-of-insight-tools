import { describe, expect, test } from "bun:test";
import {
  BLOCKED,
  colorCell,
  EMPTY,
} from "../../src/pages/match-three-solver/cell";
import {
  MAX_COLORS,
  MAX_GRID_SIDE,
  validateConfig,
} from "../../src/pages/match-three-solver/config";
import { COLOR_NAMES } from "../../src/pages/match-three-solver/palette";
import type { MatchThreeCell } from "../../src/util/types";

const VALID = {
  gridWidth: 3,
  gridHeight: 2,
  colors: ["teal", "gold"],
  cells: [
    [colorCell(0), BLOCKED],
    [EMPTY, colorCell(1)],
    [colorCell(1), colorCell(0)],
  ] as MatchThreeCell[][],
};

/** The highest legal cell value for a two-color board. */
const MAX_CELL = colorCell(1);

function clone(): typeof VALID {
  return JSON.parse(JSON.stringify(VALID));
}

/** A config whose palette is `colors` and whose cells are all `fill`. */
function withPalette(colors: unknown, fill: MatchThreeCell = EMPTY) {
  return {
    gridWidth: 2,
    gridHeight: 2,
    colors,
    cells: [
      [fill, fill],
      [fill, fill],
    ],
  };
}

describe("Match three validateConfig", () => {
  test("accepts a hand-written valid config", () => {
    const result = validateConfig(clone());
    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    expect(result.config.colors).toEqual(["teal", "gold"]);
    expect(result.config.cells[1]![1]).toBe(colorCell(1));
  });

  test("accepts every legal cell value for the palette size", () => {
    const result = validateConfig({
      gridWidth: 2,
      gridHeight: 2,
      colors: ["teal", "gold"],
      cells: [
        [EMPTY, BLOCKED],
        [colorCell(0), colorCell(1)],
      ],
    });
    expect(result.ok).toBeTrue();
  });

  test("accepts a real downloaded fixture", async () => {
    const fixture = await Bun.file(
      `${import.meta.dir}/../resources/match-three-solver/matchThreeTest1.json`,
    ).json();
    const result = validateConfig(fixture);
    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    expect(result.config.gridWidth).toBe(6);
    expect(result.config.colors).toHaveLength(3);
  });

  test("accepts the full palette", () => {
    const result = validateConfig(withPalette([...COLOR_NAMES]));
    expect(result.ok).toBeTrue();
  });

  const rejections: [string, unknown, string][] = [
    ["a non-object", 42, "Config must be a JSON object."],
    ["null", null, "Config must be a JSON object."],
    [
      "a missing width",
      { ...clone(), gridWidth: undefined },
      `gridWidth must be an integer between 1 and ${MAX_GRID_SIDE}.`,
    ],
    [
      "a fractional width",
      { ...clone(), gridWidth: 2.5 },
      `gridWidth must be an integer between 1 and ${MAX_GRID_SIDE}.`,
    ],
    [
      "an oversized width",
      { ...clone(), gridWidth: MAX_GRID_SIDE + 1 },
      `gridWidth must be an integer between 1 and ${MAX_GRID_SIDE}.`,
    ],
    [
      "a zero height",
      { ...clone(), gridHeight: 0 },
      `gridHeight must be an integer between 1 and ${MAX_GRID_SIDE}.`,
    ],
    [
      "a missing palette",
      withPalette(undefined),
      `colors must hold between 1 and ${MAX_COLORS} colors.`,
    ],
    [
      "an empty palette",
      withPalette([]),
      `colors must hold between 1 and ${MAX_COLORS} colors.`,
    ],
    [
      "a palette longer than the color list",
      withPalette([...COLOR_NAMES, "teal"]),
      `colors must hold between 1 and ${MAX_COLORS} colors.`,
    ],
    [
      "an unknown color",
      withPalette(["teal", "notacolor"]),
      "colors may only contain known color names.",
    ],
    [
      "a non-string color",
      withPalette(["teal", 3]),
      "colors may only contain known color names.",
    ],
    [
      "a repeated color",
      withPalette(["teal", "teal"]),
      "colors must not repeat a color.",
    ],
    [
      "cells that are not an array",
      { ...clone(), cells: "nope" },
      "cells must be an array of 3 columns.",
    ],
    [
      "the wrong number of columns",
      { ...clone(), cells: [[0, 1]] },
      "cells must be an array of 3 columns.",
    ],
    [
      "a short column",
      { ...clone(), cells: [[0, 1], [0], [0, 1]] },
      "Every cells column must have 2 entries.",
    ],
    [
      "a cell that is not a number",
      { ...clone(), cells: [[0, "blocked"], [0, 1], [0, 1]] },
      `Cells must be integers between 0 and ${MAX_CELL} (0 empty, 1 blocked, 2+ colors).`,
    ],
    [
      "a fractional cell",
      { ...clone(), cells: [[0, 1.5], [0, 1], [0, 1]] },
      `Cells must be integers between 0 and ${MAX_CELL} (0 empty, 1 blocked, 2+ colors).`,
    ],
    [
      "a color index past the palette",
      { ...clone(), cells: [[0, MAX_CELL + 1], [0, 1], [0, 1]] },
      `Cells must be integers between 0 and ${MAX_CELL} (0 empty, 1 blocked, 2+ colors).`,
    ],
    [
      "a negative cell",
      { ...clone(), cells: [[0, -1], [0, 1], [0, 1]] },
      `Cells must be integers between 0 and ${MAX_CELL} (0 empty, 1 blocked, 2+ colors).`,
    ],
  ];

  test.each(rejections)("rejects %s", (_name, input, error) => {
    const result = validateConfig(input);
    expect(result.ok).toBeFalse();
    if (result.ok) return;
    expect(result.error).toBe(error);
  });
});
