import { readdirSync } from "node:fs";
import { BLOCKED, symbolCell, EMPTY } from "../../src/pages/match-three-solver/cell";
import {
  applyMove,
  blockCount,
  cellAt,
  type MatchThreeBoard,
  type Move,
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

/**
 * Replays a solution the way the player would. Every move has to still be
 * legal at the point it is played, and the board has to end up empty — an
 * answer that does not survive this is not an answer.
 *
 * Here rather than in a test file because both halves of the split engine suite
 * need it: engine.test.ts for the hand-made cases, engine.solve.slow.test.ts
 * for the captured corpus.
 */
export function clearsBoard(start: MatchThreeBoard, moves: Move[]): boolean {
  let current = start;
  for (const move of moves) {
    const outcome = applyMove(current, move);
    if (!outcome) return false;
    current = outcome.board;
  }
  return blockCount(current) === 0;
}

/** Every board captured from the game, discovered by listing rather than enumerated. */
export const FIXTURE_DIR = `${import.meta.dir}/../resources/match-three-solver`;

export const FIXTURES = readdirSync(FIXTURE_DIR).filter(name =>
  name.endsWith(".json"),
);
