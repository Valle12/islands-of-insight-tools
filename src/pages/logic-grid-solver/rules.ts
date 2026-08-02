export interface LogicGridRule {
  /** Stable, lowercase, and never reused — it is what the tests read. */
  readonly id: string;
  /** The chip's text, and the accessible name that goes with it. */
  readonly label: string;
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
 * Renaming an entry is safe, since nothing is stored by name; only the position
 * matters.
 *
 * A rule is a plain on/off flag — none of them carries a parameter. What each
 * one *means* is the solver's business and lives nowhere in this page.
 */
export const RULES: readonly LogicGridRule[] = [
  // The forbidden arrangements, shortest first, DARK before light in every
  // pair. They all compile into one table in the solver, so keeping them
  // together here means the catalogue reads the way the engine treats them.
  { id: "no-dark-2x2", label: "No dark 2x2" },
  { id: "no-light-2x2", label: "No light 2x2" },
  { id: "no-dark-1x2", label: "No dark 1x2" },
  { id: "no-light-1x2", label: "No light 1x2" },
  { id: "no-dark-1x3", label: "No dark 1x3" },
  { id: "no-light-1x3", label: "No light 1x3" },
  { id: "no-dark-1x4", label: "No dark 1x4" },
  { id: "no-light-1x4", label: "No light 1x4" },
  { id: "no-dark-1x5", label: "No dark 1x5" },
  { id: "no-light-1x5", label: "No light 1x5" },
  { id: "no-checkerboard", label: "No checkerboard" },
  // Then the two that talk about whole regions rather than arrangements.
  { id: "connect-dark", label: "Connect all dark cells" },
  { id: "connect-light", label: "Connect all light cells" },
  { id: "one-symbol-dark", label: "One symbol per dark area" },
  { id: "one-symbol-light", label: "One symbol per light area" },
  // Last, and on its own, because it is the only entry that changes what the
  // ANSWER is rather than which colourings are legal.
  { id: "underclued", label: "Underclued" },
];

/** How many rules a puzzle can draw from — every known one. */
export const RULE_COUNT = RULES.length;

export function ruleAt(index: number): LogicGridRule | undefined {
  return RULES[index];
}
