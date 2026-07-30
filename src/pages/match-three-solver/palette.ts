// The color palette a match-three board draws from. Colors are never picked
// by hand: a board starts with one color and "Add Color" hands out another,
// so the only thing that matters is that any two slots stay tellable apart on
// a grid of 42px squares. That rules out most of the CSS named colors — the
// list below is the curated subset, and the near-duplicate greys, whites and
// pastels are left out on purpose.

export const COLOR_NAMES: readonly string[] = [
  "crimson",
  "tomato",
  "orange",
  "gold",
  "yellowgreen",
  "mediumseagreen",
  "teal",
  "turquoise",
  "dodgerblue",
  "royalblue",
  "mediumpurple",
  "orchid",
  "hotpink",
  "sienna",
  "olive",
  "darkcyan",
  "steelblue",
  "indigo",
  "darkmagenta",
  "firebrick",
  "chocolate",
  "darkkhaki",
  "seagreen",
  "slateblue",
  "lightcoral",
  "plum",
  "khaki",
  "aquamarine",
];

/** How many colors one board can hold — every name may be used once. */
export const MAX_COLORS = COLOR_NAMES.length;

const KNOWN_COLORS: ReadonlySet<string> = new Set(COLOR_NAMES);

export function isKnownColor(value: unknown): value is string {
  return typeof value === "string" && KNOWN_COLORS.has(value);
}

/**
 * A uniform index in [0, count). Drawn from the Web Crypto RNG rather than
 * `Math.random` — not because the palette is a secret, but because it is the
 * one random draw on the page and this keeps it off Sonar's pseudorandom rule
 * without a suppression. Values in the ragged tail of the 2^32 range are
 * rejected so the modulo stays unbiased; with a palette this small that
 * effectively never loops.
 */
function randomIndex(count: number): number {
  const limit = Math.floor(2 ** 32 / count) * count;
  const buffer = new Uint32Array(1);
  let value = limit;
  while (value >= limit) {
    crypto.getRandomValues(buffer);
    value = buffer[0]!;
  }
  return value % count;
}

/**
 * Picks a color that is not in `used`, or null once every name is taken.
 * The choice is random rather than the next entry in order so a board does not
 * always open on the same color.
 */
export function pickUnusedColor(used: readonly string[]): string | null {
  const taken = new Set(used);
  const free = COLOR_NAMES.filter(name => !taken.has(name));
  if (free.length === 0) return null;
  return free[randomIndex(free.length)]!;
}
