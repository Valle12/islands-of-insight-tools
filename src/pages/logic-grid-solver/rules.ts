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
