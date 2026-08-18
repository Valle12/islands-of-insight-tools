// A forbidden arrangement the player DREW, and the geometry it needs.
//
// The other half of what a config carries beyond its rule flags, beside the
// sized `areas`/`runs` instances — and the answer to a catalog that grew to
// 57 entries chasing shapes the game kept producing. A drawn pattern needs no
// code at all: it is a box of squares, each either naming a color or naming
// nothing, and the engine compiles it into the same table every arrangement
// rule compiles into.
//
// **A drawn pattern forbids its rotations and reflections too, always.** Every
// built-in arrangement family already did — the T bans four rotations, the L
// all eight, the checkerboard both colorings — and each of them is exactly
// the dihedral closure of one shape, which is what makes the two things one
// mechanism. There is no per-pattern switch for it.
//
// Nothing here knows what a board is: bounds against the grid belong to
// `config.ts`, which owns `MAX_GRID_SIDE`. This file is pure geometry and
// ordering, shared by the validator, the editor and the TS oracle.

import type { LogicGridPattern } from "../../util/types";
import { DARK, LIGHT, UNKNOWN } from "./cell";

/** Whether this square of a box names a color, rather than nothing at all. */
export function namesColor(square: number): boolean {
  return square === DARK || square === LIGHT;
}

/**
 * A pattern from a picture, one string per row of the box: '.' for a square the
 * pattern does not name, 'D' and 'L' for the two colors.
 *
 * How the ten retired catalog entries spell the shape they became, so it can
 * be read in `rules.ts` — and the mirror of `drawnFromLegacy` in the engine's
 * `Rules.cpp`, which reads the same pictures out of `kLegacyPatterns`.
 */
export function patternFromPicture(
  picture: readonly string[],
): LogicGridPattern {
  const colorOf: Record<string, number> = { D: DARK, L: LIGHT };
  const cells: number[] = [];
  for (const row of picture) {
    for (const square of row) cells.push(colorOf[square] ?? UNKNOWN);
  }
  return {
    width: picture[0]?.length ?? 0,
    height: picture.length,
    cells,
  };
}

/** Whether any square names a color. One that names none forbids nothing. */
export function namesASquare(pattern: LogicGridPattern): boolean {
  return pattern.cells.some(namesColor);
}

/** The square at (x, y), or `UNKNOWN` outside the box. */
function squareAt(pattern: LogicGridPattern, x: number, y: number): number {
  if (x < 0 || x >= pattern.width || y < 0 || y >= pattern.height)
    return UNKNOWN;
  return pattern.cells[y * pattern.width + x]!;
}

/**
 * Whether the box is trimmed to the squares it names — no empty edge row or
 * column.
 *
 * An INTERIOR empty row is ordinary and stays: a knight's move is two squares
 * with a blank row between them. What tightness buys is that two drawings of
 * one shape have the same box, so they can be compared at all.
 */
export function isTightBox(pattern: LogicGridPattern): boolean {
  if (!namesASquare(pattern)) return false;
  const rowNames = (y: number) => {
    for (let x = 0; x < pattern.width; x++) {
      if (namesColor(squareAt(pattern, x, y))) return true;
    }
    return false;
  };
  const columnNames = (x: number) => {
    for (let y = 0; y < pattern.height; y++) {
      if (namesColor(squareAt(pattern, x, y))) return true;
    }
    return false;
  };
  return (
    rowNames(0) &&
    rowNames(pattern.height - 1) &&
    columnNames(0) &&
    columnNames(pattern.width - 1)
  );
}

/**
 * The same shape trimmed to its bounding box, or `null` when it names nothing.
 *
 * What the DIALOG produces goes through here: a player paints inside whatever
 * box they sized, and the stored shape is only the part that means something.
 * Both C++ intakes refuse an untrimmed box rather than trimming it, so this is
 * the one place the trim happens.
 */
export function normalizePattern(
  pattern: LogicGridPattern,
): LogicGridPattern | null {
  let minX = pattern.width;
  let minY = pattern.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < pattern.height; y++) {
    for (let x = 0; x < pattern.width; x++) {
      if (!namesColor(squareAt(pattern, x, y))) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (maxX < 0) return null;
  const width = maxX - minX + 1;
  const height = maxY - minY + 1;
  const cells: number[] = [];
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) cells.push(squareAt(pattern, x, y));
  }
  return { width, height, cells };
}

/**
 * Where (x, y) lands under one of the eight dihedral images: bit 0 transposes
 * and bits 1 and 2 flip the result's two axes. Between them that is the whole
 * group — transpose is a reflection, and the two flips generate the other
 * three reflections and the four rotations.
 *
 * Split out from `transformed` below so neither is doing two things at once:
 * this one is the geometry, that one is the copy.
 */
