/**
 * Which band of the rule row a rule's control is drawn in. Display-only and
 * free to change — the row's actual layout lives in `RULE_ROW` below.
 */
export type LogicGridRuleGroup =
  | "arrangement"
  | "region"
  | "symbol"
  | "answer";

/** The two rule families that carry a number, named by their config key. */
export type SizedRuleFamily = "areas" | "runs";

/** The colour a sized rule constrains, spelled the way the config stores it. */
export type SizedRuleColor = "dark" | "light";

/**
 * What a retired sized catalogue entry means since format version 2: the
 * `areas`/`runs` entry it turned into. This mapping is LISTED here rather than
 * parsed out of ids or labels, and it is what the migration, the validator's
 * by-name rejection and the test board builders all read.
 */
export interface SizedRuleOrigin {
  readonly family: SizedRuleFamily;
  readonly color: SizedRuleColor;
  readonly value: number;
}

export interface LogicGridRule {
  /** Stable, lowercase, and never reused — it is what the tests read. */
  readonly id: string;
  /**
   * The rule's full name: the accessible name of whatever control toggles it,
   * whether that is its own chip or one segment of a folded pair.
   */
  readonly label: string;
  /** Where its control is drawn. Says nothing about where it is stored. */
  readonly group: LogicGridRuleGroup;
  /**
   * Present on the 22 entries that are the same rule at different sizes.
   * Since format version 2 their indices are no longer legal in a config's
   * `rules` list — the rule is stored under `areas` or `runs` with the number
   * beside the colour, which is what this marker spells — and the row draws
   * one value control per family and colour instead of one chip per size.
   */
  readonly sized?: SizedRuleOrigin;
}

/**
 * The board-wide constraints a puzzle can switch on, in a FIXED order. A config
 * stores the INDEX of every active flag rule, so entries may only ever be
 * APPENDED — inserting or reordering one silently rewrites the rule set of
 * every puzzle ever saved. Appending is safe and needs no migration: a saved
 * puzzle simply never mentions the indices it does not use.
 *
 * This list WAS reordered once, before the site went live and while the only
 * saved puzzles were the captured fixtures — every one of which was rewritten in
 * the same change and checked to solve identically afterwards. That is the only
 * circumstance in which it may happen again: once a player has a downloaded
 * config, a reorder silently turns their puzzle into a different one.
 *
 * So the position in THIS array is the file format, and a rule that belongs
 * beside its family still has to be appended. `group` is what puts it there on
 * screen: the two are deliberately separate, and only this one is frozen.
 *
 * Renaming an entry is safe, since nothing is stored by name; only the position
 * matters.
 *
 * A flag rule is a plain on/off switch and carries no parameter. The two
 * families that DO carry a number — regions-have-area-N and no-1xN — left this
 * encoding in format version 2: their 22 entries stay below so no index ever
 * changes meaning, each carrying the `sized` marker the migration rewrites it
 * into, but a current file spells them as `areas`/`runs` entries with the
 * number stored beside the colour. A new SIZE therefore needs no entry at all;
 * a new FLAG rule still appends here.
 */
