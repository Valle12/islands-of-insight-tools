// The part of config validation that is the same whatever the puzzle is. Each
// page keeps its own `config.ts` for the rules only it can state — what a cell
// may hold, how many blocks are legal, which clue kinds exist — and takes the
// answer shape and the opening checks from here.

/**
 * What every page's `validateConfig` answers: the typed config, or the first
 * problem found in words the page can put straight into its warning banner.
 *
 * `migratedFrom` is set only when the file was written in an OLDER format
 * version and had to be brought up to date on the way in — see
 * `configVersion.ts`. The config is current either way; the number is there so
 * the page can say the copy on disk is not, and offer to write a new one. A
 * page whose format carries no version tag never sets it.
 */
export type ConfigResult<T> =
  | { ok: true; config: T; migratedFrom?: number }
  | { ok: false; error: string };

/** Whether `value` is an integer within `[min, max]`. */
export function intInRange(
  value: unknown,
  min: number,
  max: number,
): value is number {
  return (
    Number.isInteger(value) &&
    (value as number) >= min &&
    (value as number) <= max
  );
}

export type GridSize = {
  gridWidth: number;
  gridHeight: number;
};

/**
 * The preamble every grid page's validator opens with: the value is an object,
 * and it carries a `gridWidth` and a `gridHeight` inside that page's own cap.
 *
 * The messages are part of the download format's contract — unit tests and e2e
 * suites assert them verbatim — so they are produced once here rather than
 * restated identically in each page.
 *
 * The cap is a parameter because it is genuinely per page: it comes from what
 * that solver's engine can take, not from anything shared.
 */
export function readGridSize(
  data: unknown,
  maxSide: number,
): ConfigResult<GridSize> {
  // `Array.isArray` as well as the null test: `typeof [] === "object"`, so an
  // array top level used to sail through and be refused for a missing
  // `gridWidth` — naming a key that cannot exist on an array. phasic-dial's
  // validator already guarded this; the four grid pages now say the same thing.
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { ok: false, error: "Config must be a JSON object." };
  }
  const raw = data as Record<string, unknown>;

  for (const key of ["gridWidth", "gridHeight"] as const) {
    if (!intInRange(raw[key], 1, maxSide)) {
      return {
        ok: false,
        error: `${key} must be an integer between 1 and ${maxSide}.`,
      };
    }
  }

  return {
    ok: true,
    config: {
      gridWidth: raw.gridWidth as number,
      gridHeight: raw.gridHeight as number,
    },
  };
}
