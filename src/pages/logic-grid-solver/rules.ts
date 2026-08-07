/**
 * Which band of the chip row a rule is drawn in. This is the ONLY thing that
 * decides display order, and it is free to change — see `RULE_DISPLAY_ORDER`.
 */
export type LogicGridRuleGroup =
  | "arrangement"
  | "region"
  | "symbol"
  | "answer";

export interface LogicGridRule {
  /** Stable, lowercase, and never reused — it is what the tests read. */
  readonly id: string;
  /** The chip's text, and the accessible name that goes with it. */
  readonly label: string;
  /** Where it is drawn. Says nothing about where it is stored. */
  readonly group: LogicGridRuleGroup;
  /**
   * WHERE in its band the chip is drawn, when the frozen storage position is
   * not where it belongs on screen. Defaults to the storage index, so a band
   * normally reads in catalogue order; a fractional value slots a
   * late-appended rule between older neighbours — display-only, exactly like
   * `group`, and free to change the same way.
   */
  readonly order?: number;
}

/**
 * The board-wide constraints a puzzle can switch on, in a FIXED order. A config
 * stores the INDEX of every active rule, so entries may only ever be APPENDED —
 * inserting or reordering one silently rewrites the rule set of every puzzle
 * ever saved. Appending is safe and needs no migration: a saved puzzle simply
 * never mentions the indices it does not use.
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
 * A rule is a plain on/off flag — none of them carries a parameter. What each
 * one *means* is the solver's business and lives nowhere in this page. The area
 * rules name their size in their id for the same reason: "area 3" would be
 * another entry rather than a number stored beside this one.
 */