export const RULES: readonly LogicGridRule[] = [
  // The forbidden arrangements, shortest first, DARK before light in every
  // pair. They all compile into one table in the solver, so keeping them
  // together here means the catalogue reads the way the engine treats them.
  { id: "no-dark-2x2", label: "No dark 2x2", group: "arrangement" },
  { id: "no-light-2x2", label: "No light 2x2", group: "arrangement" },
  {
    id: "no-dark-1x2",
    label: "No dark 1x2",
    group: "arrangement",
    sized: { family: "runs", color: "dark", value: 2 },
  },
  {
    id: "no-light-1x2",
    label: "No light 1x2",
    group: "arrangement",
    sized: { family: "runs", color: "light", value: 2 },
  },
  {
    id: "no-dark-1x3",
    label: "No dark 1x3",
    group: "arrangement",
    sized: { family: "runs", color: "dark", value: 3 },
  },
  {
    id: "no-light-1x3",
    label: "No light 1x3",
    group: "arrangement",
    sized: { family: "runs", color: "light", value: 3 },
  },
  {
    id: "no-dark-1x4",
    label: "No dark 1x4",
    group: "arrangement",
    sized: { family: "runs", color: "dark", value: 4 },
  },
  {
    id: "no-light-1x4",
    label: "No light 1x4",
    group: "arrangement",
    sized: { family: "runs", color: "light", value: 4 },
  },
  {
    id: "no-dark-1x5",
    label: "No dark 1x5",
    group: "arrangement",
    sized: { family: "runs", color: "dark", value: 5 },
  },
  {
    id: "no-light-1x5",
    label: "No light 1x5",
    group: "arrangement",
    sized: { family: "runs", color: "light", value: 5 },
  },
  { id: "no-checkerboard", label: "No checkerboard", group: "arrangement" },
  // Then the ones that talk about whole regions rather than arrangements.
  { id: "connect-dark", label: "Connect all dark cells", group: "region" },
  { id: "connect-light", label: "Connect all light cells", group: "region" },
  { id: "one-symbol-dark", label: "One symbol per dark area", group: "symbol" },
  {
    id: "one-symbol-light",
    label: "One symbol per light area",
    group: "symbol",
  },
  // Last, and on its own, because it is the only entry that changes what the
  // ANSWER is rather than which colourings are legal.
  { id: "underclued", label: "Underclued", group: "answer" },
  // Appended after `underclued` because appending was the only safe edit.
  // Both sizes on for one colour is not a contradiction — it is satisfied
  // exactly when that colour has no cells at all, every one of its zero
  // regions being both sizes at once — which is why `areas` may hold several
  // entries per colour.
  {
    id: "area-two-dark",
    label: "Dark regions have area 2",
    group: "region",
    sized: { family: "areas", color: "dark", value: 2 },
  },
  {
    id: "area-two-light",
    label: "Light regions have area 2",
    group: "region",
    sized: { family: "areas", color: "light", value: 2 },
  },
  {
    id: "area-four-dark",
    label: "Dark regions have area 4",
    group: "region",
    sized: { family: "areas", color: "dark", value: 4 },
  },
  {
    id: "area-four-light",
    label: "Light regions have area 4",
    group: "region",
    sized: { family: "areas", color: "light", value: 4 },
  },
  {
    id: "area-five-dark",
    label: "Dark regions have area 5",
    group: "region",
    sized: { family: "areas", color: "dark", value: 5 },
  },
  {
    id: "area-five-light",
    label: "Light regions have area 5",
    group: "region",
    sized: { family: "areas", color: "light", value: 5 },
  },
  // The first arrangements that name BOTH colours: a line of three alternating
  // colours, in either orientation.
  {
    id: "no-dark-light-dark",
    label: "No dark-light-dark",
    group: "arrangement",
  },
  {
    id: "no-light-dark-light",
    label: "No light-dark-light",
    group: "arrangement",
  },
  // The T-tetromino, in any of its four rotations.
  { id: "no-dark-t", label: "No dark T", group: "arrangement" },
  { id: "no-light-t", label: "No light T", group: "arrangement" },
  // A 2x2 holding exactly three of one colour and one of the other. The id
  // names the majority colour first, so the dark-first pair rule holds.
  {
    id: "no-three-dark-one-light",
    label: "No 3 dark + 1 light",
    group: "arrangement",
  },
  {
    id: "no-three-light-one-dark",
    label: "No 3 light + 1 dark",
    group: "arrangement",
  },
  // No two cells of the colour touching corner to corner — even inside one
  // connected piece, so an L-bend and a filled 2x2 both break it and every
  // region of the colour is a straight bar.
  {
    id: "no-dark-diagonal",
    label: "No dark diagonal",
    group: "arrangement",
  },
  {
    id: "no-light-diagonal",
    label: "No light diagonal",
    group: "arrangement",
  },
  // Region sizes again, appended like four and five.
  {
    id: "area-three-dark",
    label: "Dark regions have area 3",
    group: "region",
    sized: { family: "areas", color: "dark", value: 3 },
  },
  {
    id: "area-three-light",
    label: "Light regions have area 3",
    group: "region",
    sized: { family: "areas", color: "light", value: 3 },
  },
  // The first rule about the CLUES rather than the colouring: every numeric
  // clue — area number, dart, viewpoint — displays a value exactly one off
  // its true count, and never the truth. Drawn in the symbol band because
  // what it changes is what the symbols' numbers mean; the editor widens its
  // value bounds while this is on, which is how a displayed 0 becomes legal.
  {
    id: "off-by-one",
    label: "Numbers are off by one",
    group: "symbol",
  },
  // The bent tromino — a 2x2 with one square left out, any orientation.
  {
    id: "no-dark-elbow",
    label: "No dark elbow",
    group: "arrangement",
  },
  {
    id: "no-light-elbow",
    label: "No light elbow",
    group: "arrangement",
  },
  // The L-tetromino: three in a row with a fourth on one END, in BOTH mirror
  // forms — eight orientations per colour.
  {
    id: "no-dark-l",
    label: "No dark L",
    group: "arrangement",
  },
  {
    id: "no-light-l",
    label: "No light L",
    group: "arrangement",
  },
  // Two squares of the colour exactly two apart in a straight line, whatever
  // sits between them — the other colour, undecided, or even a gap.
  {
    id: "no-dark-any-dark",
    label: "No dark-any-dark",
    group: "arrangement",
  },
  {
    id: "no-light-any-light",
    label: "No light-any-light",
    group: "arrangement",
  },
  // Region sizes again, appended like every pair since the reorder.
  {
    id: "area-six-dark",
    label: "Dark regions have area 6",
    group: "region",
    sized: { family: "areas", color: "dark", value: 6 },
  },
  {
    id: "area-six-light",
    label: "Light regions have area 6",
    group: "region",
    sized: { family: "areas", color: "light", value: 6 },
  },
  {
    id: "area-seven-dark",
    label: "Dark regions have area 7",
    group: "region",
    sized: { family: "areas", color: "dark", value: 7 },
  },
  {
    id: "area-seven-light",
    label: "Light regions have area 7",
    group: "region",
    sized: { family: "areas", color: "light", value: 7 },
  },
  // The T-tetromino again, with its CROSSING — the bar's middle, where the
  // stem attaches — the OTHER colour and the three remaining cells the named
  // one. The id names the crossing colour first, so the DARK T is
  // `no-light-crossed-dark-t` — the pair in `RULE_ROW` sorts that out.
  {
    id: "no-light-crossed-dark-t",
    label: "No light-crossed dark T",
    group: "arrangement",
  },
  {
    id: "no-dark-crossed-light-t",
    label: "No dark-crossed light T",
    group: "arrangement",
  },
  // The T-pentomino: the same bar with a stem of TWO from its middle.
  {
    id: "no-dark-long-t",
    label: "No long dark T",
    group: "arrangement",
  },
  {
    id: "no-light-long-t",
    label: "No long light T",
    group: "arrangement",
  },
  {
    id: "area-twenty-four-dark",
    label: "Dark regions have area 24",
    group: "region",
    sized: { family: "areas", color: "dark", value: 24 },
  },
  {
    id: "area-twenty-four-light",
    label: "Light regions have area 24",
    group: "region",
    sized: { family: "areas", color: "light", value: 24 },
  },
  // Two squares of the colour a chess knight's move apart — two in one
  // direction and one in the other. Positional like the diagonal rules.
  {
    id: "no-dark-knight",
    label: "No dark knight's move",
    group: "arrangement",
  },
  {
    id: "no-light-knight",
    label: "No light knight's move",
    group: "arrangement",
  },
  // The bent tromino again, with its CORNER — the square touching both
  // others — the OTHER colour and both ends the named one.
  {
    id: "no-dark-light-dark-elbow",
    label: "No dark-light-dark elbow",
    group: "arrangement",
  },
  {
    id: "no-light-dark-light-elbow",
    label: "No light-dark-light elbow",
    group: "arrangement",
  },
];

