// The markup of the editor's two tool rows, and the catalogue lookups they
// need.
//
// Split out of `logicGridSolver.ts` because none of it is about the editor:
// every function here is PURE — catalogue plus board size in, a string out —
// while the class around it is all DOM handles and selection state. Two rows'
// worth of string building was a third of that file, and reading it meant
// scrolling past markup to find the behaviour.
//
// What is deliberately NOT here: anything that creates a live element or wires
// a listener. The sized controls' slot fields are built, focused and dropped
// while the page runs, so they went to `sizedRuleControls.ts` along with the
// raw text each one holds — the record and the elements have one owner, and it
// is not this file. The label, the divider and the `+` are still written here,
// because they are part of the row and never change.
//
// The row is a DISPLAY catalogue the config format never sees. Only
// `ruleRowMarkup` reads `RULE_ROW`; everything else in the page addresses chips
// by id, so a test that indexes chips by DOM position is what this breaks.

import type { LogicGridTool } from "../../util/types";
import {
  RULE_ROW,
  RULES,
  type RuleRowEntry,
  type RuleRowPair,
  type SizedControlKey,
  type SizedControlSpec,
} from "./rules";
import {
  AXES,
  AXIS_ICON,
  DIRECTION_ICON,
  DIRECTIONS,
  SYMBOL_KINDS,
  symbolKindAt,
  symbolValueMax,
  symbolValueMin,
  type LogicGridSize,
  type LogicGridSymbolKind,
} from "./symbols";

/**
 * A rule's position in the append-only catalogue, by its stable id.
 *
 * Resolved through a Map rather than `findIndex` per call: the rule row builds
 * every chip in the catalogue at once, and the row is rebuilt on every board
 * replacement.
 */
const RULE_INDEX_BY_ID = new Map(RULES.map((rule, index) => [rule.id, index]));

export function ruleIndexOf(id: string): number {
  const index = RULE_INDEX_BY_ID.get(id);
  if (index === undefined) {
    throw new Error(`Unknown rule id: ${id}`);
  }
  return index;
}

/** Every sized-rule control the row carries, flattened out of the bands. */
export const SIZED_CONTROLS: readonly SizedControlSpec[] = RULE_ROW.flatMap(
  band =>
    band.entries.flatMap(entry =>
      entry.kind === "sized" ? [entry.control] : [],
    ),
);

export function sizedControlOf(key: SizedControlKey): SizedControlSpec {
  const spec = SIZED_CONTROLS.find(control => control.key === key);
  if (!spec) {
    throw new Error(`Unknown sized rule control: ${key}`);
  }
  return spec;
}

/** The name of the armed tool and of what a right-click does with it. */
export function toolLabels(
  tool: LogicGridTool,
  selectedSymbol: number,
): [string, string] {
  switch (tool) {
    case "light":
      return ["Light", "Dark"];
    case "unplayable":
      return ["Unplayable", "Erase"];
    case "erase":
      return ["Eraser", "Erase"];
    case "symbol":
      return [
        symbolKindAt(selectedSymbol)?.label ?? "Symbol",
        "Remove symbol",
      ];
    case "merge":
      return ["Merge cells", "Split cells"];
    default:
      return ["Dark", "Light"];
  }
}

/**
 * The four arrows a directed kind is aimed with, as one segmented end to its
 * control.
 *
 * Inline rather than behind a menu: there are only four, one click has to be
 * enough to change aim, and which way the clue points is worth seeing without
 * opening anything. They deliberately do NOT carry `.symbol-chip` — that class
 * means "the clue kinds", and the tests count it.
 */
function directionToggles(kind: LogicGridSymbolKind, index: number): string {
  // Each toggle carries `data-direction` on itself, which is the same hook the
  // stylesheet turns a tile's arrow with — so one glyph faces four ways here
  // exactly as it does on the board.
  const buttons = DIRECTIONS.map(
    direction => `
        <button class="direction-toggle" type="button"
          data-symbol-index="${index}" data-direction="${direction.id}"
          title="${direction.label}"
          aria-label="${kind.label} pointing ${direction.label.toLowerCase()}"
          aria-pressed="false"
        ><md-icon class="cell-arrow">${DIRECTION_ICON}</md-icon></button>
      `,
  ).join("");
  return `
      <span class="symbol-divider" aria-hidden="true"></span>
      <div class="symbol-directions" role="group"
        aria-label="${kind.label} direction"
      >${buttons}</div>
    `;
}

/**
 * The four axes an axis-aimed kind is laid along — the lotus's counterpart to
 * `directionToggles`, one glyph turned four ways by `data-axis` exactly as the
 * tile turns it. Same class as the compass arrows on purpose: the styling and
 * the "not a `.symbol-chip`" rule are about being a segmented picker, not about
 * what the segments mean.
 */
function axisToggles(kind: LogicGridSymbolKind, index: number): string {
  const buttons = AXES.map(
    axis => `
        <button class="direction-toggle" type="button"
          data-symbol-index="${index}" data-axis="${axis.id}"
          title="${axis.label}"
          aria-label="${kind.label} along the ${axis.label.toLowerCase()} axis"
          aria-pressed="false"
        ><md-icon class="cell-axis">${AXIS_ICON}</md-icon></button>
      `,
  ).join("");
  return `
      <span class="symbol-divider" aria-hidden="true"></span>
      <div class="symbol-directions" role="group"
        aria-label="${kind.label} axis"
      >${buttons}</div>
    `;
}

