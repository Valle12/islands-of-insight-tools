import { describe, expect, test } from "bun:test";
import {
  MAX_DIALS,
  MIN_DIALS,
  validateConfig,
} from "../../src/pages/phasic-dial-solver/config";

const validConfig = {
  maxValues: [3, 4],
  initialValues: [1, 0],
  buttons: [{ turns: [1, 2] }, { turns: [0, 3] }],
};

describe("phasic dial validateConfig", () => {
  test("accepts a config without a result", () => {
    const result = validateConfig(structuredClone(validConfig));
    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    expect(result.config.maxValues).toEqual([3, 4]);
    expect(result.config.initialValues).toEqual([1, 0]);
    expect(result.config.buttons.map(b => b.getTurns())).toEqual([
      [1, 2],
      [0, 3],
    ]);
    expect(result.config.result).toBeUndefined();
  });

  test("accepts a config with a result", () => {
    const result = validateConfig({ ...structuredClone(validConfig), result: [2, 1] });
    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    expect(result.config.result).toEqual([2, 1]);
  });

  test("accepts the maximum number of dials", () => {
    const result = validateConfig({
      maxValues: Array<number>(MAX_DIALS).fill(3),
      initialValues: Array<number>(MAX_DIALS).fill(1),
      buttons: [{ turns: Array<number>(MAX_DIALS).fill(1) }],
    });
    expect(result.ok).toBeTrue();
  });

  const rejections: [string, unknown, string][] = [
    ["a non-object", 42, "Config must be a JSON object."],
    ["null", null, "Config must be a JSON object."],
    ["an array", [], "Config must be a JSON object."],
    [
      "non-integer maxValues",
      { ...validConfig, maxValues: [3, 1.5] },
      "maxValues must be an array of integers.",
    ],
    [
      "missing initialValues",
      { maxValues: [3, 4], buttons: validConfig.buttons },
      "initialValues must be an array of integers.",
    ],
    [
      "too few dials",
      { maxValues: [3], initialValues: [0], buttons: [{ turns: [1] }] },
      `maxValues must hold between ${MIN_DIALS} and ${MAX_DIALS} dials.`,
    ],
    [
      "too many dials",
      {
        maxValues: Array<number>(MAX_DIALS + 1).fill(3),
        initialValues: Array<number>(MAX_DIALS + 1).fill(0),
        buttons: [{ turns: Array<number>(MAX_DIALS + 1).fill(1) }],
      },
      `maxValues must hold between ${MIN_DIALS} and ${MAX_DIALS} dials.`,
    ],
    [
      "mismatched initialValues length",
      { ...validConfig, initialValues: [1] },
      "initialValues must have the same length as maxValues.",
    ],
    [
      "an inert dial",
      { ...validConfig, maxValues: [3, 0] },
      "maxValues[1] must be at least 1.",
    ],
    [
      "a value above its max",
      { ...validConfig, initialValues: [1, 5] },
      "initialValues[1] must be between 0 and 4.",
    ],
    [
      "a negative value",
      { ...validConfig, initialValues: [-1, 0] },
      "initialValues[0] must be between 0 and 3.",
    ],
    [
      "no buttons",
      { ...validConfig, buttons: [] },
      "buttons must be a non-empty array.",
    ],
    [
      "a non-object button",
      { ...validConfig, buttons: [7] },
      "buttons[0] must be an object.",
    ],
    [
      "non-integer turns",
      { ...validConfig, buttons: [{ turns: [1, "2"] }] },
      "buttons[0].turns must be an array of integers.",
    ],
    [
      "a button with the wrong arity",
      { ...validConfig, buttons: [{ turns: [1] }] },
      "buttons[0].turns must have one entry per dial (2).",
    ],
    [
      "a result that does not cover every button",
      { ...validConfig, result: [1] },
      "result must be an array of integers, one per button.",
    ],
  ];

  test.each(rejections)("rejects %s", (_name, input, error) => {
    const result = validateConfig(input);
    expect(result.ok).toBeFalse();
    if (result.ok) return;
    expect(result.error).toBe(error);
  });
});
