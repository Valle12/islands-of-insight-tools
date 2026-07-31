import { BLOCKED, symbolCell, EMPTY } from "../../src/pages/match-three-solver/cell";
import {
  cellAt,
  type MatchThreeBoard,
} from "../../src/pages/match-three-solver/rules";

/**
 * Boards are written as rows top to bottom: `.` empty, `#` blocked, and a
 * letter per symbol index 0, 1, 2 … A grid of characters is the only readable
 * way to state a case whose whole point is a shape.
 */
export function board(rows: string[]): MatchThreeBoard {
  const height = rows.length;
  const width = rows[0]!.length;
  const cells = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const char = rows[y]![x]!;
      if (char === "#") cells[y * width + x] = BLOCKED;
      else if (char !== ".") {
        cells[y * width + x] = symbolCell(char.charCodeAt(0) - 97);
      }
    }
  }
  return { width, height, cells };
}

/** The inverse of `board`, so a result can be asserted as a picture too. */
export function draw(value: MatchThreeBoard): string[] {
  return Array.from({ length: value.height }, (_, y) =>
    Array.from({ length: value.width }, (_unused, x) => {
      const cell = cellAt(value, x, y);
      if (cell === EMPTY) return ".";
      if (cell === BLOCKED) return "#";
      return String.fromCharCode(97 + cell - symbolCell(0));
    }).join(""),
  );
}

/** The "x,y" coordinates a match mask marks, for order-free comparison. */
export function marked(
  value: MatchThreeBoard,
  mask: Uint8Array | null,
): string[] {
  if (!mask) return [];
  const cells: string[] = [];
  for (let i = 0; i < mask.length; i++) {
    if (mask[i]) cells.push(`${i % value.width},${Math.floor(i / value.width)}`);
  }
  return cells.sort((a, b) => a.localeCompare(b));
}

/**
 * Settled, match-free, and one swap away from a two-wave cascade: the swap
 * completes a vertical run of four in column 0, which drops that column's `b`
 * onto the bottom row next to two more.
 */
export const CASCADE = ["...", "b..", "a..", "a..", "ca.", "abb"];