/** The picker a kind's aims call for, or nothing for an unaimed kind. */
function aimToggles(kind: LogicGridSymbolKind, index: number): string {
  if (kind.aims === "compass") return directionToggles(kind, index);
  return kind.aims === "axis" ? axisToggles(kind, index) : "";
}

/**
 * The value field of a kind that carries one, with its leading divider. A
 * valueless kind renders nothing here: its control is the chip and the axis
 * toggles with no field between.
 */
function valueField(
  kind: LogicGridSymbolKind,
  index: number,
  size: LogicGridSize,
): string {
  if (kind.valueKind === "none") return "";
  const numeric = kind.valueKind === "number";
  const max = symbolValueMax(kind, size);
  const limits = numeric
    ? `type="number" min="${symbolValueMin(kind, size)}" max="${max}"`
    : 'type="text" maxlength="1"';
  // The field is sized to the longest value its own kind could hold, rather
  // than every kind paying for the widest: an area on a 32x32 board runs to
  // four digits, a letter is one character, and a dart can never outgrow the
  // board's longest line. Without that the four arrows below made the dart's
  // control much wider than it had any need to be.
  const chars = numeric ? String(max).length : 1;
  return `
        <span class="symbol-divider" aria-hidden="true"></span>
        <input class="symbol-value" data-symbol-index="${index}" ${limits}
          style="--value-chars: ${chars}" aria-label="${kind.label} value" />
    `;
}

/**
 * One clue kind as a split control: the chip that selects it, then — each with
 * its own hairline divider — the value it will stamp and the aim it will stamp,
 * for the kinds that carry one.
 *
 * Everything belongs beside its own chip rather than in one shared field below
 * the row — a single field has to keep saying which clue it is for, and every
 * kind added makes that worse.
 */
function symbolTool(
  kind: LogicGridSymbolKind,
  index: number,
  size: LogicGridSize,
): string {
  return `
      <div class="symbol-tool" data-symbol="${kind.id}">
        <button class="tool-button symbol-chip" type="button"
          data-symbol-index="${index}" data-symbol="${kind.id}"
          title="${kind.label}" aria-label="${kind.label}"
        ><span class="symbol-sample"></span></button>
        ${valueField(kind, index, size)}
        ${aimToggles(kind, index)}
      </div>
    `;
}

/**
 * The whole clue row.
 *
 * Built from the list rather than written into the HTML: `SYMBOL_KINDS` is
 * append-only and a new kind must cost no markup edit. The caller runs this
 * only when the board is replaced, because it destroys the value fields —
 * everything else goes through the editor's `refreshSymbolRow`.
 */
export function symbolRowMarkup(size: LogicGridSize): string {
  return SYMBOL_KINDS.map((kind, index) =>
    symbolTool(kind, index, size),
  ).join("");
}

/** A rule with no partner keeps the plain full-label chip. */
function singleRuleChip(id: string): string {
  const index = ruleIndexOf(id);
  return `
      <button class="tool-button rule-chip" type="button"
        data-rule-index="${index}" data-rule="${id}"
      >${RULES[index]!.label}</button>
    `;
}

/**
 * One segment of a folded pair: the same button a chip always was — same
 * classes, same data attributes, `aria-pressed` — wearing the colour as a
 * SWATCH, the paint tools' own visual, and the full rule name as its accessible
 * one.
 */
function pairSegment(id: string, color: "dark" | "light"): string {
  const index = ruleIndexOf(id);
  const label = RULES[index]!.label;
  return `
      <button class="tool-button rule-chip" type="button"
        data-rule-index="${index}" data-rule="${id}"
        title="${label}" aria-label="${label}"
      ><span class="swatch" data-swatch="${color}"></span></button>
    `;
}

/**
 * A dark/light pair as one control: a shared label and two INDEPENDENT
 * segments, so both colours can be on at once — exactly the two chips it
 * replaces. The dark segment comes first, whatever the ids spell.
 */
function rulePair(pair: RuleRowPair): string {
  return `
      <div class="rule-pair" role="group" aria-label="${pair.label}">
        <span class="rule-pair-label">${pair.label}</span>
        <span class="symbol-divider" aria-hidden="true"></span>
        ${pairSegment(pair.dark, "dark")}
        ${pairSegment(pair.light, "light")}
      </div>
    `;
}

/**
 * A sized control's shell: label and add button. The value fields between them
 * are appended by the editor's `fillSizedSlots`/`addSizedSlot`, which have the
 * one spelling of what a slot field is.
 */
function sizedControlShell(spec: SizedControlSpec): string {
  return `
      <div class="rule-sized" role="group" aria-label="${spec.label}"
        data-sized-control="${spec.key}">
        <span class="rule-sized-label">${spec.label}</span>
        <span class="symbol-divider" aria-hidden="true"></span>
        <button class="rule-size-add" type="button"
          data-sized-control="${spec.key}"
          title="Add a value" aria-label="${spec.label}: add a value"
        >+</button>
      </div>
    `;
}

function ruleControl(entry: RuleRowEntry): string {
  if (entry.kind === "single") return singleRuleChip(entry.id);
  if (entry.kind === "pair") return rulePair(entry);
  return sizedControlShell(entry.control);
}

/**
 * The whole rule row: headed bands, each holding its chips, folded pairs and
 * sized controls. The caller fills the sized controls' slots afterwards.
 */
export function ruleRowMarkup(): string {
  return RULE_ROW.map(
    band => `
      <section class="rule-band" data-band="${band.band}">
        <h3 class="rule-band-heading">${band.heading}</h3>
        <div class="rule-band-chips tool-row">${band.entries
          .map(entry => ruleControl(entry))
          .join("")}</div>
      </section>
    `,
  ).join("");
}
