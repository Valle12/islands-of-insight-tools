import blocker from "./../../../images/blocker.png";
import blueBlock from "./../../../images/blue-block.png";
import cyanBlock from "./../../../images/cyan-block.png";
import nudeBlock from "./../../../images/nude-block.png";
import ocherBlock from "./../../../images/ocher-block.png";
import pinkBlock from "./../../../images/pink-block.png";
import purpleBlock from "./../../../images/purple-block.png";
import purple2Block from "./../../../images/purple2-block.png";
import tealBlock from "./../../../images/teal-block.png";

export interface MatchThreeSymbol {
  /** Stable, lowercase, and never reused — it is what the tests read. */
  readonly id: string;
  /** The chip shows the tile alone, so this only names it for screen readers. */
  readonly label: string;
  /** A data URL: `pngDataUrl` in `src/util/plugins.ts` inlines every PNG. */
  readonly image: string;
}

/**
 * The blocks the game paints its boards with, in a FIXED order. A cell stores
 * an index into this list, so entries may only ever be APPENDED — inserting or
 * reordering one silently repaints every board ever saved. Appending is safe
 * and needs no migration: a board simply never mentions the indices it does
 * not use.
 *
 * Renaming an entry is safe too, since nothing is stored by name; only the
 * position matters. Index 2 was called `pink` before the tile now at index 5
 * arrived.
 */
export const SYMBOLS: readonly MatchThreeSymbol[] = [
  { id: "blue", label: "Blue", image: blueBlock },
  { id: "cyan", label: "Cyan", image: cyanBlock },
  { id: "purple", label: "Purple", image: purpleBlock },
  { id: "nude", label: "Nude", image: nudeBlock },
  { id: "ocher", label: "Ocher", image: ocherBlock },
  { id: "pink", label: "Pink", image: pinkBlock },
  { id: "purple2", label: "Purple 2", image: purple2Block },
  { id: "teal", label: "Teal", image: tealBlock },
];

/** How many symbols a board can draw from — every known one. */
export const SYMBOL_COUNT = SYMBOLS.length;

/**
 * The game's own blockade texture. Deliberately NOT in `SYMBOLS`: a blocked
 * cell is the structural value `BLOCKED`, not a symbol, and giving it a slot
 * would shift every index and repaint every saved board. It only *renders*
 * alongside them.
 */
export const BLOCKER_IMAGE = blocker;

export function symbolAt(index: number): MatchThreeSymbol | undefined {
  return SYMBOLS[index];
}