/** How many rules a puzzle can draw from — every known one. */
export const RULE_COUNT = RULES.length;

export function ruleAt(index: number): LogicGridRule | undefined {
  return RULES[index];
}

/**
 * Bounds for the number a sized rule carries, shared by the validator, the
 * editor's value fields and the migration's outputs.
 *
 * The area cap is a FORMAT limit — it keeps the value field four digits wide —
 * not a board one: an area larger than the board is still enforceable, it
 * just means the colour cannot appear at all. Absent the colour the rule
 * holds vacuously, so such a file loads and Solve empties that colour —
 * answering Unsolvable only where a given or clue demands it anyway. The
 * floor of 1 is real; singleton regions are a size the engine enforces.
 *
 * The run cap is an ENGINE limit and moves with `kMaxPatternCells` in
 * a-star/Rules.h: a forbidden run is enforced only by its compiled pattern,
 * and a pattern holds at most eight cells, so a longer run is refused by name
 * rather than accepted and silently not enforced.
 */
export const MIN_AREA_SIZE = 1;
export const MAX_AREA_SIZE = 9999;
export const MIN_RUN_LENGTH = 2;
export const MAX_RUN_LENGTH = 8;

/** A rule with no dark/light sibling, drawn as one full-label chip. */
export interface RuleRowSingle {
  readonly kind: "single";
  readonly id: string;
}

/**
 * A dark/light pair folded into one control: a shared concept label and two
 * INDEPENDENT toggle segments, so both colours can be on at once — exactly
 * the two chips this replaces. For a mixed-colour rule the segment names the
 * pattern's MAJORITY colour, and the full rule label rides on the segment as
 * its accessible name.
 */
export interface RuleRowPair {
  readonly kind: "pair";
  readonly label: string;
  /** The id behind the Dark segment. */
  readonly dark: string;
  /** The id behind the Light segment. */
  readonly light: string;
}

export type SizedControlKey =
  | "run-dark"
  | "run-light"
  | "area-dark"
  | "area-light";

