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

/** The color a sized rule constrains, spelled the way the config stores it. */
export type SizedRuleColor = "dark" | "light";

/**
 * What a retired sized catalog entry means since format version 2: the
 * `areas`/`runs` entry it turned into. This mapping is LISTED here rather than
 * parsed out of ids or labels, and it is what the migration, the validator's
 * by-name rejection and the test board builders all read.
 */
export interface SizedRuleOrigin {
  readonly family: SizedRuleFamily;
  readonly color: SizedRuleColor;
  readonly value: number;
}

/**
 * The box a retired arrangement's shape is drawn in, and the squares it names
 * — the picture written one string per row, '.' for a square the pattern does
 * not name and 'D'/'L' for the two colors.
 *
 * Spelled as a picture rather than as numbers so the shape can be READ here,
 * and mirrored exactly by `kLegacyPatterns` in `a-star/Rules.h`. One image
 * each: a drawn pattern forbids its dihedral images too, and the closure of
 * each shape below is precisely the family its rule used to compile to.
 */
export interface DrawnRuleOrigin {
  readonly squares: readonly string[];
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
   * beside the color, which is what this marker spells — and the row draws
   * one value control per family and color instead of one chip per size.
   */
  readonly sized?: SizedRuleOrigin;
  /**
   * Present on the 10 entries retired in format version 3: the five controls
   * the captured corpus names on exactly one board each. Their indices are no
   * longer legal in `rules` either — the shape is stored under `patterns`,
   * which is what this marker spells — and they have no control in the row at
   * all. To use one now you draw it, and it keeps no name when you do.
   */
  readonly drawn?: DrawnRuleOrigin;
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
 * A flag rule is a plain on/off switch and carries no parameter. TWO batches
 * have left this encoding, and both keep their entries below so no index ever
 * changes meaning:
 *
 * - the 22 that carry a NUMBER — regions-have-area-N and no-1xN — went to
 *   `areas`/`runs` in format version 2, each marked `sized`. A new SIZE
 *   therefore needs no entry at all;
 * - the 10 rarest ARRANGEMENTS went to the drawn `patterns` key in version 3,
 *   each marked `drawn` with the shape it became. Between them, the five
 *   controls they made up are named by exactly one captured board each, which
 *   is what a per-rule append cycle was buying. A new forbidden shape now
 *   needs no entry either — it is drawn.
 *
 * A new FLAG rule still appends here. What that is FOR after version 3 is a
 * rule the pattern table cannot state: a region rule, a clue rule, something
 * about the answer.
 */
export const RULES: readonly LogicGridRule[] = [
  // The forbidden arrangements, shortest first, DARK before light in every
  // pair. They all compile into one table in the solver, so keeping them
  // together here means the catalog reads the way the engine treats them.
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
  // ANSWER is rather than which colorings are legal.
  { id: "underclued", label: "Underclued", group: "answer" },
  // Appended after `underclued` because appending was the only safe edit.
  // Both sizes on for one color is not a contradiction — it is satisfied
  // exactly when that color has no cells at all, every one of its zero
  // regions being both sizes at once — which is why `areas` may hold several
  // entries per color.
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
  // The first arrangements that name BOTH colors: a line of three alternating
  // colors, in either orientation.
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
  // A 2x2 holding exactly three of one color and one of the other. The id
  // names the majority color first, so the dark-first pair rule holds.
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
  // No two cells of the color touching corner to corner — even inside one
  // connected piece, so an L-bend and a filled 2x2 both break it and every
  // region of the color is a straight bar.
  {
    id: "no-dark-diagonal",
    label: "No dark diagonal",
    group: "arrangement",
    drawn: { squares: ["D.", ".D"] },
  },
  {
    id: "no-light-diagonal",
    label: "No light diagonal",
    group: "arrangement",
    drawn: { squares: ["L.", ".L"] },
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
  // The first rule about the CLUES rather than the coloring: every numeric
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
  // forms — eight orientations per color.
  {
    id: "no-dark-l",
    label: "No dark L",
    group: "arrangement",
    drawn: { squares: ["D.", "D.", "DD"] },
  },
  {
    id: "no-light-l",
    label: "No light L",
    group: "arrangement",
    drawn: { squares: ["L.", "L.", "LL"] },
  },
  // Two squares of the color exactly two apart in a straight line, whatever
  // sits between them — the other color, undecided, or even a gap.
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
  // stem attaches — the OTHER color and the three remaining cells the named
  // one. The id names the crossing color first, so the DARK T is
  // `no-light-crossed-dark-t` — the pair in `RULE_ROW` sorts that out.
  {
    id: "no-light-crossed-dark-t",
    label: "No light-crossed dark T",
    group: "arrangement",
    drawn: { squares: ["DLD", ".D."] },
  },
  {
    id: "no-dark-crossed-light-t",
    label: "No dark-crossed light T",
    group: "arrangement",
    drawn: { squares: ["LDL", ".L."] },
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
  // Two squares of the color a chess knight's move apart — two in one
  // direction and one in the other. Positional like the diagonal rules.
  {
    id: "no-dark-knight",
    label: "No dark knight's move",
    group: "arrangement",
    drawn: { squares: ["D.", "..", ".D"] },
  },
  {
    id: "no-light-knight",
    label: "No light knight's move",
    group: "arrangement",
    drawn: { squares: ["L.", "..", ".L"] },
  },
  // The bent tromino again, with its CORNER — the square touching both
  // others — the OTHER color and both ends the named one.
  {
    id: "no-dark-light-dark-elbow",
    label: "No dark-light-dark elbow",
    group: "arrangement",
    drawn: { squares: ["LD", "D."] },
  },
  {
    id: "no-light-dark-light-elbow",
    label: "No light-dark-light elbow",
    group: "arrangement",
    drawn: { squares: ["DL", "L."] },
  },
  // Two rules about the SHAPES of whole regions, which is a thing no
  // arrangement rule can say: they relate regions arbitrarily far apart, and
  // they read each region's MAXIMALITY, so neither compiles into the pattern
  // table the way every entry above does.
  //
  // "Same shape" means CONGRUENT — the eight dihedral images, rotations AND
  // reflections — so an S and a Z are one shape and an L and a J are one
  // shape. Congruence fixes the cardinality too, which is why "shape and
  // size" is one predicate with no separate size test anywhere.
  {
    id: "distinct-shapes-dark",
    label: "No two dark regions have the same shape",
    group: "region",
  },
  {
    id: "distinct-shapes-light",
    label: "No two light regions have the same shape",
    group: "region",
  },
  // The opposite of the pair above, and both of one color may be on at once:
  // together they say that color has AT MOST ONE region, which is an ordinary
  // thing for a board to be — `connect-dark` says it on its own — and a puzzle
  // may well use the pair to tell the player exactly that. So they are two
  // independent flags, not two sides of a switch.
  {
    id: "same-shape-dark",
    label: "All dark regions have the same shape",
    group: "region",
  },
  {
    id: "same-shape-light",
    label: "All light regions have the same shape",
    group: "region",
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
 * just means the color cannot appear at all. Absent the color the rule
 * holds vacuously, so such a file loads and Solve empties that color —
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
 * INDEPENDENT toggle segments, so both colors can be on at once — exactly
 * the two chips this replaces. For a mixed-color rule the segment names the
 * pattern's MAJORITY color, and the full rule label rides on the segment as
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
 * One value-field control covering a sized family for one color: its active
 * values are the config's `areas`/`runs` entries of that color, one small
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
  /**
   * Whether a SECOND value for this color would contradict the first, and so
   * whether the control drops its `+` once it holds one.
   *
   * The two families answer differently. Two run rules are two separate bans —
   * "no dark 1x2" and "no dark 1x4" are both enforceable and merely redundant.
   * Two area rules are not: "every dark region has area 2" and "…area 3" hold
   * together only where dark is ABSENT from the board, which is not a puzzle
   * anyone means. `SizedListSpec.perColor` in `config.ts` is the same rule on
   * the file's side.
   */
  readonly onePerColor: boolean;
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
 * control, no sized and no drawn rule appears at all (the four value controls
 * carry the sized families, and a drawn shape has no control), every pair is
 * dark-then-light, and each control sits in the band its rules' `group` names.
 *
 * The patterns the player draws are NOT here and never will be: they are data,
 * not catalog, so their chips are built from the board rather than from
 * this. `ruleRowMarkup` closes the ARRANGEMENT band with them — a drawn shape
 * says exactly what that band's entries say — but nothing about them is
 * listed here.
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
          onePerColor: false,
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
          onePerColor: false,
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
      { kind: "pair", label: "No T", dark: "no-dark-t", light: "no-light-t" },
      {
        kind: "pair",
        label: "No long T",
        dark: "no-dark-long-t",
        light: "no-light-long-t",
      },
      {
        kind: "pair",
        label: "No 3 + 1",
        dark: "no-three-dark-one-light",
        light: "no-three-light-one-dark",
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
          onePerColor: true,
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
          onePerColor: true,
        },
      },
      {
        kind: "pair",
        label: "No two regions alike",
        dark: "distinct-shapes-dark",
        light: "distinct-shapes-light",
      },
      {
        kind: "pair",
        label: "All regions alike",
        dark: "same-shape-dark",
        light: "same-shape-light",
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
