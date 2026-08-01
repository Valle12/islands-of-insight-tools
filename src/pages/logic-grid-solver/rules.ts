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
 * Renaming an entry is safe too, since nothing is stored by name; only the
 * position matters.
 *
 * A rule is a plain on/off flag — none of them carries a parameter. What each
 * one *means* is the solver's business and lives nowhere in this page, which is
 * a stub for now.
 */
export const RULES: readonly LogicGridRule[] = [
  { id: "no-dark-2x2", label: "No dark 2x2" },
  { id: "no-light-2x2", label: "No light 2x2" },
  { id: "connect-dark", label: "Connect all dark cells" },
  { id: "connect-light", label: "Connect all light cells" },
  { id: "no-light-1x2", label: "No light 1x2" },
  { id: "no-dark-1x2", label: "No dark 1x2" },
  { id: "no-light-1x3", label: "No light 1x3" },
  { id: "no-dark-1x3", label: "No dark 1x3" },
  { id: "no-light-1x4", label: "No light 1x4" },
  { id: "no-dark-1x4", label: "No dark 1x4" },
  { id: "underclued", label: "Underclued" },
  { id: "no-checkerboard", label: "No checkerboard" },
];

/** How many rules a puzzle can draw from — every known one. */
export const RULE_COUNT = RULES.length;

export function ruleAt(index: number): LogicGridRule | undefined {
  return RULES[index];
}