export const RULES: readonly LogicGridRule[] = [
  // The forbidden arrangements, shortest first, DARK before light in every
  // pair. They all compile into one table in the solver, so keeping them
  // together here means the catalogue reads the way the engine treats them.
  { id: "no-dark-2x2", label: "No dark 2x2", group: "arrangement" },
  { id: "no-light-2x2", label: "No light 2x2", group: "arrangement" },
  { id: "no-dark-1x2", label: "No dark 1x2", group: "arrangement" },
  { id: "no-light-1x2", label: "No light 1x2", group: "arrangement" },
  { id: "no-dark-1x3", label: "No dark 1x3", group: "arrangement" },
  { id: "no-light-1x3", label: "No light 1x3", group: "arrangement" },
  { id: "no-dark-1x4", label: "No dark 1x4", group: "arrangement" },
  { id: "no-light-1x4", label: "No light 1x4", group: "arrangement" },
  { id: "no-dark-1x5", label: "No dark 1x5", group: "arrangement" },
  { id: "no-light-1x5", label: "No light 1x5", group: "arrangement" },
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
  // Appended after `underclued` because appending is the only safe edit, and
  // drawn beside the connect rules because that is where they belong. Both
  // statements are true at once, which is the whole point of `group`.
  { id: "area-two-dark", label: "Dark regions have area 2", group: "region" },
  { id: "area-two-light", label: "Light regions have area 2", group: "region" },
  // The same rule at a different size, which is why they say the size in their
  // id rather than storing it beside a single "regions have area N" entry.
  // Both sizes on for one colour is not a contradiction — it is satisfied
  // exactly when that colour has no cells at all, every one of its zero regions
  // being both sizes at once.
  { id: "area-four-dark", label: "Dark regions have area 4", group: "region" },
  {
    id: "area-four-light",
    label: "Light regions have area 4",
    group: "region",
  },
  { id: "area-five-dark", label: "Dark regions have area 5", group: "region" },
  {
    id: "area-five-light",
    label: "Light regions have area 5",
    group: "region",
  },
  // The first arrangements that name BOTH colours: a line of three alternating
  // colours, in either orientation. Appended here like everything since the
  // reorder, and drawn in the arrangement band where they belong.
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
  // Region sizes again, appended like four and five — and DRAWN between the
  // area-two and area-four pairs, so the band reads by size. `order` slots
  // them there; sharing one value keeps dark before light by stability.
  {
    id: "area-three-dark",
    label: "Dark regions have area 3",
    group: "region",
    order: 17.5,
  },
  {
    id: "area-three-light",
    label: "Light regions have area 3",
    group: "region",
    order: 17.5,
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
  // Drawn between the triples and the T pair so the monochrome shapes read
  // elbow, L, T, long T. From here on a PAIR shares one `order` value:
  // stability keeps dark before light, the area-three precedent above.
  {
    id: "no-dark-elbow",
    label: "No dark elbow",
    group: "arrangement",
    order: 23.1,
  },
  {
    id: "no-light-elbow",
    label: "No light elbow",
    group: "arrangement",
    order: 23.1,
  },
  // The L-tetromino: three in a row with a fourth on one END, in BOTH mirror
  // forms — eight orientations per colour.
  {
    id: "no-dark-l",
    label: "No dark L",
    group: "arrangement",
    order: 23.2,
  },
  {
    id: "no-light-l",
    label: "No light L",
    group: "arrangement",
    order: 23.2,
  },
  // Two squares of the colour exactly two apart in a straight line, whatever
  // sits between them — the other colour, undecided, or even a gap. Drawn at
  // the end of the arrangement band beside the diagonal and knight rules,
  // the other relative-position bans.
  {
    id: "no-dark-any-dark",
    label: "No dark-any-dark",
    group: "arrangement",
    order: 29.2,
  },
  {
    id: "no-light-any-light",
    label: "No light-any-light",
    group: "arrangement",
    order: 29.2,
  },
  // Region sizes again, appended like every pair since the reorder. No
  // `order` needed: six, seven and twenty-four land after area-five in the
  // region band by index, which is already size order.
  { id: "area-six-dark", label: "Dark regions have area 6", group: "region" },
  {
    id: "area-six-light",
    label: "Light regions have area 6",
    group: "region",
  },
  {
    id: "area-seven-dark",
    label: "Dark regions have area 7",
    group: "region",
  },
  {
    id: "area-seven-light",
    label: "Light regions have area 7",
    group: "region",
  },
  // The T-tetromino again, with its CROSSING — the bar's middle, where the
  // stem attaches — the OTHER colour and the three remaining cells the named
  // one. Drawn after the mixed elbows, closing the mixed stretch before the
  // 3+1 pair.
  {
    id: "no-light-crossed-dark-t",
    label: "No light-crossed dark T",
    group: "arrangement",
    order: 25.3,
  },
  {
    id: "no-dark-crossed-light-t",
    label: "No dark-crossed light T",
    group: "arrangement",
    order: 25.3,
  },
  // The T-pentomino: the same bar with a stem of TWO from its middle. Drawn
  // right after the T pair it extends.
  {
    id: "no-dark-long-t",
    label: "No long dark T",
    group: "arrangement",
    order: 25.1,
  },
  {
    id: "no-light-long-t",
    label: "No long light T",
    group: "arrangement",
    order: 25.1,
  },
  {
    id: "area-twenty-four-dark",
    label: "Dark regions have area 24",
    group: "region",
  },
  {
    id: "area-twenty-four-light",
    label: "Light regions have area 24",
    group: "region",
  },
  // Two squares of the colour a chess knight's move apart — two in one
  // direction and one in the other. Positional like the diagonal rules, and
  // drawn beside them.
  {
    id: "no-dark-knight",
    label: "No dark knight's move",
    group: "arrangement",
    order: 29.1,
  },
  {
    id: "no-light-knight",
    label: "No light knight's move",
    group: "arrangement",
    order: 29.1,
  },
  // The bent tromino again, with its CORNER — the square touching both
  // others — the OTHER colour and both ends the named one. Drawn after the
  // long T, opening the mixed stretch: mixed elbow, mixed T, 3+1.
  {
    id: "no-dark-light-dark-elbow",
    label: "No dark-light-dark elbow",
    group: "arrangement",
    order: 25.2,
  },
  {
    id: "no-light-dark-light-elbow",
    label: "No light-dark-light elbow",
    group: "arrangement",
    order: 25.2,
  },
];

/** How many rules a puzzle can draw from — every known one. */
export const RULE_COUNT = RULES.length;

/** The bands, in the order the row draws them. */
const GROUP_ORDER: readonly LogicGridRuleGroup[] = [
  "arrangement",
  "region",
  "symbol",
  "answer",
];

/**
 * Storage indices, in the order the chips are drawn.
 *
 * This exists so the catalogue can stay append-only while the row still reads
 * in family order — `area-two-dark` is stored at 16 and drawn beside
 * `connect-light` at 12. Within a band the chips sort by `order ?? index`,
 * stably: a rule appended to an existing band lands at the end of it without
 * anything else being touched, unless its entry says where else it belongs —
 * which is how the area-three pair draws between area-two and area-four while
 * being stored at 30 and 31.
 *
 * Nothing is stored in this order and nothing may be: it is the row's layout and
 * may be changed freely, which is exactly what `RULES` may not.
 */
export const RULE_DISPLAY_ORDER: readonly number[] = GROUP_ORDER.flatMap(
  group =>
    RULES.flatMap((rule, index) => (rule.group === group ? [index] : [])).sort(
      (a, b) => (RULES[a]!.order ?? a) - (RULES[b]!.order ?? b),
    ),
);

export function ruleAt(index: number): LogicGridRule | undefined {
  return RULES[index];
}
