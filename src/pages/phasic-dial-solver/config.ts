import type { ConfigResult } from "../../util/configValidation";
import type { PhasicDialTest } from "../../util/types";
import { Button } from "./button";

/**
 * The number of dial colours the game has (blue, red, green, yellow, cyan,
 * purple). `PhasicDialSolver.dialOrder` renders one row per dial, so a config
 * asking for more than this has no icon to draw and cannot be entered by hand
 * either.
 */
export const MAX_DIALS = 6;

/**
 * A puzzle needs at least two dials — the page starts at two and the "-" is
 * only reachable through a reset.
 */
export const MIN_DIALS = 2;

export type PhasicDialConfigParseResult = ConfigResult<PhasicDialTest>;

type Rejection = { ok: false; error: string };

function isIntArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every(entry => Number.isInteger(entry));
}

type DialsResult =
  | Rejection
  | { ok: true; maxValues: number[]; initialValues: number[] };

/** Checks the two parallel dial arrays: shape, count, and each dial's range. */
function validateDials(raw: Record<string, unknown>): DialsResult {
  if (!isIntArray(raw.maxValues)) {
    return { ok: false, error: "maxValues must be an array of integers." };
  }
  if (!isIntArray(raw.initialValues)) {
    return { ok: false, error: "initialValues must be an array of integers." };
  }

  const maxValues = raw.maxValues;
  const initialValues = raw.initialValues;

  if (maxValues.length < MIN_DIALS || maxValues.length > MAX_DIALS) {
    return {
      ok: false,
      error: `maxValues must hold between ${MIN_DIALS} and ${MAX_DIALS} dials.`,
    };
  }
  if (initialValues.length !== maxValues.length) {
    return {
      ok: false,
      error: "initialValues must have the same length as maxValues.",
    };
  }

  for (let i = 0; i < maxValues.length; i++) {
    // Max is "sides of the dial minus 1", so 0 would mean a one-sided dial:
    // its modulus is 1, every value is already 0 and the dial is inert.
    if (maxValues[i]! < 1) {
      return { ok: false, error: `maxValues[${i}] must be at least 1.` };
    }
    if (initialValues[i]! < 0 || initialValues[i]! > maxValues[i]!) {
      return {
        ok: false,
        error: `initialValues[${i}] must be between 0 and ${maxValues[i]}.`,
      };
    }
  }

  return { ok: true, maxValues, initialValues };
}

type ButtonsResult = Rejection | { ok: true; buttons: Button[] };

/** Checks every button carries one integer turn count per dial. */
function validateButtons(value: unknown, dialCount: number): ButtonsResult {
  if (!Array.isArray(value) || value.length === 0) {
    return { ok: false, error: "buttons must be a non-empty array." };
  }

  const buttons: Button[] = [];
  for (let b = 0; b < value.length; b++) {
    const entry = value[b] as Record<string, unknown> | null;
    if (typeof entry !== "object" || entry === null) {
      return { ok: false, error: `buttons[${b}] must be an object.` };
    }
    if (!isIntArray(entry.turns)) {
      return {
        ok: false,
        error: `buttons[${b}].turns must be an array of integers.`,
      };
    }
    if (entry.turns.length !== dialCount) {
      return {
        ok: false,
        error:
          `buttons[${b}].turns must have one entry ` +
          `per dial (${dialCount}).`,
      };
    }
    buttons.push(new Button(entry.turns));
  }

  return { ok: true, buttons };
}

/**
 * Validates an unknown parsed JSON value against the phasic dial config
 * (download) format. Returns the typed config on success, or a human-readable
 * error explaining the first problem found.
 */
export function validateConfig(data: unknown): PhasicDialConfigParseResult {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { ok: false, error: "Config must be a JSON object." };
  }
  const raw = data as Record<string, unknown>;

  const dials = validateDials(raw);
  if (!dials.ok) return dials;

  const buttons = validateButtons(raw.buttons, dials.maxValues.length);
  if (!buttons.ok) return buttons;

  const config: PhasicDialTest = {
    maxValues: dials.maxValues,
    initialValues: dials.initialValues,
    buttons: buttons.buttons,
  };

  // `result` is optional: it only exists in files downloaded after a solve.
  if (raw.result !== undefined) {
    if (
      !isIntArray(raw.result) ||
      raw.result.length !== config.buttons.length
    ) {
      return {
        ok: false,
        error: "result must be an array of integers, one per button.",
      };
    }
    config.result = raw.result;
  }

  return { ok: true, config };
}