function mapped(
  x: number,
  y: number,
  image: number,
  width: number,
  height: number,
) {
  const swap = (image & 1) !== 0;
  const nx = swap ? y : x;
  const ny = swap ? x : y;
  return {
    x: (image & 2) === 0 ? nx : width - 1 - nx,
    y: (image & 4) === 0 ? ny : height - 1 - ny,
  };
}

/**
 * One dihedral image of a whole pattern. A tight box maps to a tight box under
 * every one of the eight, so no image needs re-trimming.
 */
function transformed(pattern: LogicGridPattern, image: number) {
  const swap = (image & 1) !== 0;
  const width = swap ? pattern.height : pattern.width;
  const height = swap ? pattern.width : pattern.height;
  const cells = new Array<number>(width * height).fill(UNKNOWN);
  for (let y = 0; y < pattern.height; y++) {
    for (let x = 0; x < pattern.width; x++) {
      const at = mapped(x, y, image, width, height);
      cells[at.y * width + at.x] = squareAt(pattern, x, y);
    }
  }
  return { width, height, cells };
}

/**
 * The eight dihedral images, de-duplicated — a symmetric shape has fewer, and
 * a 2x2 block has exactly one.
 *
 * This is what a drawn pattern MEANS: the board may not hold any of these
 * anywhere.
 */
export function dihedralImages(
  pattern: LogicGridPattern,
): LogicGridPattern[] {
  const images: LogicGridPattern[] = [];
  const seen = new Set<string>();
  for (let image = 0; image < 8; image++) {
    const turned = transformed(pattern, image);
    const key = rawKey(turned);
    if (seen.has(key)) continue;
    seen.add(key);
    images.push(turned);
  }
  return images;
}

/**
 * A pattern as one comparable string: height, width and the squares, each side
 * zero-padded so plain string order IS (height, width, cells) order. That is
 * the same total order `rules::drawnLess` spells in C++, which is what lets one
 * side write a list the other accepts as canonical.
 */
function rawKey(pattern: LogicGridPattern): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(pattern.height)}:${pad(pattern.width)}:${pattern.cells.join("")}`;
}

/**
 * The key two drawings of the SAME rule share, whichever orientation each was
 * drawn in: the smallest of the eight images.
 *
 * Used for duplicate detection and for ordering, never for display — the chip
 * shows what was drawn, not this.
 */
export function patternKey(pattern: LogicGridPattern): string {
  let smallest = rawKey(pattern);
  for (const image of dihedralImages(pattern)) {
    const key = rawKey(image);
    if (key < smallest) smallest = key;
  }
  return smallest;
}

/** Canonical list order: ascending by `patternKey`. */
export function comparePatterns(
  a: LogicGridPattern,
  b: LogicGridPattern,
): number {
  const left = patternKey(a);
  const right = patternKey(b);
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** A copy, so a stored pattern cannot be mutated through the one handed out. */
export function clonePattern(pattern: LogicGridPattern): LogicGridPattern {
  return {
    width: pattern.width,
    height: pattern.height,
    cells: [...pattern.cells],
  };
}

/** The list in canonical order with rotations of one shape collapsed. */
export function canonicalPatterns(
  patterns: readonly LogicGridPattern[],
): LogicGridPattern[] {
  const seen = new Set<string>();
  const kept: LogicGridPattern[] = [];
  for (const pattern of patterns) {
    const key = patternKey(pattern);
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(clonePattern(pattern));
  }
  return kept.sort(comparePatterns);
}

/**
 * What a pattern is called out loud, derived from the drawing and nothing else.
 *
 * There is no catalog lookup here on purpose: a drawn pattern shows only what
 * was drawn, so a shape that happens to match a rule the page still lists gets
 * no borrowed name. `position` is the chip's place in the row, which is all
 * that tells two drawings apart at a glance.
 */
export function describePattern(
  pattern: LogicGridPattern,
  position: number,
): string {
  const squares: string[] = [];
  for (let y = 0; y < pattern.height; y++) {
    for (let x = 0; x < pattern.width; x++) {
      const square = squareAt(pattern, x, y);
      if (!namesColor(square)) continue;
      const color = square === DARK ? "dark" : "light";
      squares.push(`${color} at row ${y + 1} column ${x + 1}`);
    }
  }
  return (
    `Forbidden pattern ${position}, ${pattern.width} by ${pattern.height}, ` +
    squares.join(", ")
  );
}