/**
 * One value-field control covering a sized family for one colour: its active
 * values are the config's `areas`/`runs` entries of that colour, one small
 * number field each, plus a button that appends another.
 */
export interface SizedControlSpec {
  readonly key: SizedControlKey;
  readonly family: SizedRuleFamily;
  readonly color: SizedRuleColor;
  /** The control's visible prefix — it reads straight into its values. */
  readonly label: string;
  readonly min: number;
  readonly max: number;
}

export interface RuleRowSized {
  readonly kind: "sized";
  readonly control: SizedControlSpec;
}

export type RuleRowEntry = RuleRowSingle | RuleRowPair | RuleRowSized;

export interface RuleRowBand {
  readonly band: LogicGridRuleGroup;
  readonly heading: string;
  readonly entries: readonly RuleRowEntry[];
}

/**
 * The rule row's layout: bands of folded controls, in drawing order. This is
 * display-only and may be rewritten whenever the row should read differently —
 * which is exactly what `RULES` may not. `catalog.test.ts` pins the coverage
 * invariants instead of the order: every flag rule appears in exactly one
 * control, no sized rule appears at all (the four value controls carry those
 * families), every pair is dark-then-light, and each control sits in the band
 * its rules' `group` names.
 */
export const RULE_ROW: readonly RuleRowBand[] = [
  {
    band: "arrangement",
    heading: "Arrangement",
    entries: [
      {
        kind: "pair",
        label: "No 2x2",
        dark: "no-dark-2x2",
        light: "no-light-2x2",
      },
      {
        kind: "sized",
        control: {
          key: "run-dark",
          family: "runs",
          color: "dark",
          label: "No dark 1x",
          min: MIN_RUN_LENGTH,
          max: MAX_RUN_LENGTH,
        },
      },
      {
        kind: "sized",
        control: {
          key: "run-light",
          family: "runs",
          color: "light",
          label: "No light 1x",
          min: MIN_RUN_LENGTH,
          max: MAX_RUN_LENGTH,
        },
      },
      { kind: "single", id: "no-checkerboard" },
      {
        kind: "pair",
        label: "No alternating triple",
        dark: "no-dark-light-dark",
        light: "no-light-dark-light",
      },
      {
        kind: "pair",
        label: "No elbow",
        dark: "no-dark-elbow",
        light: "no-light-elbow",
      },
      { kind: "pair", label: "No L", dark: "no-dark-l", light: "no-light-l" },
      { kind: "pair", label: "No T", dark: "no-dark-t", light: "no-light-t" },
      {
        kind: "pair",
        label: "No long T",
        dark: "no-dark-long-t",
        light: "no-light-long-t",
      },
      {
        kind: "pair",
        label: "No mixed elbow",
        dark: "no-dark-light-dark-elbow",
        light: "no-light-dark-light-elbow",
      },
      {
        // The id names the crossing colour, so the DARK T is the
        // `no-light-crossed-…` entry — the one place id order and segment
        // order disagree.
        kind: "pair",
        label: "No crossed T",
        dark: "no-light-crossed-dark-t",
        light: "no-dark-crossed-light-t",
      },
      {
        kind: "pair",
        label: "No 3 + 1",
        dark: "no-three-dark-one-light",
        light: "no-three-light-one-dark",
      },
      {
        kind: "pair",
        label: "No diagonal",
        dark: "no-dark-diagonal",
        light: "no-light-diagonal",
      },
      {
        kind: "pair",
        label: "No knight's move",
        dark: "no-dark-knight",
        light: "no-light-knight",
      },
      {
        kind: "pair",
        label: "No two apart",
        dark: "no-dark-any-dark",
        light: "no-light-any-light",
      },
    ],
  },
  {
    band: "region",
    heading: "Region",
    entries: [
      {
        kind: "pair",
        label: "Connect all cells",
        dark: "connect-dark",
        light: "connect-light",
      },
      {
        kind: "sized",
        control: {
          key: "area-dark",
          family: "areas",
          color: "dark",
          label: "Dark regions have area",
          min: MIN_AREA_SIZE,
          max: MAX_AREA_SIZE,
        },
      },
      {
        kind: "sized",
        control: {
          key: "area-light",
          family: "areas",
          color: "light",
          label: "Light regions have area",
          min: MIN_AREA_SIZE,
          max: MAX_AREA_SIZE,
        },
      },
    ],
  },
  {
    band: "symbol",
    heading: "Symbol",
    entries: [
      {
        kind: "pair",
        label: "One symbol per area",
        dark: "one-symbol-dark",
        light: "one-symbol-light",
      },
      { kind: "single", id: "off-by-one" },
    ],
  },
  {
    band: "answer",
    heading: "Answer",
    entries: [{ kind: "single", id: "underclued" }],
  },
];
